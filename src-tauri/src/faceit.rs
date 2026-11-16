// Демки с FACEIT для «Истории игр» на главной.
// Прямой ссылки на демку Data API не даёт: файлы лежат за подписанными ссылками Downloads API,
// а к нему FACEIT пускает только по заявке. Поэтому: находим матч по ключу Data API (тот же, что для
// уровней), открываем комнату матча в браузере, человек жмёт «Watch demo», а faceit_import забирает
// скачанный 1-<uuid>-1-1.dem.zst (или .gz) из «Загрузок», распаковывает и кладёт в csgo\replays.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct FaceitMatch {
    pub id: String,
    pub url: String,
    pub started: u64, // мс
    pub finished: u64,
    pub map: String,
    pub score: String, // «13:9» со стороны игрока
    pub result: String, // win | loss | ""
    pub stats: Option<FcStats>,
}

// статистика игрока за матч и рейтинг clipforge по ней
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FcStats {
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub hs: u32,
    pub adr: f64,
    pub rounds: u32,
    pub rating: f64,
}

// Своего рейтинга FACEIT в Data API не отдаёт, поэтому считаем приближение HLTV 2.0.
// KAST в статистике тоже нет: оцениваем его по выжитым раундам и убийствам/ассистам.
fn rating(k: u32, d: u32, a: u32, adr: f64, r: u32) -> f64 {
    if r == 0 { return 0.0; }
    let r = r as f64;
    let (kpr, dpr, apr) = (k as f64 / r, d as f64 / r, a as f64 / r);
    let kast = (((r - d as f64).max(0.0) + 0.5 * (k + a) as f64) / r).clamp(0.3, 0.95) * 100.0;
    let impact = 2.13 * kpr + 0.42 * apr - 0.41;
    let v = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
    (v.max(0.0) * 100.0).round() / 100.0
}

fn num(v: &Value) -> f64 {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0.0)
}

fn stats_of(s: &Value) -> Option<FcStats> {
    let (k, d, a) = (num(&s["Kills"]) as u32, num(&s["Deaths"]) as u32, num(&s["Assists"]) as u32);
    let adr = num(&s["ADR"]);
    let mut rounds = num(&s["Rounds"]) as u32;
    if rounds == 0 {
        // «13 / 16» — сумма счёта
        rounds = s["Score"].as_str().unwrap_or("").split('/').filter_map(|x| x.trim().parse::<u32>().ok()).sum();
    }
    if rounds == 0 || k + d == 0 { return None; }
    Some(FcStats { kills: k, deaths: d, assists: a, hs: num(&s["Headshots"]) as u32, adr, rounds, rating: rating(k, d, a, adr, rounds) })
}

// карта матча не меняется — второй раз за ней не ходим
static MAPS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn get(key: &str, url: &str) -> Result<Value, String> {
    match ureq::get(url).header("Authorization", &format!("Bearer {}", key.trim())).call() {
        Ok(mut r) => serde_json::from_str(&r.body_mut().read_to_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        Err(ureq::Error::StatusCode(401 | 403)) => Err("FACEIT не принял ключ API".into()),
        Err(ureq::Error::StatusCode(404)) => Err("404".into()),
        Err(e) => Err(format!("FACEIT не отвечает: {e}")),
    }
}

fn map_of(key: &str, id: &str) -> String {
    if let Some(m) = MAPS.lock().unwrap().as_ref().and_then(|c| c.get(id)) { return m.clone(); }
    let Ok(v) = get(key, &format!("https://open.faceit.com/data/v4/matches/{id}")) else { return String::new() };
    let map = v["voting"]["map"]["pick"][0].as_str().unwrap_or("").to_string();
    if !map.is_empty() { MAPS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.into(), map.clone()); }
    map
}

