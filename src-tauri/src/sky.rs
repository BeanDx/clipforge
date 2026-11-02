// Звёздное небо для ночного интро (пресет Night) — настоящий скайбокс CS2, а не подмена поверх видео.
// HLAE подменяет материал неба командой mirv_sky material; сам материал (.vmat_c + .vtex_c) лежит
// в game\csgo\materials\clipforge — CS2 читает оттуда файлы напрямую (папка HLAE в Program Files
// без прав администратора недоступна для записи).
// С Workshop Tools небо собирается под каждое интро (луна там, куда смотрит камера), без них —
// готовое небо из ресурсов программы.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::render::no_window;

static SKY_DIR: OnceLock<PathBuf> = OnceLock::new();

// папка sky в ресурсах установленной программы (lib.rs); без неё — src-tauri/sky из исходников
pub fn set_sky_dir(dir: PathBuf) {
    let _ = SKY_DIR.set(dir);
}

fn bundled() -> PathBuf {
    SKY_DIR.get().filter(|d| d.exists()).cloned()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("sky"))
}

pub const SKY_MATERIAL: &str = "materials/clipforge/night_sky.vmat_c";

const VMAT: &str = "// clipforge: звёздное небо для ночного интро (mirv_sky material)
Layer0
{
\tshader \"sky.vfx\"
\tF_TEXTURE_FORMAT2 3
\tg_flBrightnessExposureBias \"0.000\"
\tg_flRenderOnlyExposureBias \"0.000\"
\tg_vTint \"[1.000000 1.000000 1.000000 0.000000]\"
\tSkyTexture \"materials/clipforge/night_sky.png\"
}
";

// скомпилированные файлы неба из папки from (vmat_c и самая свежая текстура) — в папку игры
fn copy_sky(from: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let tex = fs::read_dir(from).map_err(|e| e.to_string())?.flatten().map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| { let n = n.to_string_lossy(); n.starts_with("night_sky_png_") && n.ends_with(".vtex_c") }))
        .max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
        .ok_or("нет текстуры неба")?;
    // старые текстуры неба (имя меняется с каждой сборкой) — убираем
    if let Ok(rd) = fs::read_dir(dst) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("night_sky_png_") { let _ = fs::remove_file(e.path()); }
        }
    }
    fs::copy(from.join("night_sky.vmat_c"), dst.join("night_sky.vmat_c")).map_err(|e| e.to_string())?;
    fs::copy(&tex, dst.join(tex.file_name().unwrap_or_default())).map_err(|e| e.to_string())?;
    Ok(())
}

// Ставит небо в игру. png — панорама 2:1 с луной под это интро (src/nightfx.js buildSkyEquirect).
// Возвращает true, если небо собрано из неё (есть Workshop Tools), false — поставлено готовое.
#[tauri::command]
pub fn install_sky(cs2: String, png: Option<String>) -> Result<bool, String> {
    let game = Path::new(&cs2).ancestors().nth(3).ok_or("неверный путь к cs2.exe")?.to_path_buf();
    let root = game.parent().ok_or("неверный путь к CS2")?.to_path_buf();
    let dst = game.join("csgo").join("materials").join("clipforge");
    let rc = game.join("bin").join("win64").join("resourcecompiler.exe");
    if let (true, Some(png)) = (rc.exists(), png.filter(|p| Path::new(p).exists())) {
        let content = root.join("content").join("csgo_addons").join("clipforge_sky").join("materials").join("clipforge");
        let out = game.join("csgo_addons").join("clipforge_sky").join("materials").join("clipforge");
        fs::create_dir_all(&content).map_err(|e| e.to_string())?;
        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        fs::copy(&png, content.join("night_sky.png")).map_err(|e| e.to_string())?;
        fs::write(content.join("night_sky.vmat"), VMAT).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&rc);
        cmd.args(["-f", "-i"]).arg(content.join("night_sky.vmat")).current_dir(rc.parent().unwrap_or(&game));
        no_window(&mut cmd);
        let ok = cmd.output().map(|o| o.status.success()).unwrap_or(false);
        if ok && copy_sky(&out, &dst).is_ok() { return Ok(true); }
    }
    copy_sky(&bundled(), &dst)?;
    Ok(false)
}

