use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub account_id: u64,
    pub name: String,
    pub round: u32,
    pub start: u32,
    pub end: u32,
    // Номер слота игрока в демке (1–10). CS2 переключает наблюдателя командой
    // "spec_player <n>" по этому числу — по нику команда ненадёжна (кириллица,
    // спецсимволы, совпадения). Проверяется вручную стрелками в demo-UI игры.
    pub slot: u8,
    // Тики убийств внутри клипа — вокруг них делается slow-motion
    #[serde(default)]
    pub kill_ticks: Vec<u32>,
    // Попадания игрока внутри клипа — для оверлея цифр урона
    #[serde(default)]
    pub hits: Vec<Hit>,
    // Начала припева в секундах записи клипа — там плавное замедление (опция «Замедление на припеве»)
    #[serde(default)]
    pub drops: Vec<f64>,
    // Своё начало трека для этого клипа («припев — на последний килл»), иначе общее из MusicJob
    #[serde(default)]
    pub music_start: Option<f64>,
    // Кинокамера на последнем фраге клипа (опции «Вид убитого» и «Облёт после фрага»)
    #[serde(default)]
    pub cine: Option<Cine>,
    // тики киллов в голову — там «зум на хедшот»
    #[serde(default)]
    pub hs_ticks: Vec<u32>,
    // трек плавно появляется / уходит в этом клипе (в ролике из нескольких — только первый/последний)
    #[serde(default)]
    pub music_fade_in: Option<bool>,
    #[serde(default)]
    pub music_fade_out: Option<bool>,
    // ночной вид (пресет Night): звёздное небо вместо дневного, ночной цвет, светящееся оружие в руках
    #[serde(default)]
    pub night: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cine {
    // тик килла
    pub kill: u32,
    // слот жертвы: перед киллом камера смотрит её глазами
    pub victim_slot: Option<u8>,
    // путь камеры HLAE (XML mirv_campath) для облёта после килла и тик его конца
    pub orbit_xml: Option<String>,
    pub orbit_end: Option<u32>,
    // повтор глазами каждой жертвы клипа по очереди (тик килла и слот убитого)
    #[serde(default)]
    pub victims: Vec<Victim>,
}

#[derive(Deserialize, Clone)]
pub struct Victim {
    pub kill: u32,
    pub slot: u8,
}

#[derive(Deserialize, Clone)]
pub struct Hit {
    pub tick: u32,
    pub dmg: u32,
    pub head: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    demo: String,
    hlae: String, // путь к HLAE.exe
    cs2: String,  // путь к cs2.exe (game/bin/win64/cs2.exe)
    out: String,
    clips: Vec<Clip>,
    fps: u32,
    blur: bool,
    fov: u32,
    width: u32,
    height: u32,
    crf: u32,
    vm_fov: f32,
    vm_x: f32,
    vm_y: f32,
    vm_z: f32,
    voice_indices: i64,
    voice_indices_high: i64,
    // h264_nvenc / h264_amf / h264_qsv, если включено кодирование на GPU (см. detect_gpu_encoder)
    #[serde(default)]
    gpu_encoder: Option<String>,
    #[serde(default)]
    slowmo: bool,
    #[serde(default)]
    damage: bool,
    #[serde(default)]
    xray: bool,
    #[serde(default)]
    hide_demo_ui: bool,
    // "full" — HUD как в демке, "killfeed" — только килфид. "match" (свой HUD игрока) пока не реализован.
    #[serde(default)]
    hud: String,
    // Метка времени запуска рендера ("2026-10-30_15-40-12") — имя временной папки и префикс клипов
    #[serde(default)]
    stamp: String,
    // Свой трек под клипом (по умолчанию выключено)
    #[serde(default)]
    music: Option<MusicJob>,
    // «Пересобрать без игры»: взять сырую запись прошлого рендера и заново наложить эффекты
    #[serde(default)]
    reuse_last: bool,
    // мягкая вспышка-свечение на каждом килле и её оттенок: "pink" | "white" | "gold"
    #[serde(default)]
    kill_flash: bool,
    #[serde(default)]
    flash_color: String,
    // атмосфера: "night" | "fog" | "sunset" | "neon" ("" — как в игре); atmo_game — менять ещё и туман/небо в самой игре
    #[serde(default)]
    atmo: String,
    #[serde(default)]
    atmo_game: bool,
    // наезд камеры на цель при килле в голову
    #[serde(default)]
    hs_zoom: bool,
    // клавиша в игре, которая запускает запись (имя для bind в CS2: f10, ins, home…)
    #[serde(default = "default_start_key")]
    start_key: String,
    // 4:3 растянуть до 16:9 (stretched, как у про-игроков)
    #[serde(default)]
    stretch: bool,
    // несколько клипов — склеить в один ролик; keep_parts — оставить и отдельные клипы рядом с ним
    #[serde(default = "yes")]
    merge: bool,
    #[serde(default)]
    keep_parts: bool,
    // монтаж из нескольких демок: клипы — отдельными файлами part_NN.mp4 в эту папку, без ролика и уведомления
    #[serde(default)]
    parts_dir: Option<String>,
}
fn yes() -> bool { true }

// Переход между клипами в ролике, секунды (тот же REEL_XFADE во фронтенде — на него сдвинут трек)
const REEL_XFADE: f64 = 0.35;

// Длина видео по выводу ffmpeg
fn media_duration(ff: &Path, path: &Path) -> Option<f64> {
    let mut cmd = Command::new(ff);
    cmd.arg("-hide_banner").arg("-i").arg(path);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let log = String::from_utf8_lossy(&out.stderr);
    let t = log.split("Duration: ").nth(1)?.split(',').next()?;
    Some(t.trim().split(':').filter_map(|x| x.parse::<f64>().ok()).fold(0.0, |acc, x| acc * 60.0 + x))
}

// Ролик из клипов с коротким переходом «рывок вбок» (xfade smoothleft) и перекрёстным звуком.
// Видео пережимается (переход — новые кадры), поэтому кодировщик тот же, что у клипов.
fn reel_with_transitions(ff: &Path, parts: &[PathBuf], dst: &Path, enc: Option<&str>, crf: u32) -> bool {
    let Some(durs) = parts.iter().map(|p| media_duration(ff, p)).collect::<Option<Vec<f64>>>() else { return false };
    if durs.iter().any(|d| *d <= REEL_XFADE * 2.0) { return false; }
    let mut g = String::new();
    let (mut v, mut a) = ("[0:v]".to_string(), "[0:a]".to_string());
    let mut offset = 0.0;
    for i in 1..parts.len() {
        offset += durs[i - 1] - REEL_XFADE;
        g += &format!("{v}[{i}:v]xfade=transition=smoothleft:duration={REEL_XFADE}:offset={offset:.3}[xv{i}];");
        g += &format!("{a}[{i}:a]acrossfade=d={REEL_XFADE}[xa{i}];");
        v = format!("[xv{i}]");
        a = format!("[xa{i}]");
    }
    g.pop();
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    for p in parts { cmd.arg("-i").arg(p); }
    cmd.arg("-filter_complex").arg(&g).args(["-map", &v, "-map", &a]).args(codec_args(enc, crf))
        .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]).arg(dst);
    no_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false) && dst.exists()
}

// Склейка готовых клипов в один ролик: у них одинаковые кодеки, разрешение и fps
fn concat_clips(ff: &Path, parts: &[PathBuf], dst: &Path, list: &Path) -> bool {
    let body: String = parts.iter()
        .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")))
        .collect();
    if fs::write(list, body).is_err() { return false; }
    let mut cmd = Command::new(ff);
    // видео копируется как есть; звук пересобирается — при копировании AAC на стыках клипов
    // повторялись метки времени, и ffmpeg ронял склейку. -xerror: любая ошибка = неудача
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-xerror", "-f", "concat", "-safe", "0", "-i"]).arg(list)
        .args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]).arg(dst);
    no_window(&mut cmd);
    let ok = cmd.status().map(|s| s.success()).unwrap_or(false) && dst.exists();
    let _ = fs::remove_file(list);
    ok
}
fn default_start_key() -> String { "f10".into() }

// Цветокоррекция атмосферы при сборке клипа — работает всегда, даже если игра не приняла команды тумана
fn atmo_grade(a: &str) -> Option<&'static str> {
    Some(match a {
        "night" => "eq=brightness=-0.05:contrast=1.15:saturation=0.6:gamma=0.75,\
                    colorbalance=rs=-0.12:gs=-0.03:bs=0.16:rm=-0.08:bm=0.12:rh=-0.05:bh=0.08,vignette=angle=PI/4",
        "fog" => "curves=all='0/0.18 0.5/0.56 1/0.94',eq=saturation=0.55,colorbalance=bs=0.03:bm=0.02",
        "sunset" => "colorbalance=rs=0.12:gs=0.01:bs=-0.12:rm=0.10:gm=-0.01:bm=-0.10:rh=0.05:bh=-0.08,\
                     eq=saturation=1.15:contrast=1.06:gamma=0.95,vignette=angle=PI/5",
        "neon" => "colorbalance=rs=0.15:gs=-0.12:bs=0.25:rm=0.12:gm=-0.12:bm=0.08:rh=0.06:gh=-0.04:bh=0.10,\
                   eq=saturation=1.4:contrast=1.18:gamma=0.8,vignette=angle=PI/4.5",
        _ => return None,
    })
}

