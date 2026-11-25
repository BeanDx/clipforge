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
    extra: Option<Extra>, // нет в дампе — только steamid, ник и команда
    // все нужные поля контроллера лежат в одном куске памяти: читаем его целиком одним вызовом
    block: u64, // начало куска (оффсет от контроллера)
    block_len: usize,
}

// Поля CCSPlayerController, которые и так видны в таблице счёта (рейтинг, победы, прогноз, пинг).
// Отдельно их не читаем: они попадают в тот же кусок памяти, что steamid, ник и команда.
#[derive(Clone, Copy)]
struct Extra {
    ping: u64,
    rank: u64,
    wins: u64,
    rank_type: u64,
    win: u64,
    loss: u64,
    tie: u64,
}
const BLOCK_MAX: u64 = 0x1000; // кусок больше 4 КБ — дамп странный, лишние поля не берём

#[derive(Serialize, Clone, Default)]
pub struct Live {
    pub ping: u32,
    pub rank: i32,      // Premier — рейтинг, ММ — звание на карте (1–18), 0 — нет
    pub rank_type: u8,  // 11 Premier, 12 ММ, 7 напарники, 10 вингман
    pub wins: i32,
    pub win: i32,       // прогноз рейтинга от игры: после победы / поражения / ничьей
    pub loss: i32,
    pub tie: i32,
}

// границы куска памяти, в который попадают поля (оффсет, размер)
fn span(fields: &[(u64, u64)]) -> (u64, u64) {
    let a = fields.iter().map(|f| f.0).min().unwrap_or(0);
    let b = fields.iter().map(|f| f.0 + f.1).max().unwrap_or(0);
    (a, b - a)
}

#[derive(Serialize, Clone)]
pub struct LobbyPlayer {
    pub steamid: String,
    pub name: String,
    pub team: String, // "T" | "CT" | ""
    pub live: Option<Live>,
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
    let f = &cls["CCSPlayerController"]["fields"];
    let g = |n: &str| f[n].as_u64();
    let extra = (|| Some(Extra {
        ping: g("m_iPing")?, rank: g("m_iCompetitiveRanking")?, wins: g("m_iCompetitiveWins")?,
        rank_type: g("m_iCompetitiveRankType")?, win: g("m_iCompetitiveRankingPredicted_Win")?,
        loss: g("m_iCompetitiveRankingPredicted_Loss")?, tie: g("m_iCompetitiveRankingPredicted_Tie")?,
    }))();
    let (steam_id, name, team) = (
        cls["CBasePlayerController"]["fields"]["m_steamID"].as_u64()?,
        cls["CBasePlayerController"]["fields"]["m_iszPlayerName"].as_u64()?,
        cls["C_BaseEntity"]["fields"]["m_iTeamNum"].as_u64()?,
    );
    let base = [(steam_id, 8), (name, 128), (team, 1)];
    let (bs, bl) = span(&base);
    if bl > BLOCK_MAX { return None; }
    let mut all = base.to_vec();
    if let Some(e) = extra {
        all.extend([(e.ping, 4), (e.rank, 4), (e.wins, 4), (e.rank_type, 1), (e.win, 4), (e.loss, 4), (e.tie, 4)]);
    }
    let (es, el) = span(&all);
    let (extra, block, block_len) = if el <= BLOCK_MAX { (extra, es, el) } else { (None, bs, bl) };
    Some(Offsets { entity_list: o["client.dll"]["dwEntityList"].as_u64()?, steam_id, name, team, extra, block, block_len: block_len as usize })
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
}

// настоящий SteamID64 (у ботов 0)
fn real_id(id: u64) -> bool { (76561197960265729..76561202255233023).contains(&id) }

