// Пресет Cinematic RTX (вкладка «Эдит»): запись демки через ReShade с аддоном HLAE (ReShade_advancedfx) —
// эффекты по буферу глубины игры: непрямой свет и тени по углам (MXAO с IL), отражения (SSR),
// свечение (Bloom), цветокор (Lightroom), резкость. Похоже на трассировку лучей, но это экранные эффекты.
//
// В папку игры ничего не кладётся: всё лежит в %LOCALAPPDATA%\clipforge\reshade, а HLAE подгружает
// ReShade в CS2 вторым DLL (после AfxHookSource2.dll), только на время записи. Обычная игра идёт без него.
//
// Скачивается один раз: ReShade (сборка с аддонами — только она загружает аддоны), ReShade_advancedfx
// и шейдеры qUINT (бесплатные, github martymcmodding/qUINT). Версии ReShade и аддона — те, что HLAE
// называет проверенными (changelog AfxHookSource2).
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

use crate::ffmpeg::download;

const RESHADE_URL: &str = "https://reshade.me/downloads/ReShade_Setup_6.4.1_Addon.exe";
const ADDON_URL: &str = "https://github.com/advancedfx/ReShade_advancedfx/releases/download/v1.4.1/ReShade_advancedfx_1_4_1.zip";
const SHADERS_URL: &str = "https://codeload.github.com/martymcmodding/qUINT/zip/refs/heads/master";

pub fn own_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("reshade")
}

// ReShade под именем dxgi.dll: по имени модуля он понимает, что надо перехватывать DirectX 11,
// а базовая папка (ReShade.ini, аддоны) — папка самой dll
pub fn dll() -> PathBuf { own_dir().join("dxgi.dll") }

fn shaders_dir() -> PathBuf { own_dir().join("reshade-shaders").join("Shaders") }

fn has_addon(dir: &Path) -> bool {
    fs::read_dir(dir).map(|rd| rd.flatten().any(|e| {
        let n = e.file_name().to_string_lossy().to_lowercase();
        n.ends_with(".addon") || n.ends_with(".addon64")
    })).unwrap_or(false)
}

fn ready() -> bool {
    dll().exists() && has_addon(&own_dir()) && shaders_dir().join("qUINT_mxao.fx").exists()
}

// ---- zip без внешних программ: установщик ReShade — exe с zip в конце, tar его не всегда берёт ----

struct Entry { name: String, method: u16, comp: usize, local: usize }

fn u16le(d: &[u8], i: usize) -> usize { u16::from_le_bytes([d[i], d[i + 1]]) as usize }
fn u32le(d: &[u8], i: usize) -> usize { u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]) as usize }

fn zip_entries(d: &[u8]) -> Result<Vec<Entry>, String> {
    if d.len() < 22 { return Err("пустой архив".into()); }
    // конец центрального каталога ищем с конца (за ним могут быть комментарий и подпись exe)
    let min = d.len().saturating_sub(1 << 20);
    let eocd = (min..=d.len() - 22).rev().find(|&i| &d[i..i + 4] == b"PK\x05\x06").ok_or("это не zip")?;
    let n = u16le(d, eocd + 10);
    let cd_size = u32le(d, eocd + 12);
    let cd_off = u32le(d, eocd + 16);
    // у zip внутри exe все смещения сдвинуты на длину самого exe
    let cd_start = eocd.checked_sub(cd_size).ok_or("битый zip")?;
    let shift = cd_start.saturating_sub(cd_off);
    let mut p = cd_start;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if p + 46 > d.len() || &d[p..p + 4] != b"PK\x01\x02" { return Err("битый каталог zip".into()); }
        let (nl, el, cl) = (u16le(d, p + 28), u16le(d, p + 30), u16le(d, p + 32));
        out.push(Entry {
            name: String::from_utf8_lossy(&d[p + 46..(p + 46 + nl).min(d.len())]).replace('\\', "/"),
            method: u16le(d, p + 10) as u16,
            comp: u32le(d, p + 20),
            local: u32le(d, p + 42) + shift,
        });
        p += 46 + nl + el + cl;
    }
    Ok(out)
}

