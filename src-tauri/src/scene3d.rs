// 3D-превью клипа: геометрия карты из CS2 пользователя + положения игроков из демки.
// Карту выгружает в glTF открытый Source 2 Viewer (ValveResourceFormat, CLI): сама программа
// ассеты Valve не содержит, всё берётся из установленной игры и кешируется в
// %LOCALAPPDATA%\clipforge\maps3d\<карта>. CLI скачивается один раз в %LOCALAPPDATA%\clipforge\s2v.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::render::no_window;

// Скачивание CLI и выгрузка — по одной за раз: иначе два открытия окна (или двойной запуск эффекта
// в dev-режиме React) качают один и тот же архив одновременно
static BUSY: Mutex<()> = Mutex::new(());

// версия зафиксирована: формат CLI и экспорта меняется между релизами
const S2V_VERSION: &str = "20.1";

fn base() -> PathBuf {
    let b = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    b.join("clipforge")
}

fn cli_dir() -> PathBuf {
    base().join("s2v").join(S2V_VERSION)
}

fn ensure_cli(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = cli_dir();
    let exe = dir.join("Source2Viewer-CLI.exe");
    if exe.is_file() { return Ok(exe); }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join("cli.zip");
    let url = format!("https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/{S2V_VERSION}/cli-windows-x64.zip");
    let on = |done: f64, total: f64| { let _ = app.emit("scene3d-progress", ("download", done, total)); };
    crate::ffmpeg::download(&url, &zip, &on).map_err(|e| format!("не удалось скачать Source 2 Viewer: {e}"))?;
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(&zip).arg("-C").arg(&dir);
    no_window(&mut cmd);
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    let _ = fs::remove_file(&zip);
    if !ok || !exe.is_file() { return Err("не удалось распаковать Source 2 Viewer".into()); }
    Ok(exe)
}

// cs2.exe → game\csgo
fn csgo_dir(cs2: &str) -> Option<PathBuf> {
    let game = Path::new(cs2).parent()?.parent()?.parent()?;
    let d = game.join("csgo");
    d.is_dir().then_some(d)
}

fn safe_map(map: &str) -> Result<String, String> {
    let m = map.trim().to_ascii_lowercase();
    // имя из демки бывает с путём (workshop/123/de_x) — берём последнюю часть
    let m = m.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    if m.is_empty() || !m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("неизвестная карта «{map}»"));
    }
    Ok(m)
}

// world.glb, который выгрузил CLI (без *_physics.glb)
fn find_glb(dir: &Path) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_glb(&p) { return Some(f); }
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("glb"))
            && !p.file_stem().is_some_and(|s| s.to_string_lossy().ends_with("_physics")) {
            return Some(p);
        }
    }
    None
}