// Контроллеры игроков лежат в первых 64 слотах списка сущностей. Размер записи CEntityIdentity
// менялся между патчами (0x78 → 0x70), поэтому пробуем оба; первый подошедший — второй уже не трогаем.
// Чтений за опрос: список + на каждый размер записи 1 блок слотов (все 64 слота в нём) и по 2 на слот:
// указатель на контроллер и один кусок со всеми полями игрока.
fn scan(p: &Proc, client: u64, o: Offsets) -> Vec<LobbyPlayer> {
    let Some(list) = p.u64(client + o.entity_list) else { return vec![] };
    let Some(chunk) = p.u64(list + 16) else { return vec![] }; // слоты 0–511 в первом блоке
    let mut buf = vec![0u8; o.block_len];
    let at = |off: u64| (off - o.block) as usize;
    for stride in [0x70u64, 0x78] {
        let mut out: Vec<LobbyPlayer> = vec![];
        for i in 1u64..=64 {
            let Some(ctrl) = p.u64(chunk + stride * i) else { continue };
            if !p.bytes(ctrl + o.block, &mut buf) { continue; }
            let b = &buf;
            let u64_ = |off: u64| u64::from_le_bytes(b[at(off)..at(off) + 8].try_into().unwrap());
            let i32_ = |off: u64| i32::from_le_bytes(b[at(off)..at(off) + 4].try_into().unwrap());
            let id = u64_(o.steam_id);
            if !real_id(id) || out.iter().any(|x| x.steamid == id.to_string()) { continue; }
            let nb = &b[at(o.name)..at(o.name) + 128];
            let n = nb.iter().position(|&c| c == 0).unwrap_or(nb.len());
            let name = String::from_utf8_lossy(&nb[..n]).into_owned();
            let team = match b[at(o.team)] { 2 => "T", 3 => "CT", _ => "" };
            let live = o.extra.map(|e| Live {
                ping: i32_(e.ping).max(0) as u32,
                rank: i32_(e.rank),
                rank_type: b[at(e.rank_type)],
                wins: i32_(e.wins),
                win: i32_(e.win),
                loss: i32_(e.loss),
                tie: i32_(e.tie),
            });
            out.push(LobbyPlayer { steamid: id.to_string(), name, team: team.into(), live });
        }
        if !out.is_empty() { return out; }
    }
    vec![]
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
    pub country: String, // код страны FACEIT (ru, ua, de…)
    pub faceit_nick: String,
    // Leetify: оценки 0–100 и время реакции
    pub aim: Option<f64>,
    pub utility: Option<f64>,
    pub opening: Option<f64>,
    pub reaction_ms: Option<f64>,
    pub first_match: String, // дата первого матча на Leetify (ISO)
    pub bans: u32,
    // Steam
    pub since: String, // «December 3, 2021»
    pub public: bool,
    pub limited: bool,
    pub friends: Vec<String>, // steamid друзей (для пати); пусто — список скрыт или друзей нет
    pub friends_hidden: bool,
    pub steam_ok: bool, // Steam ответил: возраст, приватность и баны известны
    // статистика игрока: FACEIT, если там от 10 побед, иначе Премьер, иначе ММ (по Leetify)
    pub stat: Option<Stat>,
}

#[derive(Serialize, Clone, Default)]
pub struct Stat {
    pub source: String, // faceit | premier | mm
    pub kd: Option<f64>,
    pub wr: Option<f64>, // %
    pub matches: u64,    // сколько матчей в основе винрейта
    pub hs: Option<f64>, // % убийств в голову
    pub adr: Option<f64>,
    pub kd_games: u64, // по скольким матчам посчитан K/D (Leetify — последние несколько)
    // на текущей карте
    pub map_wr: Option<f64>,
    pub map_kd: Option<f64>,
    pub map_matches: u64,
}

// с FACEIT берём статистику, только если там набралось хоть немного игр
const FACEIT_MIN_WINS: f64 = 10.0;
// K/D для Премьера и ММ: Leetify отдаёт его только в подробностях матча — берём последние 5
const KD_GAMES: usize = 5;

static MATCHES: Mutex<Option<std::collections::HashMap<String, Value>>> = Mutex::new(None);

fn leet_match(id: &str) -> Option<Value> {
    if let Some(v) = MATCHES.lock().unwrap().as_ref().and_then(|c| c.get(id).cloned()) { return Some(v); }
    let url = format!("https://api-public.cs-prod.leetify.com/v2/matches/{id}");
    let mut r = ureq::get(&url).header("User-Agent", "clipforge").call().ok()?;
    let v: Value = serde_json::from_str(&r.body_mut().read_to_string().ok()?).ok()?;
    MATCHES.lock().unwrap().get_or_insert_with(Default::default).insert(id.into(), v.clone());
    Some(v)
}

