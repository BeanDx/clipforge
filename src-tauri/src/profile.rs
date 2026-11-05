// Вкладка «Профиль»: открытый профиль Steam (без ключа, XML с steamcommunity.com) и статистика FACEIT
// (Data API, ключ из «Настроек»). Кого показывать — SteamID64, ссылка на профиль Steam,
// её короткое имя (/id/...) или ссылка / ник FACEIT.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct SteamProfile {
    pub steamid: String,
    pub name: String,
    pub avatar: String,
    pub online: String, // online | offline | in-game
    pub status: String, // «Online», «In-Game Counter-Strike 2», «Last Online 3 hrs ago»
    pub game: String,
    pub vac: bool,
    pub trade_ban: String,
    pub limited: bool,
    pub since: String, // «December 3, 2021»
    pub url: String,
    pub location: String,
    pub public: bool,
    // Steam не ответил (чаще всего 429 — слишком много запросов): данные из кэша или с этого компьютера
    pub stale: bool,
}

// значение тега: <tag><![CDATA[...]]></tag> или <tag>...</tag>; в нике Steam экранирует &, <, >
fn tag(xml: &str, name: &str) -> String {
    let open = format!("<{name}>");
    let Some(a) = xml.find(&open).map(|i| i + open.len()) else { return String::new() };
    let Some(b) = xml[a..].find(&format!("</{name}>")).map(|i| a + i) else { return String::new() };
    let v = xml[a..b].trim();
    let v = v.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(v);
    v.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

// SteamID64, ссылка /profiles/<id> или /id/<имя>, либо просто короткое имя
fn steam_url(q: &str) -> String {
    let q = q.trim().trim_end_matches('/');
    if let Some(at) = q.find("/profiles/") { return format!("https://steamcommunity.com/profiles/{}", &q[at + 10..].split('/').next().unwrap_or("")); }
    if let Some(at) = q.find("/id/") { return format!("https://steamcommunity.com/id/{}", &q[at + 4..].split('/').next().unwrap_or("")); }
    if q.len() == 17 && q.starts_with("7656") && q.bytes().all(|c| c.is_ascii_digit()) { return format!("https://steamcommunity.com/profiles/{q}"); }
    format!("https://steamcommunity.com/id/{q}")
}

// Кэш профилей Steam: steamcommunity.com быстро отвечает 429 на частые запросы с одного IP.
// Свежий (до 10 минут) отдаём без запроса, старый — когда Steam не отвечает. Лежит рядом с history.json.
const FRESH_MS: u64 = 10 * 60_000;
static CACHE: Mutex<Option<HashMap<String, (u64, SteamProfile)>>> = Mutex::new(None);

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) }
fn cache_file() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("clipforge").join("steam-profiles.json")
}
fn with_cache<R>(f: impl FnOnce(&mut HashMap<String, (u64, SteamProfile)>) -> R) -> R {
    let mut g = CACHE.lock().unwrap();
    let c = g.get_or_insert_with(|| fs::read(cache_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    f(c)
}
fn remember(keys: &[String], p: &SteamProfile) {
    let at = now_ms();
    let snapshot = with_cache(|c| {
        for k in keys { c.insert(k.clone(), (at, p.clone())); }
        serde_json::to_vec(c).ok()
    });
    if let Some(b) = snapshot {
        let f = cache_file();
        let _ = fs::create_dir_all(f.parent().unwrap_or(Path::new(".")));
        let _ = fs::write(f, b);
    }
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 { s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' }); }
    }
    s
}

// Свой аккаунт без сети: ник из loginusers.vdf и аватар из кэша Steam (config\avatarcache\<id>.png)
fn local_profile(id: &str) -> Option<SteamProfile> {
    if !crate::gallery::steam_ids().iter().any(|x| x == id) { return None; }
    let root = crate::gallery::steam_root();
    let avatar = fs::read(Path::new(&root).join("config").join("avatarcache").join(format!("{id}.png")))
        .map(|b| format!("data:image/png;base64,{}", b64(&b))).unwrap_or_default();
    Some(SteamProfile {
        steamid: id.into(), name: crate::gsi::persona(&root, id), avatar,
        url: format!("https://steamcommunity.com/profiles/{id}"), public: true, stale: true, ..Default::default()
    })
}

#[tauri::command]
pub async fn steam_profile(query: String) -> Result<SteamProfile, String> {
    let url = steam_url(&query);
    if let Some((at, p)) = with_cache(|c| c.get(&url).cloned()) {
        if now_ms().saturating_sub(at) < FRESH_MS { return Ok(p); }
    }
    match fetch_profile(&url) {
        Ok(p) => {
            remember(&[url, p.url.clone()], &p);
            Ok(p)
        }
        Err(e) => {
            // Steam молчит: последняя сохранённая копия, а для своего аккаунта — то, что есть на компьютере
            if let Some((_, p)) = with_cache(|c| c.get(&url).cloned()) { return Ok(SteamProfile { stale: true, ..p }); }
            let id = url.rsplit('/').next().unwrap_or("");
            local_profile(id).ok_or(e)
        }
    }
}

fn fetch_profile(url: &str) -> Result<SteamProfile, String> {
    let mut r = match ureq::get(&format!("{url}/?xml=1")).header("User-Agent", "clipforge").call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(429)) => return Err("Steam временно ограничил запросы, попробуй через несколько минут".into()),
        Err(e) => return Err(format!("Steam не отвечает: {e}")),
    };
    let xml = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if xml.contains("<error>") || !xml.contains("<steamID64>") { return Err("профиль Steam не найден".into()); }
    let id = tag(&xml, "steamID64");
    Ok(SteamProfile {
        stale: false,
        name: tag(&xml, "steamID"),
        avatar: tag(&xml, "avatarFull"),
        online: tag(&xml, "onlineState"),
        status: tag(&xml, "stateMessage").replace("<br/>", " · "),
        game: tag(&xml, "gameName"),
        vac: tag(&xml, "vacBanned") == "1",
        trade_ban: tag(&xml, "tradeBanState"),
        limited: tag(&xml, "isLimitedAccount") == "1",
        since: tag(&xml, "memberSince"),
        url: format!("https://steamcommunity.com/profiles/{id}"),
        location: tag(&xml, "location"),
        public: tag(&xml, "privacyState") == "public",
        steamid: id,
    })
}