fn zip_read(d: &[u8], e: &Entry) -> Result<Vec<u8>, String> {
    let l = e.local;
    if l + 30 > d.len() || &d[l..l + 4] != b"PK\x03\x04" { return Err(format!("битый zip: {}", e.name)); }
    let start = l + 30 + u16le(d, l + 26) + u16le(d, l + 28);
    let raw = d.get(start..start + e.comp).ok_or_else(|| format!("битый zip: {}", e.name))?;
    match e.method {
        0 => Ok(raw.to_vec()),
        8 => {
            let mut v = Vec::new();
            flate2::read::DeflateDecoder::new(raw).read_to_end(&mut v).map_err(|er| er.to_string())?;
            Ok(v)
        }
        m => Err(format!("сжатие {m} в zip не поддерживается ({})", e.name)),
    }
}

fn file_name(entry: &str) -> &str { entry.rsplit('/').next().unwrap_or(entry) }

// ---- установка ----

fn fetch(tmp: &Path, url: &str, name: &str, on: &dyn Fn(f64, f64)) -> Result<Vec<u8>, String> {
    let f = tmp.join(name);
    download(url, &f, on).map_err(|e| format!("не удалось скачать {name}: {e}"))?;
    fs::read(&f).map_err(|e| e.to_string())
}

