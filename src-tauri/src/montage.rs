// Монтаж под бит (пресет Night): куски готовых клипов из разных демок в заданном порядке.
// Все тайминги считает фронтенд (src/features/edit/montage.js): откуда резать каждый кусок, с какой скоростью
// (так киллы встают ровно на удары трека), где склейки и удары. Здесь — только ffmpeg:
// склейка кусков → рывок-размытие на склейках → удар зума на киллах → затемнение в конце → трек.
use serde::Deserialize;
use std::path::Path;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::render::{codec_args, no_window, stretch};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub path: String,
    pub from: f64,
    pub to: f64,
    // скорость куска: >1 — быстрее (кусок короче), <1 — медленнее
    pub speed: f64,
    // чёрно-белый кусок (очередь коротких киллов)
    #[serde(default)]
    pub gray: bool,
    // кусок задом наперёд (перемотка назад в слоу-мо)
    #[serde(default)]
    pub reverse: bool,
}

// вспышка цвета на секунде t итоговой шкалы: "red" — заливка после килла, "pink" — яркая вспышка
#[derive(Deserialize)]
pub struct Flash {
    pub t: f64,
    pub color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MontageMusic {
    pub path: String,
    pub start: f64,
    pub music_vol: f32,
    pub game_vol: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Montage {
    pub hlae: String,
    pub out: String,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub crf: u32,
    #[serde(default)]
    pub gpu_encoder: Option<String>,
    pub segments: Vec<Segment>,
    // секунды склеек (итоговая шкала): там рывок с горизонтальным размытием
    #[serde(default)]
    pub whips: Vec<f64>,
    #[serde(default)]
    pub music: Option<MontageMusic>,
    #[serde(default)]
    pub flashes: Vec<Flash>,
    // текст песни поверх всего эдита (кадры ffconcat, как у клипов) и слой умножения для «Акцента»
    #[serde(default)]
    pub lyrics: Option<String>,
    #[serde(default)]
    pub lyrics_mul: Option<String>,
}

fn has_audio(ff: &Path, p: &str) -> bool {
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-i", p]);
    no_window(&mut cmd);
    cmd.output().map(|o| String::from_utf8_lossy(&o.stderr).contains("Audio:")).unwrap_or(false)
}

fn graph(m: &Montage, inputs: &[String], game_audio: bool, rubberband: bool) -> (String, f64) {
    let mut g = String::new();
    let mut total = 0.0;
    let n = m.segments.len();
    for (k, s) in m.segments.iter().enumerate() {
        let i = inputs.iter().position(|p| *p == s.path).unwrap_or(0);
        let sp = s.speed.clamp(0.25, 4.0);
        g += &format!(
            "[{i}:v]trim=start={:.4}:end={:.4},setpts=PTS-STARTPTS{},setpts=(PTS-STARTPTS)/{sp:.5},fps={},scale={}:{},setsar=1{}[v{k}];",
            s.from, s.to, if s.reverse { ",reverse" } else { "" }, m.fps, m.width, m.height, if s.gray { ",hue=s=0" } else { "" }
        );
        if game_audio {
            let tempo = if (sp - 1.0).abs() < 1e-3 { "anull".to_string() } else { stretch(sp, rubberband) };
            g += &format!("[{i}:a]atrim=start={:.4}:end={:.4},asetpts=PTS-STARTPTS{},aresample=48000,{tempo}[a{k}];",
                s.from, s.to, if s.reverse { ",areverse" } else { "" });
        }
        total += (s.to - s.from) / sp;
    }
    for k in 0..n {
        g += &format!("[v{k}]");
        if game_audio { g += &format!("[a{k}]"); }
    }
    g += &format!("concat=n={n}:v=1:a={}[vc]{}", game_audio as u8, if game_audio { "[ac]" } else { "" });
    let mut v = "[vc]".to_string();
    // рывок: на 0.07 с вокруг склейки кадр размазывается по горизонтали и чуть приближается
    if !m.whips.is_empty() {
        let en = m.whips.iter().map(|c| format!("between(t,{:.3},{:.3})", c - 0.07, c + 0.07)).collect::<Vec<_>>().join("+");
        g += &format!(";{v}avgblur=sizeX={}:sizeY=1:enable='{en}'[vw]", (m.width / 30).max(8));
        v = "[vw]".into();
    }
    // на киллах ни свечения, ни зума: склейки в эдите жёсткие, кадр не дёргается (как в референсе)
    // вспышки цвета: заливка поверх кадра, гаснет ступеньками (drawbox дешевле формул по пикселям)
    let mut boxes: Vec<String> = Vec::new();
    for f in &m.flashes {
        let (col, steps): (&str, &[(f64, f64)]) = match f.color.as_str() {
            "pink" => ("0xff2fa0", &[(0.08, 0.85), (0.16, 0.55), (0.28, 0.3), (0.45, 0.12)]),
            _ => ("0xff1a2e", &[(0.12, 0.3), (0.3, 0.22), (0.5, 0.14), (0.8, 0.06)]),
        };
        let mut a = f.t;
        for &(b, op) in steps {
            boxes.push(format!("drawbox=x=0:y=0:w=iw:h=ih:color={col}@{op}:t=fill:enable='between(t,{a:.3},{:.3})'", f.t + b));
            a = f.t + b;
        }
    }
    if !boxes.is_empty() {
        g += &format!(";{v}{}[vfl]", boxes.join(","));
        v = "[vfl]".into();
    }
    // текст песни поверх всего эдита: сначала умножение (буквы «Акцента» окрашивают картинку), потом сами кадры
    let mut li = inputs.len() + m.music.is_some() as usize;
    if let Some(_) = &m.lyrics_mul {
        g += &format!(";{v}format=gbrp[vlg];[{li}:v]format=gbrp[vlm];[vlg][vlm]blend=all_mode=multiply,format=yuv420p[vlx]");
        v = "[vlx]".into();
        li += 1;
    }
    if let Some(_) = &m.lyrics {
        g += &format!(";{v}[{li}:v]overlay=0:0:format=auto[vly]");
        v = "[vly]".into();
    }
    g += &format!(";{v}fade=t=out:st={:.3}:d=1.0,format=yuv420p[vout]", (total - 1.0).max(0.0));
    // звук: трек + игра потише, конец уходит в тишину вместе с картинкой
    let fade = format!("afade=t=out:st={:.3}:d=1.2", (total - 1.2).max(0.0));
    let mi = inputs.len();
    match (&m.music, game_audio) {
        (Some(mu), true) => g += &format!(
            ";[{mi}:a]aresample=48000,volume={:.2},afade=t=in:d=0.3[mus];[ac]volume={:.2}[ga];[ga][mus]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=disabled,{fade}[aout]",
            mu.music_vol, mu.game_vol
        ),
        (Some(mu), false) => g += &format!(";[{mi}:a]aresample=48000,volume={:.2},atrim=end={total:.3},{fade}[aout]", mu.music_vol),
        (None, true) => g += &format!(";[ac]{fade}[aout]"),
        (None, false) => {}
    }
    (g, total)
}

// Прогресс склейки для интерфейса: доля готового видео и сколько МБ уже записано (событие montage-progress)
#[derive(Clone, serde::Serialize)]
struct MontageProgress { frac: f64, mb: f64 }

#[tauri::command]
pub async fn build_montage(app: AppHandle, m: Montage) -> Result<String, String> {
    if m.segments.is_empty() { return Err("нет кусков для монтажа".into()); }
    let ff = crate::ffmpeg::find(&m.hlae).ok_or("не найден ffmpeg")?;
    let mut inputs: Vec<String> = Vec::new();
    for s in &m.segments { if !inputs.contains(&s.path) { inputs.push(s.path.clone()); } }
    let game_audio = inputs.iter().all(|p| has_audio(&ff, p));
    let rubberband = {
        let mut cmd = Command::new(&ff);
        cmd.args(["-hide_banner", "-filters"]);
        no_window(&mut cmd);
        cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).contains(" rubberband ")).unwrap_or(false)
    };
    // рабочая папка ffmpeg — рядом с готовым эдитом (flash.cmd прошлых версий оттуда удаляется)
    let work = Path::new(&m.out).parent().map(Path::to_path_buf).unwrap_or_default();
    let (g, total) = graph(&m, &inputs, game_audio, rubberband);
    let run = |enc: Option<&str>| {
        let mut cmd = Command::new(&ff);
        cmd.current_dir(&work);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        for p in &inputs { cmd.arg("-i").arg(p); }
        if let Some(mu) = &m.music { cmd.args(["-ss", &format!("{:.3}", mu.start.max(0.0)), "-i"]).arg(&mu.path); }
        if let Some(l) = &m.lyrics_mul { cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(l); }
        if let Some(l) = &m.lyrics { cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(l); }
        cmd.arg("-filter_complex").arg(&g).args(["-map", "[vout]"]);
        let has_a = m.music.is_some() || game_audio;
        if has_a { cmd.args(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]); }
        cmd.args(codec_args(enc, m.crf)).args(["-movflags", "+faststart"]);
        // ffmpeg пишет прогресс в stdout: сколько видео готово (out_time_us) и сколько байт записано
        cmd.args(["-progress", "pipe:1", "-nostats"]).arg(&m.out)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        no_window(&mut cmd);
        let mut child = cmd.spawn()?;
        if let Some(out) = child.stdout.take() {
            let (mut frac, mut mb) = (0.0, 0.0);
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(v) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                    frac = (v / 1e6 / total.max(0.1)).clamp(0.0, 1.0);
                } else if let Some(v) = line.strip_prefix("total_size=").and_then(|v| v.trim().parse::<f64>().ok()) {
                    mb = v / 1048576.0;
                } else if line.starts_with("progress=") {
                    let _ = app.emit("montage-progress", MontageProgress { frac, mb });
                }
            }
        }
        child.wait_with_output()
    };
    let first = run(m.gpu_encoder.as_deref()).map_err(|e| e.to_string())?;
    let res = if first.status.success() { Ok(m.out.clone()) }
        else if m.gpu_encoder.is_some() {
            let second = run(None).map_err(|e| e.to_string())?;
            if second.status.success() { Ok(m.out.clone()) }
            else { Err(String::from_utf8_lossy(&second.stderr).trim().chars().take(600).collect()) }
        } else { Err(String::from_utf8_lossy(&first.stderr).trim().chars().take(600).collect()) };
    let _ = std::fs::remove_file(work.join("flash.cmd"));
    res
}