fn fget(key: &str, url: &str) -> Result<Option<Value>, String> {
    match ureq::get(url).header("Authorization", &format!("Bearer {}", key.trim())).call() {
        Ok(mut r) => serde_json::from_str(&r.body_mut().read_to_string().map_err(|e| e.to_string())?).map(Some).map_err(|e| e.to_string()),
        Err(ureq::Error::StatusCode(401 | 403)) => Err("FACEIT не принял ключ API".into()),
        Err(ureq::Error::StatusCode(404)) => Ok(None),
        Err(e) => Err(format!("FACEIT не отвечает: {e}")),
    }
}

// Игрок FACEIT по SteamID64 или нику (ссылка faceit.com/<lang>/players/<ник> тоже подходит):
// { player, lifetime, maps: [...], games: [последние 30 матчей со статистикой] }. Нет аккаунта — null.
#[tauri::command]
pub async fn faceit_profile(key: String, steamid: Option<String>, nickname: Option<String>) -> Result<Value, String> {
    const API: &str = "https://open.faceit.com/data/v4";
    let nick = nickname.as_deref().map(|n| n.trim().trim_end_matches('/')).map(|n| n.rsplit("/players/").next().unwrap_or(n).split('/').next().unwrap_or(n).to_string());
    let player = match (&steamid, &nick) {
        (Some(id), _) if !id.is_empty() => fget(&key, &format!("{API}/players?game=cs2&game_player_id={id}"))?,
        (_, Some(n)) if !n.is_empty() => fget(&key, &format!("{API}/players?nickname={n}"))?,
        _ => None,
    };
    let Some(player) = player else { return Ok(Value::Null) };
    let pid = player["player_id"].as_str().ok_or("FACEIT: нет player_id")?.to_string();
    let stats = fget(&key, &format!("{API}/players/{pid}/stats/cs2"))?.unwrap_or(Value::Null);
    let games = fget(&key, &format!("{API}/players/{pid}/games/cs2/stats?offset=0&limit=30"))?.unwrap_or(Value::Null);
    let cs2 = &player["games"]["cs2"];
    let maps: Vec<Value> = stats["segments"].as_array().cloned().unwrap_or_default().into_iter()
        .filter(|s| s["mode"].as_str().is_none_or(|m| m == "5v5"))
        .map(|s| json!({ "map": s["label"], "img": s["img_regular"], "stats": s["stats"] }))
        .collect();
    Ok(json!({
        "player": {
            "id": pid, "nickname": player["nickname"], "avatar": player["avatar"], "cover": player["cover_image"],
            "country": player["country"], "url": player["faceit_url"].as_str().unwrap_or("").replace("{lang}", "en"),
            "level": cs2["skill_level"], "elo": cs2["faceit_elo"], "region": cs2["region"],
            "steamid": cs2["game_player_id"], "since": player["activated_at"], "verified": player["verified"],
        },
        "lifetime": stats["lifetime"],
        "maps": maps,
        "games": games["items"].as_array().cloned().unwrap_or_default().into_iter().map(|g| g["stats"].clone()).collect::<Vec<_>>(),
    }))
}

// Ссылки из профиля — только Steam и FACEIT, в браузере по умолчанию
#[tauri::command]
pub fn open_profile_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://steamcommunity.com/") || url.starts_with("https://www.faceit.com/")) { return Err("чужая ссылка".into()); }
    Command::new("explorer").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(steam_url("76561199224852472"), "https://steamcommunity.com/profiles/76561199224852472");
        assert_eq!(steam_url("https://steamcommunity.com/id/stay-fatal/"), "https://steamcommunity.com/id/stay-fatal");
        assert_eq!(steam_url("https://steamcommunity.com/profiles/76561199224852472/home"), "https://steamcommunity.com/profiles/76561199224852472");
        assert_eq!(steam_url("stay-fatal"), "https://steamcommunity.com/id/stay-fatal");
    }

    #[test]
    fn tags() {
        let x = "<steamID><![CDATA[3&gt;]]></steamID><vacBanned>0</vacBanned>";
        assert_eq!(tag(x, "steamID"), "3>");
        assert_eq!(tag(x, "vacBanned"), "0");
        assert_eq!(tag(x, "nope"), "");
    }

    #[test]
    fn base64() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foobar!"), "Zm9vYmFyIQ==");
    }

    // свой аккаунт без сети: ник и аватар с этого компьютера (тест смотрит на настоящий Steam)
    #[test]
    #[ignore]
    fn local() {
        let id = crate::gallery::steam_ids().into_iter().next().unwrap();
        let p = local_profile(&id).unwrap();
        println!("{} avatar {} chars", p.name, p.avatar.len());
        assert!(!p.name.is_empty() && p.avatar.starts_with("data:image/png;base64,"));
    }
}