// Премьер (rank_type 11) или остальной матчмейкинг из последних матчей Leetify
fn leet_stat(leet: &Value, steamid: &str, map: &str) -> Option<Stat> {
    let recent = leet["recent_matches"].as_array()?;
    let mm: Vec<&Value> = recent.iter().filter(|m| m["data_source"].as_str() == Some("matchmaking")).collect();
    let premier: Vec<&Value> = mm.iter().copied().filter(|m| m["rank_type"].as_u64() == Some(11)).collect();
    let (source, list) = if !premier.is_empty() { ("premier", premier) } else if !mm.is_empty() { ("mm", mm) } else { return None };
    let wins = |l: &[&Value]| l.iter().filter(|m| m["outcome"].as_str() == Some("win")).count() as f64;
    let on_map: Vec<&Value> = list.iter().copied().filter(|m| m["map_name"].as_str() == Some(map)).collect();
    let mut st = Stat {
        source: source.into(),
        wr: Some(wins(&list) / list.len() as f64 * 100.0),
        matches: list.len() as u64,
        map_wr: (!on_map.is_empty()).then(|| wins(&on_map) / on_map.len() as f64 * 100.0),
        map_matches: on_map.len() as u64,
        ..Default::default()
    };
    let (mut k, mut d, mut hs, mut dmg, mut rounds, mut games) = (0.0, 0.0, 0.0, 0.0, 0.0, 0u64);
    for m in list.iter().take(KD_GAMES) {
        let Some(id) = m["id"].as_str() else { continue };
        let Some(full) = leet_match(id) else { continue };
        let Some(me) = full["stats"].as_array().and_then(|a| a.iter().find(|x| x["steam64_id"].as_str() == Some(steamid))) else { continue };
        k += num(&me["total_kills"]).unwrap_or(0.0);
        d += num(&me["total_deaths"]).unwrap_or(0.0);
        hs += num(&me["total_hs_kills"]).unwrap_or(0.0);
        dmg += num(&me["total_damage"]).unwrap_or(0.0);
        rounds += num(&me["rounds_count"]).unwrap_or(0.0);
        games += 1;
    }
    if games > 0 {
        st.kd = Some(k / d.max(1.0));
        st.hs = (k > 0.0).then(|| hs / k * 100.0);
        st.adr = (rounds > 0.0).then(|| dmg / rounds);
        st.kd_games = games;
    }
    Some(st)
}

// steamcommunity.com быстро отвечает 429: страницы друзей запрашиваем по одной
static STEAM_GATE: Mutex<()> = Mutex::new(());

fn num(v: &Value) -> Option<f64> { v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) }

