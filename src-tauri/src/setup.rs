// Мастер первого запуска (src/features/setup): сам находит CS2 во всех библиотеках Steam
// и проверяет, что HLAE на месте, а в папку хайлайтов можно писать и на диске есть место.
use std::path::{Path, PathBuf};
use serde::Serialize;

const CS2_REL: &str = r"steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe";

#[derive(Serialize)]
pub struct SetupScan {
    // путь к cs2.exe: указанный, если он есть, иначе найденный в библиотеках Steam
    cs2: Option<String>,
    steam: bool,
    hlae: bool,
    out_ok: bool,
    free_gb: Option<f64>,
}

// Папки библиотек Steam: сама папка Steam и все "path" из steamapps\libraryfolders.vdf
fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut v = vec![root.to_path_buf()];
    let vdf = std::fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")).unwrap_or_default();
    for line in vdf.lines() {
        let l = line.trim();
        if !l.starts_with("\"path\"") { continue; }
        // "path"		"D:\\SteamLibrary"
        let parts: Vec<&str> = l.split('"').filter(|s| !s.trim().is_empty()).collect();
        if let Some(p) = parts.get(1) {
            let p = PathBuf::from(p.replace("\\\\", "\\"));
            if !v.contains(&p) { v.push(p); }
        }
    }
    v
}

fn find_cs2() -> Option<String> {
    let root = PathBuf::from(crate::gallery::steam_root().replace('/', "\\"));
    let mut libs = libraries(&root);
    // запасные места, если Steam стоит не там, где говорит реестр
    for d in ['C', 'D', 'E', 'F'] {
        libs.push(PathBuf::from(format!(r"{d}:\Program Files (x86)\Steam")));
        libs.push(PathBuf::from(format!(r"{d}:\SteamLibrary")));
        libs.push(PathBuf::from(format!(r"{d}:\Steam")));
    }
    libs.iter().map(|l| l.join(CS2_REL)).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn setup_scan(cs2: String, hlae: String, out: String) -> SetupScan {
    tauri::async_runtime::spawn_blocking(move || {
        let cs2 = if !cs2.is_empty() && Path::new(&cs2).is_file() { Some(cs2) } else { find_cs2() };
        let steam_root = crate::gallery::steam_root();
        let out_path = PathBuf::from(&out);
        let out_ok = !out.trim().is_empty() && crate::preflight::writable(&out_path);
        SetupScan {
            cs2,
            steam: Path::new(&steam_root).join("steam.exe").is_file(),
            hlae: !hlae.is_empty() && Path::new(&hlae).is_file(),
            out_ok,
            free_gb: crate::preflight::free_bytes(&out_path).map(|b| (b as f64 / 1024f64.powi(3) * 10.0).round() / 10.0),
        }
    }).await.unwrap_or(SetupScan { cs2: None, steam: false, hlae: false, out_ok: false, free_gb: None })
}
