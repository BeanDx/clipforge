// Демки матчмейкинга и Premier для «Истории игр» на главной.
// Ссылки на демки Valve отдаёт только игровой координатор CS2, а к нему пускают лишь клиент игры.
// Поэтому, как CS Demo Manager, берём boiler-writter (MIT, github.com/akiver/boiler-writter): при запущенном
// Steam он на пару секунд представляется CS2, спрашивает последние матчи и пишет ответ координатора
// (CMsgGCCStrike15_v2_MatchList) в файл. Пароль не нужен — это тот же вход, что у самой игры.
// Утилита скачивается сама в %LOCALAPPDATA%\clipforge\boiler, как ffmpeg. Демка — .dem.bz2 с replayN.valve.net:
// качаем, распаковываем на лету в csgo\replays и кладём рядом .dem.info, чтобы её видела и сама CS2.
use serde::Serialize;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::render::{no_window, process_running};

// --- protobuf: нужно несколько полей, своего разбора хватает ---

enum Val<'a> { Int(u64), Bytes(&'a [u8]) }

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let c = *b.get(*i)?;
        *i += 1;
        v |= u64::from(c & 0x7f) << shift;
        if c & 0x80 == 0 { return Some(v); }
    }
    None
}

// все поля сообщения: (номер, значение); битое сообщение обрывается там, где сломалось
fn fields(b: &[u8]) -> Vec<(u32, Val<'_>)> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(key) = varint(b, &mut i) else { break };
        let (num, wire) = ((key >> 3) as u32, key & 7);
        let val = match wire {
            0 => match varint(b, &mut i) { Some(v) => Val::Int(v), None => break },
            1 => { let Some(s) = b.get(i..i + 8) else { break }; i += 8; Val::Int(u64::from_le_bytes(s.try_into().unwrap())) }
            2 => {
                let Some(len) = varint(b, &mut i) else { break };
                let Some(s) = b.get(i..i + len as usize) else { break };
                i += len as usize;
                Val::Bytes(s)
            }
            5 => { let Some(s) = b.get(i..i + 4) else { break }; i += 4; Val::Int(u64::from(u32::from_le_bytes(s.try_into().unwrap()))) }
            _ => break,
        };
        out.push((num, val));
    }
    out
}

fn int(f: &[(u32, Val)], n: u32) -> Option<u64> {
    f.iter().rev().find_map(|(k, v)| match v { Val::Int(x) if *k == n => Some(*x), _ => None })
}
fn msg<'a>(f: &[(u32, Val<'a>)], n: u32) -> Option<&'a [u8]> {
    f.iter().rev().find_map(|(k, v)| match v { Val::Bytes(x) if *k == n => Some(*x), _ => None })
}
fn msgs<'a>(f: &[(u32, Val<'a>)], n: u32) -> Vec<&'a [u8]> {
    f.iter().filter_map(|(k, v)| match v { Val::Bytes(x) if *k == n => Some(*x), _ => None }).collect()
}
// repeated-числа: обычные или упакованные (packed)
fn ints(f: &[(u32, Val)], n: u32) -> Vec<u64> {
    let mut out = vec![];
    for (k, v) in f {
        if *k != n { continue; }
        match v {
            Val::Int(x) => out.push(*x),
            Val::Bytes(b) => { let mut i = 0; while let Some(x) = varint(b, &mut i) { out.push(x); } }
        }
    }
    out
}

// --- матчи ---

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ValveMatch {
    pub id: String,
    pub started: u64, // мс
    pub duration: u64, // с
    pub map: String,  // de_mirage или "", если карту по game_type не узнать (её всё равно скажет демка)
    pub mode: String, // competitive | wingman | ""
    pub score: String, // «13:9» со стороны игрока
    pub result: String, // win | loss | draw | ""
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub url: String,  // http://replayN.valve.net/730/<...>.dem.bz2
    pub name: String, // match730_<reservation>_<tv port>_<ip> — так демку называет сама CS2
    pub info: String, // CDataGCCStrike15_v2_MatchInfo в hex: файл .dem.info рядом с демкой
}

