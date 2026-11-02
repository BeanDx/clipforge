// Музыка в хайлайте: теги трека и поиск синхронизированного текста песни (LRCLIB).
// Сама подмешивание трека и наложение текста — в render.rs (post_filter / finish_take).
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

#[derive(Serialize, Default)]
pub struct TrackInfo {
    pub title: String,
    pub artist: String,
    pub duration: f64,
}

// Удары в куске трека [offset, offset+dur) — секунды от начала куска (= время готового клипа).
// Берём низкие частоты (бочка, бас), считаем энергию каждые 10 мс в логарифме, ищем резкие
// приросты выше скользящего порога и отбираем пики не чаще чем раз в 0.28 с.
pub fn detect_beats(ff: &Path, track: &str, offset: f64, dur: f64) -> Vec<f64> {
    const RATE: usize = 8000;
    const HOP: usize = 80; // 10 мс
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{offset:.3}"), "-t", &format!("{dur:.3}"), "-i"])
        .arg(track)
        .args(["-af", &format!("lowpass=f=160,aresample={RATE}"), "-ac", "1", "-f", "f32le", "pipe:1"]);
    crate::render::no_window(&mut cmd);
    let Ok(out) = cmd.output() else { return vec![] };
    let samples: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let energy: Vec<f64> = samples.chunks(HOP).map(|c| (1.0 + 1000.0 * c.iter().map(|x| (*x as f64).powi(2)).sum::<f64>()).ln()).collect();
    if energy.len() < 10 { return vec![]; }
    let onset: Vec<f64> = (0..energy.len()).map(|i| if i == 0 { 0.0 } else { (energy[i] - energy[i - 1]).max(0.0) }).collect();
    let mut beats = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for i in 1..onset.len() - 1 {
        // порог: среднее за ±0.5 с с запасом — тихие места не дают ложных ударов
        let (a, b) = (i.saturating_sub(50), (i + 50).min(onset.len()));
        let mean = onset[a..b].iter().sum::<f64>() / (b - a) as f64;
        let thr = mean * 1.6 + 0.02;
        let lo = i.saturating_sub(5);
        let hi = (i + 6).min(onset.len());
        let is_peak = onset[i] > thr && onset[lo..hi].iter().all(|&o| o <= onset[i]);
        let t = (i * HOP) as f64 / RATE as f64;
        if is_peak && t - last >= 0.28 {
            beats.push(t);
            last = t;
        }
    }
    beats
}

// Удары куска трека для текста песни, у которого слова встают на удары (стиль «Акцент»).
// Секунды от offset — как у detect_beats.
#[tauri::command]
pub async fn track_beats(hlae: String, path: String, offset: f64, dur: f64) -> Result<Vec<f64>, String> {
    let ff = crate::ffmpeg::find(&hlae).ok_or("не найден ffmpeg")?;
    Ok(detect_beats(&ff, &path, offset.max(0.0), dur))
}

// Файл трека для прослушивания в панели: отдаём байты напрямую (без JSON),
// чтобы не открывать окну программы доступ к файлам через asset-протокол
#[tauri::command]
pub async fn read_audio(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("не удалось прочитать трек: {e}"))
}

// Путь к HLAE.exe: если указанный не существует (например, настройки сбросились), ищем
// в стандартных местах установки. None — HLAE не найден нигде.
#[tauri::command]
pub fn locate_hlae(current: String) -> Option<String> {
    if !current.is_empty() && Path::new(&current).exists() { return Some(current); }
    let mut cands = vec![
        r"C:\Program Files (x86)\HLAE\HLAE.exe".to_string(),
        r"C:\Program Files\HLAE\HLAE.exe".to_string(),
    ];
    // своя копия, которую программа скачала сама (hlae.rs)
    cands.push(crate::hlae::own_dir().join("HLAE.exe").to_string_lossy().into_owned());
    for var in ["LOCALAPPDATA", "USERPROFILE"] {
        if let Ok(base) = std::env::var(var) {
            cands.push(format!(r"{base}\HLAE\HLAE.exe"));
            cands.push(format!(r"{base}\Desktop\HLAE\HLAE.exe"));
            cands.push(format!(r"{base}\Downloads\HLAE\HLAE.exe"));
        }
    }
    cands.into_iter().find(|p| Path::new(p).exists())
}