// Туман и небо в самой игре: fog_override_* (нужен sv_cheats) и mirv_sky из HLAE.
// (цвет тумана, начало, конец, плотность, цвет неба, цвет облаков)
fn atmo_cmds(a: &str) -> String {
    let (fog, start, end, dens, sky, clouds) = match a {
        "night" => ("18 26 54", 200, 2600, 0.55, "14 20 44", "40 48 80"),
        "fog" => ("160 168 176", 0, 1400, 0.9, "150 158 166", "170 175 180"),
        "sunset" => ("200 110 60", 300, 4000, 0.45, "255 130 70", "255 170 120"),
        "neon" => ("90 30 140", 300, 3000, 0.5, "120 40 180", "255 80 200"),
        _ => return String::new(),
    };
    format!(
        "sv_cheats 1\nfog_override_enable 1\nfog_override 1\nfog_override_color {fog}\nfog_override_start {start}\n\
         fog_override_end {end}\nfog_override_max_density {dens}\nmirv_sky color {sky} 255\nmirv_sky clouds color {clouds}\n"
    )
}

// Сырая запись последнего рендера (take-папки) хранится в <out>/.clipforge_last вместе с этим
// описанием: пересобрать можно, только если клипы, разрешение и частота записи подходят.
const LAST_DIR: &str = ".clipforge_last";
#[derive(Serialize, Deserialize, PartialEq, Clone)]
pub struct LastRender {
    pub clips: Vec<(u32, u32)>,
    pub width: u32,
    pub height: u32,
    pub rec_fps: u32,
    #[serde(default)]
    pub takes: usize,
}

fn read_last(out: &Path) -> Option<LastRender> {
    let dir = out.join(LAST_DIR);
    let mut m: LastRender = serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
    m.takes = takes(&dir).len();
    Some(m)
}

// «До / после»: какой сырой take стал каким готовым клипом и отрезки slow-mo, чтобы по секунде
// готового клипа найти тот же момент в сырой записи. Лежит в кэше рядом с take-папками.
#[derive(Serialize, Deserialize, Clone)]
pub struct CompareItem {
    pub name: String,
    pub out: String,
    pub take: String,
    pub dur: f64,
    pub segs: Vec<(f64, Option<f64>, f64)>,
}

#[tauri::command]
pub fn compare_list(out: String) -> Vec<CompareItem> {
    let list: Vec<CompareItem> = fs::read_to_string(Path::new(&out).join(LAST_DIR).join("compare.json")).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.into_iter().filter(|c| Path::new(&c.out).exists() && Path::new(&c.take).exists()).collect()
}

// Один кадр видео в JPEG (сырые байты, без JSON) — для шторки «до / после»
#[tauri::command]
pub async fn grab_frame(hlae: String, path: String, t: f64, width: u32) -> Result<tauri::ipc::Response, String> {
    let ff = ffmpeg_path(&hlae).ok_or("неверный путь к HLAE")?;
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{:.3}", t.max(0.0)), "-i"]).arg(&path)
        .args(["-frames:v", "1", "-vf", &format!("scale={width}:-2"), "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"]);
    no_window(&mut cmd);
    let o = cmd.output().map_err(|e| e.to_string())?;
    if o.stdout.is_empty() { return Err(String::from_utf8_lossy(&o.stderr).trim().to_string()); }
    Ok(tauri::ipc::Response::new(o.stdout))
}

// Что лежит в кэше последнего рендера (для кнопки «Пересобрать без игры»)
#[tauri::command]
pub fn last_render(out: String) -> Option<LastRender> {
    read_last(Path::new(&out)).filter(|m| m.takes > 0 && m.takes == m.clips.len())
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicJob {
    path: String,
    // с какой секунды трека начинать (подобрано под припев)
    offset: f64,
    music_vol: f32,
    game_vol: f32,
    // эффекты в такт: "zoom" | "shake" | "both" (None — выключено) и сила (1 — обычная)
    #[serde(default)]
    beat_fx: Option<String>,
    #[serde(default = "one")]
    beat_amount: f32,
}
fn one() -> f32 { 1.0 }

// Удар камеры на каждый удар трека: кадр резко приближается и за ~0.13 с отпускает,
// в режиме тряски ещё и смещается в пределах этого приближения. E(t) — сумма затуханий.
pub(crate) fn beat_filter(beats: &[f64], mode: &str, amount: f32, w: u32, h: u32) -> Option<String> {
    if beats.is_empty() { return None; }
    let env = beats.iter()
        .map(|b| format!("if(gte(t,{b:.3}),exp(-(t-{b:.3})/0.13),0)"))
        .collect::<Vec<_>>().join("+");
    let a = amount as f64;
    // тряске нужен запас по краям — небольшое приближение есть и в режиме «только тряска»
    let (zoom, shake) = match mode { "shake" => (0.025 * a, 0.9), "both" => (0.05 * a, 0.9), _ => (0.06 * a, 0.0) };
    let z = format!("(1+{zoom:.4}*min(1,{env}))");
    Some(format!(
        "scale=w='trunc(iw*{z}/2)*2':h='trunc(ih*{z}/2)*2':eval=frame,\
         crop=w={w}:h={h}:x='(iw-ow)/2*(1+{shake}*sin(97*t))':y='(ih-oh)/2*(1+{shake}*cos(89*t))'"
    ))
}

// Вспышка на килле: за 0.06 с до него кадр мягко засвечивается размытой копией самого себя
// (screen-смешивание даёт свечение) с лёгким оттенком, потом за ~0.25 с плавно гаснет.
// kills — секунды киллов уже на итоговой шкале. Фильтры работают только в окнах вспышек.
// Сила вспышки меняется командами sendcmd (dir/flash.cmd) раз в кадр: раньше она была формулой
// blend по каждому пикселю со всеми киллами сразу — эдит с 20 киллами собирался ~12 минут.
// ffmpeg надо запускать с текущей папкой dir (в графе — относительное имя файла команд).
pub(crate) fn flash_filter(kills: &[f64], color: &str, h: u32, dir: &Path) -> Option<String> {
    if kills.is_empty() { return None; }
    let env = |t: f64| kills.iter().map(|&k| {
        if t >= k - 0.06 && t < k { ((t - k + 0.06) / 0.06).powi(2) }
        else if t >= k && t <= k + 0.9 { (-(t - k) / 0.25).exp() } else { 0.0 }
    }).sum::<f64>().min(1.0);
    let end = kills.iter().cloned().fold(0.0, f64::max) + 1.0;
    let (mut cmds, mut prev, mut f) = (String::new(), -1.0, 0u32);
    loop {
        let t = f as f64 / 240.0;
        if t > end { break; }
        let v = (env(t) * 0.85 * 1000.0).round() / 1000.0;
        if v != prev { cmds += &format!("{t:.4} blend@kf all_opacity {v};\n"); prev = v; }
        f += 1;
    }
    fs::write(dir.join("flash.cmd"), cmds).ok()?;
    let enable = kills.iter().map(|k| format!("between(t,{:.3},{:.3})", k - 0.06, k + 0.9)).collect::<Vec<_>>().join("+");
    // оттенок свечения (в RGB): розовый, золотой или чисто белый
    let tint = match color {
        "white" => "",
        "gold" => ",colorchannelmixer=rr=1.08:gg=0.98:bb=0.8",
        _ => ",colorchannelmixer=rr=1.08:rb=0.06:gg=0.86:bb=1.06:br=0.05",
    };
    let sigma = (h as f64 / 27.0).round();
    Some(format!(
        "sendcmd=f=flash.cmd,format=gbrp,split[kfa][kfb];[kfb]gblur=sigma={sigma}:enable='{enable}'{tint}[kfg];\
         [kfa][kfg]blend@kf=all_mode=screen:all_opacity=0:enable='{enable}',format=yuv420p"
    ))
}

// Наезд камеры на строку текста: keys — [начало, конец, x, y] на итоговой шкале, x/y — доли кадра.
// За 0.35 с камера тянется на 12% к точке строки (сбоку от прицела): разгон к середине и короткое
// торможение в конце, держит, так же отпускает. Строк с зумом немного — их выбирает фронтенд.
fn text_zoom_filter(keys: &[[f64; 4]], w: u32, h: u32) -> Option<String> {
    if keys.is_empty() { return None; }
    // плавная ступенька 0..1..0 на отрезке [a, b]: st/ld — регистр выражения ffmpeg
    let s = |a: f64, b: f64| format!(
        "(st(0,clip(min((t-{a:.3})/0.35,({b:.3}-t)/0.35),0,1))*0+if(lt(ld(0),0.5),4*pow(ld(0),3),1-pow(2-2*ld(0),3)/2))"
    );
    let env = keys.iter().map(|k| s(k[0], k[1])).collect::<Vec<_>>().join("+");
    let px = keys.iter().map(|k| format!("{}*{:.4}", s(k[0], k[1]), (k[2] - 0.5) * 0.9)).collect::<Vec<_>>().join("+");
    let py = keys.iter().map(|k| format!("{}*{:.4}", s(k[0], k[1]), (k[3] - 0.5) * 0.9)).collect::<Vec<_>>().join("+");
    let z = format!("(1+0.12*min(1,{env}))");
    Some(format!(
        "scale=w='trunc(iw*{z}/2)*2':h='trunc(ih*{z}/2)*2':eval=frame,\
         crop=w={w}:h={h}:x='clip((0.5+{px})*iw-ow/2,0,iw-ow)':y='clip((0.5+{py})*ih-oh/2,0,ih-oh)'"
    ))
}

// Зум на хедшот: кадр за 0.12 с наезжает к центру (там прицел, а значит и голова цели),
// держится до +0.25 с и плавно отпускает к +0.6 с. kills — секунды хедшотов на итоговой шкале.
fn hs_zoom_filter(kills: &[f64], w: u32, h: u32) -> Option<String> {
    if kills.is_empty() { return None; }
    let env = kills.iter().map(|k| {
        let (a, b, c, d) = (k - 0.06, k + 0.06, k + 0.25, k + 0.6);
        format!(
            "if(between(t,{a:.3},{b:.3}),(1-cos(PI*(t-{a:.3})/0.12))/2,if(between(t,{b:.3},{c:.3}),1,\
             if(between(t,{c:.3},{d:.3}),(1+cos(PI*(t-{c:.3})/0.35))/2,0)))"
        )
    }).collect::<Vec<_>>().join("+");
    let z = format!("(1+0.28*min(1,{env}))");
    Some(format!(
        "scale=w='trunc(iw*{z}/2)*2':h='trunc(ih*{z}/2)*2':eval=frame,crop=w={w}:h={h}:x='(iw-ow)/2':y='(ih-oh)/2'"
    ))
}

// Секунда записи -> секунда готового клипа с учётом отрезков slow-mo
fn out_time(segs: &[(f64, Option<f64>, f64)], t: f64) -> f64 {
    segs.iter().filter(|s| s.0 < t).map(|&(a, b, s)| (b.map_or(t, |b| b.min(t)) - a) / s).sum()
}

fn clip_segs(j: &Job, cl: &Clip) -> Vec<(f64, Option<f64>, f64)> {
    if !j.slowmo && cl.drops.is_empty() { return vec![(0.0, None, 1.0)]; }
    let kills: Vec<f64> = if j.slowmo { cl.kill_ticks.iter().map(|&k| (k as f64 - cl.start as f64) / TICKRATE).collect() } else { vec![] };
    slowmo_segments(&kills, &cl.drops)
}

const TICKRATE: f64 = 64.0;
const GPU_ENCODERS: [&str; 3] = ["h264_nvenc", "h264_amf", "h264_qsv"];
const DAMAGE_FONT: &str = "C:/Windows/Fonts/arialbd.ttf";

pub(crate) fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // без мигающего окна консоли
    }
    let _ = cmd;
}