// game_type: младший байт — режим (8 соревновательный, 10 напарники), остальное — бит карты.
// Таблица из CS Demo Manager; для новых карт пусто — тогда карту назовёт сама демка.
fn map_of(game_type: u64) -> (&'static str, &'static str) {
    let mode = match game_type & 0xff { 8 => "competitive", 10 => "wingman", _ => "" };
    let bit = (game_type >> 8) & 0xff_ffff;
    let map = match bit {
        0x1 => "de_warden", 0x2 => "de_dust2", 0x4 => "de_train", 0x8 => "de_ancient", 0x10 => "de_inferno",
        0x20 => "de_nuke", 0x40 => "de_vertigo", 0x80 => if mode == "wingman" { "de_debris" } else { "de_mirage" },
        0x100 => "cs_office", 0x200 => "de_poseidon", 0x400 => "de_eldorado", 0x800 => "de_sanctum",
        0x1000 => "de_cache", 0x2000 => "de_stronghold", 0x4000 => "de_boulder", 0x8000 => "de_anubis",
        0x10000 => "de_tuscan", 0x40000 => "de_fachwerk", 0x80000 => "cs_shelter", 0x100000 => "de_overpass",
        0x200000 => "de_cobblestone", 0x400000 => "de_canals",
        _ => "",
    };
    (map, mode)
}

fn hex(b: &[u8]) -> String { b.iter().map(|c| format!("{c:02x}")).collect() }
fn unhex(s: &str) -> Option<Vec<u8>> {
    s.len().is_multiple_of(2).then(|| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect())?
}

// числа int32 в protobuf приходят как u64: -1 → 2^64-1
fn i32_of(v: u64) -> i64 { v as u32 as i32 as i64 }

fn parse_match(b: &[u8], me: u64) -> Option<ValveMatch> {
    let f = fields(b);
    let id = int(&f, 1)?;
    let watch = fields(msg(&f, 3).unwrap_or_default());
    // итог матча — в статистике последнего раунда
    let all = msgs(&f, 5);
    let last = fields(msg(&f, 4).or_else(|| all.last().copied())?);
    let url = msg(&last, 3).map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default();
    let reserve = fields(msg(&last, 2).unwrap_or_default());
    let (map, mode) = map_of(int(&reserve, 2).unwrap_or(0));
    let reservation = int(&last, 1).unwrap_or(0);
    let name = format!("match730_{reservation:021}_{:010}_{}", int(&watch, 2).unwrap_or(0), int(&watch, 1).unwrap_or(0));

    // слоты 0–4 — одна команда, 5–9 — другая; счёт team_scores[0] всегда у слотов 0–4
    let slot = ints(&reserve, 1).iter().position(|&a| a == me);
    let scores: Vec<i64> = ints(&last, 12).into_iter().map(i32_of).collect();
    let (score, result) = match (slot, scores.as_slice()) {
        (Some(s), [a, b, ..]) => {
            let (mine, theirs) = if s < 5 { (*a, *b) } else { (*b, *a) };
            let r = if mine > theirs { "win" } else if mine < theirs { "loss" } else { "draw" };
            (format!("{mine}:{theirs}"), r)
        }
        _ => (String::new(), ""),
    };
    let stat = |n: u32| slot.and_then(|s| ints(&last, n).get(s).copied()).map_or(0, i32_of);

    Some(ValveMatch {
        id: id.to_string(),
        started: int(&f, 2).unwrap_or(0) * 1000,
        duration: int(&last, 15).unwrap_or(0),
        map: map.into(),
        mode: mode.into(),
        score,
        result: result.into(),
        kills: stat(5),
        deaths: stat(7),
        assists: stat(6),
        url,
        name,
        info: hex(b),
    })
}

