// Живые данные из игры (Game State Integration — официальный механизм Valve, им пользуются
// оверлеи стримеров; VAC это не трогает). CS2 сама шлёт сюда JSON о матче: карта, раунд, счёт,
// киллы и хедшоты игрока за раунд, оружие. По ним программа ведёт историю матчей и сессий,
// часы по дням и ставит закладки на хайлайты (3K, 4K, эйс, все в голову, нож, клавиша «запомни»).
// После матча — уведомление с хайлайтами, после закрытия игры — итог сессии.
// Конфиг для игры (gamestate_integration_clipforge.cfg) кладёт gsi_install; читается при запуске CS2.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const PORT: u16 = 31982;
const TOKEN: &str = "clipforge-gsi";
// клавиша «запомни этот момент» (системная: работает поверх игры в полноэкранном режиме)
const MARK_KEY: u32 = 0x77; // F8
const MARK_KEY_NAME: &str = "F8";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RoundRec {
    pub round: u32,
    pub kills: u32,
    pub hs: u32,
    #[serde(default)]
    pub knife: bool,
    #[serde(default)]
    pub marked: bool,
    // хайлайт: "ACE", "4K", "3K", "все в голову", "нож", "закладка"
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MatchRec {
    pub id: String,
    pub map: String,
    pub mode: String,
    pub started: u64, // unix, мс
    #[serde(default)]
    pub ended: Option<u64>,
    #[serde(default)]
    pub finished: bool,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub mvps: u32,
    pub hs: u32,
    #[serde(default)]
    pub team: String,
    #[serde(default)]
    pub score_ct: u32,
    #[serde(default)]
    pub score_t: u32,
    // "win" / "loss" / "draw" / "" (вышел раньше)
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub rounds: Vec<RoundRec>,
    // киллы по оружию
    #[serde(default)]
    pub weapons: BTreeMap<String, u32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SessionRec {
    pub started: u64,
    pub ended: u64,
    pub matches: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct History {
    pub matches: Vec<MatchRec>,
    pub sessions: Vec<SessionRec>,
    // секунды в игре по дням ("2026-11-03")
    pub days: BTreeMap<String, u64>,
}

// Состояние текущего матча и сессии между сообщениями игры
#[derive(Default)]
struct Live {
    me: String,
    cur: Option<MatchRec>,
    round_no: u32,
    rk: u32,  // киллы в текущем раунде (максимум из round_kills)
    rhs: u32, // хедшоты в текущем раунде
    prev_rhs: u32, // round_killhs из прошлого сообщения: хедшоты за матч считаются по приросту
    rknife: bool,
    rmarked: bool,
    last_kills: u32,
    weapon: String,
    prev_weapon: String, // оружие в прошлом сообщении: нож — только если он был в руках и до килла
    session: Option<SessionRec>,
    // где идёт текущий матч (ServerInfo.kind) и название комьюнити-сервера — запоминаем по ходу матча:
    // при выходе в меню строка подключения в логе уже сброшена
    src: String,
    src_name: String,
    last_seen: u64,
    live: Value, // последнее сообщение — для «сейчас в игре» на главной
}

static HISTORY: Mutex<Option<History>> = Mutex::new(None);
static LIVE: Mutex<Option<Live>> = Mutex::new(None);

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn data_file() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("history.json")
}

fn with_history<R>(f: impl FnOnce(&mut History) -> R) -> R {
    let mut g = HISTORY.lock().unwrap();
    if g.is_none() {
        let mut h: History = fs::read_to_string(data_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        // матчи без раундов из прошлых версий: «ничья» и «3K» за весь матч были ошибкой
        for m in h.matches.iter_mut().filter(|m| roundless(&m.mode)) {
            m.result.clear();
            m.rounds.retain(|r| r.marked);
            for r in &mut m.rounds { r.tags = vec!["закладка".into()]; }
        }
        // карты из мастерской попадали в статистику в прошлых версиях
        h.matches.retain(|m| !workshop_map(&m.map));
        *g = Some(h);
    }
    f(g.as_mut().unwrap())
}

fn save_history() {
    let json = with_history(|h| serde_json::to_string(h).unwrap_or_default());
    let p = data_file();
    if let Some(d) = p.parent() { let _ = fs::create_dir_all(d); }
    // через временный файл: при сбое старая история не портится
    let tmp = p.with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() { let _ = fs::rename(&tmp, &p); }
}

// день по местному времени: смещение пояса берём из Windows один раз
fn local_day(ms: u64) -> String {
    static OFFSET: Mutex<Option<i64>> = Mutex::new(None);
    let off = *OFFSET.lock().unwrap().get_or_insert_with(|| {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalSeconds"]);
        crate::render::no_window(&mut cmd);
        cmd.output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
    });
    let days = ((ms / 1000) as i64 + off).div_euclid(86400);
    // дата по номеру дня (алгоритм Хиннанта)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

fn round_tags(r: &RoundRec) -> Vec<String> {
    let mut t = Vec::new();
    match r.kills { k if k >= 5 => t.push("ACE".into()), 4 => t.push("4K".into()), 3 => t.push("3K".into()), _ => {} }
    if r.kills >= 2 && r.hs == r.kills { t.push("все в голову".into()); }
    if r.knife { t.push("нож".into()); }
    if r.marked { t.push("закладка".into()); }
    t
}

// раунд закончился: в матч попадают раунды с киллами или с закладкой
// режимы без раундов: весь матч — один «раунд», и киллы в нём — это киллы за матч
fn roundless(mode: &str) -> bool {
    matches!(mode, "deathmatch" | "gungameprogressive" | "gungametrbomb" | "armsrace")
}

fn close_round(l: &mut Live) {
    let Some(m) = l.cur.as_mut() else { return };
    let flat = roundless(&m.mode);
    // без раундов хайлайт — только закладка клавишей (3K за весь матч в DM — не хайлайт)
    let keep = if flat { l.rmarked } else { l.rk > 0 || l.rmarked };
    if l.round_no > 0 && keep && !m.rounds.iter().any(|r| r.round == l.round_no) {
        let mut r = RoundRec { round: l.round_no, kills: l.rk, hs: l.rhs, knife: l.rknife, marked: l.rmarked, tags: vec![] };
        r.tags = if flat { vec!["закладка".into()] } else { round_tags(&r) };
        m.rounds.push(r);
    }
    l.rk = 0; l.rhs = 0; l.rknife = false; l.rmarked = false;
}

// Карта из мастерской: GSI называет её «workshop/<id>/<имя>»
fn workshop_map(map: &str) -> bool { map.contains('/') || map.starts_with("workshop") }

// Идёт ли матч в статистику: только официальные серверы Valve и FACEIT. Комьюнити-серверы (DM, aim, retake…),
// игра с ботами, карты из мастерской, просмотр демок и рендер (CS2 под HLAE) — нет.
// Без -condebug сервер не узнать — тогда отсекаем только мастерскую и рендер.
fn counts(l: &Live, m: &MatchRec) -> bool {
    if workshop_map(&m.map) { return false; }
    if crate::render::process_running("HLAE.exe") { return false; }
    match l.src.as_str() {
        "demo" | "local" => false,
        "community" => l.src_name.to_lowercase().contains("faceit")
            || crate::render::process_running("faceitclient.exe")
            || crate::render::process_running("FACEIT.exe"),
        _ => true,
    }
}

fn finish_match(l: &mut Live, app: &AppHandle, finished: bool) {
    close_round(l);
    let Some(mut m) = l.cur.take() else { return };
    if !counts(l, &m) { return; }
    m.ended = Some(now_ms());
    m.finished = finished;
    if finished && !roundless(&m.mode) {
        let (mine, theirs) = if m.team == "CT" { (m.score_ct, m.score_t) } else { (m.score_t, m.score_ct) };
        m.result = if mine > theirs { "win" } else if mine < theirs { "loss" } else { "draw" }.into();
    }
    // пустой матч (зашёл и сразу вышел) не сохраняем
    if m.kills == 0 && m.deaths == 0 && m.rounds.is_empty() { return; }
    if let Some(s) = l.session.as_mut() { s.matches.push(m.id.clone()); }
    with_history(|h| {
        h.matches.retain(|x| x.id != m.id);
        h.matches.push(m.clone());
        // история за последние ~полгода: файл не растёт бесконечно
        let cut = now_ms().saturating_sub(183 * 86_400_000);
        h.matches.retain(|x| x.started >= cut);
    });
    save_history();
    let _ = app.emit("gsi-match-end", &m);
    let hl: Vec<String> = m.rounds.iter().filter(|r| !r.tags.is_empty()).map(|r| format!("R{} {}", r.round, r.tags[0])).collect();
    if finished && !hl.is_empty() {
        crate::toast::note(app, crate::toast::ToastNote {
            tag: "clipforge · хайлайты матча".into(),
            title: format!("{} · {} хайлайт{}", map_title(&m.map), hl.len(), if hl.len() == 1 { "" } else if hl.len() < 5 { "а" } else { "ов" }),
            sub: format!("{} · скачай демку в «Смотреть»", hl.iter().take(4).cloned().collect::<Vec<_>>().join(", ")),
            action: "home".into(),
        });
    }
}

fn map_title(map: &str) -> String {
    let n = map.trim_start_matches("de_").trim_start_matches("cs_");
    let mut c = n.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn end_session(l: &mut Live, app: &AppHandle) {
    if l.cur.is_some() { finish_match(l, app, false); }
    let Some(mut s) = l.session.take() else { return };
    s.ended = l.last_seen.max(s.started);
    // меньше пяти минут без матчей — не сессия (зашёл в меню и вышел)
    if s.matches.is_empty() && s.ended - s.started < 300_000 { return; }
    with_history(|h| {
        h.sessions.push(s.clone());
        let cut = now_ms().saturating_sub(183 * 86_400_000);
        h.sessions.retain(|x| x.started >= cut);
    });
    save_history();
    let _ = app.emit("gsi-session-end", &s);
    let ms: Vec<MatchRec> = with_history(|h| h.matches.iter().filter(|m| s.matches.contains(&m.id)).cloned().collect());
    if !ms.is_empty() {
        let (k, d, hs) = ms.iter().fold((0, 0, 0), |a, m| (a.0 + m.kills, a.1 + m.deaths, a.2 + m.hs));
        let mins = (s.ended - s.started) / 60_000;
        crate::toast::note(app, crate::toast::ToastNote {
            tag: "clipforge · итог сессии".into(),
            title: format!("{} матч{} · K/D {:.2}", ms.len(), if ms.len() == 1 { "" } else if ms.len() < 5 { "а" } else { "ей" }, k as f64 / d.max(1) as f64),
            sub: format!("{} ч {} мин · {} киллов · {}% в голову", mins / 60, mins % 60, k, if k > 0 { hs * 100 / k } else { 0 }),
            action: "home".into(),
        });
    }
}

fn s_u32(v: &Value, path: &[&str]) -> Option<u32> {
    let mut x = v;
    for p in path { x = x.get(p)?; }
    x.as_u64().map(|n| n as u32)
}
fn s_str<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut x = v;
    for p in path { x = x.get(p)?; }
    x.as_str()
}

fn handle(app: &AppHandle, v: Value) {
    if s_str(&v, &["auth", "token"]) != Some(TOKEN) { return; }
    let mut g = LIVE.lock().unwrap();
    let l = g.get_or_insert_with(Live::default);
    let now = now_ms();
    // время в игре по дням: между сообщениями (игра шлёт их хотя бы раз в 10 с), не больше 30 с за раз
    if l.last_seen > 0 {
        let dt = now.saturating_sub(l.last_seen).min(30_000);
        with_history(|h| *h.days.entry(local_day(now)).or_insert(0) += dt / 1000);
    }
    // перерыв больше 5 минут — новая сессия
    if l.session.is_some() && now.saturating_sub(l.last_seen) > 300_000 { end_session(l, app); }
    if l.session.is_none() { l.session = Some(SessionRec { started: now, ended: now, matches: vec![] }); }
    l.last_seen = now;
    if let Some(me) = s_str(&v, &["provider", "steamid"]) { l.me = me.to_string(); }

    let map = v.get("map");
    let map_name = map.and_then(|m| m.get("name")).and_then(|x| x.as_str()).unwrap_or("");
    let phase = map.and_then(|m| m.get("phase")).and_then(|x| x.as_str()).unwrap_or("");
    if map_name.is_empty() {
        // в меню: недоигранный матч закрываем
        if l.cur.is_some() { finish_match(l, app, false); }
    } else {
        let new_match = match &l.cur {
            None => phase != "gameover",
            Some(m) => m.map != map_name || (phase == "warmup" && !m.rounds.is_empty()),
        };
        if new_match {
            if l.cur.is_some() { finish_match(l, app, false); }
            l.cur = Some(MatchRec {
                id: now.to_string(), map: map_name.into(), mode: s_str(&v, &["map", "mode"]).unwrap_or("").into(),
                started: now, ..Default::default()
            });
            l.round_no = 0; l.rk = 0; l.rhs = 0; l.prev_rhs = 0; l.rknife = false; l.rmarked = false; l.last_kills = 0;
            l.src.clear(); l.src_name.clear();
        }
    }
    if l.cur.is_some() {
        let srv = server_now(l.session.as_ref().map(|s| s.started).unwrap_or(0));
        if !srv.kind.is_empty() { l.src = srv.kind; }
        if !srv.name.is_empty() { l.src_name = srv.name; }
        // map.round — сколько раундов сыграно: идёт раунд номер map.round + 1
        let played = s_u32(&v, &["map", "round"]).unwrap_or(0);
        let round_now = played + 1;
        if l.round_no != 0 && round_now != l.round_no { close_round(l); }
        l.round_no = round_now;
        let me_now = s_str(&v, &["player", "steamid"]) == Some(l.me.as_str());
        let m = l.cur.as_mut().unwrap();
        m.score_ct = s_u32(&v, &["map", "team_ct", "score"]).unwrap_or(m.score_ct);
        m.score_t = s_u32(&v, &["map", "team_t", "score"]).unwrap_or(m.score_t);
        // данные игрока — только свои (после смерти игра присылает того, за кем смотришь)
        if me_now && phase != "warmup" {
            if let Some(t) = s_str(&v, &["player", "team"]) { m.team = t.into(); }
            let ms = |k: &str| s_u32(&v, &["player", "match_stats", k]);
            let kills = ms("kills").unwrap_or(m.kills);
            m.deaths = ms("deaths").unwrap_or(m.deaths);
            m.assists = ms("assists").unwrap_or(m.assists);
            m.mvps = ms("mvps").unwrap_or(m.mvps);
            l.prev_weapon = l.weapon.clone();
            if let Some(ws) = v.get("player").and_then(|p| p.get("weapons")).and_then(|w| w.as_object()) {
                if let Some(w) = ws.values().find(|w| w.get("state").and_then(|s| s.as_str()) == Some("active")) {
                    l.weapon = w.get("name").and_then(|n| n.as_str()).unwrap_or("").trim_start_matches("weapon_").to_string();
                }
            }
            if kills > l.last_kills {
                let d = kills - l.last_kills;
                let knife = |w: &str| w.contains("knife") || w.contains("bayonet");
                // сразу после килла часто достают нож: тогда убил ствол из прошлого сообщения, а нож засчитываем,
                // только если он был в руках и до килла
                let gun = if knife(&l.weapon) && !l.prev_weapon.is_empty() && !knife(&l.prev_weapon) { &l.prev_weapon } else { &l.weapon };
                *m.weapons.entry(if gun.is_empty() { "?".into() } else { gun.clone() }).or_insert(0) += d;
                if knife(&l.weapon) && knife(&l.prev_weapon) { l.rknife = true; }
            }
            l.last_kills = kills;
            m.kills = kills;
            l.rk = l.rk.max(s_u32(&v, &["player", "state", "round_kills"]).unwrap_or(0));
            // хедшоты за матч — по приросту round_killhs (в DM он сбрасывается каждую жизнь, в раундах — каждый раунд)
            let rhs_now = s_u32(&v, &["player", "state", "round_killhs"]).unwrap_or(0);
            if rhs_now > l.prev_rhs { m.hs += rhs_now - l.prev_rhs; }
            l.prev_rhs = rhs_now;
            l.rhs = l.rhs.max(rhs_now);
        }
        if phase == "gameover" { finish_match(l, app, true); }
    }
    l.live = v;
    let _ = app.emit("gsi-update", live_view(l));
}

// ---- Где ты играешь: сервер из консоли CS2 (лог пишется с параметром запуска -condebug) ----
// Строка «CCreateGameClientJob creating client connection to '<куда>'»: IP:порт — комьюнити-сервер,
// «=[A:1:…]» — официальный сервер Valve (через Steam), loopback — своя игра с ботами, путь .dem — демка.
// Для комьюнити-сервера название и игроков спрашиваем у самого сервера (A2S_INFO — тот же запрос,
// что у браузера серверов в игре).
#[derive(Serialize, Clone, Default)]
pub struct ServerInfo {
    // "official" | "community" | "local" | "demo" | "" (неизвестно)
    pub kind: String,
    pub addr: String,
    pub name: String,
    pub players: u32,
    pub max: u32,
    // false — консоль CS2 не пишется в файл (нет -condebug в параметрах запуска)
    pub log: bool,
}

static CS2_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static SERVER: Mutex<Option<(ServerInfo, u64)>> = Mutex::new(None); // сведения и когда спрашивали

fn console_target(session_started: u64) -> (String, bool) {
    let Some(dir) = CS2_DIR.lock().unwrap().clone() else { return (String::new(), false) };
    let p = dir.join("console.log");
    let Ok(meta) = fs::metadata(&p) else { return (String::new(), false) };
    // лог от прошлого запуска игры (или от рендера) — не считается
    let fresh = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    if session_started > 0 && fresh + 60_000 < session_started { return (String::new(), false); }
    // лог не менялся с прошлого раза — тот же ответ (игра шлёт сообщения дважды в секунду)
    static LAST: Mutex<Option<(u64, u64, String)>> = Mutex::new(None);
    if let Some((l, t, target)) = LAST.lock().unwrap().as_ref() {
        if *l == meta.len() && *t == fresh { return (target.clone(), true); }
    }
    let Ok(mut f) = fs::File::open(&p) else { return (String::new(), false) };
    use std::io::Seek;
    let len = meta.len();
    let _ = f.seek(std::io::SeekFrom::Start(len.saturating_sub(512 * 1024)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut target = String::new();
    for l in text.lines() {
        if let Some(i) = l.find("creating client connection to '") {
            let rest = &l[i + "creating client connection to '".len()..];
            target = rest.split('\'').next().unwrap_or("").to_string();
        } else if l.contains("Disconnecting from server") {
            target.clear();
        }
    }
    *LAST.lock().unwrap() = Some((len, fresh, target.clone()));
    (target, true)
}

// A2S_INFO: название сервера, карта, игроки. Отвечает за ~50 мс; ответ-вызов (challenge) — повторяем с ним
fn a2s_info(addr: &str) -> Option<(String, u32, u32)> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(1200))).ok()?;
    let mut q = b"\xFF\xFF\xFF\xFFTSource Engine Query\0".to_vec();
    let mut buf = [0u8; 1400];
    for _ in 0..2 {
        sock.send_to(&q, addr).ok()?;
        let n = sock.recv(&mut buf).ok()?;
        let b = &buf[..n];
        if n >= 9 && b[4] == 0x41 {
            q.truncate(25);
            q.extend_from_slice(&b[5..9]);
            continue;
        }
        if n < 6 || b[4] != 0x49 { return None; }
        let mut i = 6; // заголовок и версия протокола
        let mut cstr = || {
            let s = i;
            while i < n && b[i] != 0 { i += 1; }
            let out = String::from_utf8_lossy(&b[s..i]).to_string();
            i += 1;
            out
        };
        let name = cstr();
        let _map = cstr();
        let _folder = cstr();
        let _game = cstr();
        let at = i + 2; // id игры (2 байта)
        if at + 3 > n { return Some((name, 0, 0)); }
        let (players, max, bots) = (b[at] as u32, b[at + 1] as u32, b[at + 2] as u32);
        return Some((name, players.saturating_sub(bots), max));
    }
    None
}

fn server_now(session_started: u64) -> ServerInfo {
    let (target, log) = console_target(session_started);
    let kind = if target.is_empty() { "" }
        else if target.ends_with(".dem") { "demo" }
        else if target.starts_with("loopback") { "local" }
        else if target.split(':').next().is_some_and(|h| h.split('.').count() == 4 && h.split('.').all(|x| x.parse::<u8>().is_ok())) { "community" }
        // не IP — адрес в сети Steam («=[A:1:…]» и подобные): так подключают только официальные серверы Valve
        else { "official" };
    let mut info = ServerInfo { kind: kind.into(), addr: if kind == "community" { target.clone() } else { String::new() }, log, ..Default::default() };
    if kind == "community" {
        let mut cache = SERVER.lock().unwrap();
        let stale = !cache.as_ref().is_some_and(|(s, at)| s.addr == target && now_ms().saturating_sub(*at) < 30_000);
        if let Some((s, _)) = cache.as_ref().filter(|(s, _)| s.addr == target) {
            info.name = s.name.clone(); info.players = s.players; info.max = s.max;
        }
        if stale {
            // сразу запоминаем, что спросили, и спрашиваем в фоне: сообщение игры не ждёт сеть
            let keep = cache.as_ref().filter(|(s, _)| s.addr == target).map(|(s, _)| s.clone()).unwrap_or_else(|| info.clone());
            *cache = Some((keep, now_ms()));
            let t = target.clone();
            thread::spawn(move || {
                if let Some((name, players, max)) = a2s_info(&t) {
                    let mut c = SERVER.lock().unwrap();
                    *c = Some((ServerInfo { kind: "community".into(), addr: t, name, players, max, log: true }, now_ms()));
                }
            });
        }
    }
    info
}

// Что сейчас в игре — для главной и живой строки
#[derive(Serialize, Clone)]
pub struct LiveView {
    pub connected: bool,
    pub map: String,
    pub phase: String,
    pub round: u32,
    pub score_ct: u32,
    pub score_t: u32,
    pub team: String,
    pub kills: u32,
    pub deaths: u32,
    pub hs: u32,
    pub round_kills: u32,
    pub highlights: Vec<RoundRec>,
    pub session_started: Option<u64>,
    pub mark_key: &'static str,
    // режим из игры: competitive, premier, deathmatch, casual, scrimcomp2v2…
    pub mode: String,
    // "menu" — в главном меню, "playing" — в матче
    pub activity: String,
    pub server: ServerInfo,
}

fn live_view(l: &Live) -> LiveView {
    let connected = now_ms().saturating_sub(l.last_seen) < 40_000 && l.last_seen > 0;
    let m = l.cur.as_ref();
    LiveView {
        connected,
        map: m.map(|m| m.map.clone()).unwrap_or_default(),
        phase: s_str(&l.live, &["map", "phase"]).unwrap_or("").into(),
        round: l.round_no,
        score_ct: m.map(|m| m.score_ct).unwrap_or(0),
        score_t: m.map(|m| m.score_t).unwrap_or(0),
        team: m.map(|m| m.team.clone()).unwrap_or_default(),
        kills: m.map(|m| m.kills).unwrap_or(0),
        deaths: m.map(|m| m.deaths).unwrap_or(0),
        hs: m.map(|m| m.hs).unwrap_or(0),
        round_kills: l.rk,
        highlights: m.map(|m| m.rounds.iter().filter(|r| !r.tags.is_empty()).cloned().collect()).unwrap_or_default(),
        session_started: l.session.as_ref().map(|s| s.started),
        mark_key: MARK_KEY_NAME,
        mode: s_str(&l.live, &["map", "mode"]).unwrap_or("").into(),
        activity: s_str(&l.live, &["player", "activity"]).unwrap_or("").into(),
        server: if connected { server_now(l.session.as_ref().map(|s| s.started).unwrap_or(0)) } else { ServerInfo::default() },
    }
}

fn serve(app: AppHandle, mut s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut need: Option<usize> = None;
    loop {
        let Ok(n) = s.read(&mut chunk) else { break };
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        if need.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|x| x.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                need = Some(pos + 4 + len);
            }
        }
        if need.is_some_and(|n| buf.len() >= n) { break; }
        if buf.len() > 4 << 20 { break; }
    }
    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        if let Ok(v) = serde_json::from_slice::<Value>(&buf[pos + 4..]) { handle(&app, v); }
    }
}

