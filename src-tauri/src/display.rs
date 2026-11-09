// «Мега-качество»: CS2 не рисует кадр больше рабочего стола — окно крупнее экрана Windows ужимает,
// а игра тогда откатывается к разрешению экрана. Поэтому на время записи экран переключается в
// режим побольше (его дают AMD VSR / NVIDIA DSR: «виртуальные» разрешения больше родного), а после
// записи возвращается обратно.
//
// Режим меняется динамически, без записи в реестр (dwflags = 0): даже после перезагрузки или вылета
// Windows вернётся к обычному. Ещё и метка-файл: если программа упала посреди записи, при следующем
// запуске разрешение возвращается сразу (как настройки видео CS2 в reshade.rs).
use std::{fs, path::PathBuf};

use serde::Serialize;

use windows_sys::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplaySettingsW, DEVMODEW, DISP_CHANGE_SUCCESSFUL, DM_PELSHEIGHT, DM_PELSWIDTH,
    ENUM_CURRENT_SETTINGS,
};

// запас под рамку и заголовок окна игры (она запускается в окне -windowed)
const PAD_W: u32 = 32;
const PAD_H: u32 = 80;

fn marker() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("display_raised")
}

fn devmode() -> DEVMODEW {
    let mut dm: DEVMODEW = unsafe { std::mem::zeroed() };
    dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    dm
}

// разрешение основного экрана сейчас
pub fn current() -> Option<(u32, u32)> {
    let mut dm = devmode();
    let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm) } != 0;
    ok.then_some((dm.dmPelsWidth, dm.dmPelsHeight))
}

// все режимы основного экрана (с VSR/DSR — и больше родного)
fn modes() -> Vec<(u32, u32)> {
    let mut v = Vec::new();
    let mut dm = devmode();
    let mut i = 0;
    while unsafe { EnumDisplaySettingsW(std::ptr::null(), i, &mut dm) } != 0 {
        if !v.contains(&(dm.dmPelsWidth, dm.dmPelsHeight)) { v.push((dm.dmPelsWidth, dm.dmPelsHeight)); }
        i += 1;
    }
    v
}

fn fits((sw, sh): (u32, u32), w: u32, h: u32) -> bool {
    sw >= w + PAD_W && sh >= h + PAD_H
}

// самый маленький режим, в который влезает окно игры w×h с рамкой
pub fn pick(modes: &[(u32, u32)], w: u32, h: u32) -> Option<(u32, u32)> {
    modes.iter().copied().filter(|&m| fits(m, w, h)).min_by_key(|&(a, b)| a as u64 * b as u64)
}

// Влезет ли окно игры w×h: в текущий экран или в режим, на который его можно переключить
pub fn can_fit(w: u32, h: u32) -> bool {
    current().is_some_and(|c| fits(c, w, h)) || pick(&modes(), w, h).is_some()
}

// Поднять разрешение экрана под окно игры w×h. Ok(None) — экран и так большой, Ok(Some) — во что
// переключили, Err — подходящего режима нет (VSR/DSR выключен) или драйвер отказал.
pub fn raise_for(w: u32, h: u32) -> Result<Option<(u32, u32)>, String> {
    if current().is_some_and(|c| fits(c, w, h)) { return Ok(None); }
    let (mw, mh) = pick(&modes(), w, h).ok_or("нет режима экрана больше родного (VSR / DSR выключен)")?;
    let mut dm = devmode();
    dm.dmPelsWidth = mw;
    dm.dmPelsHeight = mh;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    let _ = fs::create_dir_all(marker().parent().unwrap_or(&std::env::temp_dir()));
    let _ = fs::write(marker(), format!("{mw}x{mh}"));
    let r = unsafe { ChangeDisplaySettingsExW(std::ptr::null(), &dm, std::ptr::null_mut(), 0, std::ptr::null()) };
    if r != DISP_CHANGE_SUCCESSFUL {
        let _ = fs::remove_file(marker());
        return Err(format!("драйвер не переключил экран в {mw}x{mh} (код {r})"));
    }
    Ok(Some((mw, mh)))
}

// Вернуть обычное разрешение (из реестра), если его поднимали мы
pub fn restore() {
    if !marker().exists() { return; }
    unsafe { ChangeDisplaySettingsExW(std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), 0, std::ptr::null()) };
    let _ = fs::remove_file(marker());
}

// Проверка для панели «Мега-качества»: экран сейчас, во что он переключится под окно игры
// width×height (уже двойной кадр), и чья видеокарта — от неё зависит, где включать VSR / DSR
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UltraCheck {
    screen: Option<(u32, u32)>,
    mode: Option<(u32, u32)>,
    fits_now: bool,
    vendor: &'static str, // "amd" | "nvidia" | "intel" | "other"
    gpu: Option<String>,
}

fn vendor_of(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("rtx") || n.contains("quadro") { "nvidia" }
    else if n.contains("amd") || n.contains("radeon") { "amd" }
    else if n.contains("intel") { "intel" }
    else { "other" }
}

// основная видеокарта: дискретная важнее встроенной Intel и «базового адаптера Microsoft»
fn main_gpu(names: &[String]) -> Option<String> {
    let rank = |n: &String| match vendor_of(n) { "nvidia" | "amd" => 0, "intel" => 1, _ => 2 };
    names.iter().min_by_key(|n| rank(n)).cloned()
}

#[tauri::command]
pub async fn ultra_check(width: u32, height: u32) -> UltraCheck {
    tauri::async_runtime::spawn_blocking(move || {
        let screen = current();
        let fits_now = screen.is_some_and(|c| fits(c, width, height));
        let gpu = main_gpu(&crate::preflight::gpu_names());
        UltraCheck {
            screen,
            mode: if fits_now { None } else { pick(&modes(), width, height) },
            fits_now,
            vendor: gpu.as_deref().map_or("other", vendor_of),
            gpu,
        }
    }).await.unwrap_or(UltraCheck { screen: None, mode: None, fits_now: false, vendor: "other", gpu: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    // только чтение: что видно на этом компьютере (cargo test -- --ignored --nocapture)
    #[test]
    #[ignore]
    fn show_modes_here() {
        println!("current {:?}", current());
        println!("4:3 x2 -> {:?}, 1080p x2 -> {:?}", pick(&modes(), 2560, 1920), pick(&modes(), 3840, 2160));
        println!("can_fit 4:3 {} 1080p {}", can_fit(2560, 1920), can_fit(3840, 2160));
    }

    #[test]
    fn main_gpu_prefers_discrete() {
        let l = vec!["Intel(R) UHD Graphics 770".to_string(), "AMD Radeon RX 9070 GRE".to_string()];
        assert_eq!(main_gpu(&l).as_deref(), Some("AMD Radeon RX 9070 GRE"));
        assert_eq!(vendor_of("NVIDIA GeForce RTX 4070"), "nvidia");
        assert_eq!(vendor_of("Microsoft Basic Display Adapter"), "other");
    }

    #[test]
    fn picks_smallest_mode_that_fits_the_window() {
        let m = [(1920, 1080), (2560, 1440), (3840, 2160), (5120, 2880), (7680, 4320)];
        // 4:3 1280×960 вдвое — 2560×1920: нужен экран выше 1920 с рамкой
        assert_eq!(pick(&m, 2560, 1920), Some((3840, 2160)));
        // 1080p вдвое — 3840×2160: окно с рамкой в 4K-экран не влезает
        assert_eq!(pick(&m, 3840, 2160), Some((5120, 2880)));
        // без VSR — только родной режим
        assert_eq!(pick(&[(1920, 1080)], 2560, 1920), None);
    }
}
