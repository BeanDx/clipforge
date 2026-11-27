// Оптимизатор FPS: железо (память, процессор) и настройки Windows, которые влияют на CS2.
// Чинит только то, что пишется в HKCU и powercfg (без прав администратора). HAGS и частота экрана
// открывают нужную страницу «Параметров» — там Windows сама спросит и перезагрузку, и подтверждение.
use std::process::Command;

use serde::Serialize;
use windows_sys::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS};

use crate::gallery::reg;
use crate::render::no_window;

const GAMEBAR: &str = r"HKCU\Software\Microsoft\GameBar";
const GAMEDVR: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR";
const GAMECFG: &str = r"HKCU\System\GameConfigStore";
const GPUPREF: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";
const HAGS: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers";

// схемы питания Windows (GUID одинаковые на всех языках)
const PLAN_SAVER: &str = "a1841308-3541-4fab-bc81-f71556f20b4a";
const PLAN_BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";
const PLAN_HIGH: &str = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
const PLAN_ULTIMATE: &str = "e9a42b02-d5df-448d-aa00-03f14749eb61";

#[derive(Serialize)]
pub struct Plan {
    guid: String,
    name: String,
    // "saver" | "balanced" | "high" | "ultimate" | "custom"
    kind: &'static str,
}

#[derive(Serialize)]
pub struct FpsCheck {
    plans: Vec<Plan>,
    active_plan: String,
    battery: bool,
    // None — значения нет (в Windows 11 по умолчанию игровой режим включён)
    game_mode: Option<u32>,
    // AppCaptureEnabled: запись через Xbox Game Bar; HistoricalCaptureEnabled: фоновая запись последних минут
    capture: Option<u32>,
    background_capture: Option<u32>,
    // HwSchMode: 2 — включено, 1 — выключено, None — видеокарта/драйвер не поддерживают
    hags: Option<u32>,
    hz: u32,
    max_hz: u32,
    resolution: (u32, u32),
    gpus: Vec<String>,
    // GpuPreference для cs2.exe: 0 — решает Windows, 1 — энергосбережение, 2 — производительная
    gpu_pref: Option<u32>,
    ram: Ram,
    cpu: String,
}

#[derive(Serialize, Default)]
pub struct Module {
    gb: u32,
    // частота по SPD без разгона (JEDEC) и та, на которой планка работает сейчас
    speed: u32,
    configured: u32,
    // частота из маркировки планки (XMP/EXPO), если её удалось прочитать
    rated: Option<u32>,
    part: String,
    maker: String,
    channel: String,
}

#[derive(Serialize, Default)]
pub struct Ram {
    modules: Vec<Module>,
    // "DDR4" | "DDR5" | ""
    kind: String,
    // None — не понять по подписям слотов
    dual_channel: Option<bool>,
}

// Частота из маркировки: «F5-6000J3038F16G» (G.Skill), «CMK32GX5M2B6000C36» (Corsair),
// «CP16G60C36U5W» / «BL16G32C16U4B» (Crucial: 60 → 6000), «KF560C36-16» (Kingston: 5 — DDR5, 60 → 6000)
pub(crate) fn rated_from_part(part: &str) -> Option<u32> {
    let p = part.trim().to_ascii_uppercase();
    let ok = |v: u32| (1600..=9600).contains(&v).then_some(v);
    let b = p.as_bytes();
    let digits_at = |i: usize, n: usize| -> Option<u32> {
        (i + n <= b.len() && b[i..i + n].iter().all(u8::is_ascii_digit)).then(|| p[i..i + n].parse().ok()).flatten()
    };
    // Kingston: KF/KVR + поколение + две цифры частоты
    for pre in ["KF", "KVR"] {
        if let Some(rest) = p.strip_prefix(pre) {
            if let (Some(ddr), Some(v)) = (digits_at(pre.len(), 1), digits_at(pre.len() + 1, 2)) {
                if (ddr == 4 || ddr == 5) && rest.len() > 3 { return ok(v * 100); }
            }
        }
    }
    // четыре цифры подряд, не окружённые другими цифрами
    for i in 0..b.len() {
        if (i == 0 || !b[i - 1].is_ascii_digit()) && !b.get(i + 4).is_some_and(u8::is_ascii_digit) {
            if let Some(v) = digits_at(i, 4).and_then(ok) {
                if v % 100 == 0 || v % 100 == 33 || v % 100 == 66 { return Some(v); }
            }
        }
    }
    // две цифры частоты перед таймингом: «60C36», «32C16»
    for i in 0..b.len() {
        if (i == 0 || !b[i - 1].is_ascii_digit()) && b.get(i + 2) == Some(&b'C') {
            if let (Some(v), Some(_)) = (digits_at(i, 2), digits_at(i + 3, 2)) {
                if let Some(v) = ok(v * 100) { return Some(v); }
            }
        }
    }
    None
}

// «P0 CHANNEL A» / «ChannelA-DIMM0» / «Controller0-ChannelB» → «A», «B»
fn channel_of(bank: &str, loc: &str) -> String {
    for s in [bank, loc] {
        let u = s.to_ascii_uppercase();
        if let Some(i) = u.find("CHANNEL") {
            let c = u[i + 7..].trim_start_matches([' ', '-', '_']).chars().next();
            if let Some(c) = c.filter(|c| c.is_ascii_alphanumeric()) { return c.to_string(); }
        }
    }
    String::new()
}

