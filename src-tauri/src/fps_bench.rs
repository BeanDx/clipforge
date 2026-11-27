// Замер FPS для вкладки «FPS»: CS2 с твоими настройками прогоняет кусок демки командой
// timedemoquit (играет демку на максимальной скорости, пишет итог в консоль и выходит).
// В console.log (-condebug) строка движка:
//   «%i frames %5.3f seconds %5.2f fps (%5.2f ms/f) %5.3f fps variability, P5/50/95 frame time %.1f/%.1f/%.1f ms»
// Второй аргумент timedemo — файл покадровой статистики: по нему считается 1% low.
// На время замера fps_max 0 (иначе упрёмся в свой лимит), после — значение в конфиге возвращается.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::fps_video::{kv, set_kv};
use crate::render::{no_window, process_running};

const STATS: &str = "clipforge_bench.txt";
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct BenchResult {
    frames: u32,
    seconds: f64,
    avg: f64,
    variability: f64,
    // время кадра, мс: 5-й, 50-й и 95-й перцентили
    p5: f64,
    p50: f64,
    p95: f64,
    // 1% low, FPS: среднее худшего 1% кадров (если игра записала покадровую статистику)
    low1: Option<f64>,
    at: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    // "launch" | "load" | "run" | "done" | "error"
    stage: &'static str,
    result: Option<BenchResult>,
    error: Option<String>,
}

fn emit(app: &AppHandle, stage: &'static str, result: Option<BenchResult>, error: Option<String>) {
    let _ = app.emit("fps-bench", Progress { stage, result, error });
}

fn num(s: &str) -> Option<f64> { s.trim().parse().ok() }

// последняя строка итогов timedemo в хвосте console.log
pub(crate) fn parse_summary(log: &str) -> Option<BenchResult> {
    let line = log.lines().rev().find(|l| l.contains(" fps variability, P5/50/95 frame time "))?;
    let words: Vec<&str> = line.split_whitespace().collect();
    let at = |w: &str| words.iter().position(|x| *x == w);
    let frames = words.get(at("frames")?.checked_sub(1)?)?.parse().ok()?;
    let seconds = num(words.get(at("seconds")?.checked_sub(1)?)?)?;
    let avg = num(words.get(at("fps")?.checked_sub(1)?)?)?;
    let variability = num(words.get(at("variability,")?.checked_sub(2)?)?).unwrap_or(0.0);
    let times = line.rsplit("frame time ").next()?.trim().trim_end_matches("ms").trim();
    let t: Vec<f64> = times.split('/').filter_map(num).collect();
    if t.len() != 3 { return None; }
    Some(BenchResult { frames, seconds, avg, variability, p5: t[0], p50: t[1], p95: t[2], ..Default::default() })
}

// 1% low из покадрового файла: «demo tick,frame start time,frame start delta,frame swap time,frame swap delta,…»
fn low1(csv: &str) -> Option<f64> {
    let mut d: Vec<f64> = csv.lines().skip(1)
        .filter_map(|l| l.split(',').nth(2).and_then(num)).filter(|v| *v > 0.0).collect();
    if d.len() < 200 { return None; }
    // секунды или миллисекунды — по медиане (кадр дольше секунды не бывает)
    d.sort_by(|a, b| a.total_cmp(b));
    let ms = if d[d.len() / 2] < 1.0 { 1000.0 } else { 1.0 };
    let worst = &d[d.len() - (d.len() / 100).max(1)..];
    let avg_ms = worst.iter().sum::<f64>() / worst.len() as f64 * ms;
    (avg_ms > 0.0).then(|| 1000.0 / avg_ms)
}

fn log_tail(p: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(p) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)));
    let mut b = Vec::new();
    let _ = f.read_to_end(&mut b);
    String::from_utf8_lossy(&b).into_owned()
}

// fps_max в cs2_user_convars всех аккаунтов: (файл, значение до замера)
fn fps_max_snapshot() -> Vec<(PathBuf, Option<String>)> {
    let root = Path::new(&crate::gallery::steam_root()).join("userdata");
    fs::read_dir(root).map(|rd| rd.flatten().filter_map(|e| {
        let p = e.path().join("730").join("local").join("cfg").join("cs2_user_convars_0_slot0.vcfg");
        let t = fs::read(&p).ok()?;
        Some((p.clone(), kv(&String::from_utf8_lossy(&t)).remove("fps_max")))
    }).collect()).unwrap_or_default()
}

fn fps_max_restore(snap: &[(PathBuf, Option<String>)]) {
    for (p, was) in snap {
        let Ok(b) = fs::read(p) else { continue };
        let t = String::from_utf8_lossy(&b).into_owned();
        let now = kv(&t).remove("fps_max");
        if &now == was { continue; }
        let fixed = match was {
            Some(v) => set_kv(&t, "fps_max", v),
            // строки не было (значение по умолчанию) — убираем
            None => t.split_inclusive('\n').filter(|l| !l.trim_start().starts_with("\"fps_max\"")).collect(),
        };
        let _ = fs::write(p, fixed);
    }
}

fn kill_cs2() {
    let mut c = Command::new("taskkill");
    c.args(["/IM", "cs2.exe", "/F"]);
    no_window(&mut c);
    let _ = c.status();
}

