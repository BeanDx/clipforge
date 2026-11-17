// Игроки текущего матча (ММ, Premier) для уровней FACEIT на главной. GSI отдаёт всех игроков только
// наблюдателю, поэтому steamid и ники читаются из памяти client.dll: контроллеры игроков из списка сущностей.
// Функция экспериментальная и по умолчанию выключена: VAC может счесть чтение памяти игры читом.
// Доступ минимальный: только PROCESS_VM_READ, хэндл открывается на один опрос и сразу закрывается, ничего не пишется.
// Пока запущен античит FACEIT, ничего не читаем.
// Оффсеты берутся из открытого дампа a2x/cs2-dumper и кэшируются на диске.
use serde::Serialize;
use serde_json::Value;
use std::ffi::c_void;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW, MODULEENTRY32W,
    PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_VM_READ};

const DUMPER: &str = "https://raw.githubusercontent.com/a2x/cs2-dumper/main/output";
const REFRESH_MS: u64 = 6 * 3600 * 1000; // свежий дамп подтягиваем раз в 6 часов
const OUTDATED: &str = "Оффсеты устарели: CS2 обновилась, а дамп cs2-dumper ещё нет. Попробуй позже";

#[derive(Clone, Copy)]
struct Offsets {
    entity_list: u64,
    steam_id: u64,
    name: u64,
    team: u64,
}

#[derive(Serialize, Clone)]
pub struct LobbyPlayer {
    pub steamid: String,
    pub name: String,
    pub team: String, // "T" | "CT" | ""
}

static OFFS: Mutex<Option<(u64, Offsets)>> = Mutex::new(None); // (когда загружены, оффсеты)

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn cache_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("offsets")
}

fn parse(offsets: &str, client: &str) -> Option<Offsets> {
    let o: Value = serde_json::from_str(offsets).ok()?;
    let c: Value = serde_json::from_str(client).ok()?;
    let cls = &c["client.dll"]["classes"];
    Some(Offsets {
        entity_list: o["client.dll"]["dwEntityList"].as_u64()?,
        steam_id: cls["CBasePlayerController"]["fields"]["m_steamID"].as_u64()?,
        name: cls["CBasePlayerController"]["fields"]["m_iszPlayerName"].as_u64()?,
        team: cls["C_BaseEntity"]["fields"]["m_iTeamNum"].as_u64()?,
    })
}

fn fetch(file: &str) -> Result<String, String> {
    let mut r = ureq::get(&format!("{DUMPER}/{file}")).call().map_err(|e| format!("не скачались оффсеты: {e}"))?;
    r.body_mut().read_to_string().map_err(|e| e.to_string())
}

// оффсеты: из памяти, из кэша на диске или свежие с GitHub (force — дамп заведомо не подошёл)
fn offsets(force: bool) -> Result<Offsets, String> {
    let now = now_ms();
    if let Some((at, o)) = *OFFS.lock().unwrap() {
        // свежий дамп с GitHub — не чаще раза в 10 минут, даже если этот не подходит
        if now - at < if force { 10 * 60_000 } else { REFRESH_MS } { return Ok(o); }
    }
    let dir = cache_dir();
    let (po, pc) = (dir.join("offsets.json"), dir.join("client_dll.json"));
    let cached_age = fs::metadata(&po).and_then(|m| m.modified()).ok()
        .and_then(|t| t.elapsed().ok()).map(|d| d.as_millis() as u64);
    if !force && cached_age.is_some_and(|a| a < REFRESH_MS) {
        if let (Ok(a), Ok(b)) = (fs::read_to_string(&po), fs::read_to_string(&pc)) {
            if let Some(o) = parse(&a, &b) { *OFFS.lock().unwrap() = Some((now, o)); return Ok(o); }
        }
    }
    match (fetch("offsets.json"), fetch("client_dll.json")) {
        (Ok(a), Ok(b)) => {
            let o = parse(&a, &b).ok_or("в дампе cs2-dumper нет нужных полей")?;
            let _ = fs::create_dir_all(&dir);
            let _ = fs::write(&po, &a);
            let _ = fs::write(&pc, &b);
            *OFFS.lock().unwrap() = Some((now, o));
            Ok(o)
        }
        (Err(e), _) | (_, Err(e)) => {
            // нет сети — работаем со старым кэшем, если он есть
            let a = fs::read_to_string(&po).map_err(|_| e.clone())?;
            let b = fs::read_to_string(&pc).map_err(|_| e.clone())?;
            let o = parse(&a, &b).ok_or(e)?;
            *OFFS.lock().unwrap() = Some((now, o));
            Ok(o)
        }
    }
}

