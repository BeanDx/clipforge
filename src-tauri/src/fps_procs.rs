// Фоновые программы для вкладки «FPS»: сколько каждая ест процессора и видеокарты прямо сейчас.
// Процессор — по времени процесса (GetProcessTimes) за секунду, видеокарта — счётчики «GPU Engine»
// (то же, что в диспетчере задач; английские имена счётчиков работают на любом языке Windows).
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::render::no_window;

// Эти не закрываем никогда: система, сама игра, Steam, античит и сам clipforge
const PROTECTED: &[&str] = &[
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
    "svchost.exe", "dwm.exe", "explorer.exe", "fontdrvhost.exe", "audiodg.exe", "msmpeng.exe", "nissrv.exe",
    "searchindexer.exe", "searchhost.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe", "sihost.exe",
    "ctfmon.exe", "taskhostw.exe", "runtimebroker.exe", "spoolsv.exe", "memory compression", "secure system",
    "cs2.exe", "steam.exe", "steamservice.exe", "steamwebhelper.exe", "msedgewebview2.exe", "conhost.exe",
    "wudfhost.exe", "lsaiso.exe", "dllhost.exe", "applicationframehost.exe", "textinputhost.exe",
    "amdrsserv.exe", "atieclxx.exe", "atiesrxx.exe", "nvcontainer.exe", "nvdisplay.container.exe",
];

#[derive(Serialize)]
pub struct Proc {
    name: String,
    count: usize,
    cpu: f64, // % всего процессора
    gpu: f64, // % видеокарты (самый загруженный движок)
    killable: bool,
}

// Сам clipforge со всеми своими процессами (webview интерфейса, node, ffmpeg) — показывается отдельно,
// без кнопки «Закрыть»: чтобы было видно, сколько ест программа, которая советует закрывать другие
#[derive(Serialize, Default)]
pub struct Own {
    count: usize,
    cpu: f64,
    gpu: f64,
    // своя (не общая с другими процессами) память, МБ
    mem_mb: f64,
}

#[derive(Serialize)]
pub struct Procs {
    list: Vec<Proc>,
    own: Own,
    // всего занято процессора и видеокарты (без простоя)
    cpu_total: f64,
    gpu_total: f64,
    cs2_running: bool,
}

// (pid, pid родителя, имя exe)
fn processes() -> Vec<(u32, u32, String)> {
    let mut out = Vec::new();
    // SAFETY: снимок процессов, структура с выставленным dwSize, хэндл закрывается
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 { return out; }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                if Process32NextW(snap, &mut e) == 0 { break; }
            }
        }
        CloseHandle(snap);
    }
    out
}

// Сам clipforge и всё, что он запустил (webview интерфейса, node для разбора демок, ffmpeg)
fn app_tree(procs: &[(u32, u32, String)]) -> HashSet<u32> {
    let mut mine: HashSet<u32> = HashSet::from([std::process::id()]);
    loop {
        let before = mine.len();
        for (pid, parent, _) in procs {
            if *pid != *parent && mine.contains(parent) { mine.insert(*pid); }
        }
        if mine.len() == before { break; }
    }
    mine
}

// Не показываем в общем списке и не закрываем: clipforge и, в dev-сборке, инструменты разработки
// (на node крутится сам интерфейс — Vite; у пользователей готовой сборки их нет)
fn own_tree(procs: &[(u32, u32, String)]) -> HashSet<u32> {
    let mut mine = app_tree(procs);
    if cfg!(debug_assertions) {
        for (pid, _, name) in procs {
            if ["node.exe", "cargo.exe", "rustc.exe", "esbuild.exe"].contains(&name.to_ascii_lowercase().as_str()) { mine.insert(*pid); }
        }
    }
    mine
}

// своя память процесса (private bytes), байт
fn private_bytes(pid: u32) -> u64 {
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    // SAFETY: хэндл только на чтение, структура с выставленным cb, хэндл закрывается
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return 0; }
        let mut m: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        m.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = K32GetProcessMemoryInfo(h, &mut m, m.cb) != 0;
        CloseHandle(h);
        if ok { m.PagefileUsage as u64 } else { 0 }
    }
}

fn ft(f: FILETIME) -> u64 { ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64 }

// время процесса на процессоре, в сотнях наносекунд
fn cpu_time(pid: u32) -> Option<u64> {
    // SAFETY: хэндл только на чтение, закрывается
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return None; }
        let (mut c, mut x, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
        let ok = GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u) != 0;
        CloseHandle(h);
        ok.then(|| ft(k) + ft(u))
    }
}

struct GpuQuery { q: isize, c: isize }

impl GpuQuery {
    fn open() -> Option<Self> {
        let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0".encode_utf16().collect();
        // SAFETY: указатели на живые переменные, строка с нулём
        unsafe {
            let mut q = std::mem::zeroed();
            if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != 0 { return None; }
            let mut c = std::mem::zeroed();
            if PdhAddEnglishCounterW(q, path.as_ptr(), 0, &mut c) != 0 { PdhCloseQuery(q); return None; }
            PdhCollectQueryData(q);
            Some(GpuQuery { q: q as isize, c: c as isize })
        }
    }