fn ram() -> Ram {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_PhysicalMemory | ForEach-Object { \"$($_.Capacity)|$($_.Speed)|$($_.ConfiguredClockSpeed)|$($_.SMBIOSMemoryType)|$($_.BankLabel)|$($_.DeviceLocator)|$($_.Manufacturer)|$($_.PartNumber)\" }"]);
    no_window(&mut cmd);
    let Ok(out) = cmd.output() else { return Ram::default() };
    let mut kind = String::new();
    let modules: Vec<Module> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| {
        let f: Vec<&str> = l.trim().split('|').collect();
        if f.len() < 8 { return None; }
        let n = |s: &str| s.trim().parse::<u64>().unwrap_or(0);
        match n(f[3]) { 26 => kind = "DDR4".into(), 34 => kind = "DDR5".into(), _ => {} }
        let part = f[7].trim().to_string();
        Some(Module {
            gb: (n(f[0]) / (1024 * 1024 * 1024)) as u32,
            speed: n(f[1]) as u32,
            configured: n(f[2]) as u32,
            rated: rated_from_part(&part),
            maker: f[6].trim().to_string(),
            channel: channel_of(f[4], f[5]),
            part,
        })
    }).filter(|m| m.gb > 0).collect();
    let chans: std::collections::HashSet<&str> = modules.iter().map(|m| m.channel.as_str()).collect();
    let dual_channel = if modules.len() == 1 { Some(false) }
        else if modules.iter().all(|m| !m.channel.is_empty()) { Some(chans.len() > 1) }
        else { None };
    Ram { modules, kind, dual_channel }
}

fn cpu() -> String {
    reg(r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString").unwrap_or_default().trim().to_string()
}

fn dword(key: &str, val: &str) -> Option<u32> {
    let v = reg(key, val)?;
    let v = v.trim();
    v.strip_prefix("0x").and_then(|h| u32::from_str_radix(h, 16).ok()).or_else(|| v.parse().ok())
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    no_window(&mut c);
    let o = c.output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
        return Err(if err.is_empty() { String::from_utf8_lossy(&o.stdout).trim().to_string() } else { err });
    }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

fn plan_kind(guid: &str) -> &'static str {
    match guid {
        PLAN_SAVER => "saver",
        PLAN_BALANCED => "balanced",
        PLAN_HIGH => "high",
        PLAN_ULTIMATE => "ultimate",
        _ => "custom",
    }
}

// GUID из строки powercfg: «GUID схемы питания: 381b4222-...  (Сбалансированная) *»
fn guid_in(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|w| w.len() == 36 && w.matches('-').count() == 4 && w.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .map(|w| w.to_ascii_lowercase())
}

fn plans() -> (Vec<Plan>, String) {
    // вывод powercfg в кодировке консоли (cp866 на русской Windows): имена могут прийти кривыми,
    // поэтому тип схемы — по GUID, а имя только для своих схем
    let out = run("powercfg", &["/list"]).unwrap_or_default();
    let mut list = Vec::new();
    let mut active = String::new();
    for l in out.lines() {
        let Some(guid) = guid_in(l) else { continue };
        let name = l.split_once('(').and_then(|(_, r)| r.rsplit_once(')')).map(|(n, _)| n.trim().to_string()).unwrap_or_default();
        if l.trim_end().ends_with('*') { active = guid.clone(); }
        list.push(Plan { kind: plan_kind(&guid), guid, name });
    }
    (list, active)
}

fn on_battery() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: структура заполняется системой
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 { return false; }
    s.ACLineStatus == 0 && s.BatteryFlag != 128
}

// текущая частота основного экрана и самая высокая при том же разрешении
fn refresh() -> (u32, u32, (u32, u32)) {
    let mut dm: DEVMODEW = unsafe { std::mem::zeroed() };
    dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    // SAFETY: dmSize выставлен, структура живёт до конца функции
    if unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm) } == 0 { return (0, 0, (0, 0)); }
    let (w, h, hz) = (dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency);
    let mut max = hz;
    for i in 0.. {
        let mut m: DEVMODEW = unsafe { std::mem::zeroed() };
        m.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if unsafe { EnumDisplaySettingsW(std::ptr::null(), i, &mut m) } == 0 { break; }
        if m.dmPelsWidth == w && m.dmPelsHeight == h { max = max.max(m.dmDisplayFrequency); }
    }
    (hz, max, (w, h))
}

#[tauri::command]
pub async fn fps_check(cs2: String) -> FpsCheck {
    tauri::async_runtime::spawn_blocking(move || check(cs2)).await.expect("fps_check")
}