fn ffmpeg_path(hlae: &str) -> Option<PathBuf> {
    crate::ffmpeg::find(hlae)
}

// Аргументы видеокодека; q — целевое качество в шкале crf (меньше = лучше).
pub(crate) fn codec_args(enc: Option<&str>, q: u32) -> Vec<String> {
    let q = q.to_string();
    let a: Vec<&str> = match enc {
        Some("h264_nvenc") => vec!["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", &q, "-b:v", "0", "-pix_fmt", "yuv420p"],
        Some("h264_amf") => vec!["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q, "-pix_fmt", "yuv420p"],
        Some("h264_qsv") => vec!["-c:v", "h264_qsv", "-preset", "slow", "-global_quality", &q, "-pix_fmt", "nv12"],
        _ => vec!["-c:v", "libx264", "-crf", &q, "-pix_fmt", "yuv420p"],
    };
    a.into_iter().map(String::from).collect()
}

// Пробует закодировать пару кадров каждым аппаратным кодировщиком ffmpeg из папки HLAE.
// Возвращает первый рабочий — наличие в `ffmpeg -encoders` ещё не значит, что видеокарта его тянет.
#[tauri::command]
pub async fn detect_gpu_encoder(hlae: String) -> Option<String> {
    let ff = ffmpeg_path(&hlae).filter(|p| p.exists())?;
    GPU_ENCODERS.iter().find(|enc| {
        let mut cmd = Command::new(&ff);
        cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2"])
            .args(codec_args(Some(enc), 23))
            .args(["-f", "null", "-"]);
        no_window(&mut cmd);
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    }).map(|e| e.to_string())
}

// Профиль замедления вокруг килла: разгон → замедление → разгон.
// (смещение от килла в секундах, скорость); вне окна скорость 1.
const SLOWMO_RAMP: [(f64, f64, f64); 5] = [
    (-0.60, -0.45, 0.75),
    (-0.45, -0.25, 0.50),
    (-0.25, 0.25, 0.35),
    (0.25, 0.45, 0.50),
    (0.45, 0.60, 0.75),
];

// Замедление на припеве: очень плавное — торможение и разгон по косинусу мелкими ступенями.
// d — секунды от начала припева: за 1.2 с до него скорость падает до DROP_MIN, держится 0.6 с,
// затем за 1.4 с возвращается. Тот же профиль — в music.jsx (dropSpeed), они должны совпадать.
const DROP_MIN: f64 = 0.35;
const DROP_FROM: f64 = -1.2;
const DROP_TO: f64 = 2.0;
const DROP_STEP: f64 = 0.08;
fn drop_speed(d: f64) -> f64 {
    let ease = |x: f64| (1.0 - (std::f64::consts::PI * x).cos()) / 2.0;
    if d < DROP_FROM || d >= DROP_TO { 1.0 }
    else if d < 0.0 { 1.0 - (1.0 - DROP_MIN) * ease((d - DROP_FROM) / -DROP_FROM) }
    else if d < 0.6 { DROP_MIN }
    else { DROP_MIN + (1.0 - DROP_MIN) * ease((d - 0.6) / (DROP_TO - 0.6)) }
}

// Делит таймлайн клипа на отрезки постоянной скорости: (начало, конец или None до конца, скорость).
// kills — секунды киллов (рампа SLOWMO_RAMP), drops — начала припевов (плавная рампа drop_speed).
fn slowmo_segments(kills: &[f64], drops: &[f64]) -> Vec<(f64, Option<f64>, f64)> {
    let speed_at = |t: f64| {
        let kill = kills.iter().flat_map(|k| SLOWMO_RAMP.iter().filter(move |(a, b, _)| t >= k + a && t < k + b))
            .map(|r| r.2).fold(1.0, f64::min);
        drops.iter().map(|c| drop_speed(t - c)).fold(kill, f64::min)
    };
    let mut pts: Vec<f64> = vec![0.0];
    for k in kills {
        for (a, b, _) in SLOWMO_RAMP { pts.push((k + a).max(0.0)); pts.push((k + b).max(0.0)); }
    }
    for c in drops {
        let steps = ((DROP_TO - DROP_FROM) / DROP_STEP).round() as i32;
        for s in 0..=steps { pts.push((c + DROP_FROM + s as f64 * DROP_STEP).max(0.0)); }
    }
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    pts.dedup_by(|a, b| (*a - *b).abs() < 1e-3);

    let mut segs: Vec<(f64, Option<f64>, f64)> = Vec::new();
    for (i, &a) in pts.iter().enumerate() {
        let b = pts.get(i + 1).copied();
        let s = match b { Some(b) => speed_at((a + b) / 2.0), None => 1.0 };
        match segs.last_mut() {
            Some(last) if (last.2 - s).abs() < 1e-6 => last.1 = b,
            _ => segs.push((a, b, s)),
        }
    }
    segs
}

// Замедление звука отрезка. rubberband в режиме для ударных сохраняет атаку выстрелов и точную
// длину; atempo на коротких отрезках двоит выстрелы и теряет сэмплы (звук уезжал до 0.7 с) — он
// только запасной вариант для ffmpeg без rubberband. atempo принимает 0.5..100, поэтому цепочкой.
pub(crate) fn stretch(s: f64, rubberband: bool) -> String {
    if rubberband {
        return format!("rubberband=tempo={s}:transients=crisp:detector=percussive:phase=independent:window=short");
    }
    let (mut s, mut parts) = (s, Vec::new());
    while s < 0.5 { parts.push("atempo=0.5".to_string()); s /= 0.5; }
    parts.push(format!("atempo={:.4}", s));
    parts.join(",")
}

fn has_rubberband(ff: &Path) -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let mut cmd = Command::new(ff);
        cmd.args(["-hide_banner", "-filters"]);
        no_window(&mut cmd);
        cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).contains(" rubberband ")).unwrap_or(false)
    })
}

// Граф фильтров пост-обработки: блюр → цифры урона → slow-mo → целевой fps. Выходы [v] и [a].
// hud — номер входа ffmpeg с кадрами HUD (ffconcat из PNG с прозрачностью), если он есть.
fn post_filter(j: &Job, cl: &Clip, has_audio: bool, rubberband: bool, hud: Option<usize>) -> String {
    let at = |tick: u32| (tick as f64 - cl.start as f64) / TICKRATE;
    // Блюр до HUD, чтобы цифры HUD не размазывались; HUD до slow-mo, чтобы он замедлялся вместе с видео
    let (mut head, mut cur) = (String::new(), "0:v");
    if j.blur { head += "[0:v]tmix=frames=3[vb];"; cur = "vb"; }
    // атмосфера — до своего HUD, чтобы его цифры оставались чистыми
    if let Some(gr) = atmo_grade(&j.atmo) { head += &format!("[{cur}]{gr}[vg];"); cur = "vg"; }
    if let Some(idx) = hud {
        head += &format!("[{cur}][{idx}:v]overlay=0:0:format=auto[vh];");
        cur = "vh";
    }
    let mut chain: Vec<String> = Vec::new();

    if j.damage && Path::new(DAMAGE_FONT).exists() {
        let font = DAMAGE_FONT.replacen(':', "\\:", 1);
        for (i, h) in cl.hits.iter().enumerate() {
            let t0 = at(h.tick);
            if t0 < 0.0 { continue; }
            let (t1, tf) = (t0 + 0.75, t0 + 0.5);
            let xo = [0.035, 0.055, 0.045][i % 3];
            let color = if h.head { "0xF5C518" } else { "white" };
            chain.push(format!(
                "drawtext=fontfile='{font}':text='{dmg}':fontsize=h/16:fontcolor={color}:borderw=3:bordercolor=black@0.85\
                 :x=w/2+w*{xo}:y=h/2-h*0.05-(t-{t0:.3})*h*0.12\
                 :enable='between(t,{t0:.3},{t1:.3})':alpha='if(lt(t,{tf:.3}),1,({t1:.3}-t)/0.25)'",
                dmg = h.dmg
            ));
        }
    }

    let segs = if j.slowmo || !cl.drops.is_empty() {
        let kills: Vec<f64> = if j.slowmo { cl.kill_ticks.iter().map(|&k| at(k)).collect() } else { vec![] };
        slowmo_segments(&kills, &cl.drops)
    } else {
        vec![(0.0, None, 1.0)]
    };
    let fps = format!("fps={}", j.fps);

    if segs.len() == 1 {
        chain.push(fps);
        let mut g = format!("{head}[{cur}]{}[v]", chain.join(","));
        if has_audio { g += ";[1:a]anull[a]"; }
        return g;
    }

    let n = segs.len();
    let range = |a: f64, b: Option<f64>| match b {
        Some(b) => format!("start={a:.3}:end={b:.3}"),
        None => format!("start={a:.3}"),
    };
    chain.push(format!("split={n}{}", (0..n).map(|i| format!("[s{i}]")).collect::<String>()));
    let mut g = format!("{head}[{cur}]{};", chain.join(","));
    if has_audio {
        g += &format!("[1:a]asplit={n}{};", (0..n).map(|i| format!("[r{i}]")).collect::<String>());
    }
    let mut concat_in = String::new();
    for (i, &(a, b, s)) in segs.iter().enumerate() {
        g += &format!("[s{i}]trim={},setpts=(PTS-STARTPTS)/{s}[v{i}];", range(a, b));
        concat_in += &format!("[v{i}]");
        if has_audio {
            // отрезки без замедления не трогаем вовсе
            let fx = if s < 1.0 { format!(",{}", stretch(s, rubberband)) } else { String::new() };
            g += &format!("[r{i}]atrim={},asetpts=PTS-STARTPTS{fx}[a{i}];", range(a, b));
            concat_in += &format!("[a{i}]");
        }
    }
    if has_audio {
        g += &format!("{concat_in}concat=n={n}:v=1:a=1[vc][a];[vc]{fps}[v]");
    } else {
        g += &format!("{concat_in}concat=n={n}:v=1:a=0[vc];[vc]{fps}[v]");
    }
    g
}

