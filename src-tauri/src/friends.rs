// Друзья Steam для «Профиля»: открыть друга или сравнить с ним без ссылок.
// Свой аккаунт — из localconfig.vdf (блок "friends": id аккаунта, ник, аватар): без сети и даже при
// скрытом списке. Чужой — со страницы steamcommunity.com/.../friends; если там никого — список скрыт.
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const BASE: u64 = 76561197960265728; // SteamID64 = id аккаунта + BASE

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Friend {
    pub steamid: String,
    pub name: String,
    pub avatar: String,
}

#[derive(Serialize, Clone)]
pub struct Friends {
    pub source: String, // local | web
    pub private: bool,  // Steam не показал ни одного друга: список скрыт (или пуст)
    pub friends: Vec<Friend>,
}

#[derive(Debug, PartialEq)]
enum Tok { S(String), Open, Close }

// Токены VDF: строки в кавычках (с \" и \\ внутри) и фигурные скобки
fn tokens(s: &str) -> Vec<Tok> {
    let mut out = vec![];
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '"' => {
                let mut v = String::new();
                while let Some(c) = it.next() {
                    match c {
                        '\\' => { if let Some(n) = it.next() { v.push(n); } }
                        '"' => break,
                        _ => v.push(c),
                    }
                }
                out.push(Tok::S(v));
            }
            _ => {}
        }
    }
    out
}

fn avatar_url(hash: &str) -> String {
    if hash.is_empty() || hash.bytes().all(|b| b == b'0') { return String::new(); }
    format!("https://avatars.steamstatic.com/{hash}_medium.jpg")
}

// Блок "friends" из localconfig.vdf: { "<id аккаунта>" { "name" ... "avatar" ... } ... "PersonaName" "..." }
fn parse_local(vdf: &str, own_acc: u64) -> Vec<Friend> {
    let Some(at) = vdf.find("\"friends\"") else { return vec![] };
    let t = tokens(&vdf[at..]);
    let mut out = vec![];
    // t[0] = "friends", t[1] = {
    if t.get(1) != Some(&Tok::Open) { return out; }
    let mut i = 2;
    while i < t.len() {
        match (&t[i], t.get(i + 1)) {
            (Tok::Close, _) => break, // конец блока friends
            (Tok::S(key), Some(Tok::Open)) => {
                // вложенный блок: друг (числовой ключ) или что-то другое — читаем пары верхнего уровня
                let (mut name, mut avatar) = (String::new(), String::new());
                let mut depth = 1;
                i += 2;
                while i < t.len() && depth > 0 {
                    match &t[i] {
                        Tok::Open => { depth += 1; i += 1; }
                        Tok::Close => { depth -= 1; i += 1; }
                        Tok::S(k) => {
                            if let Some(Tok::S(v)) = t.get(i + 1) {
                                if depth == 1 && k == "name" { name = v.clone(); }
                                if depth == 1 && k == "avatar" { avatar = v.clone(); }
                                i += 2;
                            } else { i += 1; }
                        }
                    }
                }
                if let Ok(acc) = key.parse::<u64>() {
                    if acc != own_acc && !name.is_empty() {
                        out.push(Friend { steamid: (acc + BASE).to_string(), name, avatar: avatar_url(&avatar) });
                    }
                }
            }
            (Tok::S(_), Some(Tok::S(_))) => i += 2, // "PersonaName" "..." и прочие пары
            _ => i += 1,
        }
    }
    out.sort_by_key(|f| f.name.to_lowercase());
    out
}

fn local_friends(steamid: &str) -> Option<Vec<Friend>> {
    let acc = steamid.parse::<u64>().ok()?.checked_sub(BASE)?;
    let p = Path::new(&crate::gallery::steam_root()).join("userdata").join(acc.to_string()).join("config").join("localconfig.vdf");
    let raw = fs::read(p).ok()?;
    let list = parse_local(&String::from_utf8_lossy(&raw), acc);
    (!list.is_empty()).then_some(list)
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

// Страница друзей: <div class="selectable friend_block_v2 ..." data-steamid="7656..."> ... <img src="...">
// ... <div class="friend_block_content">Ник<br>...
fn parse_web(html: &str) -> Vec<Friend> {
    let mut out: Vec<Friend> = vec![];
    for chunk in html.split("friend_block_v2").skip(1) {
        let Some(id) = chunk.split("data-steamid=\"").nth(1).and_then(|s| s.split('"').next()) else { continue };
        if !id.bytes().all(|b| b.is_ascii_digit()) || id.len() != 17 { continue; }
        let avatar = chunk.split("<img src=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("").to_string();
        let name = chunk.split("friend_block_content\">").nth(1)
            .and_then(|s| s.split("<br").next()).map(unescape).unwrap_or_default();
        if out.iter().any(|f| f.steamid == id) { continue; }
        out.push(Friend { steamid: id.into(), name, avatar });
    }
    out
}

// страница друзей тоже под лимитом запросов Steam — помним 10 минут
static WEB: Mutex<Option<HashMap<String, (u64, Vec<Friend>)>>> = Mutex::new(None);
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) }