fn run(app: &AppHandle, cs2: &str, demo: &str, start: Option<u32>, end: Option<u32>) -> Result<BenchResult, String> {
    let exe = Path::new(cs2);
    let game = exe.parent().and_then(Path::parent).and_then(Path::parent).ok_or("неверный путь к cs2.exe")?;
    let csgo = game.join("csgo");
    let console_log = csgo.join("console.log");
    let _ = fs::remove_file(&console_log);
    let stats_dirs = [csgo.clone(), game.to_path_buf(), exe.parent().unwrap_or(game).to_path_buf()];
    for d in &stats_dirs { let _ = fs::remove_file(d.join(STATS)); }

    let snap = fps_max_snapshot();
    let mut cmdline = vec!["-steam".to_string(), "-novid".into(), "-condebug".into(), "+fps_max".into(), "0".into()];
    if let (Some(s), Some(e)) = (start, end) {
        cmdline.extend(["+timedemo_start".into(), s.to_string(), "+timedemo_end".into(), e.to_string()]);
    }
    cmdline.extend(["+timedemoquit".into(), demo.replace('\\', "/"), STATS.into()]);
    Command::new(exe).args(&cmdline).current_dir(exe.parent().unwrap_or(game)).spawn()
        .map_err(|e| format!("не удалось запустить CS2: {e}"))?;

    // ждём игру, потом её выход; по console.log видно, что демка пошла
    let t0 = Instant::now();
    let mut seen = false;
    let mut stage = "launch";
    loop {
        thread::sleep(Duration::from_millis(1000));
        if CANCEL.load(Ordering::SeqCst) { kill_cs2(); fps_max_restore(&snap); return Err("замер остановлен".into()); }
        let alive = process_running("cs2.exe");
        if alive { seen = true; }
        if seen && !alive { break; }
        if !seen && t0.elapsed() > Duration::from_secs(120) { fps_max_restore(&snap); return Err("CS2 не запустилась".into()); }
        if t0.elapsed() > Duration::from_secs(20 * 60) { kill_cs2(); fps_max_restore(&snap); return Err("замер идёт больше 20 минут, остановил".into()); }
        let tail = log_tail(&console_log);
        let next = if tail.contains("Requesting timedemo") || tail.contains("DemoPlaybackStarted") || tail.contains("playing ") { "run" }
            else if seen { "load" } else { "launch" };
        if next != stage { stage = next; emit(app, stage, None, None); }
    }
    // CS2 дописывает конфиги при выходе — подождать, потом вернуть fps_max
    thread::sleep(Duration::from_millis(1500));
    fps_max_restore(&snap);

    let tail = log_tail(&console_log);
    let mut r = parse_summary(&tail).ok_or_else(|| {
        if tail.contains("couldn't open demo") || tail.contains("failed to read demo header") { "CS2 не смогла открыть демку (старая версия или битый файл)".to_string() }
        else { "CS2 закрылась без итогов замера".to_string() }
    })?;
    r.low1 = stats_dirs.iter().find_map(|d| fs::read_to_string(d.join(STATS)).ok()).and_then(|t| low1(&t));
    r.at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Ok(r)
}

#[tauri::command]
pub fn fps_bench_start(app: AppHandle, cs2: String, demo: String, start: Option<u32>, end: Option<u32>) -> Result<(), String> {
    if !cs2.to_ascii_lowercase().ends_with("cs2.exe") || !Path::new(&cs2).is_file() { return Err("укажи путь к cs2.exe в настройках".into()); }
    if !Path::new(&demo).is_file() { return Err("демка не найдена".into()); }
    if process_running("cs2.exe") { return Err("закрой CS2: замер запускает игру сам".into()); }
    if RUNNING.swap(true, Ordering::SeqCst) { return Err("замер уже идёт".into()); }
    CANCEL.store(false, Ordering::SeqCst);
    emit(&app, "launch", None, None);
    thread::spawn(move || {
        match run(&app, &cs2, &demo, start, end) {
            Ok(r) => emit(&app, "done", Some(r), None),
            Err(e) => emit(&app, "error", None, Some(e)),
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn fps_bench_cancel() {
    if RUNNING.load(Ordering::SeqCst) { CANCEL.store(true, Ordering::SeqCst); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timedemo_summary() {
        let log = "junk\n7213 frames 18.507 seconds 389.75 fps ( 2.57 ms/f) 12.413 fps variability, P5/50/95 frame time 1.9/2.5/3.4 ms\nShutdown\n";
        let r = parse_summary(log).unwrap();
        assert_eq!((r.frames, r.avg, r.p5, r.p50, r.p95), (7213, 389.75, 1.9, 2.5, 3.4));
        assert_eq!(r.variability, 12.413);
        assert!(parse_summary("nothing here").is_none());
    }

    #[test]
    fn one_percent_low() {
        let mut csv = String::from("demo tick,frame start time,frame start delta,frame swap time,frame swap delta,FPS variability\n");
        for i in 0..1000 { csv += &format!("{i},0,{},0,0,0\n", if i % 100 == 0 { 0.010 } else { 0.0025 }); }
        assert_eq!(low1(&csv).map(|v| v.round()), Some(100.0));
    }
}
