// Вкладка «Хайлайты»: готовые клипы из папки вывода — список, превью-кадры, показ в проводнике, удаление в корзину.
// Сами видео окно читает через asset-протокол, доступ к которому открывается только для папки клипов.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::Manager;

const THUMBS: &str = ".clipforge_thumbs";

#[derive(Serialize)]
pub struct ClipFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64, // мс с 1970
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ClipThumb {
    pub thumb: String,
    pub dur: f64,
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[tauri::command]
pub fn list_clips(app: tauri::AppHandle, out: String) -> Result<Vec<ClipFile>, String> {
    let dir = PathBuf::from(&out);
    if !dir.is_dir() { return Ok(vec![]); }
    // окну можно читать только эту папку (видео и превью), остальной диск закрыт
    app.asset_protocol_scope().allow_directory(&dir, true).map_err(|e| e.to_string())?;
    let mut list: Vec<ClipFile> = fs::read_dir(&dir).map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("mp4")))
        .map(|p| ClipFile {
            name: p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            size: fs::metadata(&p).map_or(0, |m| m.len()),
            modified: mtime(&p),
            path: p.to_string_lossy().to_string(),
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(list)
}

// Превью — кадр за 2.5 с до конца (там обычно финальный фраг) и длительность из вывода ffmpeg.
// Кэшируется рядом с клипами и пересчитывается, если клип новее превью.
#[tauri::command]
pub async fn clip_thumb(hlae: String, path: String) -> Result<ClipThumb, String> {
    let src = PathBuf::from(&path);
    let dir = src.parent().ok_or("нет папки")?.join(THUMBS);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (jpg, meta) = (dir.join(format!("{stem}.jpg")), dir.join(format!("{stem}.json")));
    if jpg.exists() && mtime(&jpg) >= mtime(&src) {
        if let Some(t) = fs::read_to_string(&meta).ok().and_then(|s| serde_json::from_str::<ClipThumb>(&s).ok()) {
            return Ok(t);
        }
    }
    let ff = crate::ffmpeg::find(&hlae).ok_or("не найден ffmpeg")?;
    let mut cmd = Command::new(&ff);
    cmd.args(["-hide_banner", "-y", "-sseof", "-2.5", "-i"]).arg(&src)
        .args(["-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4"]).arg(&jpg);
    crate::render::no_window(&mut cmd);
    let o = cmd.output().map_err(|e| e.to_string())?;
    let log = String::from_utf8_lossy(&o.stderr);
    let dur = log.split("Duration: ").nth(1).and_then(|s| s.split(',').next())
        .map(|t| t.trim().split(':').filter_map(|x| x.parse::<f64>().ok()).fold(0.0, |acc, x| acc * 60.0 + x))
        .unwrap_or(0.0);
    if !jpg.exists() { return Err("ffmpeg не сделал превью".into()); }
    let t = ClipThumb { thumb: jpg.to_string_lossy().to_string(), dur };
    let _ = fs::write(&meta, serde_json::to_string(&t).unwrap_or_default());
    Ok(t)
}

// Открыть проводник с выделенным файлом
#[tauri::command]
pub fn reveal_clip(path: String) -> Result<(), String> {
    Command::new("explorer").arg(format!("/select,{}", path)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Удаление — только в корзину Windows, чтобы клип можно было вернуть
#[tauri::command]
pub fn trash_clip(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() { return Err("файл не найден".into()); }
    let escaped = path.replace('\'', "''");
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command",
        &format!("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')")]);
    crate::render::no_window(&mut cmd);
    let o = cmd.output().map_err(|e| e.to_string())?;
    if p.exists() { return Err(String::from_utf8_lossy(&o.stderr).trim().to_string()); }
    // превью удалённого клипа больше не нужно
    if let (Some(dir), Some(stem)) = (p.parent(), p.file_stem()) {
        let stem = stem.to_string_lossy();
        let _ = fs::remove_file(dir.join(THUMBS).join(format!("{stem}.jpg")));
        let _ = fs::remove_file(dir.join(THUMBS).join(format!("{stem}.json")));
    }
    Ok(())
}

// Матчи, скачанные в CS2 («Смотреть» → «Ваши матчи»): игра кладет их в game\csgo\replays
#[derive(Serialize)]
pub struct Replay {
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub map: String,
}

// Карта есть в заголовке демки (первые байты, protobuf): ищем «de_…», «cs_…», «ar_…»,
// длина строки — в байте перед ней (сразу за строкой может идти байт, похожий на букву)
fn demo_map(p: &Path) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; 4096];
    let n = fs::File::open(p).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    let s = &buf[..n];
    for i in 1..s.len().saturating_sub(4) {
        if [b"de_", b"cs_", b"ar_"].iter().any(|pre| s[i..].starts_with(*pre)) {
            let len = s[i - 1] as usize;
            if (4..=48).contains(&len) && i + len <= s.len()
                && s[i..i + len].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_') {
                return String::from_utf8_lossy(&s[i..i + len]).into_owned();
            }
        }
    }
    String::new()
}

