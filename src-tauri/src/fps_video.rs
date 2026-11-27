// Графика CS2 для вкладки «FPS»: cs2_video.txt аккаунта и «Усиление контраста игроков»
// (r_player_visibility_mode в cs2_machine_convars.vcfg). Пресеты применяются только при закрытой игре:
// на выходе CS2 перезаписывает оба файла. Перед первой правкой рядом кладётся копия
// (.clipforge-mine) — кнопка «Вернуть мои» возвращает её. Копия ReShade-записи (.clipforge) — другая.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MINE: &str = "clipforge-mine";
const CONTRAST: &str = "r_player_visibility_mode";

#[derive(Serialize)]
pub struct Video {
    account: String,
    name: String,
    // "setting.xxx" → значение
    settings: BTreeMap<String, String>,
    // усиление контраста игроков: None — строки нет (в игре по умолчанию включено)
    contrast: Option<String>,
    has_backup: bool,
    cs2_running: bool,
}

fn cfg_dir(account: &str) -> PathBuf {
    Path::new(&crate::gallery::steam_root()).join("userdata").join(account).join("730").join("local").join("cfg")
}

fn backup_of(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(format!(".{MINE}"));
    PathBuf::from(s)
}

// Аккаунт, чьи настройки показываем: активный в Steam, если у него есть cs2_video.txt, иначе тот,
// у кого файл менялся последним (CS2 с этого компа запускали под ним)
fn account() -> Option<String> {
    let root = Path::new(&crate::gallery::steam_root()).join("userdata");
    let active = crate::gallery::steam_ids().first().and_then(|id| id.parse::<u64>().ok())
        .map(|n| n.saturating_sub(76561197960265728).to_string());
    if let Some(a) = &active {
        if cfg_dir(a).join("cs2_video.txt").exists() { return Some(a.clone()); }
    }
    fs::read_dir(root).ok()?.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let m = fs::metadata(cfg_dir(&name).join("cs2_video.txt")).ok()?.modified().ok()?;
            Some((m, name))
        })
        .max().map(|(_, n)| n)
}

// "ключ"\t\t"значение" из vcfg / video.txt
pub(crate) fn kv(text: &str) -> BTreeMap<String, String> {
    text.lines().filter_map(|l| {
        let p: Vec<&str> = l.split('"').collect();
        (p.len() >= 5 && p[0].trim().is_empty()).then(|| (p[1].to_string(), p[3].to_string()))
    }).collect()
}

// Заменить значение; если строки нет — вставить после последней строки со значением
// (в vcfg значения лежат во вложенном блоке "convars", поэтому не просто перед последней скобкой)
pub(crate) fn set_kv(text: &str, key: &str, val: &str) -> String {
    let q = format!("\"{key}\"");
    let crlf = text.contains("\r\n");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut done = false;
    for l in lines.iter_mut() {
        if l.trim_start().starts_with(&q) {
            let indent: String = l.chars().take_while(|c| c.is_whitespace()).collect();
            *l = format!("{indent}{q}\t\t\"{val}\"");
            done = true;
        }
    }
    if !done {
        let is_kv = |l: &String| l.trim_start().starts_with('"') && l.split('"').count() >= 5;
        let last = lines.iter().rposition(is_kv);
        let at = last.map(|i| i + 1).or_else(|| lines.iter().rposition(|l| l.trim() == "}")).unwrap_or(lines.len());
        let indent = last.map(|i| lines[i].chars().take_while(|c| c.is_whitespace()).collect::<String>()).unwrap_or_else(|| "\t".into());
        lines.insert(at, format!("{indent}{q}\t\t\"{val}\""));
    }
    let nl = if crlf { "\r\n" } else { "\n" };
    let mut out = lines.join(nl);
    if text.ends_with('\n') { out.push_str(nl); }
    out
}