// «Запомни этот момент»: системная клавиша, закладка на текущий раунд
fn mark(app: &AppHandle) {
    let mut g = LIVE.lock().unwrap();
    let Some(l) = g.as_mut() else { return };
    if l.cur.is_none() || l.round_no == 0 { return; }
    l.rmarked = true;
    let round = l.round_no;
    let map = l.cur.as_ref().map(|m| map_title(&m.map)).unwrap_or_default();
    let _ = app.emit("gsi-mark", round);
    crate::toast::note(app, crate::toast::ToastNote {
        tag: "clipforge · закладка".into(),
        title: format!("Момент запомнен · R{round}"),
        sub: format!("{map} · раунд попадёт в «Эдит», когда скачаешь демку"),
        action: String::new(),
    });
}

fn hotkey_thread(app: AppHandle) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_NOREPEAT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
    thread::spawn(move || unsafe {
        if RegisterHotKey(std::ptr::null_mut(), 1, MOD_NOREPEAT, MARK_KEY) == 0 { return; }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_HOTKEY { mark(&app); }
        }
    });
}

// Запуск при старте программы: приём сообщений игры, клавиша закладки, проверка конца сессии
pub fn start(app: AppHandle) {
    let a = app.clone();
    thread::spawn(move || {
        let Ok(l) = TcpListener::bind(("127.0.0.1", PORT)) else { return };
        for s in l.incoming().flatten() {
            let a = a.clone();
            thread::spawn(move || serve(a, s));
        }
    });
    hotkey_thread(app.clone());
    // игра замолчала: закрыта — сессия кончилась сразу; открыта, но молчит дольше 40 с — «нет связи».
    // Последнее сообщение игры при закрытии не приходит, поэтому экран обновляем отсюда
    thread::spawn(move || {
        let mut was_connected = false;
        loop {
            thread::sleep(Duration::from_secs(5));
            let (idle, session) = {
                let g = LIVE.lock().unwrap();
                g.as_ref().map(|l| (now_ms().saturating_sub(l.last_seen), l.session.is_some())).unwrap_or((u64::MAX, false))
            };
            let connected = idle < 40_000;
            let closed = idle > 12_000 && session && !crate::render::process_running("cs2.exe");
            if closed || (was_connected && !connected) {
                let mut g = LIVE.lock().unwrap();
                if let Some(l) = g.as_mut() {
                    if closed {
                        end_session(l, &app);
                        // игры нет — и связи нет, даже если последнее сообщение было недавно
                        l.last_seen = now_ms().saturating_sub(60_000);
                        l.live = Value::Null;
                    }
                    let _ = app.emit("gsi-update", live_view(l));
                }
            }
            was_connected = connected && !closed;
        }
    });
}