// CMsgGCCStrike15_v2_MatchList → матчи, свежие первыми
fn parse_list(b: &[u8]) -> Vec<ValveMatch> {
    let f = fields(b);
    let me = int(&f, 2).unwrap_or(0); // accountid того, кто спрашивал
    let mut out: Vec<ValveMatch> = msgs(&f, 4).into_iter().filter_map(|m| parse_match(m, me)).collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.started));
    out
}

// --- boiler-writter ---

const BOILER_URL: &str = "https://github.com/akiver/boiler-writter/releases/download/v1.7.0/boiler-writter-win-1.7.0.zip";
const BOILER_SHA256: &str = "eda6ce361215c4c0427332e55811ffd621755b264ae7df0f5385ef5916331141";

fn own_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("clipforge").join("boiler")
}

fn sha256(p: &Path) -> Option<String> {
    let mut cmd = Command::new("certutil");
    cmd.arg("-hashfile").arg(p).arg("SHA256");
    no_window(&mut cmd);
    let out = String::from_utf8_lossy(&cmd.output().ok()?.stdout).into_owned();
    // вторая строка — хэш (в старых Windows с пробелами между байтами)
    out.lines().nth(1).map(|l| l.replace(' ', "").to_ascii_lowercase())
}

// путь к boiler-writter.exe; нет — скачивает (2 МБ), сверяет SHA-256 и распаковывает
fn ensure_boiler() -> Result<PathBuf, String> {
    let dir = own_dir();
    let exe = dir.join("bin").join("boiler-writter.exe");
    if exe.exists() && dir.join("bin").join("steam_api64.dll").exists() { return Ok(exe); }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join("boiler.zip");
    crate::ffmpeg::download(BOILER_URL, &zip, &|_, _| {}).map_err(|e| format!("не удалось скачать boiler-writter: {e}"))?;
    if sha256(&zip).as_deref() != Some(BOILER_SHA256) {
        let _ = fs::remove_file(&zip);
        return Err("скачанный boiler-writter не совпал по контрольной сумме".into());
    }
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(&zip).arg("-C").arg(&dir);
    no_window(&mut cmd);
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    let _ = fs::remove_file(&zip);
    if !ok || !exe.exists() { return Err("не удалось распаковать boiler-writter".into()); }
    Ok(exe)
}

fn boiler_error(code: i32) -> String {
    match code {
        3 => "Steam не ответил. Попробуй ещё раз через минуту",
        4 => "Steam уже занят игрой: закрой CS2 и попробуй ещё раз",
        5 => "Steam просит перезапуска: перезапусти Steam и попробуй ещё раз",
        6 => "Steam не запущен или ты не вошёл в аккаунт",
        7 => "В Steam не выполнен вход",
        9 => "Не удалось записать список матчей",
        _ => "Не удалось получить матчи у Valve (код {0})",
    }.replace("{0}", &code.to_string())
}

// Последние матчи матчмейкинга и Premier (координатор отдаёт около восьми). Нужен запущенный Steam
// и закрытая CS2: пока игра открыта, второй «клиент CS2» координатор не пустит.
#[tauri::command]
pub async fn valve_recent() -> Result<Vec<ValveMatch>, String> {
    if process_running("cs2.exe") { return Err("Закрой CS2: пока игра открыта, Valve не отдаёт список матчей".into()); }
    if !process_running("steam.exe") { return Err("Steam не запущен или ты не вошёл в аккаунт".into()); }
    let exe = ensure_boiler()?;
    let out = own_dir().join("matches.info");
    let _ = fs::remove_file(&out);
    let mut cmd = Command::new(&exe);
    // steam_appid.txt (730) читается из рабочей папки
    cmd.arg(&out).current_dir(exe.parent().unwrap());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("не удалось запустить boiler-writter: {e}"))?;
    let t0 = Instant::now();
    let code = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? { break s.code().unwrap_or(1); }
        if t0.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            return Err("Steam не ответил. Попробуй ещё раз через минуту".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    match code {
        0 => {}
        8 => return Ok(vec![]), // матчей нет
        c => return Err(boiler_error(c)),
    }
    let bytes = fs::read(&out).map_err(|_| boiler_error(9))?;
    Ok(parse_list(&bytes))
}