fn check(cs2: String) -> FpsCheck {
    let cs2 = cs2.replace('/', "\\");
    let (plans, active_plan) = plans();
    let (hz, max_hz, resolution) = refresh();
    let gpus = crate::preflight::gpu_names();
    let gpu_pref = (!cs2.is_empty()).then(|| reg(GPUPREF, &cs2)).flatten().and_then(|v| {
        v.split(';').find_map(|p| p.trim().strip_prefix("GpuPreference=").and_then(|x| x.parse().ok()))
    });
    FpsCheck {
        plans,
        active_plan,
        battery: on_battery(),
        game_mode: dword(GAMEBAR, "AutoGameModeEnabled"),
        capture: dword(GAMEDVR, "AppCaptureEnabled"),
        background_capture: dword(GAMEDVR, "HistoricalCaptureEnabled"),
        hags: dword(HAGS, "HwSchMode"),
        hz,
        max_hz,
        resolution,
        gpus,
        gpu_pref,
        ram: ram(),
        cpu: cpu(),
    }
}

fn set_dword(key: &str, val: &str, v: u32) -> Result<(), String> {
    run("reg", &["add", key, "/v", val, "/t", "REG_DWORD", "/d", &v.to_string(), "/f"]).map(|_| ())
}

// Исправления по одному: что именно поменять, решает кнопка в интерфейсе
#[tauri::command]
pub async fn fps_fix(what: String, cs2: Option<String>, plan: Option<String>) -> Result<(), String> {
    match what.as_str() {
        "game_mode" => set_dword(GAMEBAR, "AutoGameModeEnabled", 1),
        "capture" => {
            set_dword(GAMEDVR, "AppCaptureEnabled", 0)?;
            set_dword(GAMEDVR, "HistoricalCaptureEnabled", 0)?;
            set_dword(GAMECFG, "GameDVR_Enabled", 0)
        }
        "capture_on" => {
            set_dword(GAMEDVR, "AppCaptureEnabled", 1)?;
            set_dword(GAMECFG, "GameDVR_Enabled", 1)
        }
        "gpu_pref" => {
            let exe = cs2.map(|p| p.replace('/', "\\")).filter(|p| p.to_ascii_lowercase().ends_with("cs2.exe")).ok_or("путь к cs2.exe не указан")?;
            run("reg", &["add", GPUPREF, "/v", &exe, "/t", "REG_SZ", "/d", "GpuPreference=2;", "/f"]).map(|_| ())
        }
        // схема питания: конкретная (вернуть прошлую) или «Высокая производительность»
        "power" => {
            let guid = match plan {
                Some(g) => guid_in(&g).ok_or("неизвестная схема питания")?,
                None => {
                    let (list, _) = plans();
                    match list.iter().find(|p| p.kind == "ultimate").or_else(|| list.iter().find(|p| p.kind == "high")) {
                        Some(p) => p.guid.clone(),
                        // на ноутбуках с Modern Standby схема скрыта — создаём её копию
                        None => {
                            let out = run("powercfg", &["-duplicatescheme", PLAN_HIGH])?;
                            guid_in(&out).ok_or("не удалось создать схему «Высокая производительность»")?
                        }
                    }
                }
            };
            run("powercfg", &["/setactive", &guid]).map(|_| ())
        }
        _ => Err("неизвестное исправление".into()),
    }
}

// Страницы «Параметров» Windows — только из списка
#[tauri::command]
pub fn fps_open_settings(page: String) -> Result<(), String> {
    let uri = match page.as_str() {
        "graphics" => "ms-settings:display-advancedgraphics",
        "display" => "ms-settings:display-advanced",
        "gamemode" => "ms-settings:gaming-gamemode",
        "gamebar" => "ms-settings:gaming-gamebar",
        "power" => "ms-settings:powersleep",
        _ => return Err("неизвестная страница".into()),
    };
    Command::new("explorer").arg(uri).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_from_powercfg_line() {
        assert_eq!(
            guid_in("GUID схемы питания: 381B4222-F694-41F0-9685-FF5BB260DF2E  (Сбалансированная) *").as_deref(),
            Some(PLAN_BALANCED)
        );
        assert_eq!(guid_in("Существующие схемы питания"), None);
    }

    #[test]
    fn ram_speed_from_part_number() {
        assert_eq!(rated_from_part("CP16G60C36U5W.M8D3"), Some(6000));
        assert_eq!(rated_from_part("F5-6000J3038F16G"), Some(6000));
        assert_eq!(rated_from_part("CMK32GX5M2B6000C36"), Some(6000));
        assert_eq!(rated_from_part("BL16G32C16U4B.M8FE1"), Some(3200));
        assert_eq!(rated_from_part("KF560C36-16"), Some(6000));
        assert_eq!(rated_from_part("KF432C16BB/8"), Some(3200));
        assert_eq!(rated_from_part("F4-3600C16-8GVKC"), Some(3600));
        assert_eq!(rated_from_part("M378A1K43CB2-CTD"), None);
        assert_eq!(channel_of("P0 CHANNEL A", "DIMM 1"), "A");
        assert_eq!(channel_of("BANK 0", "Controller0-ChannelB-DIMM0"), "B");
    }

    #[test]
    #[ignore]
    fn show_check_here() {
        let c = tauri::async_runtime::block_on(fps_check(String::new()));
        println!("{}", serde_json::to_string_pretty(&c).unwrap());
    }
}
