// Где взять ffmpeg. HLAE пишет запись через ffmpeg и сам его не содержит: установщик HLAE ставит
// его отдельно (путь — в HLAE\ffmpeg\ffmpeg.ini) или кладёт в HLAE\ffmpeg\bin, а в zip-версии HLAE
// его нет совсем. Раньше программа искала только HLAE\ffmpeg\bin\ffmpeg.exe, и без него не
// рендерилось ничего. Теперь: путь из ffmpeg.ini → HLAE\ffmpeg\bin → своя копия в
// %LOCALAPPDATA%\clipforge\ffmpeg (скачивается сама, папка HLAE в Program Files не нужна).
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::render::no_window;

fn hlae_dir(hlae: &str) -> Option<PathBuf> {
    Path::new(hlae).parent().map(Path::to_path_buf)
}

// путь из HLAE\ffmpeg\ffmpeg.ini ([Ffmpeg] Path=...)
fn from_ini(dir: &Path) -> Option<PathBuf> {
    let ini = fs::read_to_string(dir.join("ffmpeg").join("ffmpeg.ini")).ok()?;
    let p = ini.lines().find_map(|l| l.trim().strip_prefix("Path=").map(|v| PathBuf::from(v.trim())))?;
    p.exists().then_some(p)
}

// ffmpeg, который HLAE найдёт без подсказки
fn hlae_bin(dir: &Path) -> Option<PathBuf> {
    let p = dir.join("ffmpeg").join("bin").join("ffmpeg.exe");
    p.exists().then_some(p)
}

fn own_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("ffmpeg")
}

fn own() -> Option<PathBuf> {
    let p = own_dir().join("ffmpeg.exe");
    p.exists().then_some(p)
}

// ffmpeg для обработки клипов
pub fn find(hlae: &str) -> Option<PathBuf> {
    let dir = hlae_dir(hlae);
    dir.as_deref().and_then(hlae_bin).or_else(|| dir.as_deref().and_then(from_ini)).or_else(own)
}

// ffmpeg, который надо явно передать HLAE для записи (его нет в HLAE\ffmpeg\bin) — или None,
// если HLAE найдёт свой сам
pub fn for_hlae(hlae: &str) -> Option<PathBuf> {
    let dir = hlae_dir(hlae)?;
    if hlae_bin(&dir).is_some() { return None; }
    from_ini(&dir).or_else(own)
}

// Строки cfg для настройки записи HLAE name с выходными параметрами out (как у mirv_streams settings
// add ffmpeg). С явным ffmpeg — расширенная настройка ffmpegEx: путь и вход задаются целиком,
// по частям (options, options+) — у консоли игры ограничена длина команды.
pub fn hlae_setting(name: &str, out: &str, exe: Option<&Path>) -> String {
    match exe {
        None => format!("mirv_streams settings add ffmpeg {name} \"{out}\"\n"),
        Some(exe) => format!(
            "mirv_streams settings add ffmpegEx {name} \"\"\n\
             mirv_streams settings edit {name} options \"{{QUOTE}}{}{{QUOTE}} -f rawvideo -pixel_format {{PIXEL_FORMAT}}\"\n\
             mirv_streams settings edit {name} options+ \" -framerate {{FRAMERATE}} -video_size {{WIDTH}}x{{HEIGHT}} -i pipe:0 \"\n\
             mirv_streams settings edit {name} options+ \"{out}\"\n",
            exe.display()
        ),
    }
}

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub path: Option<String>,
    // "hlae" — рядом с HLAE, "ini" — путь из ffmpeg.ini HLAE, "own" — своя копия, null — нет
    pub source: Option<String>,
}

#[tauri::command]
pub fn ffmpeg_status(hlae: String) -> FfmpegStatus {
    let dir = hlae_dir(&hlae);
    let (path, source) = if let Some(p) = dir.as_deref().and_then(hlae_bin) { (Some(p), Some("hlae")) }
        else if let Some(p) = dir.as_deref().and_then(from_ini) { (Some(p), Some("ini")) }
        else if let Some(p) = own() { (Some(p), Some("own")) }
        else { (None, None) };
    FfmpegStatus { path: path.map(|p| p.to_string_lossy().into_owned()), source: source.map(String::from) }
}

// сборки ffmpeg для Windows с постоянными ссылками: gyan.dev (essentials), запасная — BtbN (её же
// ставит установщик HLAE)
const SOURCES: [&str; 2] = [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
];

pub(crate) fn download(url: &str, dst: &Path, on: &dyn Fn(f64, f64)) -> Result<(), String> {
    let mut resp = ureq::get(url).call().map_err(|e| e.to_string())?;
    let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = resp.body_mut().with_config().limit(1 << 31).reader();
    let mut f = fs::File::create(dst).map_err(|e| e.to_string())?;
    let (mut buf, mut done, mut last) = (vec![0u8; 1 << 16], 0u64, 0u64);
    loop {
        let n = body.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last > 1 << 20 {
            last = done;
            on(done as f64 / 1048576.0, total as f64 / 1048576.0);
        }
    }
    Ok(())
}

fn find_exe(dir: &Path) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_exe(&p) { return Some(f); } }
        else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("ffmpeg.exe")) { return Some(p); }
    }
    None
}

// Скачивает и распаковывает ffmpeg.exe в dir (сначала gyan.dev, потом BtbN)
fn fetch(dir: &Path, on: &dyn Fn(f64, f64)) -> Result<PathBuf, String> {
    let tmp = dir.join("download");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let zip = tmp.join("ffmpeg.zip");
    let mut err = String::new();
    for url in SOURCES {
        if let Err(e) = download(url, &zip, on) { err = e; continue; }
        // tar из Windows 10+ распаковывает и zip
        let mut cmd = Command::new("tar");
        cmd.arg("-xf").arg(&zip).arg("-C").arg(&tmp);
        no_window(&mut cmd);
        if !cmd.status().map(|s| s.success()).unwrap_or(false) { err = "не удалось распаковать ffmpeg".into(); continue; }
        if let Some(exe) = find_exe(&tmp) {
            fs::copy(&exe, dir.join("ffmpeg.exe")).map_err(|e| e.to_string())?;
            let _ = fs::remove_dir_all(&tmp);
            return Ok(dir.join("ffmpeg.exe"));
        }
        err = "в архиве нет ffmpeg.exe".into();
    }
    let _ = fs::remove_dir_all(&tmp);
    Err(format!("не удалось скачать ffmpeg: {err}"))
}

// Есть ffmpeg — возвращает путь; нет — скачивает свою копию (прогресс — событие ffmpeg-progress, МБ)
#[tauri::command]
pub async fn ensure_ffmpeg(app: AppHandle, hlae: String) -> Result<String, String> {
    if let Some(p) = find(&hlae) { return Ok(p.to_string_lossy().into_owned()); }
    let on = |done: f64, total: f64| { let _ = app.emit("ffmpeg-progress", (done, total)); };
    // HLAE, который программа скачала сама, лежит в папке пользователя — ffmpeg кладём прямо ему
    // в ffmpeg\bin, там HLAE находит его без подсказки; иначе — в свою папку
    let dir = match hlae_dir(&hlae) {
        Some(d) if d == crate::hlae::own_dir() => d.join("ffmpeg").join("bin"),
        _ => own_dir(),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fetch(&dir, &on).map(|p| p.to_string_lossy().into_owned())
}