// Последние матчи игрока на FACEIT (по SteamID64). Без аккаунта FACEIT — пустой список.
#[tauri::command]
pub async fn faceit_recent(key: String, steamid: String) -> Result<Vec<FaceitMatch>, String> {
    let player = match get(&key, &format!("https://open.faceit.com/data/v4/players?game=cs2&game_player_id={steamid}")) {
        Ok(v) => v,
        Err(e) if e == "404" => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let pid = player["player_id"].as_str().ok_or("FACEIT: нет player_id")?.to_string();
    let hist = get(&key, &format!("https://open.faceit.com/data/v4/players/{pid}/history?game=cs2&offset=0&limit=15"))?;
    // статистика тех же матчей одним запросом; не ответил — строки просто без рейтинга
    let mut st: HashMap<String, FcStats> = HashMap::new();
    if let Ok(g) = get(&key, &format!("https://open.faceit.com/data/v4/players/{pid}/games/cs2/stats?offset=0&limit=20")) {
        for it in g["items"].as_array().cloned().unwrap_or_default() {
            let s = &it["stats"];
            if let (Some(id), Some(x)) = (s["Match Id"].as_str(), stats_of(s)) { st.insert(id.into(), x); }
        }
    }
    let mut out = vec![];
    for m in hist["items"].as_array().cloned().unwrap_or_default() {
        let Some(id) = m["match_id"].as_str() else { continue };
        // в какой команде игрок
        let side = ["faction1", "faction2"].into_iter().find(|f| {
            m["teams"][f]["players"].as_array().is_some_and(|ps| ps.iter().any(|p| p["player_id"].as_str() == Some(pid.as_str())))
        });
        let (mine, theirs) = match side { Some("faction2") => ("faction2", "faction1"), _ => ("faction1", "faction2") };
        let sc = &m["results"]["score"];
        let score = match (sc[mine].as_u64(), sc[theirs].as_u64()) { (Some(a), Some(b)) => format!("{a}:{b}"), _ => String::new() };
        let result = match (side, m["results"]["winner"].as_str()) {
            (Some(s), Some(w)) if w == s => "win",
            (Some(_), Some(w)) if !w.is_empty() => "loss",
            _ => "",
        };
        out.push(FaceitMatch {
            id: id.into(),
            url: m["faceit_url"].as_str().unwrap_or("").replace("{lang}", "en"),
            started: m["started_at"].as_u64().unwrap_or(0) * 1000,
            finished: m["finished_at"].as_u64().unwrap_or(0) * 1000,
            map: map_of(&key, id),
            score,
            result: result.into(),
            stats: st.get(id).cloned(),
        });
    }
    Ok(out)
}

// Матч FACEIT для вкладки «FACEIT» в разборе демки: id берётся из имени файла (1-<uuid>-1-1.dem).
// Состав с аватарками и уровнями — из /matches/{id}, вся статистика игроков — из /matches/{id}/stats.
// Готовый матч не меняется, поэтому второй раз за ним не ходим.
static MATCHES: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

fn player_of(s: &Value, roster: &Value) -> Value {
    let st = &s["player_stats"];
    let n = |k: &str| num(&st[k]);
    let u = |k: &str| num(&st[k]) as u64;
    let id = s["player_id"].as_str().unwrap_or("");
    let r = roster.as_array().and_then(|l| l.iter().find(|p| p["player_id"].as_str() == Some(id))).cloned().unwrap_or(Value::Null);
    json!({
        "id": id, "nick": s["nickname"], "avatar": r["avatar"], "level": r["game_skill_level"], "steamid": r["game_player_id"],
        "kills": u("Kills"), "deaths": u("Deaths"), "assists": u("Assists"), "adr": n("ADR"), "hsp": u("Headshots %"),
        "mvps": u("MVPs"), "k2": u("Double Kills"), "k3": u("Triple Kills"), "k4": u("Quadro Kills"), "k5": u("Penta Kills"),
        "entries": u("Entry Count"), "entryWins": u("Entry Wins"), "firstKills": u("First Kills"),
        "c1": u("1v1Count"), "c1w": u("1v1Wins"), "c2": u("1v2Count"), "c2w": u("1v2Wins"), "clutchKills": u("Clutch Kills"),
        "flashes": u("Flash Count"), "flashHits": u("Flash Successes"), "flashed": u("Enemies Flashed"),
        "utilDmg": u("Utility Damage"), "sniper": u("Sniper Kills"), "pistol": u("Pistol Kills"), "knife": u("Knife Kills"), "zeus": u("Zeus Kills"),
    })
}

#[tauri::command]
pub async fn faceit_match(key: String, id: String) -> Result<Value, String> {
    if !id.starts_with("1-") || id.len() > 40 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("не id матча FACEIT".into()); }
    if let Some(v) = MATCHES.lock().unwrap().as_ref().and_then(|c| c.get(&id)) { return Ok(v.clone()); }
    const API: &str = "https://open.faceit.com/data/v4";
    let m = get(&key, &format!("{API}/matches/{id}")).map_err(|e| if e == "404" { "FACEIT не знает этот матч".into() } else { e })?;
    let s = get(&key, &format!("{API}/matches/{id}/stats")).map_err(|e| if e == "404" { "FACEIT ещё не посчитал статистику матча".into() } else { e })?;
    let rs = &s["rounds"][0];
    let rounds = num(&rs["round_stats"]["Rounds"]) as u32;
    let rosters: Vec<Value> = ["faction1", "faction2"].iter().map(|f| m["teams"][f]["roster"].clone()).collect();
    let mut teams: Vec<Value> = rs["teams"].as_array().cloned().unwrap_or_default().iter().map(|t| {
        let ts = &t["team_stats"];
        let first = t["players"].as_array().and_then(|l| l.first()).and_then(|p| p["player_id"].as_str()).unwrap_or("");
        // какой фракции команда — по первому игроку
        let fi = rosters.iter().position(|r| r.as_array().is_some_and(|l| l.iter().any(|p| p["player_id"].as_str() == Some(first)))).unwrap_or(0);
        let fac = &m["teams"][["faction1", "faction2"][fi]];
        let mut players: Vec<Value> = t["players"].as_array().cloned().unwrap_or_default().iter().map(|p| {
            let mut v = player_of(p, &rosters[fi]);
            let g = |k: &str| v[k].as_u64().unwrap_or(0) as u32;
            v["rating"] = json!(rating(g("kills"), g("deaths"), g("assists"), v["adr"].as_f64().unwrap_or(0.0), rounds));
            v
        }).collect();
        players.sort_by(|a, b| b["rating"].as_f64().partial_cmp(&a["rating"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        json!({
            "name": fac["name"].as_str().or(ts["Team"].as_str()).unwrap_or("").trim_start_matches("team_"),
            "avatar": fac["avatar"], "win": num(&ts["Team Win"]) > 0.0, "score": num(&ts["Final Score"]) as u32,
            "first": num(&ts["First Half Score"]) as u32, "second": num(&ts["Second Half Score"]) as u32, "ot": num(&ts["Overtime score"]) as u32,
            "players": players,
        })
    }).collect();
    teams.sort_by_key(|t| !t["win"].as_bool().unwrap_or(false));
    let v = json!({
        "id": id, "url": m["faceit_url"].as_str().unwrap_or("").replace("{lang}", "en"),
        "competition": m["competition_name"], "region": m["region"], "bestOf": m["best_of"], "elo": m["calculate_elo"],
        "location": m["voting"]["location"]["pick"][0], "started": m["started_at"], "finished": m["finished_at"],
        "rounds": rounds, "teams": teams,
    });
    MATCHES.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, v.clone());
    Ok(v)
}

// Комната матча в браузере по умолчанию — там кнопка «Watch demo»
#[tauri::command]
pub fn faceit_open(url: String) -> Result<(), String> {
    if !url.starts_with("https://www.faceit.com/") { return Err("не ссылка FACEIT".into()); }
    Command::new("explorer").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Папка «Загрузки» (её могут перенести — смотрим реестр)
fn downloads_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    crate::gallery::reg(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders", "{374DE290-123F-4565-9164-39C4925E467B}")
        .map(|p| PathBuf::from(p.replace("%USERPROFILE%", &home)))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| Path::new(&home).join("Downloads"))
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) }
fn mtime(p: &Path) -> u64 {
    fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

// Имя демки FACEIT: 1-<uuid>-1-1.dem[.zst|.gz] → (имя .dem, сжатие)
fn faceit_name(file: &str) -> Option<(String, &'static str)> {
    let low = file.to_ascii_lowercase();
    let (stem, kind) = if let Some(s) = low.strip_suffix(".dem.zst") { (s, "zst") }
        else if let Some(s) = low.strip_suffix(".dem.gz") { (s, "gz") }
        else if let Some(s) = low.strip_suffix(".dem") { (s, "") }
        else { return None };
    // браузер дописывает « (1)» к повторному скачиванию
    let stem = stem.split(" (").next().unwrap_or(stem).trim();
    let b = stem.as_bytes();
    let uuid_ok = b.len() >= 38 && stem.starts_with("1-") && b[2..38].iter().enumerate()
        .all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() });
    uuid_ok.then(|| (format!("{stem}.dem"), kind))
}