    // pid → загрузка: по каждому типу движка (3D, Copy, VideoEncode…) сумма, берём самый загруженный
    fn read(&self) -> HashMap<u32, f64> {
        let mut per: HashMap<(u32, String), f64> = HashMap::new();
        // SAFETY: буфер нужного размера, его спрашиваем первым вызовом
        unsafe {
            PdhCollectQueryData(self.q as _);
            let (mut size, mut n) = (0u32, 0u32);
            PdhGetFormattedCounterArrayW(self.c as _, PDH_FMT_DOUBLE, &mut size, &mut n, std::ptr::null_mut());
            if size == 0 { return HashMap::new(); }
            let mut buf = vec![0u8; size as usize];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(self.c as _, PDH_FMT_DOUBLE, &mut size, &mut n, items) != 0 { return HashMap::new(); }
            for i in 0..n as usize {
                let it = &*items.add(i);
                let mut len = 0;
                while *it.szName.add(len) != 0 { len += 1; }
                let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.szName, len));
                // pid_1234_luid_0x…_phys_0_eng_0_engtype_3D
                let Some(pid) = name.strip_prefix("pid_").and_then(|r| r.split('_').next()).and_then(|p| p.parse().ok()) else { continue };
                let kind = name.rsplit("engtype_").next().unwrap_or("").to_string();
                *per.entry((pid, kind)).or_default() += it.FmtValue.Anonymous.doubleValue;
            }
        }
        let mut out: HashMap<u32, f64> = HashMap::new();
        for ((pid, _), v) in per {
            let e = out.entry(pid).or_default();
            if v > *e { *e = v; }
        }
        out
    }
}

impl Drop for GpuQuery {
    fn drop(&mut self) {
        // SAFETY: запрос открыт в open()
        unsafe { PdhCloseQuery(self.q as _); }
    }
}

fn scan() -> Procs {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let gpu = GpuQuery::open();
    let before: HashMap<u32, u64> = processes().into_iter().filter_map(|(p, _, _)| Some((p, cpu_time(p)?))).collect();
    let t0 = Instant::now();
    std::thread::sleep(Duration::from_millis(1000));
    let now = processes();
    let secs = t0.elapsed().as_secs_f64();
    let gpu_use = gpu.as_ref().map(|g| g.read()).unwrap_or_default();

    let app = app_tree(&now);
    let hidden = own_tree(&now);
    let mut groups: HashMap<String, Proc> = HashMap::new();
    let mut own = Own::default();
    let mut cs2_running = false;
    for (pid, _, name) in now {
        if pid == 0 { continue; }
        let lower = name.to_ascii_lowercase();
        if lower == "cs2.exe" { cs2_running = true; }
        let cpu = match (before.get(&pid), cpu_time(pid)) {
            (Some(a), Some(b)) if b >= *a => (b - a) as f64 / 1e7 / secs / cores * 100.0,
            _ => 0.0,
        };
        if app.contains(&pid) {
            own.count += 1;
            own.cpu += cpu;
            own.gpu += gpu_use.get(&pid).copied().unwrap_or(0.0);
            own.mem_mb += private_bytes(pid) as f64 / (1024.0 * 1024.0);
            continue;
        }
        if hidden.contains(&pid) { continue; }
        let g = groups.entry(lower.clone()).or_insert_with(|| Proc {
            killable: !PROTECTED.contains(&lower.as_str()),
            name, count: 0, cpu: 0.0, gpu: 0.0,
        });
        g.count += 1;
        g.cpu += cpu;
        g.gpu += gpu_use.get(&pid).copied().unwrap_or(0.0);
    }
    let cpu_total = (groups.values().map(|p| p.cpu).sum::<f64>() + own.cpu).min(100.0);
    let gpu_total = (groups.values().map(|p| p.gpu).sum::<f64>() + own.gpu).min(100.0);
    let mut list: Vec<Proc> = groups.into_values().map(|mut p| { p.gpu = p.gpu.min(100.0); p }).collect();
    list.sort_by(|a, b| (b.cpu + b.gpu).total_cmp(&(a.cpu + a.gpu)));
    own.gpu = own.gpu.min(100.0);
    Procs { list, own, cpu_total, gpu_total, cs2_running }
}

// Все процессы с загрузкой: интерфейс сам решает, что показать (известные программы — даже без нагрузки)
#[tauri::command]
pub async fn fps_processes() -> Procs {
    tauri::async_runtime::spawn_blocking(scan).await.expect("fps_processes")
}

// Закрыть программу целиком (все её процессы)
#[tauri::command]
pub async fn fps_kill(name: String) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if PROTECTED.contains(&lower.as_str()) || !lower.ends_with(".exe") || lower.contains(['/', '\\', '"']) {
        return Err("эту программу закрывать нельзя".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // по PID, а не по имени: свои процессы с тем же именем (node, ffmpeg) не трогаем
        let procs = processes();
        let mine = own_tree(&procs);
        let pids: Vec<String> = procs.iter()
            .filter(|(pid, _, n)| n.eq_ignore_ascii_case(&name) && !mine.contains(pid))
            .map(|(pid, _, _)| pid.to_string()).collect();
        if pids.is_empty() { return Ok(()); }
        let mut cmd = Command::new("taskkill");
        for p in &pids { cmd.args(["/PID", p]); }
        cmd.args(["/F", "/T"]);
        no_window(&mut cmd);
        let o = cmd.output().map_err(|e| e.to_string())?;
        // часть процессов могла быть от администратора — их taskkill не закроет
        let left = processes().iter().any(|(pid, _, _)| pids.contains(&pid.to_string()));
        if left {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            return Err(if err.is_empty() { "не удалось закрыть: возможно, программа запущена от администратора".into() } else { err });
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn show_processes_here() {
        let p = super::scan();
        println!("cpu {:.1}% gpu {:.1}%", p.cpu_total, p.gpu_total);
        println!("own: {} процессов, cpu {:.2}% gpu {:.2}% mem {:.0} MB", p.own.count, p.own.cpu, p.own.gpu, p.own.mem_mb);
        for x in p.list.iter().take(15) { println!("{:30} x{:<3} cpu {:5.1}% gpu {:5.1}%", x.name, x.count, x.cpu, x.gpu); }
    }
}