// Конфиг для игры: game\csgo\cfg\gamestate_integration_clipforge.cfg. true — записан заново
// (если CS2 уже запущена, данные пойдут после её перезапуска)
#[tauri::command]
pub async fn gsi_install(cs2: String) -> Result<bool, String> {
    let exe = Path::new(&cs2);
    let game = exe.ancestors().nth(3).ok_or("неверный путь к cs2.exe")?;
    // там же лог консоли (console.log) — по нему видно, на каком ты сервере
    *CS2_DIR.lock().unwrap() = Some(game.join("csgo"));
    let dir = game.join("csgo").join("cfg");
    if !dir.exists() { return Err(format!("нет папки {}", dir.display())); }
    let body = format!(
        "\"clipforge\"\n{{\n  \"uri\" \"http://127.0.0.1:{PORT}\"\n  \"timeout\" \"5.0\"\n  \"buffer\" \"0.1\"\n  \"throttle\" \"0.5\"\n  \"heartbeat\" \"10.0\"\n  \"auth\" {{ \"token\" \"{TOKEN}\" }}\n  \"data\"\n  {{\n    \"provider\" \"1\"\n    \"map\" \"1\"\n    \"round\" \"1\"\n    \"player_id\" \"1\"\n    \"player_state\" \"1\"\n    \"player_match_stats\" \"1\"\n    \"player_weapons\" \"1\"\n  }}\n}}\n"
    );
    let path = dir.join("gamestate_integration_clipforge.cfg");
    if fs::read_to_string(&path).ok().as_deref() == Some(body.as_str()) { return Ok(false); }
    fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(true)
}