fn unpack(src: &Path, kind: &str, dst: &Path) -> io::Result<()> {
    let tmp = dst.with_extension("dem.part");
    {
        let f = io::BufReader::new(fs::File::open(src)?);
        let mut out = io::BufWriter::new(fs::File::create(&tmp)?);
        let mut r: Box<dyn Read> = match kind {
            "zst" => Box::new(ruzstd::decoding::StreamingDecoder::new(f).map_err(|e| io::Error::other(e.to_string()))?),
            "gz" => Box::new(flate2::read::GzDecoder::new(f)),
            _ => Box::new(f),
        };
        io::copy(&mut r, &mut out)?;
        out.flush()?;
    }
    fs::rename(&tmp, dst).inspect_err(|_| { let _ = fs::remove_file(&tmp); })
}

#[derive(Serialize)]
pub struct Imported {
    pub path: String,
    pub fixed: bool, // демка была сломана (курица FACEIT, см. scripts/fixdemo.cjs) и исправлена
}

// Демки FACEIT с питомцем-курицей роняют CS2 на playdemo — чиним сразу, чтобы её можно было смотреть
// и из самой игры. Не вышло — не страшно: parse.cjs попробует ещё раз при открытии демки.
fn fix_chicken(dem: &Path) -> bool {
    let Some(p) = dem.to_str() else { return false };
    crate::render::run_node("fixdemo.cjs", &[p])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v.is_object() && v.get("error").is_none())
}