// --- скачивание ---

fn replays_dir(cs2: &str) -> Result<PathBuf, String> {
    let game = Path::new(cs2).ancestors().nth(3).ok_or("нет пути к CS2")?;
    let dir = game.join("csgo").join("replays");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn valid_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) else { return false };
    let host = rest.split('/').next().unwrap_or("");
    host.ends_with(".valve.net") && url.ends_with(".dem.bz2")
}
fn valid_name(name: &str) -> bool {
    name.starts_with("match730_") && name.len() < 80 && name.bytes().all(|c| c.is_ascii_digit() || c == b'_' || c.is_ascii_lowercase())
}

// считает прочитанные байты сжатого файла — для прогресса
struct Counting<R> { inner: R, done: u64, last: u64, total: u64, on: Box<dyn Fn(f64, f64) + Send> }
impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        if self.done - self.last > 1 << 20 || n == 0 {
            self.last = self.done;
            (self.on)(self.done as f64 / 1048576.0, self.total as f64 / 1048576.0);
        }
        Ok(n)
    }
}

// Скачать демку матча в csgo\replays (прогресс — событие valve-progress: [id, МБ, всего МБ]). Возвращает путь.
#[tauri::command]
pub async fn valve_download(app: AppHandle, cs2: String, id: String, url: String, name: String, info: String) -> Result<String, String> {
    if !valid_url(&url) || !valid_name(&name) { return Err("не ссылка на демку Valve".into()); }
    let dir = replays_dir(&cs2)?;
    let dst = dir.join(format!("{name}.dem"));
    if fs::metadata(&dst).is_ok_and(|m| m.len() > 0) { return Ok(dst.to_string_lossy().into_owned()); }

    fetch_demo(&url, &dst, Box::new(move |d, t| { let _ = app.emit("valve-progress", (&id, d, t)); }))?;
    // .dem.info — как у демок, скачанных из самой игры: CS2 покажет матч во вкладке «Смотреть»
    if let Some(bytes) = unhex(&info) { let _ = fs::write(dir.join(format!("{name}.dem.info")), bytes); }
    Ok(dst.to_string_lossy().into_owned())
}

