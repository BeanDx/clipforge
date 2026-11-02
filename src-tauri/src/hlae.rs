// HLAE — движок записи (подключается к CS2, камера, запись видео, небо, маски). Ставить его вручную
// больше не нужно: если его нет ни в обычных местах, ни по пути из настроек, программа скачивает
// официальную zip-версию последнего релиза с GitHub (advancedfx/advancedfx) в
// %LOCALAPPDATA%\clipforge\hlae — она работает без установки и без прав администратора.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::ffmpeg::download;
use crate::render::no_window;

pub fn own_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("hlae")
}

// ссылка на zip последнего релиза: через API GitHub, а если он не ответил (лимит запросов) —
// по редиректу releases/latest на тег (v2.192.10 -> hlae_2_192_10.zip)
fn latest_zip() -> Result<String, String> {
    if let Ok(mut r) = ureq::get("https://api.github.com/repos/advancedfx/advancedfx/releases/latest")
        .header("User-Agent", "clipforge").call()
    {
        if let Ok(text) = r.body_mut().read_to_string() {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&text) {
                let url = j["assets"].as_array().into_iter().flatten()
                    .filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?)))
                    .find(|(n, _)| n.to_lowercase().starts_with("hlae_") && n.to_lowercase().ends_with(".zip"))
                    .map(|(_, u)| u.to_string());
                if let Some(u) = url { return Ok(u); }
            }
        }
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().max_redirects(0).build().into();
    let r = agent.get("https://github.com/advancedfx/advancedfx/releases/latest").call().map_err(|e| e.to_string())?;
    let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("нет ссылки на релиз HLAE")?;
    let tag = loc.rsplit('/').next().ok_or("нет тега релиза HLAE")?;
    let name = format!("hlae_{}.zip", tag.trim_start_matches('v').replace('.', "_"));
    Ok(format!("https://github.com/advancedfx/advancedfx/releases/download/{tag}/{name}"))
}

fn find_hlae(dir: &Path) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_hlae(&p) { return Some(f); } }
        else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("HLAE.exe")) { return Some(p); }
    }
    None
}

fn fetch(dir: &Path, on: &dyn Fn(f64, f64)) -> Result<PathBuf, String> {
    let url = latest_zip()?;
    let tmp = dir.with_file_name("hlae_download");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let zip = tmp.join("hlae.zip");
    download(&url, &zip, on)?;
    let unpack = tmp.join("unpack");
    fs::create_dir_all(&unpack).map_err(|e| e.to_string())?;
    // tar из Windows 10+ распаковывает и zip
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(&zip).arg("-C").arg(&unpack);
    no_window(&mut cmd);
    if !cmd.status().map(|s| s.success()).unwrap_or(false) { return Err("не удалось распаковать HLAE".into()); }
    let exe = find_hlae(&unpack).ok_or("в архиве нет HLAE.exe")?;
    // папка с HLAE.exe целиком — на место прошлой копии
    let _ = fs::remove_dir_all(dir);
    fs::rename(exe.parent().ok_or("неверный архив HLAE")?, dir).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(dir.join("HLAE.exe"))
}

// Есть HLAE (по пути из настроек или в обычных местах) — возвращает путь; нет — скачивает
// (прогресс — событие hlae-progress, МБ)
#[tauri::command]
pub async fn ensure_hlae(app: AppHandle, current: String) -> Result<String, String> {
    if let Some(p) = crate::music::locate_hlae(current) { return Ok(p); }
    let on = |done: f64, total: f64| { let _ = app.emit("hlae-progress", (done, total)); };
    fetch(&own_dir(), &on).map(|p| p.to_string_lossy().into_owned())
}

