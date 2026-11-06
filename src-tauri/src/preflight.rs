// Проверка системы перед рендером: лучше сказать заранее, чем упасть посреди записи.
// Место на диске (по оценке объёма сырой записи), доступ к папке, пути к игре и HLAE,
// драйвер видеокарты и работа от батареи. Ошибки (error) рендер не пускают, предупреждения (warn) — спрашивают.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};

use crate::render::no_window;

#[derive(Serialize)]
pub struct Issue {
    level: &'static str, // "error" | "warn"
    // шаблон по-русски, переводится в интерфейсе (tr с подстановкой args)
    text: &'static str,
    args: Vec<String>,
}

fn issue(level: &'static str, text: &'static str, args: Vec<String>) -> Issue {
    Issue { level, text, args }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    out: String,
    cs2: String,
    hlae: String,
    demo: String,
    width: u32,
    height: u32,
    rec_fps: u32,
    // секунд записи всех клипов (с повторами); 0 — без записи (пересборка прошлого рендера)
    seconds: f64,
    gpu: bool,
    // демка переписывается со скинами — рядом ляжет её копия
    skins: bool,
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

fn gb(b: f64) -> String {
    format!("{:.1}", b / GB)
}

// Свободное место на диске папки (или ближайшей существующей родительской)
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let existing = dir.ancestors().find(|p| p.exists())?;
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    // SAFETY: строка с нулём на конце, указатели на живые переменные
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

// Сырая запись HLAE: на GPU q=18 ≈ 0.5 бита на пиксель, на CPU (x264 crf 22 slow) ≈ 0.12.
// Сверху запас 30% на готовые клипы и сборку.
fn estimate_bytes(p: &Plan) -> f64 {
    let bpp = if p.gpu { 0.5 } else { 0.12 };
    let raw = p.width as f64 * p.height as f64 * p.rec_fps as f64 * p.seconds * bpp / 8.0;
    raw * 1.3
}

fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() { return false; }
    let probe = dir.join(".clipforge_write_test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn on_battery() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: структура заполняется системой
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 { return false; }
    // ACLineStatus 0 — от батареи; BatteryFlag 128 — батареи нет вовсе
    s.ACLineStatus == 0 && s.BatteryFlag != 128
}

struct Gpu {
    name: String,
    date: String, // yyyy-MM-dd
}

// Видеокарты и даты драйверов. PowerShell запускается ~секунду, поэтому один раз за запуск программы.
fn gpus() -> &'static Vec<Gpu> {
    static GPUS: OnceLock<Vec<Gpu>> = OnceLock::new();
    GPUS.get_or_init(|| {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$(if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') })\" }"]);
        no_window(&mut cmd);
        let Ok(out) = cmd.output() else { return vec![] };
        String::from_utf8_lossy(&out.stdout).lines()
            .filter_map(|l| l.trim().split_once('|'))
            .map(|(n, d)| Gpu { name: n.trim().to_string(), date: d.trim().to_string() })
            .filter(|g| !g.name.is_empty())
            .collect()
    })
}

// Дней с 1970-01-01 для даты (алгоритм Хиннанта)
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn driver_age_days(date: &str) -> Option<i64> {
    let mut it = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64 / 86400;
    Some(now - days_from_civil(y, m, d))
}

fn check_gpus(v: &mut Vec<Issue>) {
    for g in gpus() {
        let lower = g.name.to_lowercase();
        if lower.contains("microsoft basic display") {
            v.push(issue("warn", "Драйвер видеокарты не установлен (стоит «{0}»): запись будет очень медленной, GPU-кодирование не заработает", vec![g.name.clone()]));
            continue;
        }
        // виртуальные адаптеры (Parsec, удалённый рабочий стол и т.п.) не проверяем
        let real = ["nvidia", "geforce", "radeon", "amd", "intel"].iter().any(|k| lower.contains(k));
        if !real { continue; }
        if let Some(age) = driver_age_days(&g.date).filter(|a| *a > 365) {
            v.push(issue("warn", "Драйвер {0} от {1} — ему больше {2} мес. Со старым драйвером CS2 и кодировщик видео чаще падают", vec![g.name.clone(), g.date.clone(), (age / 30).to_string()]));
        }
    }
}

fn run(p: &Plan) -> Vec<Issue> {
    let mut v = Vec::new();
    let recording = p.seconds > 0.0;
    if recording {
        if !Path::new(&p.cs2).is_file() {
            v.push(issue("error", "Не найден cs2.exe: {0}. Укажи путь в «Настройках»", vec![p.cs2.clone()]));
        }
        if !Path::new(&p.hlae).is_file() {
            v.push(issue("error", "Не найден HLAE.exe: {0}. Укажи путь в «Настройках»", vec![p.hlae.clone()]));
        }
        if !p.demo.is_empty() && !Path::new(&p.demo).is_file() {
            v.push(issue("error", "Демка пропала с диска: {0}", vec![p.demo.clone()]));
        }
    }
    let out = PathBuf::from(&p.out);
    if p.out.trim().is_empty() || !writable(&out) {
        v.push(issue("error", "Нет доступа на запись в папку хайлайтов: {0}. Выбери другую в «Настройках»", vec![p.out.clone()]));
    } else if let Some(free) = free_bytes(&out).map(|f| f as f64) {
        let mut need = estimate_bytes(p);
        if p.skins {
            need += std::fs::metadata(&p.demo).map(|m| m.len() as f64).unwrap_or(0.0);
        }
        need += 0.5 * GB;
        if free < need {
            v.push(issue("error", "Мало места на диске: свободно {0} ГБ, а для записи нужно около {1} ГБ. Освободи место или выбери папку на другом диске", vec![gb(free), gb(need)]));
        } else if free - need < 3.0 * GB {
            v.push(issue("warn", "Места на диске впритык: свободно {0} ГБ, запись займёт около {1} ГБ", vec![gb(free), gb(need)]));
        }
    }
    if recording {
        check_gpus(&mut v);
        if on_battery() {
            v.push(issue("warn", "Ноутбук работает от батареи: видеокарта может сбросить частоты, и запись пойдёт медленнее. Лучше подключить зарядку", vec![]));
        }
    }
    v
}

#[tauri::command]
pub async fn preflight(plan: Plan) -> Vec<Issue> {
    tauri::async_runtime::spawn_blocking(move || run(&plan)).await.unwrap_or_default()
}

// Быстрая сводка для «Настроек»: видеокарты с датами драйверов и свободное место в папке хайлайтов
#[derive(Serialize)]
pub struct SystemInfo {
    gpus: Vec<(String, String)>,
    free_gb: Option<String>,
    battery: bool,
}

#[tauri::command]
pub async fn system_info(out: String) -> SystemInfo {
    tauri::async_runtime::spawn_blocking(move || SystemInfo {
        gpus: gpus().iter().map(|g| (g.name.clone(), g.date.clone())).collect(),
        free_gb: free_bytes(Path::new(&out)).map(|f| gb(f as f64)),
        battery: on_battery(),
    }).await.unwrap_or(SystemInfo { gpus: vec![], free_gb: None, battery: false })
}