fn install(app: &AppHandle) -> Result<(), String> {
    let dir = own_dir();
    let tmp = dir.with_file_name("reshade_download");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let step = |label: &'static str| move |done: f64, total: f64| { let _ = app.emit("reshade-progress", (label, done, total)); };

    // 1. ReShade: ReShade64.dll из установщика → dxgi.dll
    let setup = fetch(&tmp, RESHADE_URL, "reshade_setup.exe", &step("ReShade"))?;
    let ents = zip_entries(&setup).map_err(|e| format!("установщик ReShade: {e}"))?;
    let e = ents.iter().find(|e| file_name(&e.name).eq_ignore_ascii_case("ReShade64.dll")).ok_or("в установщике ReShade нет ReShade64.dll")?;
    fs::write(dll(), zip_read(&setup, e)?).map_err(|e| e.to_string())?;

    // 2. аддон HLAE: 64-битный .addon из папки x64
    let zip = fetch(&tmp, ADDON_URL, "advancedfx.zip", &step("ReShade_advancedfx"))?;
    let ents = zip_entries(&zip)?;
    let is_addon = |e: &&Entry| { let n = e.name.to_lowercase(); n.ends_with(".addon") || n.ends_with(".addon64") };
    let e = ents.iter().filter(is_addon).find(|e| e.name.to_lowercase().contains("x64"))
        .or_else(|| ents.iter().find(|e| e.name.to_lowercase().ends_with(".addon64")))
        .ok_or("в архиве ReShade_advancedfx нет аддона для x64")?;
    fs::write(dir.join(file_name(&e.name)), zip_read(&zip, e)?).map_err(|e| e.to_string())?;

    // 3. шейдеры qUINT
    let zip = fetch(&tmp, SHADERS_URL, "quint.zip", &step("qUINT"))?;
    let tex = own_dir().join("reshade-shaders").join("Textures");
    fs::create_dir_all(shaders_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&tex).map_err(|e| e.to_string())?;
    for e in zip_entries(&zip)? {
        let name = file_name(&e.name);
        if name.is_empty() { continue; }
        let to = if e.name.contains("/Shaders/") { shaders_dir() } else if e.name.contains("/Textures/") { tex.clone() } else { continue };
        fs::write(to.join(name), zip_read(&zip, &e)?).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(&tmp);
    if !ready() { return Err("ReShade скачан не полностью, попробуй еще раз".into()); }
    Ok(())
}

// ---- настройки ----

// ReShade.ini: шейдеры и пресет из своей папки, глубина — от аддона HLAE (встроенный Generic Depth
// выключен), значения глубины — как в вики ReShade_advancedfx. Оверлей ReShade ничего не рисует.
fn write_config(ultra: bool) -> Result<(), String> {
    let dir = own_dir();
    let d = dir.to_string_lossy();
    let preset = if ultra { "clipforge_ultra.ini" } else { "clipforge_cinematic.ini" };
    let ini = format!(
        "[ADDON]\r\nDisabledAddons=Generic Depth\r\n\r\n\
         [GENERAL]\r\nEffectSearchPaths={d}\\reshade-shaders\\Shaders\\**\r\nTextureSearchPaths={d}\\reshade-shaders\\Textures\\**\r\n\
         IntermediateCachePath={d}\\cache\r\nPresetPath={d}\\{preset}\r\n\
         PerformanceMode=1\r\nSkipLoadingDisabledEffects=1\r\nNoReloadOnInit=0\r\n\
         PreprocessorDefinitions=RESHADE_DEPTH_INPUT_IS_REVERSED=0,RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=255,RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=0,RESHADE_DEPTH_INPUT_IS_LOGARITHMIC=0\r\n\r\n\
         [OVERLAY]\r\nTutorialProgress=4\r\nShowFPS=0\r\nShowClock=0\r\nShowFrameTime=0\r\nShowPresetName=0\r\nShowPresetTransitionMessage=0\r\nShowScreenshotMessage=0\r\n"
    );
    fs::create_dir_all(dir.join("cache")).map_err(|e| e.to_string())?;
    fs::write(dir.join("ReShade.ini"), ini).map_err(|e| e.to_string())?;
    fs::write(dir.join("clipforge_cinematic.ini"), PRESET.replace('\n', "\r\n")).map_err(|e| e.to_string())?;
    fs::write(dir.join("clipforge_ultra.ini"), ULTRA.replace('\n', "\r\n")).map_err(|e| e.to_string())
}

// «Кино»: мягкие тени по углам и цветной отражённый свет от стен (как глобальное освещение RTX),
// отражения на полу и стёклах, тёплое свечение светлых мест, контраст, чуть тёплый цвет, виньетка
const PRESET: &str = "\
Techniques=MXAO@qUINT_mxao.fx,SSR@qUINT_ssr.fx,Bloom@qUINT_bloom.fx,Lightroom@qUINT_lightroom.fx,DELC_Sharpen@qUINT_sharp.fx
TechniqueSorting=MXAO@qUINT_mxao.fx,SSR@qUINT_ssr.fx,Bloom@qUINT_bloom.fx,Lightroom@qUINT_lightroom.fx,DELC_Sharpen@qUINT_sharp.fx

[qUINT_mxao.fx]
PreprocessorDefinitions=MXAO_ENABLE_IL=1,MXAO_SMOOTHNORMALS=1,MXAO_MIPLEVEL_IL=1
MXAO_GLOBAL_SAMPLE_QUALITY_PRESET=4
MXAO_SAMPLE_RADIUS=3.0
MXAO_GLOBAL_RENDER_SCALE=1.0
MXAO_SSAO_AMOUNT=1.35
MXAO_SSIL_AMOUNT=1.8
MXAO_SSIL_SATURATION=1.3
MXAO_BLEND_TYPE=0
MXAO_FADE_DEPTH_START=0.1
MXAO_FADE_DEPTH_END=0.6

[qUINT_ssr.fx]
SSR_FIELD_OF_VIEW=60.0
SSR_REFLECTION_INTENSITY=0.65
SSR_FRESNEL_EXP=4.0
SSR_FADE_DIST=0.6
SSR_RAY_INC=1.6
SSR_ACCEPT_RANGE=2.5
SSR_JITTER_AMOUNT=0.25
SSR_FILTER_SIZE=0.8
SSR_RELIEF_AMOUNT=0.05
SSR_RELIEF_SCALE=0.35

[qUINT_bloom.fx]
BLOOM_INTENSITY=0.9
BLOOM_CURVE=2.2
BLOOM_SAT=1.2
BLOOM_DIRT=0.0
BLOOM_LAYER_MULT_1=0.05
BLOOM_LAYER_MULT_2=0.05
BLOOM_LAYER_MULT_3=0.1
BLOOM_LAYER_MULT_4=0.2
BLOOM_LAYER_MULT_5=0.5
BLOOM_LAYER_MULT_6=0.2
BLOOM_LAYER_MULT_7=0.05
BLOOM_ADAPT_STRENGTH=0.4
BLOOM_ADAPT_EXPOSURE=0.0
BLOOM_ADAPT_SPEED=2.0
BLOOM_ADAPT_MODE=0
BLOOM_TONEMAP_COMPRESSION=3.0

[qUINT_lightroom.fx]
LIGHTROOM_GLOBAL_EXPOSURE=0.0
LIGHTROOM_GLOBAL_GAMMA=0.02
LIGHTROOM_GLOBAL_BLACKS_CURVE=-0.08
LIGHTROOM_GLOBAL_SHADOWS_CURVE=-0.12
LIGHTROOM_GLOBAL_MIDTONES_CURVE=0.0
LIGHTROOM_GLOBAL_HIGHLIGHTS_CURVE=0.08
LIGHTROOM_GLOBAL_WHITES_CURVE=0.05
LIGHTROOM_GLOBAL_CONTRAST=0.18
LIGHTROOM_GLOBAL_SATURATION=-0.05
LIGHTROOM_GLOBAL_VIBRANCE=0.15
LIGHTROOM_GLOBAL_TEMPERATURE=0.08
LIGHTROOM_GLOBAL_TINT=0.0
LIGHTROOM_ENABLE_VIGNETTE=1
LIGHTROOM_VIGNETTE_SHOW_RADII=0
LIGHTROOM_VIGNETTE_OFFS=0.0,0.0
LIGHTROOM_VIGNETTE_RADIUS_INNER=0.35
LIGHTROOM_VIGNETTE_RADIUS_OUTER=1.35
LIGHTROOM_VIGNETTE_AMOUNT=0.35
LIGHTROOM_VIGNETTE_CURVE=1.5

[qUINT_sharp.fx]
SHARP_STRENGTH=0.6
DEPTH_MASK_ENABLE=1
RMS_MASK_ENABLE=1
";

// «Мега-качество»: то же, но без зерна и дымки. Без непрямого света (MXAO IL — главный источник
// крапинок на стенах), только мягкие тени по углам; отражения слабее и без дрожания лучей, с более
// широким сглаживанием; свечение — едва заметное, только на ярком; цвет — контраст и глубокие тени
// без высветления неба. Резкости здесь нет: её даёт сборка уже после уменьшения кадра (render.rs).
const ULTRA: &str = "\
Techniques=MXAO@qUINT_mxao.fx,SSR@qUINT_ssr.fx,Bloom@qUINT_bloom.fx,Lightroom@qUINT_lightroom.fx
TechniqueSorting=MXAO@qUINT_mxao.fx,SSR@qUINT_ssr.fx,Bloom@qUINT_bloom.fx,Lightroom@qUINT_lightroom.fx

[qUINT_mxao.fx]
PreprocessorDefinitions=MXAO_ENABLE_IL=0,MXAO_SMOOTHNORMALS=1
MXAO_GLOBAL_SAMPLE_QUALITY_PRESET=4
MXAO_SAMPLE_RADIUS=2.5
MXAO_GLOBAL_RENDER_SCALE=1.0
MXAO_SSAO_AMOUNT=1.0
MXAO_BLEND_TYPE=0
MXAO_FADE_DEPTH_START=0.1
MXAO_FADE_DEPTH_END=0.5

[qUINT_ssr.fx]
SSR_FIELD_OF_VIEW=60.0
SSR_REFLECTION_INTENSITY=0.45
SSR_FRESNEL_EXP=5.0
SSR_FADE_DIST=0.5
SSR_RAY_INC=1.6
SSR_ACCEPT_RANGE=2.0
SSR_JITTER_AMOUNT=0.0
SSR_FILTER_SIZE=1.6
SSR_RELIEF_AMOUNT=0.0
SSR_RELIEF_SCALE=0.35

[qUINT_bloom.fx]
BLOOM_INTENSITY=0.35
BLOOM_CURVE=3.0
BLOOM_SAT=1.0
BLOOM_DIRT=0.0
BLOOM_LAYER_MULT_1=0.05
BLOOM_LAYER_MULT_2=0.05
BLOOM_LAYER_MULT_3=0.08
BLOOM_LAYER_MULT_4=0.12
BLOOM_LAYER_MULT_5=0.2
BLOOM_LAYER_MULT_6=0.1
BLOOM_LAYER_MULT_7=0.03
BLOOM_ADAPT_STRENGTH=0.2
BLOOM_ADAPT_EXPOSURE=0.0
BLOOM_ADAPT_SPEED=2.0
BLOOM_ADAPT_MODE=0
BLOOM_TONEMAP_COMPRESSION=4.0

[qUINT_lightroom.fx]
LIGHTROOM_GLOBAL_EXPOSURE=0.0
LIGHTROOM_GLOBAL_GAMMA=0.0
LIGHTROOM_GLOBAL_BLACKS_CURVE=-0.14
LIGHTROOM_GLOBAL_SHADOWS_CURVE=-0.1
LIGHTROOM_GLOBAL_MIDTONES_CURVE=0.0
LIGHTROOM_GLOBAL_HIGHLIGHTS_CURVE=-0.06
LIGHTROOM_GLOBAL_WHITES_CURVE=0.0
LIGHTROOM_GLOBAL_CONTRAST=0.24
LIGHTROOM_GLOBAL_SATURATION=0.0
LIGHTROOM_GLOBAL_VIBRANCE=0.2
LIGHTROOM_GLOBAL_TEMPERATURE=0.04
LIGHTROOM_GLOBAL_TINT=0.0
LIGHTROOM_ENABLE_VIGNETTE=1
LIGHTROOM_VIGNETTE_SHOW_RADII=0
LIGHTROOM_VIGNETTE_OFFS=0.0,0.0
LIGHTROOM_VIGNETTE_RADIUS_INNER=0.4
LIGHTROOM_VIGNETTE_RADIUS_OUTER=1.4
LIGHTROOM_VIGNETTE_AMOUNT=0.25
LIGHTROOM_VIGNETTE_CURVE=1.5
";

// ---- MSAA: аддону HLAE нужна глубина без сглаживания MSAA (вики ReShade_advancedfx) ----
// На время записи в cs2_video.txt всех аккаунтов MSAA выключается (вместо него — CMAA2),
// старый файл лежит рядом (.clipforge) и возвращается после записи или при следующем запуске программы.

const BACKUP_EXT: &str = "txt.clipforge";

fn video_cfgs() -> Vec<PathBuf> {
    let root = Path::new(&crate::gallery::steam_root()).join("userdata");
    fs::read_dir(root).map(|rd| rd.flatten()
        .map(|e| e.path().join("730").join("local").join("cfg").join("cs2_video.txt"))
        .filter(|p| p.exists()).collect()).unwrap_or_default()
}

fn msaa_on(text: &str) -> bool {
    text.lines().any(|l| {
        let t = l.trim();
        t.starts_with("\"setting.msaa_samples\"") && !t.trim_end_matches('"').ends_with("\"0")
    })
}

fn set_setting(text: &str, key: &str, val: &str) -> String {
    let q = format!("\"{key}\"");
    text.split('\n').map(|l| {
        if l.trim().starts_with(&q) {
            let cr = if l.ends_with('\r') { "\r" } else { "" };
            let indent: String = l.chars().take_while(|c| c.is_whitespace()).collect();
            format!("{indent}{q}\t\t\"{val}\"{cr}")
        } else { l.to_string() }
    }).collect::<Vec<_>>().join("\n")
}

fn msaa_off() {
    for p in video_cfgs() {
        let Ok(text) = fs::read_to_string(&p) else { continue };
        if !msaa_on(&text) { continue; }
        let bak = p.with_extension(BACKUP_EXT);
        if !bak.exists() && fs::copy(&p, &bak).is_err() { continue; }
        let t = set_setting(&set_setting(&text, "setting.msaa_samples", "0"), "setting.r_csgo_cmaa_enable", "1");
        let _ = fs::write(&p, t);
    }
}

// вернуть настройки видео, если их меняла запись (вызывается после рендера и при старте программы)
pub fn restore_video() {
    let root = Path::new(&crate::gallery::steam_root()).join("userdata");
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let bak = e.path().join("730").join("local").join("cfg").join("cs2_video.txt.clipforge");
        if bak.exists() { let _ = fs::rename(&bak, bak.with_extension("txt")); }
    }
}

// перед запуском игры: всё на месте, настройки записаны, MSAA выключен
pub fn prepare(ultra: bool) -> Result<PathBuf, String> {
    if !ready() { return Err("ReShade для пресета Cinematic еще не скачан".into()); }
    write_config(ultra)?;
    msaa_off();
    Ok(dll())
}

#[derive(Serialize)]
pub struct ReshadeStatus { ready: bool, msaa: bool }

#[tauri::command]
pub fn reshade_status() -> ReshadeStatus {
    let msaa = video_cfgs().iter().any(|p| fs::read_to_string(p).map(|t| msaa_on(&t)).unwrap_or(false));
    ReshadeStatus { ready: ready(), msaa }
}

// Есть ReShade со всем нужным — сразу Ok; нет — скачивает (прогресс — событие reshade-progress:
// [что качается, МБ, всего МБ])
#[tauri::command]
pub async fn ensure_reshade(app: AppHandle) -> Result<(), String> {
    if ready() { return Ok(()); }
    tauri::async_runtime::spawn_blocking(move || install(&app)).await.map_err(|e| e.to_string())?
}
