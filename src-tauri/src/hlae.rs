// HLAE — движок записи (подключается к CS2, камера, запись видео, небо, маски). Ставить его вручную
// не нужно: программа держит свою копию последнего релиза с GitHub (advancedfx/advancedfx) в
// %LOCALAPPDATA%\clipforge\hlae — она работает без установки и без прав администратора.
// Хук HLAE привязан к сборке CS2: после обновления игры старый HLAE падает при запуске
// («Problem in ...addresses.cpp»), а HLAE обычно выходит под новую игру в тот же день. Поэтому
// при запуске программы и перед каждой записью сверяем тег релиза и обновляем свою копию.
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

// тег скачанной копии (v2.193.2) — файл рядом с HLAE.exe
const VERSION_FILE: &str = "clipforge_version.txt";

fn agent(redirects: u32) -> ureq::Agent {
    ureq::Agent::config_builder()
        .max_redirects(redirects)
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into()
}

// тег и ссылка на zip последнего релиза: через API GitHub, а если он не ответил (лимит запросов) —
// по редиректу releases/latest на тег (v2.192.10 -> hlae_2_192_10.zip)
fn latest_release() -> Result<(String, String), String> {
    if let Ok(mut r) = agent(5).get("https://api.github.com/repos/advancedfx/advancedfx/releases/latest")
        .header("User-Agent", "clipforge").call()
    {
        if let Ok(text) = r.body_mut().read_to_string() {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&text) {
                let tag = j["tag_name"].as_str().unwrap_or_default().to_string();
                let url = j["assets"].as_array().into_iter().flatten()
                    .filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?)))
                    .find(|(n, _)| n.to_lowercase().starts_with("hlae_") && n.to_lowercase().ends_with(".zip"))
                    .map(|(_, u)| u.to_string());
                if let (Some(u), false) = (url, tag.is_empty()) { return Ok((tag, u)); }
            }
        }
    }
    let r = agent(0).get("https://github.com/advancedfx/advancedfx/releases/latest").call().map_err(|e| e.to_string())?;
    let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("нет ссылки на релиз HLAE")?;
    let tag = loc.rsplit('/').next().ok_or("нет тега релиза HLAE")?;
    let name = format!("hlae_{}.zip", tag.trim_start_matches('v').replace('.', "_"));
    Ok((tag.to_string(), format!("https://github.com/advancedfx/advancedfx/releases/download/{tag}/{name}")))
}

fn find_hlae(dir: &Path) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_hlae(&p) { return Some(f); } }
        else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("HLAE.exe")) { return Some(p); }
    }
    None
}

fn fetch(dir: &Path, tag: &str, url: &str, on: &dyn Fn(f64, f64)) -> Result<PathBuf, String> {
    let tmp = dir.with_file_name("hlae_download");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let zip = tmp.join("hlae.zip");
    download(url, &zip, on)?;
    let unpack = tmp.join("unpack");
    fs::create_dir_all(&unpack).map_err(|e| e.to_string())?;
    // tar из Windows 10+ распаковывает и zip
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(&zip).arg("-C").arg(&unpack);
    no_window(&mut cmd);
    if !cmd.status().map(|s| s.success()).unwrap_or(false) { return Err("не удалось распаковать HLAE".into()); }
    let exe = find_hlae(&unpack).ok_or("в архиве нет HLAE.exe")?;
    // папка с HLAE.exe целиком — на место прошлой копии. Прошлую сначала отодвигаем целиком: если
    // её хук сейчас загружен в запущенную CS2, переименование не пройдёт и старая копия останется
    // рабочей (удаление по файлам оставило бы полупустую папку)
    let new = exe.parent().ok_or("неверный архив HLAE")?.to_path_buf();
    let old = dir.with_file_name("hlae_old");
    let _ = fs::remove_dir_all(&old);
    if dir.exists() {
        fs::rename(dir, &old).map_err(|e| format!("HLAE сейчас занят (закрой CS2): {e}"))?;
    }
    if let Err(e) = fs::rename(&new, dir) {
        let _ = fs::rename(&old, dir);
        return Err(e.to_string());
    }
    // ffmpeg, докачанный программой в ffmpegin прошлой копии (в zip HLAE его нет), переносим
    // (в zip есть папка ffmpeg, но в ней только readme)
    let ff = dir.join("ffmpeg").join("bin");
    if !ff.exists() && old.join("ffmpeg").join("bin").exists() {
        let _ = fs::create_dir_all(dir.join("ffmpeg"));
        let _ = fs::rename(old.join("ffmpeg").join("bin"), &ff);
    }
    let _ = fs::remove_dir_all(&old);
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::write(dir.join(VERSION_FILE), tag);
    Ok(dir.join("HLAE.exe"))
}

// Путь к HLAE, который подходит к текущей CS2. Своя копия последней версии — главный вариант:
// её тег сверяется с GitHub, вышла новая — скачивается (прогресс — событие hlae-progress, МБ).
// GitHub недоступен или скачать не вышло — берём то, что есть: свою копию, путь из настроек
// или HLAE из обычных мест (так программа работает и без интернета).
#[tauri::command]
pub async fn ensure_hlae(app: AppHandle, current: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = own_dir();
        let own = dir.join("HLAE.exe");
        let have = fs::read_to_string(dir.join(VERSION_FILE)).map(|t| t.trim().to_string()).ok();
        let fallback = || {
            if own.exists() { return Some(own.to_string_lossy().into_owned()); }
            crate::music::locate_hlae(current.clone())
        };
        let (tag, url) = match latest_release() {
            Ok(r) => r,
            Err(e) => return fallback().ok_or(format!("не удалось узнать последнюю версию HLAE: {e}")),
        };
        if own.exists() && have.as_deref() == Some(tag.as_str()) {
            return Ok(own.to_string_lossy().into_owned());
        }
        let on = |done: f64, total: f64| { let _ = app.emit("hlae-progress", (done, total)); };
        match fetch(&dir, &tag, &url, &on) {
            Ok(p) => Ok(p.to_string_lossy().into_owned()),
            Err(e) => fallback().ok_or(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // сеть: cargo test --lib hlae -- --ignored
    #[test]
    #[ignore]
    fn update_keeps_ffmpeg_and_writes_tag() {
        let root = std::env::temp_dir().join("cf_hlae_test");
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("hlae");
        fs::create_dir_all(dir.join("ffmpeg").join("bin")).unwrap();
        fs::write(dir.join("ffmpeg").join("bin").join("ffmpeg.exe"), b"x").unwrap();
        fs::write(dir.join(VERSION_FILE), "v0.0.1").unwrap();
        let (tag, url) = latest_release().unwrap();
        let exe = fetch(&dir, &tag, &url, &|_, _| {}).unwrap();
        assert!(exe.exists());
        assert!(dir.join("x64").join("AfxHookSource2.dll").exists());
        assert_eq!(fs::read_to_string(dir.join(VERSION_FILE)).unwrap(), tag);
        assert!(dir.join("ffmpeg").join("bin").join("ffmpeg.exe").exists());
        assert!(!root.join("hlae_old").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