fn read(account: String) -> Result<Video, String> {
    let dir = cfg_dir(&account);
    let video = dir.join("cs2_video.txt");
    let text = fs::read(&video).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|_| "не найден cs2_video.txt: запусти CS2 хотя бы раз")?;
    let settings = kv(&text).into_iter().filter(|(k, _)| k.starts_with("setting.")).collect();
    let contrast = fs::read(dir.join("cs2_machine_convars.vcfg")).ok()
        .and_then(|b| kv(&String::from_utf8_lossy(&b)).remove(CONTRAST));
    let steamid = account.parse::<u64>().map(|n| (n + 76561197960265728).to_string()).unwrap_or_default();
    Ok(Video {
        name: crate::gsi::persona(&crate::gallery::steam_root(), &steamid),
        has_backup: backup_of(&video).exists(),
        cs2_running: crate::render::process_running("cs2.exe"),
        account, settings, contrast,
    })
}

#[tauri::command]
pub async fn fps_video() -> Result<Video, String> {
    tauri::async_runtime::spawn_blocking(|| read(account().ok_or("не найдены настройки CS2 ни у одного аккаунта Steam")?))
        .await.map_err(|e| e.to_string())?
}

fn safe_account(a: &str) -> Result<(), String> {
    (!a.is_empty() && a.chars().all(|c| c.is_ascii_digit())).then_some(()).ok_or_else(|| "неверный аккаунт".into())
}

// Записать настройки (только ключи setting.* и контраст). Копия делается один раз — до первой правки.
#[tauri::command]
pub async fn fps_video_apply(account: String, settings: BTreeMap<String, String>, contrast: Option<String>) -> Result<Video, String> {
    safe_account(&account)?;
    tauri::async_runtime::spawn_blocking(move || {
        if crate::render::process_running("cs2.exe") { return Err("закрой CS2: при выходе она перезапишет настройки".to_string()); }
        let dir = cfg_dir(&account);
        let video = dir.join("cs2_video.txt");
        let mut text = String::from_utf8_lossy(&fs::read(&video).map_err(|e| e.to_string())?).into_owned();
        let bak = backup_of(&video);
        if !bak.exists() { fs::copy(&video, &bak).map_err(|e| e.to_string())?; }
        for (k, v) in &settings {
            let ok_key = k.starts_with("setting.") && k[8..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let ok_val = !v.is_empty() && v.len() < 12 && v.chars().all(|c| c.is_ascii_digit() || c == '-');
            if ok_key && ok_val { text = set_kv(&text, k, v); }
        }
        fs::write(&video, text).map_err(|e| e.to_string())?;
        if let Some(c) = contrast.filter(|c| c == "0" || c == "1") {
            let mc = dir.join("cs2_machine_convars.vcfg");
            if let Ok(b) = fs::read(&mc) {
                let t = String::from_utf8_lossy(&b).into_owned();
                let cbak = backup_of(&mc);
                if !cbak.exists() { let _ = fs::copy(&mc, &cbak); }
                fs::write(&mc, set_kv(&t, CONTRAST, &c)).map_err(|e| e.to_string())?;
            }
        }
        read(account)
    }).await.map_err(|e| e.to_string())?
}

// «Вернуть мои»: копии на место, копии удаляются
#[tauri::command]
pub async fn fps_video_restore(account: String) -> Result<Video, String> {
    safe_account(&account)?;
    tauri::async_runtime::spawn_blocking(move || {
        if crate::render::process_running("cs2.exe") { return Err("закрой CS2: при выходе она перезапишет настройки".to_string()); }
        let dir = cfg_dir(&account);
        for f in ["cs2_video.txt", "cs2_machine_convars.vcfg"] {
            let p = dir.join(f);
            let bak = backup_of(&p);
            if bak.exists() {
                fs::copy(&bak, &p).map_err(|e| e.to_string())?;
                let _ = fs::remove_file(&bak);
            }
        }
        read(account)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_and_inserts_values() {
        let t = "\"video.cfg\"\r\n{\r\n\t\"setting.msaa_samples\"\t\t\"4\"\r\n}\r\n";
        let t = set_kv(t, "setting.msaa_samples", "0");
        let t = set_kv(&t, "setting.videocfg_parallax_detail", "0");
        assert_eq!(t, "\"video.cfg\"\r\n{\r\n\t\"setting.msaa_samples\"\t\t\"0\"\r\n\t\"setting.videocfg_parallax_detail\"\t\t\"0\"\r\n}\r\n");
        let m = kv(&t);
        assert_eq!(m.get("setting.msaa_samples").map(String::as_str), Some("0"));
        assert!(!m.contains_key("video.cfg"));
    }
}