// Забрать свежие (до 3 дней) демки FACEIT из «Загрузок» в csgo\replays. Возвращает новые демки.
// Сам скачанный файл не трогаем — он остаётся в «Загрузках».
#[tauri::command]
pub async fn faceit_import(cs2: String) -> Result<Vec<Imported>, String> {
    let game = Path::new(&cs2).ancestors().nth(3).ok_or("нет пути к CS2")?;
    let replays = game.join("csgo").join("replays");
    fs::create_dir_all(&replays).map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut out = vec![];
    let mut errs = vec![];
    for e in fs::read_dir(downloads_dir()).map_err(|e| e.to_string())?.flatten() {
        // только файлы: архиватор мог оставить папку с таким же именем, как у демки
        if !e.file_type().is_ok_and(|t| t.is_file()) { continue; }
        let p = e.path();
        let Some((name, kind)) = p.file_name().and_then(|n| n.to_str()).and_then(faceit_name) else { continue };
        let t = mtime(&p);
        // ещё качается или старьё
        if now.saturating_sub(t) < 2000 || now.saturating_sub(t) > 3 * 86_400_000 { continue; }
        let dst = replays.join(&name);
        if fs::metadata(&dst).is_ok_and(|m| m.len() > 0) { continue; }
        // один битый файл не мешает забрать остальные
        match unpack(&p, kind, &dst) {
            Ok(()) => out.push(Imported { fixed: fix_chicken(&dst), path: dst.to_string_lossy().into_owned() }),
            Err(e) => errs.push(format!("не получилось распаковать {name}: {e}")),
        }
    }
    if out.is_empty() && !errs.is_empty() { return Err(errs.join("; ")); }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        let id = "1-0a1b2c3d-1111-2222-3333-444455556666";
        assert_eq!(faceit_name(&format!("{id}-1-1.dem.zst")), Some((format!("{id}-1-1.dem"), "zst")));
        assert_eq!(faceit_name(&format!("{id}-1-1.dem (1).gz")), None);
        assert_eq!(faceit_name(&format!("{id}-1-1 (1).dem.gz")), Some((format!("{id}-1-1.dem"), "gz")));
        assert_eq!(faceit_name("match730_003.dem"), None);
        assert_eq!(faceit_name(&format!("{id}-1-1.dem.zst.crdownload")), None);
    }

    #[test]
    fn ratings() {
        assert_eq!(rating(20, 22, 10, 80.8, 29), 1.10);
        assert_eq!(rating(24, 16, 6, 93.3, 24), 1.59);
        assert!(rating(12, 21, 1, 67.0, 22) < 0.85);
        assert!(rating(23, 13, 7, 119.4, 18) > 1.8);
        assert_eq!(rating(0, 0, 0, 0.0, 0), 0.0);
        let s = serde_json::json!({ "Kills": "20", "Deaths": "22", "Assists": "10", "ADR": "80.8", "Score": "13 / 16" });
        assert_eq!(stats_of(&s).unwrap().rounds, 29);
    }

    #[test]
    fn unpacks() {
        let dir = std::env::temp_dir().join("cf-faceit-test");
        let _ = fs::create_dir_all(&dir);
        let data = b"PBDEMS2\0 hello demo ".repeat(5000);
        let gz = dir.join("a.dem.gz");
        let mut e = flate2::write::GzEncoder::new(fs::File::create(&gz).unwrap(), flate2::Compression::fast());
        e.write_all(&data).unwrap();
        e.finish().unwrap();
        let zst = dir.join("b.dem.zst");
        fs::write(&zst, ruzstd::encoding::compress_to_vec(&data[..], ruzstd::encoding::CompressionLevel::Fastest)).unwrap();
        for (src, kind) in [(gz, "gz"), (zst, "zst")] {
            let dst = dir.join(format!("out-{kind}.dem"));
            unpack(&src, kind, &dst).unwrap();
            assert_eq!(fs::read(&dst).unwrap(), data);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod real_file {
    // настоящая демка FACEIT: CF_ZST=путь\к\файлу.dem.zst cargo test --lib real_zst -- --ignored
    #[test]
    #[ignore]
    fn real_zst() {
        let src = std::path::PathBuf::from(std::env::var("CF_ZST").unwrap());
        let dst = std::path::PathBuf::from(std::env::var("CF_OUT").unwrap());
        super::unpack(&src, "zst", &dst).unwrap();
        let mut head = [0u8; 8];
        std::io::Read::read_exact(&mut std::fs::File::open(&dst).unwrap(), &mut head).unwrap();
        assert_eq!(&head, b"PBDEMS2\0");
        println!("{} bytes", std::fs::metadata(&dst).unwrap().len());
    }
}
