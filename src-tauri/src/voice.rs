// Голосовой чат из демки для 3D-превью. Голос пишется в демки FACEIT и комьюнити-серверов (Opus 48 кГц,
// пакет на 10–20 мс с SteamID говорящего). В демки матчмейкинга Valve голос не попадает вовсе.
// Пакеты одного игрока склеиваются в непрерывные фразы, каждая фраза упаковывается в Ogg Opus —
// его WebView проигрывает сам. Если голос вдруг пришёл зашифрованным (SvcEncryptedData), расшифровываем
// ключом из .dem.info.
use crate::ice::Ice;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::*;
use std::collections::HashMap;
use std::sync::Mutex;

const TICKRATE: f64 = 64.0;
const OPUS_RATE: f64 = 48000.0;
// пауза больше полсекунды между пакетами — новая фраза
const GAP_TICKS: f64 = 32.0;

struct Packet {
    tick: u32,
    seq: u32,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub struct Phrase {
    pub id: String,   // steamid говорящего
    pub tick: f64,    // начало фразы
    pub dur: f64,     // длительность, секунды
    pub ogg: String,  // base64 Ogg Opus
}

#[derive(Default)]
struct Collector {
    ice: Option<Ice>,
    by: HashMap<u64, Vec<Packet>>,
}

impl Collector {
    fn take(&mut self, tick: u32, m: CSvcMsgVoiceData) {
        let xuid = m.xuid();
        let Some(a) = m.audio else { return };
        if a.format() != VoiceDataFormatT::VoicedataFormatOpus || xuid == 0 { return; }
        let data = a.voice_data.unwrap_or_default();
        if data.is_empty() { return; }
        self.by.entry(xuid).or_default().push(Packet { tick, seq: a.section_number.unwrap_or(0), data });
    }

    // зашифрованное сообщение: [число байт выравнивания][выравнивание][длина BE u32][сообщение битами]
    fn decrypt(&self, e: CSvcMsgEncryptedData) -> Option<CSvcMsgVoiceData> {
        let ice = self.ice.as_ref()?;
        let mut d = e.encrypted.unwrap_or_default();
        ice.decrypt(&mut d);
        let pad = *d.first()? as usize;
        let d = d.get(1 + pad..)?;
        if d.len() < 4 || u32::from_be_bytes([d[0], d[1], d[2], d[3]]) as usize != d.len() - 4 { return None; }
        let mut br = Bits { d: &d[4..], pos: 0 };
        if br.ubitvar() != SvcMessages::SvcVoiceData as u32 { return None; } // обычно это чат
        let size = br.varint() as usize;
        CSvcMsgVoiceData::decode(br.bytes(size).as_slice()).ok()
    }
}

impl Observer for Collector {
    fn interests(&self) -> Interests { Interests::SVC_MESSAGE }
    fn on_svc_message(&mut self, ctx: &Context, t: SvcMessages, b: &[u8]) -> ObserverResult {
        let m = match t {
            SvcMessages::SvcVoiceData => CSvcMsgVoiceData::decode(b).ok(),
            SvcMessages::SvcEncryptedData => CSvcMsgEncryptedData::decode(b).ok().and_then(|e| self.decrypt(e)),
            _ => None,
        };
        if let Some(m) = m { self.take(ctx.tick(), m); }
        Ok(())
    }
}

// чтение сообщения внутри зашифрованного блока: биты младшими вперёд, как в пакетах Source 2
struct Bits<'a> {
    d: &'a [u8],
    pos: usize,
}
impl Bits<'_> {
    fn bit(&mut self) -> u32 {
        let b = (self.d.get(self.pos / 8).copied().unwrap_or(0) >> (self.pos % 8)) & 1;
        self.pos += 1;
        b as u32
    }
    fn read(&mut self, n: u32) -> u32 { (0..n).fold(0, |v, i| v | (self.bit() << i)) }
    fn ubitvar(&mut self) -> u32 {
        let r = self.read(6);
        match r & 0x30 {
            16 => (r & 15) | (self.read(4) << 4),
            32 => (r & 15) | (self.read(8) << 4),
            48 => (r & 15) | (self.read(28) << 4),
            _ => r,
        }
    }
    fn varint(&mut self) -> u32 {
        let mut v = 0;
        for i in 0..5 {
            let b = self.read(8);
            v |= (b & 0x7f) << (7 * i);
            if b & 0x80 == 0 { break; }
        }
        v
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> { (0..n.min(self.d.len())).map(|_| self.read(8) as u8).collect() }
}