#[derive(Serialize)]
pub struct HomeData {
    pub history: History,
    pub live: LiveView,
}

#[tauri::command]
pub async fn gsi_home() -> HomeData {
    let history = with_history(|h| h.clone());
    let g = LIVE.lock().unwrap();
    let live = g.as_ref().map(live_view).unwrap_or_else(|| live_view(&Live::default()));
    HomeData { history, live }
}

// Часы CS2 из Steam (localconfig.vdf активного аккаунта): всего и за 2 недели, в минутах
#[derive(Serialize, Default)]
pub struct Playtime {
    pub total: u64,
    pub two_weeks: u64,
    pub last_played: u64,
    // ник в Steam и SteamID64 аккаунта
    pub name: String,
    pub steamid: String,
}

// ник аккаунта из loginusers.vdf: блок "<steamid>" { ... "PersonaName" "..." }
pub(crate) fn persona(root: &str, id: &str) -> String {
    let Ok(raw) = fs::read(Path::new(root).join("config").join("loginusers.vdf")) else { return String::new() };
    let vdf = String::from_utf8_lossy(&raw);
    let Some(at) = vdf.find(&format!("\"{id}\"")) else { return String::new() };
    vdf[at..].lines().take(12).find(|l| l.trim_start().starts_with("\"PersonaName\""))
        .and_then(|l| l.split('"').nth(3)).unwrap_or("").to_string()
}

