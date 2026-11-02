// Авто-тайминг текста песни, которой нет в базах (LRCLIB и т. п.): пользователь вставляет текст,
// а маленькая локальная нейросеть Whisper (whisper.cpp, официальная сборка с GitHub) слушает трек
// и даёт время каждого услышанного слова. Сами слова она слышит неточно — выравнивание с
// правильным текстом делает фронтенд (src/lyricsAlign.js), отсюда только [время, слово].
// Один раз качается программа (~22 МБ) и модель base (~148 МБ) в %LOCALAPPDATA%\clipforge\whisper.
// Против глюков Whisper на музыке: без «памяти» между кусками (-mc 0, иначе зацикливается на одной
// строке), бас бита срезается фильтром.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::ffmpeg::download;
use crate::render::no_window;

const BIN_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_SIZE: u64 = 147_951_465;

fn dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("whisper")
}

fn find_cli(d: &Path) -> Option<PathBuf> {
    for e in fs::read_dir(d).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_cli(&p) { return Some(f); } }
        else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("whisper-cli.exe")) { return Some(p); }
    }
    None
}

fn model() -> PathBuf { dir().join("ggml-base.bin") }

// Скачивает недостающее; прогресс — событие whisper-progress: (что, скачано МБ, всего МБ)
fn ensure(app: &AppHandle) -> Result<PathBuf, String> {
    let d = dir();
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let bin = d.join("bin");
    if find_cli(&bin).is_none() {
        let zip = d.join("whisper.zip");
        download(BIN_URL, &zip, &|a, b| { let _ = app.emit("whisper-progress", ("bin", a, b)); })?;
        let _ = fs::remove_dir_all(&bin);
        fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
        // tar из Windows 10+ распаковывает и zip
        let mut cmd = Command::new("tar");
        cmd.arg("-xf").arg(&zip).arg("-C").arg(&bin);
        no_window(&mut cmd);
        let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
        let _ = fs::remove_file(&zip);
        if !ok { return Err("не удалось распаковать Whisper".into()); }
    }
    let cli = find_cli(&bin).ok_or("в архиве нет whisper-cli.exe")?;
    if !fs::metadata(model()).is_ok_and(|m| m.len() == MODEL_SIZE) {
        let part = d.join("ggml-base.bin.part");
        download(MODEL_URL, &part, &|a, b| { let _ = app.emit("whisper-progress", ("model", a, b)); })?;
        fs::rename(&part, model()).map_err(|e| e.to_string())?;
    }
    Ok(cli)
}

// Слова трека со временем начала: [[секунды, "слово"], ...]. lang — "ru", "en" или "auto".
#[tauri::command]
pub async fn track_words(app: AppHandle, hlae: String, path: String, lang: String) -> Result<Vec<(f64, String)>, String> {
    let cli = ensure(&app)?;
    let ff = crate::ffmpeg::find(&hlae).ok_or("не найден ffmpeg")?;
    let _ = app.emit("whisper-progress", ("run", 0.0, 0.0));
    words(&cli, &ff, &path, &lang)
}

fn words(cli: &Path, ff: &Path, path: &str, lang: &str) -> Result<Vec<(f64, String)>, String> {
    let work = dir().join("job");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let wav = work.join("song.wav");
    // Whisper ест 16 кГц моно; бас и верх срезаем — голос остаётся, бит мешает меньше
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(path)
        .args(["-af", "highpass=f=180,lowpass=f=6000,dynaudnorm", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]).arg(&wav);
    no_window(&mut cmd);
    if !cmd.status().map(|s| s.success()).unwrap_or(false) { return Err("не удалось подготовить звук трека".into()); }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16).to_string();
    // -ml 1 -sow: каждый отрезок — одно слово, -oj — JSON со временем в миллисекундах
    let mut cmd = Command::new(cli);
    cmd.arg("-m").arg(model()).arg("-f").arg(&wav)
        .args(["-l", lang, "-t", &threads, "-mc", "0", "-ml", "1", "-sow", "-oj", "-of"]).arg(work.join("words"))
        .current_dir(cli.parent().unwrap_or(&work));
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Whisper не запустился: {e}"))?;
    let raw = fs::read(work.join("words.json"))
        .map_err(|_| format!("Whisper не разобрал трек: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")))?;
    let _ = fs::remove_dir_all(&work);
    let j: Value = serde_json::from_str(&String::from_utf8_lossy(&raw)).map_err(|e| e.to_string())?;
    let list: Vec<(f64, String)> = j["transcription"].as_array().into_iter().flatten()
        .filter_map(|s| Some((s["offsets"]["from"].as_f64()? / 1000.0, s["text"].as_str()?.trim().to_string())))
        .filter(|(_, w)| !w.is_empty())
        .collect();
    if list.is_empty() { return Err("в треке не нашлось слов".into()); }
    Ok(list)
}