// Папка parser в ресурсах установленной программы: свой node.exe, скрипты разбора и demoparser2.
// Задаётся при запуске (lib.rs). Нет её — значит, запуск из исходников: системный node и scripts/ проекта.
static PARSER_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_parser_dir(dir: PathBuf) {
    let _ = PARSER_DIR.set(dir);
}

fn node_command(script: &str) -> (Command, PathBuf) {
    if let Some(dir) = PARSER_DIR.get() {
        let s = dir.join("scripts").join(script);
        if s.exists() {
            let node = dir.join("node.exe");
            let cmd = if node.exists() { Command::new(node) } else { Command::new("node") };
            return (cmd, s);
        }
    }
    (Command::new("node"), Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts").join(script))
}

fn run_node(script: &str, args: &[&str]) -> Result<String, String> {
    let (mut cmd, script) = node_command(script);
    cmd.arg(script).args(args);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("не удалось запустить node: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

// Состояние игрока по тикам клипов для HUD «как в матче» (scripts/hud.cjs). ranges — JSON [[start,end],...]
#[tauri::command]
pub async fn parse_hud(path: String, steamid: String, ranges: String) -> Result<String, String> {
    run_node("hud.cjs", &[&path, &steamid, &ranges])
}

// Положение игрока вокруг киллов и сдвиг игрового времени — для облёта камерой (scripts/cine.cjs)
#[tauri::command]
pub async fn parse_cine(path: String, steamid: String, kills: String) -> Result<String, String> {
    run_node("cine.cjs", &[&path, &steamid, &kills])
}

// Досье матча: счёт, сервер и статистика игроков для вкладок «Демо» и «Архив» (scripts/info.cjs)
#[tauri::command]
pub async fn demo_info(path: String) -> Result<String, String> {
    run_node("info.cjs", &[&path])
}

// Текущие уровень и эло FACEIT игроков по steamid. Data API FACEIT без ключа не отвечает —
// ключ пользователь берёт на developers.faceit.com. Игроки без аккаунта FACEIT просто пропускаются.
#[tauri::command]
pub async fn faceit_levels(key: String, steamids: Vec<String>) -> Result<HashMap<String, (u64, u64)>, String> {
    let mut out = HashMap::new();
    for id in steamids {
        let url = format!("https://open.faceit.com/data/v4/players?game=cs2&game_player_id={id}");
        match ureq::get(&url).header("Authorization", &format!("Bearer {}", key.trim())).call() {
            Ok(mut r) => {
                let v: serde_json::Value = serde_json::from_str(&r.body_mut().read_to_string().map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                let g = &v["games"]["cs2"];
                if let (Some(l), Some(e)) = (g["skill_level"].as_u64(), g["faceit_elo"].as_u64()) { out.insert(id, (l, e)); }
            }
            Err(ureq::Error::StatusCode(401 | 403)) => return Err("FACEIT не принял ключ API".into()),
            Err(_) => {} // 404 — у игрока нет FACEIT
        }
    }
    Ok(out)
}

// Углы обзора игрока по тикам клипов — для текста песни, закреплённого в мире (scripts/cam.cjs)
#[tauri::command]
pub async fn parse_cam(path: String, steamid: String, ranges: String, victims: Option<String>) -> Result<String, String> {
    // victims — жертвы по клипам (рамка на цели в пресете Night): тогда ещё и позиции глаза и целей
    match victims {
        Some(v) => run_node("cam.cjs", &[&path, &steamid, &ranges, &v]),
        None => run_node("cam.cjs", &[&path, &steamid, &ranges]),
    }
}

// Сохраняет файл из сырого тела запроса (кадры HUD). Путь — в заголовке x-path, закодирован
// encodeURIComponent: заголовки только ASCII, а в пути может быть кириллица.
#[tauri::command]
pub fn save_file(request: tauri::ipc::Request) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("ожидались сырые байты".into());
    };
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("нет пути")?;
    let path = PathBuf::from(percent_decode(path)?);
    if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    fs::write(&path, data).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// Парсинг демки через Node + нативный @laihoe/demoparser2 (актуальный парсер CS2).
// В установленной программе Node свой (папка parser в ресурсах), при запуске из исходников — системный.
#[tauri::command]
pub async fn parse_demo(path: String) -> Result<String, String> {
    run_node("parse.cjs", &[&path])
}

// Возвращает (стартовый cfg с настройками, cfg с самой записью). Второй запускается по F10 уже внутри загруженной демки.
// cfg_dir — папка cfg игры: туда же кладём XML путей камеры (mirv_campath load берёт полный путь)
fn build_cfg(j: &Job, rec_fps: u32, work: &Path, cfg_dir: &Path) -> (String, String, Vec<(String, String)>) {
    let mut c = String::new();
    // Свои ffmpeg-настройки HLAE. Если в папке HLAE нет ffmpeg\bin\ffmpeg.exe, путь к ffmpeg
    // (из ffmpeg.ini HLAE или своя копия) передаём явно — см. ffmpeg.rs. Финальное качество (crf)
    // задаём уже при пост-обработке.
    let exe = crate::ffmpeg::for_hlae(&j.hlae);
    c += "mirv_streams record screen enabled 1\n";
    // Промежуточная запись на GPU, если есть. q=18 визуально без потерь; q=14 при 360 fps давал
    // ~1 Гбит/с (6.7 ГБ на 50-секундный клип). Без GPU — как встроенный afxFfmpegYuv420p.
    let screen_out = match j.gpu_encoder.as_deref() {
        Some(enc) => format!("{} {{QUOTE}}{{AFX_STREAM_PATH}}\\video.mp4{{QUOTE}}", codec_args(Some(enc), 18).join(" ")),
        None => "-c:v libx264 -pix_fmt yuv420p -preset slow -crf 22 {QUOTE}{AFX_STREAM_PATH}\\video.mp4{QUOTE}".to_string(),
    };
    c += &crate::ffmpeg::hlae_setting("cfrec", &screen_out, exe.as_deref());
    c += "mirv_streams record screen settings cfrec\n";
    // ночной вид: маска рук с оружием — отдельным потоком HLAE (cfvm\video.mp4 в take-папке, в оттенках
    // серого). Небо меняется в самой игре (mirv_sky material, см. sky.rs), поток глубины не нужен.
    if j.clips.iter().any(|c| c.night) {
        c += &crate::ffmpeg::hlae_setting("cfgray", "-vf format=gray -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p {QUOTE}{AFX_STREAM_PATH}\\video.mp4{QUOTE}", exe.as_deref());
        c += "mirv_streams add viewModelMatte cfvm\nmirv_streams edit cfvm settings cfgray\n";
    }
    c += &format!("mirv_streams record fps {}\n", rec_fps);
    // HLAE пишет сырые take-папки (video.mp4 + audio.wav) во временную папку, в out попадают только готовые клипы
    c += &format!("mirv_streams record name \"{}\"\n", work.to_string_lossy().replace('\\', "/"));
    c += &format!("mirv_fov {}\n", j.fov);
    c += &format!(
        "viewmodel_fov {}\nviewmodel_offset_x {}\nviewmodel_offset_y {}\nviewmodel_offset_z {}\n",
        j.vm_fov, j.vm_x, j.vm_y, j.vm_z
    );
    // запись идёт и когда игра не в фокусе (можно уйти в браузер): без фокуса CS2 по умолчанию
    // засыпает между кадрами и глушит звук — запись тормозила бы, а в audio.wav была бы тишина
    c += "engine_no_focus_sleep 0\nsnd_mute_losefocus 0\n";
    c += &format!("bind {} \"exec clipforge_run\"\n", j.start_key);

    c += &format!("tv_listen_voice_indices_h {}\n", j.voice_indices_high);
    c += &format!("tv_listen_voice_indices {}\n", j.voice_indices);

    let head = std::mem::take(&mut c);
    // Дальше — clipforge_run.cfg, он выполняется по F10 уже внутри загруженной демки.
    c += &format!("spec_show_xray {}\n", j.xray as u8);
    // для своего HUD игровой тоже прячем — остаётся килфид, остальное рисуется поверх видео
    c += &format!("cl_draw_only_deathnotices {}\n", (j.hud == "killfeed" || j.hud == "match") as u8);
    // demoui — переключатель: панель открыта при старте демки, одна команда её закрывает.
    if j.hide_demo_ui { c += "demoui\n"; }
    // карта уже загружена — mirv_sky для облаков нужно применять после загрузки
    if j.atmo_game { c += &atmo_cmds(&j.atmo); }
    let mut files: Vec<(String, String)> = Vec::new();
    // расписание каждого клипа отдельно: повтор от лица убитого очищает расписание (mirv_cmd clear),
    // чтобы отмотка назад не запустила команды клипа ещё раз, а потом восстанавливает остальные клипы
    let mut sched: Vec<String> = Vec::new();
    let mut marks: HashSet<u32> = HashSet::new();
    for (i, cl) in j.clips.iter().enumerate() {
        let mut c = String::new();
        let sky_on = if cl.night { format!("mirv_sky material \"{}\"\n", crate::sky::SKY_MATERIAL) } else { String::new() };
        files.push((
            format!("cf_{}_s", i),
            format!("{sky_on}spec_player {}\nmirv_streams record start\n", cl.slot),
        ));
        let mut end = String::from("mirv_streams record end\n");
        if cl.night { end += "mirv_sky material default\n"; }
        let reps = replays(cl);
        if !reps.is_empty() {
            // после повтора возвращаем расписание оставшихся клипов
            end += &format!("exec cf_{i}_rest\n");
        }
        if let Some(nx) = j.clips.get(i + 1) {
            end += &format!("demo_gototick {}\n", nx.start.saturating_sub(64));
        }
        files.push((format!("cf_{}_e", i), end));
        c += &format!("mirv_cmd addAtTick {} \"exec cf_{}_s\"\n", cl.start, i);
        // конец клипа: сразу конец записи или сначала повтор глазами жертвы
        let end_cmd = if reps.is_empty() { format!("cf_{i}_e") } else { format!("cf_{i}_rep0") };
        c += &format!("mirv_cmd addAtTick {} \"exec {end_cmd}\"\n", cl.end);
        // метки прогресса: каждые полсекунды демки игра выполняет пустой cfg «cfp_<тик>».
        // В console.log (-condebug) попадает строка «execing cfp_<тик>» (вывод echo туда не пишется),
        // программа читает последнюю — так процент записи идёт ровно со скоростью демки
        for t in (cl.start..cl.end).step_by(32) {
            c += &format!("mirv_cmd addAtTick {t} \"exec {PROGRESS_MARK}{t}\"\n");
            if marks.insert(t) { files.push((format!("{PROGRESS_MARK}{t}"), String::new())); }
        }
        // повторы: запись идёт дальше, демка по очереди отматывается к каждому киллу за ~1.2 с до него
        // и показывает его глазами жертвы до её смерти; после последнего — обычный конец клипа
        for (r, &(from, to, v)) in reps.iter().enumerate() {
            let next = if r + 1 < reps.len() { format!("cf_{i}_rep{}", r + 1) } else { format!("cf_{i}_e") };
            // отмотка сбрасывает, за кем следит камера: spec_player до demo_gototick терялся и повтор
            // снова шёл с наших глаз. Переключаемся уже на тиках повтора — сразу и ещё раз для надёжности.
            files.push((format!("cf_{i}_vic{r}"), format!("spec_player {v}\n")));
            files.push((format!("cf_{i}_rep{r}"), format!(
                "mirv_cmd clear\nmirv_cmd addAtTick {} \"exec cf_{i}_vic{r}\"\nmirv_cmd addAtTick {} \"exec cf_{i}_vic{r}\"\nmirv_cmd addAtTick {to} \"exec {next}\"\nspec_player {v}\ndemo_gototick {from}\n",
                from + 1, from + 8
            )));
        }
        if let Some(cn) = &cl.cine {
            // облёт: путь камеры HLAE; HUD и руки с оружием на это время прячем
            if let (Some(xml), Some(end)) = (&cn.orbit_xml, cn.orbit_end) {
                let path = cfg_dir.join(format!("cf_{i}_orbit.xml"));
                files.push((format!("cf_{i}_orbit.xml"), xml.clone()));
                files.push((format!("cf_{i}_orbit_on"), format!(
                    "sv_cheats 1\ncl_drawhud 0\nr_drawviewmodel 0\nmirv_campath clear\nmirv_campath load \"{}\"\nmirv_campath enabled 1\n",
                    path.to_string_lossy().replace('\\', "/")
                )));
                files.push((format!("cf_{i}_orbit_off"), "mirv_campath enabled 0\nmirv_campath clear\ncl_drawhud 1\nr_drawviewmodel 1\n".into()));
                c += &format!("mirv_cmd addAtTick {} \"exec cf_{i}_orbit_on\"\n", cn.kill + 6);
                c += &format!("mirv_cmd addAtTick {} \"exec cf_{i}_orbit_off\"\n", end.min(cl.end.saturating_sub(2)));
            }
        }
        sched.push(c);
    }
    // для каждого клипа — расписание всех следующих (восстанавливается после повтора)
    for i in 0..sched.len() {
        if !replays(&j.clips[i]).is_empty() {
            files.push((format!("cf_{i}_rest"), sched[i + 1..].concat()));
        }
    }
    // сначала расписание, потом перемотка к первому клипу
    c += &sched.concat();
    if let Some(f) = j.clips.first() {
        c += &format!("demo_gototick {}\n", f.start.saturating_sub(64));
    }
    (head, c, files)
}

// Повторы киллов глазами жертв, по порядку: (с какого тика отматываем, на каком заканчиваем, слот жертвы).
// Каждый — с ~1.2 с до килла до его конца. Старый формат (только последний килл) тоже понимаем.
fn replays(cl: &Clip) -> Vec<(u32, u32, u8)> {
    let Some(cn) = cl.cine.as_ref() else { return vec![] };
    let list: Vec<(u32, u8)> = if !cn.victims.is_empty() {
        cn.victims.iter().map(|v| (v.kill, v.slot)).collect()
    } else {
        cn.victim_slot.map(|s| vec![(cn.kill, s)]).unwrap_or_default()
    };
    list.into_iter().map(|(k, s)| (k.saturating_sub(77).max(cl.start), k + 16, s)).collect()
}

fn replay_secs(cl: &Clip) -> f64 {
    replays(cl).iter().map(|(a, b, _)| b.saturating_sub(*a) as f64 / TICKRATE).sum()
}

// Только take-папки HLAE: рядом лежат hud_N с кадрами HUD, их считать клипами нельзя
fn takes(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("take")))
            .collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn process_running(image: &str) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("IMAGENAME eq {image}"), "/NH", "/FO", "CSV"]);
    no_window(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&image.to_lowercase()))
        .unwrap_or(false)
}