// сколько сэмплов (48 кГц) в пакете Opus — по байту TOC (RFC 6716, 3.1)
fn opus_samples(p: &[u8]) -> u64 {
    let Some(&toc) = p.first() else { return 0 };
    let cfg = toc >> 3;
    let frame = match cfg {
        0..=11 => [480, 960, 1920, 2880][(cfg % 4) as usize],
        12..=15 => [480, 960][(cfg % 2) as usize],
        _ => [120, 240, 480, 960][(cfg % 4) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => p.get(1).map_or(1, |b| (b & 0x3f) as u64),
    };
    frame * frames
}

// ---- Ogg ----
fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, e) in t.iter_mut().enumerate() {
        let mut r = (i as u32) << 24;
        for _ in 0..8 { r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04c1_1db7 } else { r << 1 }; }
        *e = r;
    }
    t
}

fn page(out: &mut Vec<u8>, crc: &[u32; 256], flags: u8, granule: u64, seq: u32, packet: &[u8]) {
    let start = out.len();
    out.extend_from_slice(b"OggS");
    out.push(0);
    out.push(flags);
    out.extend_from_slice(&granule.to_le_bytes());
    out.extend_from_slice(&0x434c_4950u32.to_le_bytes()); // номер потока
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // CRC, посчитаем ниже
    let mut lacing = vec![255u8; packet.len() / 255];
    lacing.push((packet.len() % 255) as u8);
    out.push(lacing.len() as u8);
    out.extend_from_slice(&lacing);
    out.extend_from_slice(packet);
    let c = out[start..].iter().fold(0u32, |c, &b| (c << 8) ^ crc[(((c >> 24) as u8) ^ b) as usize]);
    out[start + 22..start + 26].copy_from_slice(&c.to_le_bytes());
}

fn ogg_opus(packets: &[&[u8]]) -> Vec<u8> {
    let crc = crc_table();
    let mut out = Vec::new();
    let mut head = b"OpusHead".to_vec();
    head.extend_from_slice(&[1, 1, 0, 0]); // версия, моно, pre-skip 0 — чтобы не сдвигать начало фразы
    head.extend_from_slice(&48000u32.to_le_bytes());
    head.extend_from_slice(&[0, 0, 0]); // усиление, раскладка каналов
    page(&mut out, &crc, 0x02, 0, 0, &head);
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&9u32.to_le_bytes());
    tags.extend_from_slice(b"clipforge");
    tags.extend_from_slice(&0u32.to_le_bytes());
    page(&mut out, &crc, 0, 0, 1, &tags);
    // пакеты собираем в страницы до 255 сегментов: один пакет на страницу раздул бы файл вдвое
    let (mut granule, mut seq, mut i) = (0u64, 2u32, 0usize);
    while i < packets.len() {
        let mut body = Vec::new();
        let mut lacing = Vec::new();
        while i < packets.len() {
            let p = packets[i];
            let need = p.len() / 255 + 1;
            if lacing.len() + need > 255 { break; }
            lacing.extend(std::iter::repeat_n(255u8, p.len() / 255));
            lacing.push((p.len() % 255) as u8);
            body.extend_from_slice(p);
            granule += opus_samples(p);
            i += 1;
        }
        if lacing.is_empty() { break; } // пакет больше 64 КБ — такого в голосе не бывает
        let flags = if i >= packets.len() { 0x04 } else { 0 };
        let start = out.len();
        out.extend_from_slice(b"OggS");
        out.push(0);
        out.push(flags);
        out.extend_from_slice(&granule.to_le_bytes());
        out.extend_from_slice(&0x434c_4950u32.to_le_bytes());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.push(lacing.len() as u8);
        out.extend_from_slice(&lacing);
        out.extend_from_slice(&body);
        let c = out[start..].iter().fold(0u32, |c, &b| (c << 8) ^ crc[(((c >> 24) as u8) ^ b) as usize]);
        out[start + 22..start + 26].copy_from_slice(&c.to_le_bytes());
        seq += 1;
    }
    out
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

// фразы: пакеты подряд по номеру и без долгой паузы. Тик фразы — тик её первого пакета
fn phrases(id: u64, list: &[Packet]) -> Vec<Phrase> {
    let mut out = vec![];
    let mut i = 0;
    while i < list.len() {
        let start = list[i].tick as f64;
        let mut samples = opus_samples(&list[i].data);
        let mut j = i + 1;
        while j < list.len() {
            let (prev, p) = (&list[j - 1], &list[j]);
            let end = start + samples as f64 / OPUS_RATE * TICKRATE;
            if p.seq != prev.seq.wrapping_add(1) || p.tick as f64 > end + GAP_TICKS { break; }
            samples += opus_samples(&p.data);
            j += 1;
        }
        let packets: Vec<&[u8]> = list[i..j].iter().map(|p| p.data.as_slice()).collect();
        out.push(Phrase { id: id.to_string(), tick: start, dur: samples as f64 / OPUS_RATE, ogg: b64(&ogg_opus(&packets)) });
        i = j;
    }
    out
}

