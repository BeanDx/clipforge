// Монтаж под бит (пресет Night): куски готовых клипов из разных демок в заданном порядке.
// Все тайминги считает фронтенд (src/montage.js): откуда резать каждый кусок, с какой скоростью
// (так киллы встают ровно на удары трека), где склейки и удары. Здесь — только ffmpeg:
// склейка кусков → рывок-размытие на склейках → удар зума на киллах → затемнение в конце → трек.
use serde::Deserialize;
use std::path::Path;
use std::process::Command;

use crate::render::{beat_filter, codec_args, flash_filter, no_window, stretch};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub path: String,
    pub from: f64,
    pub to: f64,
    // скорость куска: >1 — быстрее (кусок короче), <1 — медленнее
    pub speed: f64,
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
    // секунды киллов: удар зума
    #[serde(default)]
    pub punches: Vec<f64>,
    #[serde(default)]
    pub music: Option<MontageMusic>,
}

fn has_audio(ff: &Path, p: &str) -> bool {
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-i", p]);
    no_window(&mut cmd);
    cmd.output().map(|o| String::from_utf8_lossy(&o.stderr).contains("Audio:")).unwrap_or(false)
}

fn graph(m: &Montage, inputs: &[String], game_audio: bool, rubberband: bool, work: &Path) -> (String, f64) {
    let mut g = String::new();
    let mut total = 0.0;
    let n = m.segments.len();
    for (k, s) in m.segments.iter().enumerate() {
        let i = inputs.iter().position(|p| *p == s.path).unwrap_or(0);
        let sp = s.speed.clamp(0.25, 4.0);
        g += &format!(
            "[{i}:v]trim=start={:.4}:end={:.4},setpts=(PTS-STARTPTS)/{sp:.5},fps={},scale={}:{},setsar=1[v{k}];",
            s.from, s.to, m.fps, m.width, m.height
        );
        if game_audio {
            let tempo = if (sp - 1.0).abs() < 1e-3 { "anull".to_string() } else { stretch(sp, rubberband) };
            g += &format!("[{i}:a]atrim=start={:.4}:end={:.4},asetpts=PTS-STARTPTS,aresample=48000,{tempo}[a{k}];", s.from, s.to);
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
    // на килле: розовая вспышка-свечение и резкое приближение, которое плавно отпускает
    if let Some(fl) = flash_filter(&m.punches, "pink", m.height, work) {
        g += &format!(";{v}{fl}[vf]");
        v = "[vf]".into();
    }
    if let Some(bf) = beat_filter(&m.punches, "zoom", 2.2, m.width, m.height) {
        g += &format!(";{v}{bf}[vp]");
        v = "[vp]".into();
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

#[tauri::command]
pub async fn build_montage(m: Montage) -> Result<String, String> {
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
    // папка файла команд вспышки (flash.cmd) — рядом с готовым эдитом, после сборки удаляется
    let work = Path::new(&m.out).parent().map(Path::to_path_buf).unwrap_or_default();
    let (g, _) = graph(&m, &inputs, game_audio, rubberband, &work);
    let run = |enc: Option<&str>| {
        let mut cmd = Command::new(&ff);
        cmd.current_dir(&work);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        for p in &inputs { cmd.arg("-i").arg(p); }
        if let Some(mu) = &m.music { cmd.args(["-ss", &format!("{:.3}", mu.start.max(0.0)), "-i"]).arg(&mu.path); }
        cmd.arg("-filter_complex").arg(&g).args(["-map", "[vout]"]);
        let has_a = m.music.is_some() || game_audio;
        if has_a { cmd.args(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]); }
        cmd.args(codec_args(enc, m.crf)).args(["-movflags", "+faststart"]).arg(&m.out);
        no_window(&mut cmd);
        cmd.output()
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