const PROGRESS_MARK: &str = "cfp_";

// Хвост console.log игры (весь файл читать незачем — он растёт всю сессию)
fn log_tail(log: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(log).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

// Последняя метка прогресса: «execing cfp_<тик>»
fn last_progress_tick(tail: &str) -> Option<u32> {
    let i = tail.rfind(&format!("execing {PROGRESS_MARK}"))?;
    let rest = &tail[i + "execing ".len() + PROGRESS_MARK.len()..];
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

// Запись последнего клипа закончена — его cfg конца уже выполнен (дальше только сборка видео)
fn recording_finished(tail: &str, total: usize) -> bool {
    total > 0 && tail.contains(&format!("execing cf_{}_e", total - 1))
}

// Доля записанного: клипы пишутся по порядку, тик метки показывает, где сейчас запись
fn recorded_fraction(clips: &[Clip], tick: Option<u32>, takes_done: usize) -> f64 {
    let total: u64 = clips.iter().map(|c| c.end.saturating_sub(c.start) as u64).sum();
    if total == 0 { return 0.0; }
    let done: u64 = clips.iter().enumerate().map(|(i, c)| {
        let len = c.end.saturating_sub(c.start) as u64;
        if i < takes_done.saturating_sub(1) { return len; } // уже есть следующая запись — этот дописан
        match tick {
            Some(t) if t >= c.end => len,
            Some(t) if t >= c.start => (t - c.start) as u64,
            _ => 0,
        }
    }).sum();
    done as f64 / total as f64
}

// Закрывает CS2 и ждёт, пока процесс действительно исчезнет (до ~15 с)
fn kill_cs2() -> bool {
    if !process_running("cs2.exe") { return true; }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/IM", "cs2.exe", "/F"]);
    no_window(&mut cmd);
    let _ = cmd.status();
    for _ in 0..30 {
        if !process_running("cs2.exe") { return true; }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

// Запрос остановки рендера с кнопки «Остановить»: цикл рендера проверяет его каждую секунду
static CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn cs2_running() -> bool {
    process_running("cs2.exe")
}

// HLAE не запускает вторую копию CS2 («already running»), поэтому перед рендером закрываем старую
#[tauri::command]
pub async fn close_cs2() -> Result<(), String> {
    if kill_cs2() { Ok(()) } else { Err("не удалось закрыть CS2".into()) }
}

#[tauri::command]
pub fn cancel_render() {
    CANCEL.store(true, Ordering::SeqCst);
}

// Файлы take-папки не менялись 5 проверок подряд (~5 с) — HLAE дописал запись
fn settled(d: &Path, sizes: &mut HashMap<PathBuf, (u64, u32)>) -> bool {
    let size: u64 = ["video.mp4", "audio.wav"].iter()
        .filter_map(|f| fs::metadata(d.join(f)).ok()).map(|m| m.len()).sum();
    let e = sizes.entry(d.to_path_buf()).or_insert((u64::MAX, 0));
    if size > 0 && size == e.0 { e.1 += 1 } else { *e = (size, 0) }
    e.1 >= 5
}

// Длительность готового клипа: запись от start до end плюс удлинение от slow-mo
fn out_duration(j: &Job, cl: &Clip) -> f64 {
    // повтор от лица убитого дописывается в конец записи клипа, в обычной скорости
    let replay = replay_secs(cl);
    out_duration_main(j, cl) + replay
}

fn out_duration_main(j: &Job, cl: &Clip) -> f64 {
    let base = (cl.end.saturating_sub(cl.start)) as f64 / TICKRATE;
    if !j.slowmo && cl.drops.is_empty() { return base; }
    let kills: Vec<f64> = if j.slowmo { cl.kill_ticks.iter().map(|&k| (k as f64 - cl.start as f64) / TICKRATE).collect() } else { vec![] };
    base + slowmo_segments(&kills, &cl.drops).iter()
        .filter_map(|&(a, b, s)| b.map(|b| (b.min(base) - a.min(base)) * (1.0 / s - 1.0)))
        .sum::<f64>()
}

// Пост-обработка одного клипа: блюр, цифры урона, slow-mo, склейка со звуком, свой трек и текст песни.
// hud_dir / lyr_dir — папки с кадрами HUD и текста песни (ffconcat готовит фронтенд), если включены.
// Первый видеофайл потока HLAE в take-папке (d/<name>/...)
fn stream_file(d: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(d.join(name)).ok()?.flatten().map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| ["mp4", "mov", "avi", "mkv"].iter().any(|e| x.eq_ignore_ascii_case(e))))
}

// Доля кадра под маской (порог lut на яркости) по пяти кадрам записи — от 10% до 90% длины.
// Возвращает самую большую и самую маленькую долю: в одном кадре неба может не быть (камера
// смотрит в пол), поэтому проверять по одному кадру нельзя — так в первой записи небо и пропало.
fn mask_coverage(ff: &Path, video: &Path, lut: &str) -> Option<(f64, f64)> {
    let dur = media_duration(ff, video)?;
    let mut res: Vec<f64> = Vec::new();
    for f in [0.1, 0.3, 0.5, 0.7, 0.9] {
        let mut cmd = Command::new(ff);
        cmd.args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{:.2}", dur * f), "-i"]).arg(video)
            .args(["-frames:v", "1", "-vf", &format!("scale=64:36,format=gray,lut=y={lut}"), "-f", "rawvideo", "-"]);
        no_window(&mut cmd);
        let Ok(out) = cmd.output() else { continue };
        if out.stdout.len() < 64 * 36 { continue; }
        res.push(out.stdout.iter().filter(|&&b| b > 127).count() as f64 / out.stdout.len() as f64);
    }
    if res.is_empty() { return None; }
    Some((res.iter().cloned().fold(0.0, f64::max), res.iter().cloned().fold(1.0, f64::min)))
}

// Ночной вид клипа (пресет Night) — до всех эффектов, на сырой записи: оружие в руках светится
// сиреневым по маске HLAE. Небо уже звёздное в самой записи (mirv_sky), карта — как в игре.
fn night_pre(j: &Job, ff: &Path, d: &Path) -> Option<PathBuf> {
    let src = d.join("video.mp4");
    let out = d.join("video_night.mp4");
    let vm_lut = "if(gte(val\\,10)\\,255\\,0)";
    // оружие в руках — не больше 45% кадра (иначе поток записал не маску)
    let vm = stream_file(d, "cfvm").filter(|vp| mask_coverage(ff, vp, vm_lut).is_some_and(|(mx, _)| mx > 0.002 && mx < 0.45))?;
    let (w, h) = (j.width, j.height);
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(&src).arg("-i").arg(&vm);
    // смешивание по маске — в планарном RGB: у маски и кадра должен быть один формат
    // (в yuv420p цветовые плоскости вдвое уже, и маска ложилась бы на них со сдвигом).
    // Руки с оружием (viewModelMatte): светлая розово-сиреневая заливка по яркости (тёмные детали
    // тоже светятся), поверх мягкое свечение того же цвета. Отдельной маски оружия без перчаток
    // HLAE не даёт: weaponsMatte — это оружие в мире, а не в руках.
    let g = format!(
        "[1:v]scale={w}:{h},format=gray,lut=y={vm_lut},gblur=sigma=0.8,split[m1][m2];[m1]format=gbrp[m1g];[0:v]format=gbrp,split[vb][vt];\
         [vt]hue=s=0,format=gbrp,lutrgb=r=val*0.75+95:g=val*0.45+25:b=val*0.7+125,split[t1][t2];\
         [vb][t1][m1g]maskedmerge[vw];[t2]format=rgba[t2a];[t2a][m2]alphamerge,gblur=sigma=16[glow];[vw][glow]overlay=format=rgb,format=yuv420p[out]"
    );
    cmd.arg("-filter_complex").arg(&g).args(["-map", "[out]"]).args(codec_args(None, 14)).arg(&out);
    no_window(&mut cmd);
    (cmd.status().map(|s| s.success()).unwrap_or(false) && out.exists()).then_some(out)
}

fn finish_take(j: &Job, ff: &Path, d: &Path, clip: &Clip, dst: &Path, hud_dir: Option<&Path>, lyr_dir: Option<&Path>, on_progress: &dyn Fn(f64)) -> bool {
    let night = if clip.night { night_pre(j, ff, d) } else { None };
    let (v, a) = (night.unwrap_or_else(|| d.join("video.mp4")), d.join("audio.wav"));
    let has_audio = a.exists();
    let hud = hud_dir.map(|h| h.join("hud.ffconcat")).filter(|p| p.exists());
    let lyr = lyr_dir.map(|h| h.join("lyrics.ffconcat")).filter(|p| p.exists());
    // слой умножения текста (буквы окрашивают саму карту) и куда камера тянется к строкам
    let lyr_mul = lyr_dir.map(|h| h.join("lyrics_mul.ffconcat")).filter(|p| p.exists() && lyr.is_some());
    let text_zoom: Vec<[f64; 4]> = lyr_dir.and_then(|h| fs::read_to_string(h.join("zoom.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let music = j.music.as_ref().filter(|m| Path::new(&m.path).exists());
    // номера входов ffmpeg: 0 — видео, дальше по порядку, что есть
    let mut next = 1 + has_audio as usize;
    let mut take = |on: bool| on.then(|| { next += 1; next - 1 });
    let hud_idx = take(hud.is_some());
    let lyr_idx = take(lyr.is_some());
    let mul_idx = take(lyr_mul.is_some());
    let mus_idx = take(music.is_some());

    // Граф передаём строкой: -filter_complex_script убрали в ffmpeg 8, а длина графа далека от лимита командной строки
    let mut filter = post_filter(j, clip, has_audio, has_rubberband(ff), hud_idx);
    let (mut vout, mut aout) = ("[v]", has_audio.then_some("[a]"));
    // Текст песни и трек — уже на итоговой шкале времени (после slow-mo): музыка не замедляется
    if let Some(m) = mul_idx {
        // умножение в RGB: белое — без изменений, красное окрашивает картинку, тёмное затемняет
        filter += &format!(";{vout}format=gbrp[vg];[{m}:v]format=gbrp[mg];[vg][mg]blend=all_mode=multiply,format=yuv420p[vm]");
        vout = "[vm]";
    }
    if let Some(i) = lyr_idx {
        filter += &format!(";{vout}[{i}:v]overlay=0:0:format=auto[vl]");
        vout = "[vl]";
    }
    // в паузах камера плавно наезжает на строку текста (вместе с самим текстом)
    if let Some(zf) = text_zoom_filter(&text_zoom, j.width, j.height) {
        filter += &format!(";{vout}{zf}[vtz]");
        vout = "[vtz]";
    }
    if j.kill_flash {
        let segs = clip_segs(j, clip);
        let kills: Vec<f64> = clip.kill_ticks.iter()
            .map(|&k| (k as f64 - clip.start as f64) / TICKRATE)
            .filter(|&t| t >= 0.0)
            .map(|t| out_time(&segs, t)).collect();
        if let Some(ff) = flash_filter(&kills, &j.flash_color, j.height, d) {
            filter += &format!(";{vout}{ff}[vflash]");
            vout = "[vflash]";
        }
    }
    if j.hs_zoom {
        let segs = clip_segs(j, clip);
        let hs: Vec<f64> = clip.hs_ticks.iter()
            .map(|&k| (k as f64 - clip.start as f64) / TICKRATE)
            .filter(|&t| t >= 0.0)
            .map(|t| out_time(&segs, t)).collect();
        if let Some(zf) = hs_zoom_filter(&hs, j.width, j.height) {
            filter += &format!(";{vout}{zf}[vhs]");
            vout = "[vhs]";
        }
    }
    // удары трека -> зум/тряска на готовой картинке (после текста песни, на итоговой шкале)
    if let Some(m) = music {
        if let Some(mode) = m.beat_fx.as_deref() {
            let start = clip.music_start.unwrap_or(m.offset).max(0.0);
            let beats = crate::music::detect_beats(ff, &m.path, start, out_duration(j, clip));
            if let Some(bf) = beat_filter(&beats, mode, m.beat_amount, j.width, j.height) {
                filter += &format!(";{vout}{bf}[vbeat]");
                vout = "[vbeat]";
            }
        }
    }
    if let (Some(i), Some(m)) = (mus_idx, music) {
        let dur = out_duration(j, clip);
        let fade_at = (dur - 1.2).max(0.0);
        let fade_in = if clip.music_fade_in.unwrap_or(true) { ",afade=t=in:d=0.8".to_string() } else { String::new() };
        let fade_out = if clip.music_fade_out.unwrap_or(true) { format!(",afade=t=out:st={fade_at:.2}:d=1.2") } else { String::new() };
        filter += &format!(";[{i}:a]aresample=48000,volume={:.2}{fade_in}{fade_out}[mus]", m.music_vol);
        if has_audio {
            // лимитер: трек и игра складываются, без него громкие места хрипят (пик упирался в 0 дБ)
            filter += &format!(";[a]aresample=48000,volume={:.2}[ga];[ga][mus]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=disabled[am]", m.game_vol);
            aout = Some("[am]");
        } else {
            aout = Some("[mus]");
        }
    }

    // «растянутый» 4:3: как в игре на stretched-разрешении — кадр 4:3 растягивается до 16:9 той же высоты.
    // Последним шагом, чтобы текст песни, HUD и зумы растянулись вместе с картинкой, как в игре.
    if j.stretch && j.width * 3 == j.height * 4 {
        let sw = ((j.height as f64 * 16.0 / 9.0 / 2.0).round() * 2.0) as u32;
        filter += &format!(";{vout}scale={sw}:{}:flags=lanczos,setsar=1[vst]", j.height);
        vout = "[vst]";
    }

    let encode = |enc: Option<&str>| {
        let mut cmd = Command::new(ff);
        // текущая папка — take: там файл команд вспышки (flash.cmd)
        cmd.current_dir(d);
        cmd.arg("-y").arg("-i").arg(&v);
        if has_audio { cmd.arg("-i").arg(&a); }
        if let Some(h) = &hud { cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(h); }
        if let Some(l) = &lyr { cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(l); }
        if let Some(l) = &lyr_mul { cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(l); }
        if let Some(m) = music {
            let offset = clip.music_start.unwrap_or(m.offset).max(0.0);
            cmd.args(["-ss", &format!("{offset:.3}"), "-i"]).arg(&m.path);
        }
        cmd.arg("-filter_complex").arg(&filter).args(["-map", vout]);
        if let Some(a) = aout { cmd.args(["-map", a]); }
        cmd.args(codec_args(enc, j.crf));
        if aout.is_some() { cmd.args(["-c:a", "aac", "-b:a", "192k", "-shortest"]); }
        no_window(&mut cmd);
        // ffmpeg сообщает, сколько видео уже закодировано (out_time_us) — отдаём долю наружу
        cmd.args(["-progress", "pipe:1", "-nostats"]).arg(dst)
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let Ok(mut child) = cmd.spawn() else { return false };
        let total = out_duration(j, clip).max(0.1);
        if let Some(out) = child.stdout.take() {
            use std::io::BufRead;
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                    on_progress((us / 1e6 / total).clamp(0.0, 1.0));
                }
            }
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    };
    // Если GPU-кодировщик не справился — повторяем на CPU, клип важнее скорости
    encode(j.gpu_encoder.as_deref()) || (j.gpu_encoder.is_some() && encode(None))
}

#[tauri::command]
pub fn start_render(app: AppHandle, job: Job) -> Result<(), String> {
    if job.clips.is_empty() {
        return Err("не выбраны клипы".into());
    }
    if job.clips.iter().any(|clip| !(1..=10).contains(&clip.slot)) {
        return Err("слот игрока должен быть от 1 до 10".into());
    }
    // Фронтенд спрашивает и закрывает игру сам (close_cs2); это — страховка
    if !job.reuse_last && process_running("cs2.exe") {
        return Err("CS2 уже запущена, закрой ее и запусти рендер снова".into());
    }
    CANCEL.store(false, Ordering::SeqCst);

    let cs2 = PathBuf::from(&job.cs2);
    let cfg_dir = cs2
        .ancestors().nth(3).ok_or("неверный путь к cs2.exe")?
        .join("csgo").join("cfg");
    // Тройной fps нужен и блюру (смешивание 3→1), и slow-mo (реальные кадры вместо дублей)
    let drops = job.clips.iter().any(|c| !c.drops.is_empty());
    let rec_fps = if job.blur || job.slowmo || drops { job.fps * 3 } else { job.fps };
    let stamp = if job.stamp.is_empty() { "render".to_string() } else { job.stamp.clone() };
    // Свежая папка на каждый рендер: старые take-папки не смешиваются с новыми клипами
    let work = PathBuf::from(&job.out).join(".clipforge_tmp").join(&stamp);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    // Копии демок со скинами (~сотни МБ) от прошлых рендеров: пока шёл рендер, их держала
    // открытой игра, удалить сразу не получалось
    if let Ok(dirs) = fs::read_dir(work.parent().unwrap_or(&work)) {
        for d in dirs.flatten().map(|e| e.path()).filter(|p| *p != work) {
            let _ = fs::remove_file(d.join("skins.dem"));
            let _ = fs::remove_dir(&d);
        }
    }
    let reuse = job.reuse_last;
    let out_dir = PathBuf::from(&job.out);
    let cache = out_dir.join(LAST_DIR);
    let meta = LastRender {
        clips: job.clips.iter().map(|c| (c.start, c.end)).collect(),
        width: job.width, height: job.height, rec_fps, takes: 0,
    };
    if reuse {
        // сырьё прошлого рендера переносим во временную папку — дальше всё как после записи
        let last = read_last(&out_dir).ok_or("нет сохраненной записи прошлого рендера")?;
        if last.clips != meta.clips || last.takes != meta.clips.len() {
            return Err("клипы изменились с прошлого рендера, нужна новая запись".into());
        }
        if (last.width, last.height) != (job.width, job.height) {
            return Err("другое разрешение, чем в прошлом рендере, нужна новая запись".into());
        }
        if last.rec_fps < rec_fps {
            return Err("для блюра и замедлений нужна запись с тройной частотой кадров, нужна новая запись".into());
        }
        for d in takes(&cache) {
            if let Some(name) = d.file_name() { fs::rename(&d, work.join(name)).map_err(|e| e.to_string())?; }
        }
    } else {
        // новая запись заменяет кэш прошлой; take-папки попадут туда после склейки
        let _ = fs::remove_dir_all(&cache);
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        fs::write(cache.join("meta.json"), serde_json::to_string(&meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        // метки прогресса прошлых рендеров (cfp_<тик>.cfg) больше не нужны
        if let Ok(rd) = fs::read_dir(&cfg_dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(PROGRESS_MARK) { let _ = fs::remove_file(e.path()); }
            }
        }
        let (head, run, files) = build_cfg(&job, rec_fps, &work, &cfg_dir);
        for (name, body) in files {
            // XML пути камеры — как есть, остальное — cfg
            let file = if name.ends_with(".xml") { name } else { format!("{name}.cfg") };
            fs::write(cfg_dir.join(file), body).map_err(|e| e.to_string())?;
        }
        fs::write(cfg_dir.join("clipforge.cfg"), head).map_err(|e| e.to_string())?;
        fs::write(cfg_dir.join("clipforge_run.cfg"), run).map_err(|e| e.to_string())?;
    }
    // console.log игры (-condebug) — источник меток прогресса; старый удаляем, чтобы не читать чужие метки
    let console_log = cfg_dir.parent().map(|p| p.join("console.log")).unwrap_or_default();
    if !reuse { let _ = fs::remove_file(&console_log); }

    let hlae_dir = Path::new(&job.hlae).parent().ok_or("неверный путь к HLAE")?.to_path_buf();
    let cmdline = format!(
        "-steam -insecure -novid -console -condebug -windowed -width {} -height {} +playdemo \"{}\" +exec clipforge",
        job.width, job.height, job.demo.replace('\\', "/")
    );
    let total = job.clips.len();
    // У HLAE хук для CS2 лежит в подпапке x64 (в корне только 32-битный хук для CS:GO)
    let mut dll = hlae_dir.join("x64").join("AfxHookSource2.dll");
    if !dll.exists() { dll = hlae_dir.join("AfxHookSource2.dll"); }
    if !dll.exists() { return Err(format!("не найден AfxHookSource2.dll рядом с HLAE: {}", hlae_dir.display())); }

    thread::spawn(move || {
        // при пересборке игра не нужна: take-папки уже лежат во временной папке
        let mut child = if reuse { None } else {
            match Command::new(&job.hlae)
                .args(["-customLoader", "-noGui", "-autoStart"])
                .arg("-hookDllPath").arg(&dll)
                .arg("-programPath").arg(&job.cs2)
                .arg("-cmdLine").arg(&cmdline)
                .spawn()
            {
                Ok(c) => Some(c),
                Err(_) => { let _ = app.emit("render-error", "не удалось запустить HLAE"); return; }
            }
        };
        let out = PathBuf::from(&job.out);
        let ff = crate::ffmpeg::find(&job.hlae).unwrap_or_else(|| hlae_dir.join("ffmpeg").join("bin").join("ffmpeg.exe"));
        let prefix = stamp.replace('_', " ");
        // HLAE.exe завершается сразу после запуска игры, поэтому следим за самим cs2.exe.
        // Take готов, когда началась следующая запись, игра закрыта, или это последний клип
        // и его файлы перестали расти. Готовые клипы обрабатываем сразу, не дожидаясь выхода из игры.
        let started = Instant::now();
        let mut seen_game = false;
        let mut handled: HashSet<PathBuf> = HashSet::new();
        let mut sizes: HashMap<PathBuf, (u64, u32)> = HashMap::new();
        let mut made = 0;
        let mut done_clips: Vec<crate::toast::ToastClip> = Vec::new();
        let mut compare: Vec<CompareItem> = Vec::new();
        let _ = fs::remove_file(cache.join("compare.json"));
        // прогресс: 70% — запись (по меткам тиков из console.log), 30% — склейка (по ffmpeg)
        let emit = |rec: f64, enc: f64| { let _ = app.emit("render-progress", ((0.7 * rec + 0.3 * enc) * 100.0) as f32); };
        let mut rec = 0.0;
        let mut iter = 0u32;
        let mut game = true;
        // Подсказка поверх игры — в своём потоке: основной цикл подолгу занят склейкой клипов,
        // а подсказка должна идти вровень с демкой. Сама закрывает окно, когда её останавливают.
        let ov_stop = std::sync::Arc::new(AtomicBool::new(false));
        if !reuse {
            let (app, stop, log, clips, work) = (app.clone(), ov_stop.clone(), console_log.clone(), job.clips.clone(), work.clone());
            let key = job.start_key.to_uppercase();
            thread::spawn(move || {
                let total = clips.len();
                let mut done_at: Option<Instant> = None;
                while !stop.load(Ordering::SeqCst) {
                    let tail = log_tail(&log).unwrap_or_default();
                    let tick = last_progress_tick(&tail);
                    let n = takes(&work).len();
                    let finished = recording_finished(&tail, total);
                    if finished { done_at.get_or_insert_with(Instant::now); }
                    // «запись готова» висит пять секунд, дальше игру можно сворачивать — подсказка не нужна
                    if done_at.is_some_and(|t| t.elapsed() > Duration::from_secs(5)) {
                        crate::overlay::hide(&app);
                    } else {
                        let pct = if finished { 100.0 } else { recorded_fraction(&clips, tick, n) * 100.0 };
                        crate::overlay::show(&app, crate::overlay::OverlayState {
                            phase: if finished { "done" } else if n > 0 || tick.is_some() { "rec" } else { "wait" },
                            key: key.clone(),
                            clip: n.clamp(1, total.max(1)),
                            total,
                            pct: pct as f32,
                        });
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                crate::overlay::close(&app);
            });
        }
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                // игру запускал рендер — закрываем её вместе с ним (при пересборке игры нет)
                if let Some(c) = child.as_mut() { let _ = c.kill(); }
                ov_stop.store(true, Ordering::SeqCst);
                if !reuse { kill_cs2(); }
                let _ = app.emit("render-error", "рендер остановлен");
                return;
            }
            let hlae_alive = child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
            // tasklist — отдельный процесс, поэтому проверяем игру раз в секунду, а прогресс — 4 раза
            if reuse { game = false; } else if iter % 4 == 0 { game = process_running("cs2.exe"); }
            iter += 1;
            seen_game |= game;
            let running = !reuse && (hlae_alive || game || (!seen_game && started.elapsed() < Duration::from_secs(120)));
            if reuse { rec = 1.0; }

            let dirs = takes(&work);
            let tail = log_tail(&console_log).unwrap_or_default();
            rec = if recording_finished(&tail, total) { 1.0 }
                else { f64::max(rec, recorded_fraction(&job.clips, last_progress_tick(&tail), dirs.len())) };
            for (pos, d) in dirs.iter().enumerate() {
                if handled.contains(d) { continue; }
                // номер клипа — сколько записей уже обработано: готовые take-папки уезжают в кэш,
                // поэтому позиция в папке не совпадает с номером клипа (и раньше путала клипы)
                let i = handled.len();
                // запись готова: началась следующая, игра закрыта, или это последний клип и файлы перестали расти
                let ready = pos + 1 < dirs.len() || !running || (i + 1 >= total && settled(d, &mut sizes));
                if !ready { continue; }
                handled.insert(d.clone());
                let clip = job.clips.get(i).cloned().unwrap_or_else(|| Clip {
                    account_id: 0, name: String::new(), round: 0, start: 0, end: 0, slot: 1,
                    kill_ticks: vec![], hits: vec![], drops: vec![], music_start: None, cine: None, hs_ticks: vec![], music_fade_in: None, music_fade_out: None, night: false,
                });
                // "2026-10-30 15-40-12 R05 3K.mp4" — сортируется по времени, как остальные видео в папке
                let dst = match &job.parts_dir {
                    Some(pd) => { let _ = fs::create_dir_all(pd); PathBuf::from(pd).join(format!("part_{i:02}.mp4")) }
                    None => out.join(match (clip.round, clip.kill_ticks.len()) {
                        (0, _) => format!("{prefix} clip {:02}.mp4", i + 1),
                        (r, 0) => format!("{prefix} R{r:02}.mp4"),
                        (r, k) => format!("{prefix} R{r:02} {k}K.mp4"),
                    }),
                };
                // Сырьё удаляем только после удачной склейки — иначе оставляем, чтобы запись не пропала
                let hud_dir = work.join(format!("hud_{i}"));
                let hud = (job.hud == "match").then_some(hud_dir.as_path());
                let lyr_dir = work.join(format!("lyr_{i}"));
                let done_before = handled.len() - 1;
                let on_progress = |f: f64| emit(rec, (done_before as f64 + f) / total as f64);
                if finish_take(&job, &ff, d, &clip, &dst, hud, Some(lyr_dir.as_path()), &on_progress) {
                    made += 1;
                    done_clips.push(crate::toast::ToastClip {
                        path: dst.to_string_lossy().to_string(),
                        name: dst.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    });
                    // кусок монтажа с ночным видом: сырьё (с потоками глубины и маски оружия) остаётся рядом
                    // с кусками — следующая демка очищает кэш, а по нему видно, что записал HLAE
                    if let (Some(pd), true) = (&job.parts_dir, clip.night) {
                        let _ = fs::rename(d, PathBuf::from(pd).join(format!("take_night_{i:02}")));
                    }
                    // сырьё — в кэш для «Пересобрать без игры» (место освобождается следующим рендером)
                    let kept = d.exists() && d.file_name().is_some_and(|n| fs::rename(d, cache.join(n)).is_ok());
                    if !kept { let _ = fs::remove_dir_all(d); }
                    if let (true, Some(n)) = (kept, d.file_name()) {
                        compare.push(CompareItem {
                            name: dst.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                            out: dst.to_string_lossy().to_string(),
                            take: cache.join(n).join("video.mp4").to_string_lossy().to_string(),
                            dur: out_duration(&job, &clip),
                            segs: clip_segs(&job, &clip),
                        });
                        let _ = fs::write(cache.join("compare.json"), serde_json::to_string(&compare).unwrap_or_default());
                    }
                    let _ = fs::remove_dir_all(&hud_dir);
                    let _ = fs::remove_dir_all(&lyr_dir);
                }
            }

            if handled.len() >= total { rec = 1.0; }
            emit(rec, handled.len().min(total) as f64 / total as f64);
            if handled.len() >= total || (!running && handled.len() >= dirs.len()) { break; }
            thread::sleep(Duration::from_millis(250));
        }
        // Все клипы записаны и склеены — закрываем игру, чтобы она не мешала следующему рендеру.
        // Раньше игру не трогали из страха оборвать запись, но сюда доходим только когда файлы
        // уже дописаны (перестали расти) и обработаны.
        ov_stop.store(true, Ordering::SeqCst);
        if !reuse { kill_cs2(); }
        // Копия демки со скинами (игра закрыта — файл уже не занят)
        let _ = fs::remove_file(work.join("skins.dem"));
        // Удаляются только если опустели (remove_dir не трогает непустые папки)
        let _ = fs::remove_dir(&work);
        let _ = fs::remove_dir(out.join(".clipforge_tmp"));
        if made == 0 {
            let _ = app.emit("render-error", if handled.is_empty() {
                format!("запись не началась: в игре нужно нажать {}, когда демка загрузится", job.start_key.to_uppercase())
            } else {
                format!("не удалось собрать клипы, сырая запись осталась в {}", work.display())
            });
            return;
        }
        // несколько клипов — один ролик: «2026-11-01 17-36-17 reel 3 clips.mp4». Отдельные клипы
        // уезжают в кэш последнего рендера (там их видит «До / после») или остаются, если так выбрано.
        // куски для монтажа: склеит build_montage, когда отрендерятся все демки
        if job.parts_dir.is_some() {
            let _ = app.emit("render-progress", 100.0_f32);
            let _ = app.emit("render-done", out.to_string_lossy().to_string());
            return;
        }
        if job.merge && done_clips.len() >= 2 {
            let parts: Vec<PathBuf> = done_clips.iter().map(|c| PathBuf::from(&c.path)).collect();
            let reel = out.join(format!("{prefix} reel {} clips.mp4", parts.len()));
            // с переходом; не вышло (например, видеокарта не взяла кодирование) — простая склейка
            let made_reel = reel_with_transitions(&ff, &parts, &reel, job.gpu_encoder.as_deref(), job.crf)
                || reel_with_transitions(&ff, &parts, &reel, None, job.crf)
                || concat_clips(&ff, &parts, &reel, &cache.join("reel.ffconcat"));
            if made_reel {
                if !job.keep_parts {
                    let dir = cache.join("parts");
                    let _ = fs::create_dir_all(&dir);
                    for part in &parts {
                        let Some(name) = part.file_name() else { continue };
                        let moved = dir.join(name);
                        if fs::rename(part, &moved).is_ok() {
                            let from = part.to_string_lossy().to_string();
                            for c in compare.iter_mut().filter(|c| c.out == from) { c.out = moved.to_string_lossy().to_string(); }
                        }
                    }
                    let _ = fs::write(cache.join("compare.json"), serde_json::to_string(&compare).unwrap_or_default());
                }
                done_clips = vec![crate::toast::ToastClip {
                    path: reel.to_string_lossy().to_string(),
                    name: reel.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                }];
            }
        }
        let _ = app.emit("render-progress", 100.0_f32);
        let _ = app.emit("render-done", out.to_string_lossy().to_string());
        // уведомление в углу экрана: ты мог свернуть игру и уйти — клипы готовы
        crate::toast::show(&app, crate::toast::ToastData { clips: done_clips, hlae: job.hlae.clone(), out: job.out.clone() });
    });
    Ok(())
}