// .dem.bz2 → распакованная .dem в dst (через .part: оборванная загрузка не выглядит готовой демкой)
fn fetch_demo(url: &str, dst: &Path, on: Box<dyn Fn(f64, f64) + Send>) -> Result<(), String> {
    let mut resp = match ureq::get(url).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(404 | 403)) => return Err("Valve уже удалила эту демку: они хранятся около месяца".into()),
        Err(e) => return Err(format!("сервер демок Valve не отвечает: {e}")),
    };
    let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    let body = resp.body_mut().with_config().limit(1 << 32).reader();
    let counting = Counting { inner: body, done: 0, last: 0, total, on };

    let tmp = dst.with_extension("dem.part");
    let res = (|| -> io::Result<()> {
        let mut out = io::BufWriter::new(fs::File::create(&tmp)?);
        io::copy(&mut bzip2::read::MultiBzDecoder::new(counting), &mut out)?;
        out.flush()
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(format!("не удалось скачать демку: {e}"));
    }
    fs::rename(&tmp, dst).map_err(|e| { let _ = fs::remove_file(&tmp); e.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 { out.push(b); break; }
            out.push(b | 0x80);
        }
    }
    fn put_int(n: u32, v: u64, out: &mut Vec<u8>) { enc_varint(u64::from(n) << 3, out); enc_varint(v, out); }
    fn put_bytes(n: u32, b: &[u8], out: &mut Vec<u8>) { enc_varint((u64::from(n) << 3) | 2, out); enc_varint(b.len() as u64, out); out.extend_from_slice(b); }

    #[test]
    fn parses_match_list() {
        let me = 905_330_150u64;
        let mut reserve = vec![];
        for a in [1, 2, 3, 4, 5, 6, me, 8, 9, 10] { put_int(1, a, &mut reserve); }
        put_int(2, (0x80 << 8) | 8, &mut reserve); // mirage, соревновательный
        let mut last = vec![];
        put_int(1, 3_189_280_594_026_561_777, &mut last);
        put_bytes(2, &reserve, &mut last);
        put_bytes(3, b"http://replay183.valve.net/730/003189280594026561777_1796106830.dem.bz2", &mut last);
        // packed: kills, deaths
        let mut k = vec![]; for x in [5, 6, 7, 8, 9, 10, 21, 12, 13, 14] { enc_varint(x, &mut k); }
        put_bytes(5, &k, &mut last);
        for x in [1u64, 2, 3, 4, 5, 6, 17, 8, 9, 10] { put_int(7, x, &mut last); }
        put_int(12, 9, &mut last);
        put_int(12, 13, &mut last);
        put_int(15, 2400, &mut last);
        let mut watch = vec![];
        put_int(1, 2_315_280_907, &mut watch);
        put_int(2, 27015, &mut watch);
        let mut m = vec![];
        put_int(1, 3_189_280_594_026_561_000, &mut m);
        put_int(2, 1_796_000_000, &mut m);
        put_bytes(3, &watch, &mut m);
        put_bytes(5, &last, &mut m);
        let mut list = vec![];
        put_int(2, me, &mut list);
        put_bytes(4, &m, &mut list);

        let got = parse_list(&list);
        assert_eq!(got.len(), 1);
        let g = &got[0];
        assert_eq!(g.map, "de_mirage");
        assert_eq!(g.mode, "competitive");
        assert_eq!(g.score, "13:9"); // слот 6 — вторая пятёрка, её счёт team_scores[1]
        assert_eq!(g.result, "win");
        assert_eq!((g.kills, g.deaths), (21, 17));
        assert_eq!(g.started, 1_796_000_000_000);
        assert_eq!(g.duration, 2400);
        assert_eq!(g.name, "match730_003189280594026561777_0000027015_2315280907");
        assert!(valid_url(&g.url) && valid_name(&g.name));
        assert_eq!(unhex(&g.info).unwrap(), m);
    }

    #[test]
    fn checks_inputs() {
        assert!(!valid_url("http://evil.com/730/x.dem.bz2"));
        assert!(!valid_url("http://replay1.valve.net.evil.com/x.dem.bz2"));
        assert!(!valid_name("match730_..\\..\\x"));
        assert_eq!(map_of((0x8000 << 8) | 8), ("de_anubis", "competitive"));
        assert_eq!(map_of((0x80 << 8) | 10), ("de_debris", "wingman"));
    }

    // настоящая демка: CF_URL=http://replayN.valve.net/... CF_OUT=путь\x.dem cargo test --lib real_demo -- --ignored
    #[test]
    #[ignore]
    fn real_demo() {
        let dst = PathBuf::from(std::env::var("CF_OUT").unwrap());
        fetch_demo(&std::env::var("CF_URL").unwrap(), &dst, Box::new(|d, t| println!("{d:.1}/{t:.1} MB"))).unwrap();
        let mut head = [0u8; 8];
        fs::File::open(&dst).unwrap().read_exact(&mut head).unwrap();
        assert_eq!(&head, b"PBDEMS2\0");
        println!("{} bytes", fs::metadata(&dst).unwrap().len());
    }

    // настоящий ответ координатора: CF_MATCHES=путь\matches.info cargo test --lib real_list -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_list() {
        let b = fs::read(std::env::var("CF_MATCHES").unwrap()).unwrap();
        for m in parse_list(&b) {
            println!("{} {} {} {} {} {}/{}/{} {}s {}", m.id, m.started, m.map, m.mode, m.score, m.kills, m.deaths, m.assists, m.duration, m.url);
        }
    }
}