fn web_friends(steamid: &str) -> Result<Vec<Friend>, String> {
    if let Some((at, l)) = WEB.lock().unwrap().as_ref().and_then(|c| c.get(steamid).cloned()) {
        if now_ms().saturating_sub(at) < 10 * 60_000 { return Ok(l); }
    }
    let url = format!("https://steamcommunity.com/profiles/{steamid}/friends/");
    let mut r = match ureq::get(&url).header("User-Agent", "clipforge").call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(429)) => return Err("Steam временно ограничил запросы, попробуй через несколько минут".into()),
        Err(e) => return Err(format!("Steam не отвечает: {e}")),
    };
    let html = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let list = parse_web(&html);
    WEB.lock().unwrap().get_or_insert_with(HashMap::new).insert(steamid.into(), (now_ms(), list.clone()));
    Ok(list)
}

#[tauri::command]
pub async fn steam_friends(steamid: String) -> Result<Friends, String> {
    // свой аккаунт (есть на этом компьютере) — из файлов Steam
    if crate::gallery::steam_ids().iter().any(|x| *x == steamid) {
        if let Some(friends) = local_friends(&steamid) {
            return Ok(Friends { source: "local".into(), private: false, friends });
        }
    }
    let friends = web_friends(&steamid)?;
    Ok(Friends { source: "web".into(), private: friends.is_empty(), friends })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_block() {
        let vdf = r#"
"UserLocalConfigStore"
{
	"friends"
	{
		"100"
		{
			"NameHistory" { "0" "old" }
			"avatar"		"5c9f8efca7030bb7c0c58327c5cceb897c8f1ed5"
			"name"		"me"
		}
		"PersonaName"		"me"
		"communitypreferences"		"188f"
		"200"
		{
			"name"		"Bob \"the\" builder"
			"NameHistory" { "0" "bobby" "1" "b" }
			"avatar"		"0000000000000000000000000000000000000000"
		}
		"300"
		{
			"avatar"		"abc"
			"name"		"alice"
		}
	}
	"other" { "name" "not a friend" }
}"#;
        let l = parse_local(vdf, 100);
        assert_eq!(l, vec![
            Friend { steamid: (300 + BASE).to_string(), name: "alice".into(), avatar: "https://avatars.steamstatic.com/abc_medium.jpg".into() },
            Friend { steamid: (200 + BASE).to_string(), name: "Bob \"the\" builder".into(), avatar: String::new() },
        ]);
    }

    #[test]
    fn web_page() {
        let html = r#"<div class="profile_friends search_results" id="search_results">
<div class="selectable friend_block_v2 persona offline " data-steamid="76561198000000001" data-search="pal ; " data-miniprofile="1">
  <a class="selectable_overlay" href="https://steamcommunity.com/id/pal"></a>
  <div class="player_avatar friend_block_link_overlay offline"><img src="https://avatars.akamai.steamstatic.com/aa_medium.jpg"></div>
  <div class="friend_block_content">P&amp;L<br><span class="friend_small_text">Last Online 3 hrs ago</span></div>
</div>
<div class="selectable friend_block_v2 persona in-game " data-steamid="76561198000000002">
  <div class="player_avatar"><img src="https://avatars.akamai.steamstatic.com/bb_medium.jpg"></div>
  <div class="friend_block_content">two<br></div>
</div></div>"#;
        let l = parse_web(html);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].name, "P&L");
        assert_eq!(l[0].avatar, "https://avatars.akamai.steamstatic.com/aa_medium.jpg");
        assert_eq!(l[1].steamid, "76561198000000002");
        assert!(parse_web("<div class=\"profile_private_info\">This profile is private.</div>").is_empty());
    }

    // свой список друзей с этого компьютера (смотрит на настоящий Steam)
    #[test]
    #[ignore]
    fn real_local() {
        let id = crate::gallery::steam_ids().into_iter().next().unwrap();
        let l = local_friends(&id).unwrap_or_default();
        println!("{} friends, first has avatar: {}", l.len(), l.first().is_some_and(|f| !f.avatar.is_empty()));
        assert!(!l.is_empty());
    }
}