// «Dust2» / «de_dust2» → «de_dust2» (как mapId в profile/data.js)
fn map_id(m: &str) -> String {
    let s: String = m.to_lowercase().split_whitespace().collect();
    if s.contains('_') { s } else { format!("de_{s}") }
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
        bans: leet["bans"].as_array().map_or(0, |b| b.len() as u32),
        aim: num(&leet["rating"]["aim"]),
        utility: num(&leet["rating"]["utility"]),
        opening: num(&leet["rating"]["opening"]),
        reaction_ms: num(&leet["stats"]["reaction_time_ms"]).filter(|&x| x > 0.0),
        first_match: leet["first_match_date"].as_str().unwrap_or("").into(),
        ..Default::default()
    };
    // FACEIT по ключу: точные уровень и эло, страна и ник
    if key.trim().len() >= 32 {
        let (id, k) = (steamid.clone(), key.clone());
        let fc = tauri::async_runtime::spawn_blocking(move || {
            let key = k;
            let url = format!("https://open.faceit.com/data/v4/players?game=cs2&game_player_id={id}");
            let mut r = ureq::get(&url).header("Authorization", &format!("Bearer {}", key.trim())).call().ok()?;
            serde_json::from_str::<Value>(&r.body_mut().read_to_string().ok()?).ok()
        }).await.ok().flatten();
        if let Some(v) = fc {
            let g = &v["games"]["cs2"];
            if let Some(l) = g["skill_level"].as_u64() { p.faceit = Some(l); }
            if let Some(e) = g["faceit_elo"].as_u64() { p.faceit_elo = Some(e); }
            p.country = v["country"].as_str().unwrap_or("").to_lowercase();
            p.faceit_nick = v["nickname"].as_str().unwrap_or("").into();
            // аватар FACEIT — запасной, если Steam не ответит
            p.avatar = v["avatar"].as_str().unwrap_or("").into();
            // статистика FACEIT: за всё время и на текущей карте
            if let Some(pid) = v["player_id"].as_str().map(String::from) {
                let key = key.clone();
                let all = tauri::async_runtime::spawn_blocking(move || {
                    let url = format!("https://open.faceit.com/data/v4/players/{pid}/stats/cs2");
                    let mut r = ureq::get(&url).header("Authorization", &format!("Bearer {}", key.trim())).call().ok()?;
                    serde_json::from_str::<Value>(&r.body_mut().read_to_string().ok()?).ok()
                }).await.ok().flatten();
                if let Some(all) = all {
                    let life = &all["lifetime"];
                    if num(&life["Wins"]).unwrap_or(0.0) >= FACEIT_MIN_WINS {
                        let mid = map_id(&map);
                        let seg = all["segments"].as_array().and_then(|a| a.iter()
                            .find(|s| s["mode"].as_str().is_none_or(|m| m == "5v5") && map_id(s["label"].as_str().unwrap_or("")) == mid))
                            .map(|s| s["stats"].clone()).unwrap_or(Value::Null);
                        p.stat = Some(Stat {
                            source: "faceit".into(),
                            kd: num(&life["Average K/D Ratio"]),
                            wr: num(&life["Win Rate %"]),
                            matches: num(&life["Matches"]).unwrap_or(0.0) as u64,
                            hs: num(&life["Average Headshots %"]),
                            adr: num(&life["ADR"]).filter(|&x| x > 0.0),
                            map_wr: num(&seg["Win Rate %"]),
                            map_kd: num(&seg["Average K/D Ratio"]),
                            map_matches: num(&seg["Matches"]).unwrap_or(0.0) as u64,
                            ..Default::default()
                        });
                    }
                }
            }
        }
    }
    // нет FACEIT (или там меньше 10 побед) — Премьер, а если его нет, ММ
    if p.stat.is_none() {
        let (id, m) = (steamid.clone(), map.clone());
        p.stat = tauri::async_runtime::spawn_blocking(move || leet_stat(&leet, &id, &m)).await.ok().flatten();
    }
    // Steam: профиль, потом друзья (для пати). steamcommunity.com быстро режет частые запросы,
    // поэтому все запросы к нему идут по одному с паузой; если Steam отказал — друзей уже не спрашиваем
    let id = steamid.clone();
    let steam = tauri::async_runtime::spawn_blocking(move || {
        let _g = STEAM_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let prof = crate::profile::steam_profile_sync(&id);
        std::thread::sleep(std::time::Duration::from_millis(700));
        let friends = match &prof {
            Ok(s) if s.public && !s.stale => {
                let f = crate::friends::web_friends(&id);
                std::thread::sleep(std::time::Duration::from_millis(700));
                f.ok()
            }
            _ => None,
        };
        (prof, friends)
    }).await.ok();
    match steam {
        Some((Ok(s), friends)) => {
            p.steam_ok = true;
            if !s.avatar.is_empty() { p.avatar = s.avatar; }
            p.vac |= s.vac;
            p.since = s.since;
            p.public = s.public;
            p.limited = s.limited;
            match friends {
                Some(l) if !l.is_empty() => p.friends = l.into_iter().map(|f| f.steamid).collect(),
                _ => p.friends_hidden = true,
            }
        }
        _ => p.friends_hidden = true,
    }
    Ok(p)
}