#[tauri::command]
pub async fn steam_playtime() -> Playtime {
    let ids = crate::gallery::steam_ids();
    let root = crate::gallery::steam_root();
    for id in ids {
        let Ok(n) = id.parse::<u64>() else { continue };
        let acc = n.saturating_sub(76561197960265728);
        let p = Path::new(&root).join("userdata").join(acc.to_string()).join("config").join("localconfig.vdf");
        // в файле бывают строки не в UTF-8 (названия, ники) — читаем с заменой битых символов
        let Ok(raw) = fs::read(&p) else { continue };
        let text = String::from_utf8_lossy(&raw);
        // блок "730" в разделе apps — первые значения после него
        // ключ "730" встречается в нескольких разделах — нужен тот, где есть часы
        // блок — от "730" до его закрывающей скобки (вложенные блоки считаем по глубине)
        let block_at = |at: usize| {
            let mut depth = 0i32;
            let mut out = Vec::new();
            for l in text[at..].lines().skip(1) {
                let t = l.trim();
                if t == "{" { depth += 1; continue; }
                if t == "}" { depth -= 1; if depth <= 0 { break; } continue; }
                if depth == 1 { out.push(l); }
                if out.len() > 200 { break; }
            }
            out.join("\n")
        };
        let Some(block) = text.match_indices("\"730\"").map(|(at, _)| block_at(at))
            .find(|b| b.lines().any(|l| l.trim_start().starts_with("\"Playtime\""))) else { continue };
        let val = |k: &str| block.lines().find(|l| l.trim_start().starts_with(&format!("\"{k}\"")))
            .and_then(|l| l.split('"').nth(3)).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        let pt = Playtime {
            total: val("Playtime"), two_weeks: val("Playtime2wks"), last_played: val("LastPlayed"),
            name: persona(&root, &id), steamid: id.clone(),
        };
        if pt.total > 0 { return pt; }
    }
    Playtime::default()
}