// Путь к сжатой карте для превью (выгружает при первом открытии и после обновления карты в игре)
#[tauri::command]
pub async fn scene_map(app: AppHandle, cs2: String, map: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        let map = safe_map(&map)?;
        let csgo = csgo_dir(&cs2).ok_or("не найдена папка CS2 - укажи cs2.exe в настройках")?;
        let vpk = csgo.join("maps").join(format!("{map}.vpk"));
        let meta = fs::metadata(&vpk).map_err(|_| format!("карты {map} нет в установленной CS2 (мастерская и старые карты не поддерживаются)"))?;
        let stamp = format!("{S2V_VERSION}|{}|{:?}", meta.len(), meta.modified().ok());
        let out = base().join("maps3d").join(&map);
        let bin = out.join("map.bin");
        let stamp_file = out.join("stamp.txt");
        let _ = app.asset_protocol_scope().allow_directory(&out, true);
        if bin.is_file() && fs::read_to_string(&stamp_file).ok().as_deref() == Some(stamp.as_str()) {
            return Ok(bin.to_string_lossy().into_owned());
        }
        let exe = ensure_cli(&app)?;
        let _ = app.emit("scene3d-progress", ("export", 0.0, 0.0));
        let _ = fs::remove_dir_all(&out);
        // папка вывода должна существовать заранее: иначе CLI считает -o именем файла
        let raw = out.join("raw");
        fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&exe);
        cmd.arg("-i").arg(&vpk)
            .arg("-f").arg(format!("maps/{map}/world.vwrld_c"))
            .arg("-o").arg(&raw)
            .args(["--gltf_export_format", "glb", "-d"]);
        no_window(&mut cmd);
        let res = cmd.output().map_err(|e| format!("не удалось запустить Source 2 Viewer: {e}"))?;
        let Some(glb) = find_glb(&raw) else {
            let err = String::from_utf8_lossy(&res.stderr);
            let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
            let _ = fs::remove_dir_all(&raw);
            return Err(format!("не удалось выгрузить карту {map}: {}", if tail.is_empty() { "нет файла".into() } else { tail }));
        };
        // glb в сотни МБ сжимаем до позиций и нормалей (scripts/slim-map.cjs), сам glb не храним
        let _ = app.emit("scene3d-progress", ("slim", 0.0, 0.0));
        let slim = crate::render::run_node("slim-map.cjs", &[&glb.to_string_lossy(), &bin.to_string_lossy()]);
        let _ = fs::remove_dir_all(&raw);
        slim.map_err(|e| format!("не удалось подготовить карту {map}: {e}"))?;
        let _ = fs::write(&stamp_file, &stamp);
        let _ = app.asset_protocol_scope().allow_directory(&out, true);
        Ok(bin.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Модель оружия (weapons/models/...vmdl_c из pak01) в glb с текстурами — для вида из глаз.
// Сначала только body_legacy (у HD-версии текстуры в 4 раза тяжелее), нет такой части — целиком.
#[tauri::command]
pub async fn scene_weapon(app: AppHandle, cs2: String, model: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        let ok = model.starts_with("weapons/models/") && model.ends_with(".vmdl_c") && !model.contains("..")
            && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '.'));
        if !ok { return Err(format!("неизвестная модель {model}")); }
        let csgo = csgo_dir(&cs2).ok_or("не найдена папка CS2 - укажи cs2.exe в настройках")?;
        let pak = csgo.join("pak01_dir.vpk");
        let meta = fs::metadata(&pak).map_err(|_| "не найден pak01_dir.vpk в папке CS2".to_string())?;
        let stamp = format!("{S2V_VERSION}|{}|{:?}", meta.len(), meta.modified().ok());
        let name = model.rsplit('/').next().unwrap_or("").trim_end_matches(".vmdl_c").to_string();
        let out = base().join("weapons3d").join(&name);
        let stamp_file = out.join("stamp.txt");
        let _ = app.asset_protocol_scope().allow_directory(&out, true);
        if let Some(g) = find_glb(&out)
            && fs::read_to_string(&stamp_file).ok().as_deref() == Some(stamp.as_str()) {
            return Ok(g.to_string_lossy().into_owned());
        }
        let exe = ensure_cli(&app)?;
        for legacy in [true, false] {
            let _ = fs::remove_dir_all(&out);
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let mut cmd = Command::new(&exe);
            cmd.arg("-i").arg(&pak).arg("-f").arg(&model).arg("-o").arg(&out)
                .args(["--gltf_export_format", "glb", "--gltf_export_materials", "--gltf_textures_adapt", "-d"]);
            if legacy { cmd.args(["--gltf_mesh_list", "body_legacy"]); }
            no_window(&mut cmd);
            cmd.output().map_err(|e| format!("не удалось запустить Source 2 Viewer: {e}"))?;
            // без нужной части CLI пишет пустой glb в пару килобайт
            if let Some(g) = find_glb(&out) && fs::metadata(&g).map(|m| m.len() > 20_000).unwrap_or(false) {
                let _ = fs::write(&stamp_file, &stamp);
                let _ = app.asset_protocol_scope().allow_directory(&out, true);
                return Ok(g.to_string_lossy().into_owned());
            }
        }
        let _ = fs::remove_dir_all(&out);
        Err(format!("не удалось выгрузить модель {name}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Иконки киллфида из игры (SVG оружия и значки хедшота, прострела и т. п.) — папка, в которой лежат
// panorama/images/icons/equipment/*.svg и panorama/images/hud/deathnotice/*.svg
#[tauri::command]
pub async fn scene_icons(app: AppHandle, cs2: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        let csgo = csgo_dir(&cs2).ok_or("не найдена папка CS2 - укажи cs2.exe в настройках")?;
        let pak = csgo.join("pak01_dir.vpk");
        let meta = fs::metadata(&pak).map_err(|_| "не найден pak01_dir.vpk в папке CS2".to_string())?;
        let stamp = format!("{S2V_VERSION}|{}|{:?}", meta.len(), meta.modified().ok());
        let out = base().join("icons3d");
        let stamp_file = out.join("stamp.txt");
        let _ = app.asset_protocol_scope().allow_directory(&out, true);
        let probe = out.join("panorama").join("images").join("icons").join("equipment");
        if probe.is_dir() && fs::read_to_string(&stamp_file).ok().as_deref() == Some(stamp.as_str()) {
            return Ok(out.to_string_lossy().into_owned());
        }
        let exe = ensure_cli(&app)?;
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&exe);
        cmd.arg("-i").arg(&pak)
            .args(["-f", "panorama/images/icons/equipment/,panorama/images/hud/deathnotice/", "-e", "vsvg_c", "-d"])
            .arg("-o").arg(&out);
        no_window(&mut cmd);
        cmd.output().map_err(|e| format!("не удалось запустить Source 2 Viewer: {e}"))?;
        if !probe.is_dir() { return Err("не удалось выгрузить иконки киллфида".into()); }
        let _ = fs::write(&stamp_file, &stamp);
        let _ = app.asset_protocol_scope().allow_directory(&out, true);
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Все игроки по тикам [start, end] (scripts/scene.cjs)
#[tauri::command]
pub async fn scene_players(path: String, start: i64, end: i64, steamid: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::render::run_node("scene.cjs", &[&path, &start.to_string(), &end.to_string(), &steamid]))
        .await
        .map_err(|e| e.to_string())?
}