fn wide(s: &[u16]) -> String {
    let n = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..n])
}

// pid cs2.exe и запущен ли античит FACEIT
fn find_cs2() -> (Option<u32>, bool) {
    let (mut pid, mut faceit) = (None, false);
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE { return (None, false); }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let name = wide(&e.szExeFile).to_lowercase();
            if name == "cs2.exe" { pid = Some(e.th32ProcessID); }
            if name == "faceit.exe" || name == "faceitclient.exe" || name == "faceitservice.exe" { faceit = true; }
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    (pid, faceit)
}

fn client_base(pid: u32) -> Option<u64> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if snap == INVALID_HANDLE_VALUE { return None; }
        let mut m: MODULEENTRY32W = std::mem::zeroed();
        m.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        let mut ok = Module32FirstW(snap, &mut m) != 0;
        let mut base = None;
        while ok {
            if wide(&m.szModule).eq_ignore_ascii_case("client.dll") { base = Some(m.modBaseAddr as u64); break; }
            ok = Module32NextW(snap, &mut m) != 0;
        }
        CloseHandle(snap);
        base
    }
}

struct Proc(*mut c_void);
impl Drop for Proc {
    fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
}
impl Proc {
    fn bytes(&self, addr: u64, buf: &mut [u8]) -> bool {
        if addr < 0x10000 { return false; }
        let mut got = 0usize;
        let ok = unsafe { ReadProcessMemory(self.0, addr as *const c_void, buf.as_mut_ptr() as *mut c_void, buf.len(), &mut got) };
        ok != 0 && got == buf.len()
    }
    fn u64(&self, addr: u64) -> Option<u64> {
        let mut b = [0u8; 8];
        self.bytes(addr, &mut b).then(|| u64::from_le_bytes(b))
    }
    fn u8(&self, addr: u64) -> Option<u8> {
        let mut b = [0u8; 1];
        self.bytes(addr, &mut b).then_some(b[0])
    }
}

// настоящий SteamID64 (у ботов 0)
fn real_id(id: u64) -> bool { (76561197960265729..76561202255233023).contains(&id) }

// Контроллеры игроков лежат в первых 64 слотах списка сущностей. Размер записи CEntityIdentity
// менялся между патчами (0x78 → 0x70), поэтому пробуем оба и берём тот, где нашлись живые steamid.
fn scan(p: &Proc, client: u64, o: Offsets) -> Vec<LobbyPlayer> {
    let Some(list) = p.u64(client + o.entity_list) else { return vec![] };
    let mut best = vec![];
    for stride in [0x70u64, 0x78] {
        let mut out: Vec<LobbyPlayer> = vec![];
        for i in 1u64..=64 {
            let Some(chunk) = p.u64(list + 8 * (i >> 9) + 16) else { continue };
            let Some(ctrl) = p.u64(chunk + stride * (i & 0x1FF)) else { continue };
            let Some(id) = p.u64(ctrl + o.steam_id) else { continue };
            if !real_id(id) || out.iter().any(|x| x.steamid == id.to_string()) { continue; }
            let mut nb = [0u8; 128];
            let name = if p.bytes(ctrl + o.name, &mut nb) {
                let n = nb.iter().position(|&c| c == 0).unwrap_or(nb.len());
                String::from_utf8_lossy(&nb[..n]).into_owned()
            } else { String::new() };
            let team = match p.u8(ctrl + o.team) { Some(2) => "T", Some(3) => "CT", _ => "" };
            out.push(LobbyPlayer { steamid: id.to_string(), name, team: team.into() });
        }
        if out.len() > best.len() { best = out; }
    }
    best
}

fn read_once(force: bool) -> Result<Vec<LobbyPlayer>, String> {
    let (pid, faceit) = find_cs2();
    if faceit { return Err("Запущен античит FACEIT: на FACEIT память игры не читаем".into()); }
    let pid = pid.ok_or("CS2 не запущена")?;
    let o = offsets(force)?;
    let client = client_base(pid).ok_or("CS2 ещё загружается")?;
    let h = unsafe { OpenProcess(PROCESS_VM_READ, 0, pid) };
    if h.is_null() { return Err("Windows не дала доступ к процессу CS2".into()); }
    let p = Proc(h);
    Ok(scan(&p, client, o))
}