#[tauri::command]
pub fn list_replays(cs2: String) -> Vec<Replay> {
    // cs2.exe лежит в game\bin\win64 — поднимаемся до game\
    let Some(game) = Path::new(&cs2).ancestors().nth(3) else { return vec![] };
    let Ok(rd) = fs::read_dir(game.join("csgo").join("replays")) else { return vec![] };
    let mut v: Vec<Replay> = rd.flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("dem")))
        .map(|p| Replay {
            size: fs::metadata(&p).map_or(0, |m| m.len()),
            modified: mtime(&p),
            map: demo_map(&p),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    v.sort_by(|a, b| b.modified.cmp(&a.modified));
    v
}

#[tauri::command]
pub fn open_replays(cs2: String) -> Result<(), String> {
    let dir = Path::new(&cs2).ancestors().nth(3).ok_or("нет пути к CS2")?.join("csgo").join("replays");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Command::new("explorer").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Карта демки по заголовку (без полного разбора) — для архива при добавлении пачки демок
#[tauri::command]
pub fn demo_header(path: String) -> String {
    demo_map(Path::new(&path))
}

// Аккаунты Steam этого компа (SteamID64): сначала тот, что сейчас запущен (реестр ActiveUser),
// потом остальные из loginusers.vdf. По ним «Эдит» узнаёт, кто ты, среди игроков демок — в пати
// с другом общих игроков несколько, и «у кого больше киллов» брал не того.
#[tauri::command]
pub fn steam_users() -> Vec<String> {
    let reg = |key: &str, val: &str| -> Option<String> {
        let mut cmd = Command::new("reg");
        cmd.args(["query", key, "/v", val]);
        crate::render::no_window(&mut cmd);
        let out = String::from_utf8_lossy(&cmd.output().ok()?.stdout).to_string();
        out.lines().find(|l| l.contains(val))?.split_whitespace().last().map(str::to_string)
    };
    let mut ids: Vec<String> = Vec::new();
    if let Some(hex) = reg(r"HKCU\Software\Valve\Steam\ActiveProcess", "ActiveUser") {
        if let Ok(acc) = u64::from_str_radix(hex.trim_start_matches("0x"), 16) {
            if acc > 0 { ids.push((76561197960265728u64 + acc).to_string()); }
        }
    }
    let root = reg(r"HKCU\Software\Valve\Steam", "SteamPath").unwrap_or_else(|| r"C:\Program Files (x86)\Steam".into());
    if let Ok(vdf) = fs::read_to_string(Path::new(&root).join("config").join("loginusers.vdf")) {
        for l in vdf.lines() {
            let t = l.trim().trim_matches('"');
            if t.len() == 17 && t.starts_with("7656") && t.chars().all(|c| c.is_ascii_digit()) && !ids.iter().any(|x| x == t) {
                ids.push(t.to_string());
            }
        }
    }
    ids
}