// Название, исполнитель и длительность — из вывода ffmpeg (того, что лежит рядом с HLAE)
#[tauri::command]
pub async fn track_info(hlae: String, path: String) -> Result<TrackInfo, String> {
    let ff = crate::ffmpeg::find(&hlae).ok_or("не найден ffmpeg")?;
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-i"]).arg(&path);
    crate::render::no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    let mut info = TrackInfo::default();
    // теги идут блоком до первого Stream: берём первые title/artist
    for line in text.lines().take_while(|l| !l.trim_start().starts_with("Stream")) {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_lowercase(), v.trim());
        if k == "title" && info.title.is_empty() { info.title = clean_tag(v); }
        if k == "artist" && info.artist.is_empty() { info.artist = clean_tag(v); }
        if k == "duration" {
            let t = v.split(',').next().unwrap_or("");
            let p: Vec<f64> = t.split(':').filter_map(|x| x.trim().parse().ok()).collect();
            if p.len() == 3 { info.duration = p[0] * 3600.0 + p[1] * 60.0 + p[2]; }
        }
    }
    if info.title.is_empty() {
        info.title = clean_tag(&Path::new(&path).file_stem().map(|s| s.to_string_lossy().replace('_', " ")).unwrap_or_default());
    }
    // без тега исполнителя название часто «Исполнитель - Песня» (имя файла или весь тег title):
    // делим, иначе поиск текста ищет песню с таким длинным названием и ничего не находит
    if info.artist.is_empty() {
        for sep in [" - ", " – ", " — "] {
            if let Some((a, t)) = info.title.clone().split_once(sep) {
                if !a.trim().is_empty() && !t.trim().is_empty() {
                    info.artist = a.trim().to_string();
                    info.title = t.trim().to_string();
                }
                break;
            }
        }
    }
    Ok(info)
}

// Убирает приписки сайтов-источников: «ДИНАСТИЯ (Muzjoy.net)» -> «ДИНАСТИЯ», «911 [zaycev.net]» -> «911»
fn clean_tag(v: &str) -> String {
    let mut s = v.to_string();
    loop {
        let t = s.trim_end();
        let open = match t.chars().last() { Some(')') => '(', Some(']') => '[', _ => break };
        let Some(i) = t.rfind(open) else { break };
        if !t[i..].contains('.') { break; }
        s = t[..i].to_string();
    }
    s.trim().to_string()
}

// Поиск текста в LRCLIB. Сервер часто отвечает «busy» (503 или JSON ServerOverload) — повторяем
// с нарастающей паузой. Возвращаем сырой JSON-массив кандидатов, выбор лучшего — на фронтенде
// (по длительности). q — общий поиск по строке (когда точный по исполнителю и названию не нашёл).
#[tauri::command]
pub async fn lyrics_search(artist: String, title: String, q: Option<String>) -> Result<String, String> {
    let enc = |s: &str| s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect::<String>();
    let url = match q.filter(|q| !q.trim().is_empty()) {
        Some(q) => format!("https://lrclib.net/api/search?q={}", enc(&q)),
        None if artist.trim().is_empty() => format!("https://lrclib.net/api/search?track_name={}", enc(&title)),
        None => format!("https://lrclib.net/api/search?track_name={}&artist_name={}", enc(&title), enc(&artist)),
    };
    let mut last = String::new();
    for attempt in 0..7u64 {
        if attempt > 0 { thread::sleep(Duration::from_millis(800 * attempt)); }
        match ureq::get(&url).header("User-Agent", "clipforge (CS2 highlight renderer)").call() {
            Ok(mut r) => {
                let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
                if body.trim_start().starts_with('[') { return Ok(body); }
                last = if body.contains("ServerOverload") { "сервер перегружен".into() } else { body.chars().take(120).collect() };
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("LRCLIB сейчас не отвечает ({last}). Попробуй «Найти текст» через минуту."))
}