// весь голос демки, по фразам; кэш — чтобы следующий клип той же демки открывался сразу
static CACHE: Mutex<Option<(String, std::time::SystemTime, Vec<Phrase>)>> = Mutex::new(None);

fn all_phrases(path: &str) -> Result<Vec<Phrase>, String> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
    if let Some((p, t, v)) = CACHE.lock().unwrap().as_ref() {
        if p == path && *t == mtime { return Ok(v.clone()); }
    }
    let key = std::fs::read(format!("{path}.info")).ok()
        .and_then(|b| CDataGccStrike15V2MatchInfo::decode(b.as_slice()).ok())
        .and_then(|mi| mi.watchablematchinfo)
        .map(|w| w.cl_decryptdata_key_pub())
        .filter(|&k| k != 0);
    let owned = path.to_string();
    let by = std::thread::Builder::new().stack_size(512 << 20).spawn(move || -> Result<_, String> {
        let file = std::fs::File::open(&owned).map_err(|e| e.to_string())?;
        let mut parser = Parser::from_reader(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
        let c = parser.register_observer::<Collector>();
        if let Some(k) = key { c.borrow_mut().ice = Some(Ice::new(2, format!("{k:016X}").as_bytes())); }
        parser.run_to_end().map_err(|e| e.to_string())?;
        let by = std::mem::take(&mut c.borrow_mut().by);
        Ok(by)
    }).map_err(|e| e.to_string())?.join().map_err(|_| "разбор голоса аварийно завершился".to_string())??;
    let mut all: Vec<Phrase> = by.iter().flat_map(|(&id, list)| phrases(id, list)).collect();
    all.sort_by(|a, b| a.tick.total_cmp(&b.tick));
    *CACHE.lock().unwrap() = Some((path.to_string(), mtime, all.clone()));
    Ok(all)
}

// Фразы, которые звучат в отрезке [start, end]. Пустой список — голоса в демке нет (так у матчмейкинга Valve)
#[tauri::command]
pub async fn scene_voice(path: String, start: f64, end: f64) -> Result<Vec<Phrase>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let all = all_phrases(&path)?;
        Ok(all.into_iter().filter(|p| p.tick < end && p.tick + p.dur * TICKRATE > start).collect())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_frame_sizes() {
        assert_eq!(opus_samples(&[0x70]), 480); // hybrid FB 10 мс
        assert_eq!(opus_samples(&[0x78]), 960); // hybrid FB 20 мс
        assert_eq!(opus_samples(&[0xfc]), 960); // CELT 20 мс
        assert_eq!(opus_samples(&[0x71]), 960); // два кадра по 10 мс
    }

    #[test]
    fn ogg_crc_known() {
        // CRC Ogg от "OggS" с нулями — сверка таблицы с эталонной реализацией libogg
        let t = crc_table();
        assert_eq!(t[1], 0x04c1_1db7);
    }

    // Ручная проверка на настоящей демке: CLIPFORGE_VOICE_DEMO=путь cargo test voice_demo -- --nocapture
    #[test]
    fn voice_demo() {
        let Ok(path) = std::env::var("CLIPFORGE_VOICE_DEMO") else { return };
        let all = all_phrases(&path).unwrap();
        println!("фраз {}", all.len());
        for p in all.iter().take(5) { println!("{} tick {} dur {:.2}s ogg {}", p.id, p.tick, p.dur, p.ogg.len()); }
        if let Ok(dir) = std::env::var("CLIPFORGE_VOICE_OUT") {
            let longest = all.iter().max_by(|a, b| a.dur.total_cmp(&b.dur)).unwrap();
            let bytes = decode_b64(&longest.ogg);
            std::fs::write(format!("{dir}/phrase.ogg"), bytes).unwrap();
        }
    }

    fn decode_b64(s: &str) -> Vec<u8> {
        let v = |c: u8| match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, _ => 63 } as u32;
        let mut out = vec![];
        for ch in s.as_bytes().chunks(4) {
            let n = ch.iter().take_while(|&&c| c != b'=').enumerate().fold(0u32, |n, (i, &c)| n | v(c) << (18 - 6 * i));
            let k = ch.iter().filter(|&&c| c != b'=').count();
            out.push((n >> 16) as u8);
            if k > 2 { out.push((n >> 8) as u8); }
            if k > 3 { out.push(n as u8); }
        }
        out
    }
}