// Игроки на сервере, где сейчас играешь. Пустой список — не в матче (меню, загрузка карты).
// in_match — по GSI игрок точно на сервере: если тогда никого не нашлось, дамп не подходит к этой версии игры.
#[tauri::command]
pub async fn lobby_players(in_match: bool) -> Result<Vec<LobbyPlayer>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let got = read_once(false)?;
        if !got.is_empty() || !in_match { return Ok(got); }
        let again = read_once(true)?; // свежий дамп с GitHub
        if again.is_empty() { Err(OUTDATED.into()) } else { Ok(again) }
    }).await.map_err(|e| e.to_string())?
}

// ---- Профили игроков матча: всё по steamid из сторонних сервисов, память больше не трогаем ----
// Leetify (без ключа): премьер-рейтинг, звание ММ на картах, FACEIT, число матчей и винрейт.
// Steam: аватар (кэш profile.rs). FACEIT Data API: точный текущий уровень и эло, если в «Настройках» есть ключ.

#[derive(Serialize, Clone, Default)]
pub struct LobbyProfile {
    pub steamid: String,
    pub avatar: String,
    pub premier: Option<u64>,
    pub comp: Option<u64>, // звание ММ на текущей карте (1–18)
    pub faceit: Option<u64>,
    pub faceit_elo: Option<u64>,
    pub matches: Option<u64>,
    pub winrate: Option<f64>,
    pub vac: bool,
}

static LEET: Mutex<Option<std::collections::HashMap<String, (u64, Value)>>> = Mutex::new(None);

fn leetify(id: &str) -> Option<Value> {
    let now = now_ms();
    if let Some((at, v)) = LEET.lock().unwrap().as_ref().and_then(|c| c.get(id).cloned()) {
        if now - at < 30 * 60_000 { return Some(v); }
    }
    let url = format!("https://api-public.cs-prod.leetify.com/v3/profile?steam64_id={id}");
    let v: Value = match ureq::get(&url).header("User-Agent", "clipforge").call() {
        Ok(mut r) => serde_json::from_str(&r.body_mut().read_to_string().ok()?).ok()?,
        Err(ureq::Error::StatusCode(404)) => Value::Null, // игрока нет на Leetify — запоминаем, чтобы не спрашивать снова
        Err(_) => return None,
    };
    LEET.lock().unwrap().get_or_insert_with(Default::default).insert(id.into(), (now, v.clone()));
    Some(v)
}

#[tauri::command]
pub async fn lobby_profile(steamid: String, map: String, key: String) -> Result<LobbyProfile, String> {
    if !steamid.parse::<u64>().is_ok_and(real_id) { return Err("не SteamID64".into()); }
    let id = steamid.clone();
    let leet = tauri::async_runtime::spawn_blocking(move || leetify(&id)).await.ok().flatten().unwrap_or(Value::Null);
    let r = &leet["ranks"];
    let mut p = LobbyProfile {
        steamid: steamid.clone(),
        premier: r["premier"].as_u64().filter(|&x| x > 0),
        comp: r["competitive"].as_array().and_then(|a| a.iter().find(|m| m["map_name"].as_str() == Some(map.as_str())))
            .and_then(|m| m["rank"].as_u64()).filter(|&x| x > 0),
        faceit: r["faceit"].as_u64().filter(|&x| x > 0),
        faceit_elo: r["faceit_elo"].as_u64().filter(|&x| x > 0),
        matches: leet["total_matches"].as_u64(),
        winrate: leet["winrate"].as_f64(),
        vac: leet["bans"].as_array().is_some_and(|b| !b.is_empty()),
        ..Default::default()
    };
    if key.trim().len() >= 32 {
        if let Ok(m) = crate::render::faceit_levels(key, vec![steamid.clone()]).await {
            if let Some(&(l, e)) = m.get(&steamid) { p.faceit = Some(l); p.faceit_elo = Some(e); }
        }
    }
    if let Ok(s) = crate::profile::steam_profile(steamid).await {
        p.avatar = s.avatar;
        p.vac |= s.vac;
    }
    Ok(p)
}
