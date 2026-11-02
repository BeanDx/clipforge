// Свой трек под хайлайтом + текст песни на экране. По умолчанию выключено.
// Текст — синхронизированный по строкам из LRCLIB (поиск в Rust: music.rs). Если песни там нет —
// вставленный текст: строки размечаются пробелом под трек или автоматически (маленькая нейросеть
// Whisper даёт время слов, src/lyricsAlign.js сопоставляет их с текстом). Внутри строки буквы
// появляются в такт, распределяясь по времени её звучания.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { tr, trError, useLang } from "../../i18n";
import { drawDust, drawTargets } from "../edit/nightfx";
import { alignLyrics } from "./lyricsAlign";
import { LYRIC_STYLES, drawLyricStyle, lyricFont, lyricStyle, snapWords, wordsOf, heartWord } from "./lyricStyles";
import previewBg from "../../assets/previews/lyrics-bg.webp";
export const MUSIC_DEFAULT = {
  enabled: false, path: "", title: "", artist: "", duration: 0,
  lrc: "", start: 0, musicVol: 0.8, gameVol: 0.35, showLyrics: true, chorusSlow: false, chorusOnKill: true,
  beatFx: false, beatMode: "zoom", beatAmount: 1,
  lyricStyle: "karaoke", smartLyrics: true,
};
const BEAT_MODES = [["zoom", "Зум"], ["shake", "Тряска"], ["both", "Зум + тряска"]];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

// "[01:23.45] текст" -> [{ t: 83.45, text }]
export function parseLrc(lrc) {
  const out = [];
  for (const line of (lrc || "").split(/\r?\n/)) {
    const m = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const x of m) out.push({ t: +x[1] * 60 + +x[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Припев — строки, которые повторяются. Ищем начало окна длиной len, где их больше всего.
export function pickChorus(lines, len) {
  const sung = lines.filter((l) => norm(l.text).length > 3);
  if (!sung.length) return 0;
  const count = new Map();
  for (const l of sung) count.set(norm(l.text), (count.get(norm(l.text)) || 0) + 1);
  const isChorus = (l) => (count.get(norm(l.text)) || 0) >= 2;
  let best = { score: -1, t: sung[0].t };
  for (const s of sung) {
    const score = sung.filter((l) => l.t >= s.t && l.t < s.t + len && isChorus(l)).length;
    if (score > best.score) best = { score, t: s.t };
  }
  return Math.max(0, best.t - 0.6);
}

// --- кадры текста песни (накладываются ffmpeg после slow-mo, как HUD) ---
// Unbounded — жирный широкий шрифт с кириллицей, как в эдитах (подключён в highlight-renderer.css)
const TICKRATE = 64;

// slow-mo — те же ступени, что SLOWMO_RAMP в render.rs: (от, до, скорость) относительно килла
const RAMP = [[-0.6, -0.45, 0.75], [-0.45, -0.25, 0.5], [-0.25, 0.25, 0.35], [0.25, 0.45, 0.5], [0.45, 0.6, 0.75]];
// замедление на припеве — копия drop_speed из render.rs (константы должны совпадать)
const DROP = { min: 0.35, from: -1.2, to: 2.0, step: 0.08 };
function dropSpeed(d) {
  const ease = (x) => (1 - Math.cos(Math.PI * x)) / 2;
  if (d < DROP.from || d >= DROP.to) return 1;
  if (d < 0) return 1 - (1 - DROP.min) * ease((d - DROP.from) / -DROP.from);
  if (d < 0.6) return DROP.min;
  return DROP.min + (1 - DROP.min) * ease((d - 0.6) / (DROP.to - 0.6));
}
function slowmoSegments(kills, drops = []) {
  const speedAt = (t) => {
    const kill = kills.reduce((m, k) => {
      const r = RAMP.find(([a, b]) => t >= k + a && t < k + b);
      return r ? Math.min(m, r[2]) : m;
    }, 1);
    return drops.reduce((m, c) => Math.min(m, dropSpeed(t - c)), kill);
  };
  const steps = Math.round((DROP.to - DROP.from) / DROP.step);
  const raw = [0,
    ...kills.flatMap((k) => RAMP.flatMap(([a, b]) => [k + a, k + b])),
    ...drops.flatMap((c) => Array.from({ length: steps + 1 }, (_, s) => c + DROP.from + s * DROP.step)),
  ].map((x) => Math.max(0, x)).sort((a, b) => a - b);
  // те же точки, что в Rust: близкие (меньше 1 мс) сливаются
  const pts = raw.filter((x, i) => i === 0 || x - raw[i - 1] >= 1e-3);
  return pts.map((a, i) => [a, pts[i + 1] ?? Infinity, pts[i + 1] != null ? speedAt((a + pts[i + 1]) / 2) : 1]);
}

// Время итогового видео -> секунда записи (обратно к slow-mo)
function outToIn(segs, tOut) {
  let acc = 0;
  for (const [a, b, s] of segs) {
    const len = (b - a) / s;
    if (tOut <= acc + len) return a + (tOut - acc) * s;
    acc += len;
  }
  return tOut;
}
// Секунда записи -> время итогового видео
function inToOut(segs, tIn) {
  let acc = 0;
  for (const [a, b, s] of segs) {
    if (tIn <= b) return acc + (tIn - a) / s;
    acc += (b - a) / s;
  }
  return acc;
}

// «Припев — на последний килл»: замедление ставим на последний килл клипа (там экшен), а трек
// для этого клипа начинаем с такой секунды, чтобы первая строка припева прозвучала ровно в этот
// момент готового видео. Припев берём ближайший к выбранному на шкале месту.
// Возвращает { start, drops } или null, если в клипе нет киллов или припева.
export function alignChorusToKill({ lrc, start, clip, slowmo }) {
  const kills = (clip.killTicks || []).map((t) => (t - clip.start) / TICKRATE);
  if (!kills.length) return null;
  const lines = parseLrc(lrc);
  const count = new Map();
  for (const l of lines) if (l.text) count.set(norm(l.text), (count.get(norm(l.text)) || 0) + 1);
  const chorus = lines.filter((l) => l.text && (count.get(norm(l.text)) || 0) >= 2);
  if (!chorus.length) return null;
  // начало припева: строка припева, перед которой не припев (иначе берём середину припева)
  const starts = chorus.filter((l) => {
    const prev = lines.filter((x) => x.text && x.t < l.t).pop();
    return !prev || (count.get(norm(prev.text)) || 0) < 2;
  });
  const pick = starts.find((l) => l.t >= start) || starts[starts.length - 1] || chorus[0];
  const kill = kills[kills.length - 1];
  const killOut = inToOut(slowmoSegments(slowmo ? kills : [], [kill]), kill);
  const s = pick.t - killOut;
  return s >= 0 ? { start: +s.toFixed(3), drops: [kill] } : null;
}

// Повторы глазами жертв в конце клипа, секунды (как replays в render.rs)
function replaySecs(clip) {
  const reps = clip.cine?.victims?.length ? clip.cine.victims.map((v) => v.kill)
    : clip.cine?.victimSlot != null ? [clip.cine.kill] : [];
  return reps.reduce((s, k) => s + (k + 16 - Math.max(k - 77, clip.start)) / TICKRATE, 0);
}

// Длина готового клипа: запись со всеми замедлениями плюс повторы
export function clipOutDuration({ clip, slowmo, drops = [] }) {
  const base = (clip.end - clip.start) / TICKRATE;
  const kills = slowmo ? (clip.killTicks || []).map((t) => (t - clip.start) / TICKRATE) : [];
  const segs = slowmo || drops.length ? slowmoSegments(kills, drops) : [[0, Infinity, 1]];
  return segs.reduce((s, [a, b, sp]) => s + (Math.min(b, base) - Math.min(a, base)) / sp, 0) + replaySecs(clip);
}

// Переход между клипами в склеенном ролике, секунды (тот же REEL_XFADE в render.rs)
export const REEL_XFADE = 0.35;

// Склейка в один ролик: песня идёт через все клипы без перескоков. Каждый клип начинается с того
// места трека, где закончился предыдущий (минус переход, в нём клипы накладываются). Припев на
// последний килл — на последнем клипе ролика. Трек плавно появляется только в первом клипе
// и уходит только в последнем.
export function chainMusic({ clips, lrc, start, slowmo, chorusSlow, chorusOnKill }) {
  const last = clips[clips.length - 1];
  const target = chorusSlow && chorusOnKill && lrc ? alignChorusToKill({ lrc, start, clip: last, slowmo }) : null;
  let base = start;
  // замедления меняют длину клипов, поэтому начало подбираем в пару проходов
  for (let pass = 0; pass < 3; pass++) {
    let s = base;
    clips.forEach((c, i) => {
      c.musicStart = +s.toFixed(3);
      c.drops = i === clips.length - 1 && target ? target.drops
        : chorusSlow && lrc ? chorusDrops({ lrc, start: s, clip: c, slowmo }) : [];
      c.musicFadeIn = i === 0;
      c.musicFadeOut = i === clips.length - 1;
      s += clipOutDuration({ clip: c, slowmo, drops: c.drops }) - REEL_XFADE;
    });
    if (!target) break;
    base = Math.max(0, base + (target.start - last.musicStart));
  }
}

// Замедление на припеве: ищем в записи такой момент c, чтобы в готовом видео (со всеми
// замедлениями, включая собственное) он пришёлся ровно на начало припева в треке.
// Возвращает [c] в секундах записи клипа или [], если припев в этот клип не попадает.
export function chorusDrops({ lrc, start, clip, slowmo }) {
  const lines = parseLrc(lrc);
  const count = new Map();
  for (const l of lines) if (l.text) count.set(norm(l.text), (count.get(norm(l.text)) || 0) + 1);
  // первая строка припева — с отступом от начала: замедлению нужно место на разгон
  const first = lines.find((l) => l.text && (count.get(norm(l.text)) || 0) >= 2 && l.t >= start + 1.4);
  if (!first) return [];
  const target = first.t - start;
  const base = (clip.end - clip.start) / TICKRATE;
  const kills = slowmo ? (clip.killTicks || []).map((t) => (t - clip.start) / TICKRATE) : [];
  let lo = 0, hi = base;
  for (let i = 0; i < 40; i++) {
    const c = (lo + hi) / 2;
    if (inToOut(slowmoSegments(kills, [c]), c) < target) lo = c; else hi = c;
  }
  const c = (lo + hi) / 2;
  return c > 1.3 && c < base - 0.5 ? [+c.toFixed(3)] : [];
}

const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Углы в демке записаны 64 раза в секунду и слегка «ступенчато». Готовим гладкую кривую:
// поворот разворачиваем в непрерывный (без скачка 180/-180), сглаживаем ядром 1-4-6-4-1
// по соседним тикам, а между тиками интерполируем сплайном Катмулла — Рома.
function smoothCam(cam) {
  if (cam.length < 3) return cam;
  const yaw = [cam[0][2]];
  for (let i = 1; i < cam.length; i++) yaw.push(yaw[i - 1] + wrap(cam[i][2] - cam[i - 1][2]));
  const K = [1, 4, 6, 4, 1];
  const blur = (arr) => arr.map((_, i) => {
    let s = 0, w = 0;
    K.forEach((kw, j) => { const v = arr[i + j - 2]; if (v != null) { s += v * kw; w += kw; } });
    return s / w;
  });
  const p = blur(cam.map((c) => c[1])), y = blur(yaw);
  return cam.map((c, i) => [c[0], p[i], y[i]]);
}
const catmull = (a, b, c, d, t) =>
  0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
function camAt(cam, tick) {
  if (!cam.length) return { pitch: 0, yaw: 0 };
  const n = cam.length - 1;
  const i = Math.max(0, Math.min(n, Math.floor(tick - cam[0][0])));
  const t = Math.max(0, Math.min(1, tick - cam[i][0]));
  const at = (k) => cam[Math.max(0, Math.min(n, k))];
  const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  return { pitch: catmull(a[1], b[1], c[1], d[1], t), yaw: catmull(a[2], b[2], c[2], d[2], t) };
}

// детерминированный «случай» для рассыпания букв

// Строки песни -> куски для экрана: длинная строка делится на две половины (слева и справа)
function layoutParts(lines) {
  const parts = [];
  lines.forEach((l, li) => {
    if (!l.text) return;
    const next = lines.slice(li + 1).find((x) => x.text) || null;
    const span = Math.min((next ? next.t : l.t + 5) - l.t, 6);
    const type = Math.max(span * 0.7, 0.4);
    if (l.text.length > 26) {
      const mid = l.text.length / 2;
      let cut = l.text.lastIndexOf(" ", Math.round(mid));
      if (cut < 6) cut = l.text.indexOf(" ", Math.round(mid));
      if (cut > 0) {
        // wOff — с какого слова строки начинается кусок (для времени слов по звуку)
        parts.push({ li, text: l.text.slice(0, cut), t0: l.t, t1: l.t + type / 2, end: l.t + span, side: 1, wOff: 0 });
        parts.push({ li, text: l.text.slice(cut + 1), t0: l.t + type / 2, t1: l.t + type, end: l.t + span, side: -1, wOff: l.text.slice(0, cut).split(/\s+/).filter(Boolean).length });
        return;
      }
    }
    parts.push({ li, text: l.text, t0: l.t, t1: l.t + type, end: l.t + span, side: li % 2 ? -1 : 1, wOff: 0 });
  });
  return parts;
}

// Кусок строки, «висящий» в мире: позиция на экране зависит от того, куда смотрит камера.
// Сами слова рисует выбранный стиль (src/lyricStyles.js) в системе координат строки.
// mul — слой умножения (белый фон), для стилей, чьи буквы окрашивают саму карту.
// Возвращает, где строка на экране (доли кадра) — туда тянется камера в паузах.
function drawPart(ctx, p, t, cam, proj, k, pi, style, mul) {
  const st = lyricStyle(style);
  const centered = st.screen;
  // yaw растёт влево: точка левее взгляда имеет rel > 0 и на экране левее центра
  const rel = wrap(p.yaw - cam.yaw);
  if (Math.abs(rel) > 75 && !centered && !st.inFrame) return null;
  let x = centered ? proj.cx : proj.cx - proj.f * Math.tan((Math.max(-75, Math.min(75, rel)) * Math.PI) / 180);
  let y = centered ? proj.cy * 0.92 : proj.cy - proj.f * Math.tan(((cam.pitch - p.pitch) * Math.PI) / 180);
  // крупный текст (Night) держится в кадре: висит в мире, но у края останавливается, а не уезжает
  if (st.inFrame) {
    x = Math.max(proj.cx * 0.62, Math.min(proj.cx * 1.38, x));
    y = Math.max(proj.cy * 0.42, Math.min(proj.cy * 1.2, y));
  }
  // исчезновение: последние 0.6 с строки
  const sc = Math.max(0, Math.min(1, (t - (p.end - 0.6)) / 0.6));
  // слова на ударах трека (стили со snap)
  // время каждого слова, если известно (авто-тайминг по звуку): слово появляется, когда его поют
  let base = wordsOf(p);
  if (p.wt) {
    let last = -Infinity;
    const ts = base.map((w, i) => { const t = p.wt[p.wOff + i]; const v = Number.isFinite(t) ? Math.max(t, last) : null; if (v != null) last = v; return v; });
    if (ts.filter((t) => t != null).length >= base.length / 2) {
      base = base.map((w, i) => {
        const ws = ts[i] ?? w.ws;
        const nx = ts.slice(i + 1).find((t) => t != null);
        return { ...w, ws, we: Math.min(nx ?? p.end, ws + 1.5) };
      });
    }
  }
  const words = st.snap ? snapWords(base, p.beats) : base;
  const m = centered
    ? [1, 0, 0, 1, x, y]
    : [1 - Math.min(Math.abs(rel), 60) / 260, Math.sin((rel * Math.PI) / 180) * 0.12, 0, 1, x, y];
  const size = 40 * k;
  ctx.save(); mul?.save();
  ctx.setTransform(...m); mul?.setTransform(...m);
  drawLyricStyle(ctx, style, { p, t, size, k, pi, sc, words, maxW: proj.cx * 1.7, mul });
  ctx.restore(); mul?.restore();
  return { x: x / (proj.cx * 2), y: y / (proj.cy * 2) };
}

const pngOf = (canvas) => new Promise((ok, fail) =>
  canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => ok(new Uint8Array(a)), fail) : fail(new Error("canvas.toBlob"))), "image/png"));

// Умная подача: секунды киллов на итоговой шкале клипа (после slow-mo)
const KILL_BEFORE = 0.9, KILL_AFTER = 0.7;
// зум к строке: только если вокруг неё столько тихих секунд и не чаще чем раз в ZOOM_GAP секунд
const ZOOM_QUIET = 2.5, ZOOM_GAP = 5;

// Кадры текста песни для одного клипа. Текст «закреплён» в мире: строка появляется левее/правее
// взгляда и остаётся на месте, когда камера поворачивается (углы — из демки, cam: [[tick, pitch, yaw]]).
// Время — итоговое (после slow-mo): музыка не замедляется, а камера берётся из записи через outToIn.
// smart — умная подача: строки, на которые приходится килл, пропускаются (кроме припева), в паузах
// камера иногда коротко тянется вбок к строке (zoom.json для ffmpeg).
// Для стилей с multiply рядом пишется второй слой кадров (m*.png, lyrics_mul.ffconcat).
// night — эффекты пресета Night на тех же кадрах: { dust, eye, targets } (пыль и рамка на цели, src/nightfx.js)
export async function renderLyricFrames({ lrc, start, clip, cam: rawCam, slowmo, drops = [], fov, fps, W, H, save, onFrame, style = "karaoke", beats = [], smart = true, night = null, wordTimes = null }) {
  const st = lyricStyle(style);
  const cam = smoothCam(rawCam);
  const lines = parseLrc(lrc);
  const parts = layoutParts(lines);
  // припев (строки, которые повторяются) — для акцентов в стиле «Акцент»; удары — в секундах трека
  const counts = new Map();
  for (const l of lines) if (l.text) counts.set(norm(l.text), (counts.get(norm(l.text)) || 0) + 1);
  for (const pt of parts) { pt.chorus = (counts.get(norm(lines[pt.li].text)) || 0) >= 2; pt.beats = beats; pt.wt = wordTimes?.get(pt.li) || null; }
  // сердце (стиль Night): вокруг «любовного» слова, иначе вокруг последнего слова первой строки припева;
  // не чаще раза в 8 секунд, чтобы не приедалось
  if (style === "night") {
    let last = -Infinity;
    const seen = new Set();
    for (const pt of parts) {
      const hw = heartWord(pt.text);
      const firstChorus = pt.chorus && !seen.has(norm(lines[pt.li].text));
      if (pt.chorus) seen.add(norm(lines[pt.li].text));
      const idx = hw >= 0 ? hw : firstChorus ? pt.text.split(/\s+/).filter(Boolean).length - 1 : -1;
      if (idx >= 0 && pt.t0 - last >= 8) { pt.heart = idx; last = pt.t0; }
    }
  }
  const base = (clip.end - clip.start) / TICKRATE;
  const killRec = (clip.killTicks || []).map((t) => (t - clip.start) / TICKRATE);
  const kills = slowmo ? killRec : [];
  const segs = slowmo || drops.length ? slowmoSegments(kills, drops) : [[0, Infinity, 1]];
  // + повторы глазами жертв в конце клипа (как replays в render.rs)
  const replay = replaySecs(clip);
  const mainDur = segs.reduce((s, [a, b, sp]) => s + (Math.min(b, base) - Math.min(a, base)) / sp, 0);
  const dur = mainDur + replay;

  if (smart) {
    // моменты действия: киллы и повторы в конце — на них текст не нужен, кроме припева
    const action = killRec.map((t) => [inToOut(segs, t) - KILL_BEFORE, inToOut(segs, t) + KILL_AFTER]);
    if (replay > 0) action.push([mainDur - 0.2, dur]);
    const busy = (a, b) => action.some(([x, y]) => a < y && b > x);
    // сколько тихого времени вокруг строки
    const quiet = (a, b) => {
      const before = Math.max(0, ...action.filter(([, y]) => y <= a).map(([, y]) => y));
      const after = Math.min(dur, ...action.filter(([x]) => x >= b).map(([x]) => x));
      return after - before;
    };
    // камера тянется к строке редко: только в настоящей паузе и не чаще раза в ZOOM_GAP секунд
    let lastZoom = -Infinity;
    for (const pt of [...parts].sort((x, y) => x.t0 - y.t0)) {
      const a = pt.t0 - start, b = pt.end - start;
      pt.hide = !pt.chorus && busy(a, b);
      pt.zoom = false;
      if (!busy(a, b) && quiet(a, b) >= ZOOM_QUIET && a - lastZoom >= ZOOM_GAP && pt.side) {
        pt.zoom = true;
        lastZoom = a;
      }
    }
  }

  // горизонтальный угол обзора: fov в CS задан для 4:3, для широких кадров он больше
  const hf = 2 * Math.atan(Math.tan(((fov || 90) * Math.PI) / 360) * (W / H) / (4 / 3));
  const proj = { cx: W / 2, cy: H / 2, f: W / 2 / Math.tan(hf / 2) };
  const k = Math.min(W, H) / 1080;
  // на частоте самого видео: при 60 к/с на 120-кадровом видео текст отставал от камеры через кадр
  const rate = Math.min(240, fps || 60);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  let mcanvas = null, mctx = null;
  if (st.multiply) {
    mcanvas = document.createElement("canvas");
    mcanvas.width = W; mcanvas.height = H;
    mctx = mcanvas.getContext("2d");
  }
  await Promise.all([lyricFont(style, 40), ...(st.extraFonts || [])].map((f) => document.fonts.load(f, "Aa Яя").catch(() => {})));

  let list = "ffconcat version 1.0\n", mlist = "ffconcat version 1.0\n";
  let blank = null, mblank = null, n = 0;
  const anchors = {}; // взгляд камеры в начале каждой строки
  const zoom = new Map(); // строка -> куда тянется камера: [начало, конец, x, y] на итоговой шкале
  const frames = Math.ceil(dur * rate);
  for (let fi = 0; fi <= frames; fi++) {
    const tOut = fi / rate;
    const tTrack = start + tOut;
    const view = camAt(cam, clip.start + outToIn(segs, tOut) * TICKRATE);
    // строка закрепляется в мире там, куда смотрела камера в момент её начала; обе половины
    // длинной строки — от одного взгляда, иначе вторая (появляется позже) ложится на первую
    for (const p of parts) {
      if (p.yaw != null || tTrack < lines[p.li].t) continue;
      anchors[p.li] ??= { yaw: view.yaw, pitch: view.pitch - 7 };
      // Night — крупный текст: ближе к центру, иначе уходит за край кадра
      p.yaw = anchors[p.li].yaw + p.side * (style === "night" ? 9 : 24);
      p.pitch = anchors[p.li].pitch;
    }
    let live = parts.filter((p) => !p.hide && tTrack >= p.t0 && tTrack < p.end);
    // экранный стиль показывает одно слово: только самую свежую строку
    if (st.screen && live.length > 1) live = [live.reduce((a, b) => (b.t0 > a.t0 ? b : a))];
    let name, mname;
    // эффекты Night рисуются на каждом кадре — пустых кадров тогда нет
    const fxOn = night && (night.dust || night.targets?.length);
    if (!live.length && !fxOn) {
      if (!blank) { ctx.clearRect(0, 0, W, H); blank = "blank.png"; await save(blank, await pngOf(canvas)); }
      if (mctx && !mblank) { mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.fillStyle = "#fff"; mctx.fillRect(0, 0, W, H); mblank = "mblank.png"; await save(mblank, await pngOf(mcanvas)); }
      name = blank; mname = mblank;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (mctx) { mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.fillStyle = "#fff"; mctx.fillRect(0, 0, W, H); }
      if (night?.dust) drawDust(ctx, { t: tOut, view, proj, k });
      if (night?.targets?.length && tOut < mainDur) {
        drawTargets(ctx, { tick: clip.start + outToIn(segs, tOut) * TICKRATE, eye: night.eye, targets: night.targets, view, proj, k });
      }
      live.forEach((p) => {
        const at = drawPart(ctx, p, tTrack, view, proj, k, parts.indexOf(p), style, mctx);
        // камера тянется к строке в паузах (первое место, где строка появилась)
        if (smart && at && p.zoom && !zoom.has(p.li)) zoom.set(p.li, [p.t0 - start, p.end - start, at.x, at.y]);
      });
      name = `f${String(n).padStart(5, "0")}.png`;
      await save(name, await pngOf(canvas));
      if (mctx) { mname = `m${String(n).padStart(5, "0")}.png`; await save(mname, await pngOf(mcanvas)); }
      n++;
    }
    list += `file '${name}'\nduration ${(1 / rate).toFixed(5)}\n`;
    if (mctx) mlist += `file '${mname}'\nduration ${(1 / rate).toFixed(5)}\n`;
    if (fi % 30 === 0) onFrame?.(fi, frames);
  }
  const lastF = `f${String(n - 1).padStart(5, "0")}.png`, lastM = `m${String(n - 1).padStart(5, "0")}.png`;
  if (mctx) await save("lyrics_mul.ffconcat", new TextEncoder().encode(mlist + `file '${mblank || lastM}'\n`));
  if (smart && zoom.size) {
    // отрезки не пересекаются: следующая строка начинается не раньше конца предыдущей
    const keys = [...zoom.values()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < keys.length; i++) keys[i][0] = Math.max(keys[i][0], keys[i - 1][1]);
    await save("zoom.json", new TextEncoder().encode(JSON.stringify(keys.filter(([a, b]) => b - a > 0.6))));
  }
  return list + `file '${blank || lastF}'\n`;
}
// --- прослушивание выбранного куска ---
const MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" };

// Играет кусок трека [start, start+len); pos — текущая секунда трека или null, если тишина
function usePreview(path, start, len, volume) {
  const audio = useRef(null);
  const url = useRef({ path: "", href: "" });
  const raf = useRef(0);
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(false);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    audio.current?.pause();
    setPos(null);
  };

  const play = async () => {
    if (!path) return;
    if (url.current.path !== path) {
      setLoading(true);
      try {
        const buf = await invoke("read_audio", { path });
        if (url.current.href) URL.revokeObjectURL(url.current.href);
        const ext = path.split(".").pop().toLowerCase();
        url.current = { path, href: URL.createObjectURL(new Blob([buf], { type: MIME[ext] || "audio/mpeg" })) };
      } finally { setLoading(false); }
    }
    audio.current ??= new Audio();
    const a = audio.current;
    if (a.src !== url.current.href) a.src = url.current.href;
    a.volume = Math.min(1, volume);
    a.currentTime = start;
    await a.play();
    const tick = () => {
      if (a.paused || a.currentTime >= start + len) { stop(); return; }
      setPos(a.currentTime);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  // громкость меняется на лету; при смене трека или уходе со страницы — тишина
  useEffect(() => { if (audio.current) audio.current.volume = Math.min(1, volume); }, [volume]);
  useEffect(() => stop, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { stop(); if (url.current.href) URL.revokeObjectURL(url.current.href); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { pos, loading, playing: pos !== null, toggle: () => (pos !== null ? stop() : play().catch(() => setLoading(false))) };
}

// Свободный плеер трека для разметки текста: играет с любого места, позиция — по кадрам
export function useTrackPlayer(path) {
  const audio = useRef(null);
  const href = useRef("");
  const raf = useRef(0);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const ensure = async () => {
    if (!href.current) {
      setLoading(true);
      try {
        const buf = await invoke("read_audio", { path });
        const ext = path.split(".").pop().toLowerCase();
        href.current = URL.createObjectURL(new Blob([buf], { type: MIME[ext] || "audio/mpeg" }));
      } finally { setLoading(false); }
    }
    audio.current ??= new Audio();
    if (audio.current.src !== href.current) audio.current.src = href.current;
    return audio.current;
  };
  const loop = () => {
    const a = audio.current;
    if (!a) return;
    setPos(a.currentTime);
    if (a.paused) setPlaying(false); else raf.current = requestAnimationFrame(loop);
  };
  const play = async (at) => {
    const a = await ensure();
    if (at != null) a.currentTime = Math.max(0, at);
    await a.play();
    setPlaying(true);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(loop);
  };
  const pause = () => { audio.current?.pause(); setPlaying(false); };
  const seek = (t) => {
    if (!audio.current) return;
    audio.current.currentTime = Math.max(0, t);
    setPos(audio.current.currentTime);
  };
  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    audio.current?.pause();
    if (href.current) URL.revokeObjectURL(href.current);
  }, []);
  return { pos, playing, loading, play, pause, seek, now: () => audio.current?.currentTime ?? 0 };
}

const lrcTime = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`;
const toLrc = (rows) => rows.filter((r) => r.t != null).sort((a, b) => a.t - b.t).map((r) => `[${lrcTime(r.t)}]${r.text}`).join("\n");
// на нажатие люди чуть опаздывают — строку ставим немного раньше
const TAP_LAG = 0.12;

// Текст, скопированный с Genius и похожих сайтов: убираем заголовки частей ([Припев], [Текст песни «…»]),
// блок рекомендаций «You might also like» (до следующего заголовка, не больше 6 строк) и служебные строки вроде «12Embed»
export function cleanLyrics(text) {
  const out = [];
  let skipping = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (/^\[[^\]]*\]$/.test(s)) { skipping = 0; continue; }
    if (/^you might also like/i.test(s)) { skipping = 6; continue; }
    if (!s) continue;
    if (skipping > 0) { skipping--; continue; }
    if (/^\d*\s*(embed|contributors?|translations?)$/i.test(s) || /^see .+ live$/i.test(s) || /get tickets as low as/i.test(s)) continue;
    out.push(s.replace(/(\d*\s*Embed)$/i, "").trim());
  }
  return out.filter(Boolean);
}

// Свой текст песни: LRC с метками применяется сразу, обычный текст размечается под трек —
// включаешь трек и жмёшь Пробел в начале каждой строки
function LyricsEditor({ path, hlae, initial, onDone, onCancel }) {
  const [text, setText] = useState(initial);
  const [rows, setRows] = useState(null);
  const [cur, setCur] = useState(0);
  const player = useTrackPlayer(path);
  const listRef = useRef(null);
  // авто-тайминг: [этап, скачано МБ, всего МБ] пока идёт; ошибка
  const [auto, setAuto] = useState(null);
  const [autoErr, setAutoErr] = useState("");
  const autoTime = async (base) => {
    const list = base || rows;
    if (!list?.length) return;
    setAutoErr(""); setAuto(["run", 0, 0]);
    const un = await listen("whisper-progress", (e) => setAuto(e.payload));
    try {
      // язык по тексту: кириллица — русский, иначе пусть Whisper определит сам
      const lang = /[а-яё]/i.test(list.map((r) => r.text).join(" ")) ? "ru" : "auto";
      const words = await invoke("track_words", { hlae, path, lang });
      const timed = alignLyrics(list.map((r) => r.text), words.map(([t, w]) => ({ t, w })));
      setRows(timed.map((r) => ({ text: r.text, t: Math.max(0, r.t - 0.1) })));
      setCur(timed.length);
    } catch (e) { setAutoErr(String(e)); }
    finally { un(); setAuto(null); }
  };
  const autoBar = (auto || autoErr) && (
    <div className="mu-asr">
      {auto ? (
        <>
          <span className="mono accent pulse">
            {auto[0] === "run" ? tr("слушаю трек и расставляю строки... обычно до полминуты")
              : tr(auto[0] === "model" ? "скачиваю модель для таймингов (один раз): {0} / {1} МБ" : "скачиваю Whisper (один раз): {0} / {1} МБ", Math.round(auto[1]), Math.round(auto[2]) || "?")}
          </span>
          {auto[0] !== "run" && <span className="ff-bar__track"><i style={{ width: auto[2] ? `${(auto[1] / auto[2]) * 100}%` : "20%" }} /></span>}
        </>
      ) : <span className="mono err">{trError(autoErr)}</span>}
    </div>
  );

  const apply = () => {
    if (parseLrc(text).some((l) => l.text)) return onDone(text.trim());
    const ls = cleanLyrics(text);
    if (ls.length) { setRows(ls.map((t) => ({ text: t, t: null }))); setCur(0); }
  };
  const tap = () => {
    if (!rows || cur >= rows.length || !player.playing) return;
    const t = Math.max(0, player.now() - TAP_LAG);
    setRows((rs) => rs.map((r, i) => (i === cur ? { ...r, t } : r)));
    setCur((c) => c + 1);
  };
  const undo = () => {
    if (!rows || cur === 0) return;
    setRows((rs) => rs.map((r, i) => (i === cur - 1 ? { ...r, t: null } : r)));
    setCur((c) => c - 1);
  };
  const jump = (i) => {
    setCur(i);
    const prev = rows.slice(0, i).reverse().find((r) => r.t != null);
    const at = rows[i].t ?? prev?.t;
    if (at != null) player.playing ? player.seek(at - 0.5) : player.play(at - 0.5);
  };

  // Пробел — строка, Backspace — отменить последнюю. Ловим раньше кнопок, чтобы пробел их не нажимал.
  useEffect(() => {
    if (!rows) return;
    const onKey = (e) => {
      if (e.code === "Space") { e.preventDefault(); tap(); }
      else if (e.code === "Backspace") { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  useEffect(() => {
    listRef.current?.querySelector(".is-cur")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cur]);
  // пока трек играет — строка, которая сейчас звучит (последняя с временем не позже позиции)
  let live = -1;
  if (rows && player.playing) rows.forEach((r, i) => { if (r.t != null && r.t <= player.pos) live = i; });
  useEffect(() => {
    if (live < 0) return;
    const el = listRef.current?.children[live];
    const box = listRef.current;
    // только сам список, без прокрутки всей страницы
    if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [live]);
  // слова строки загораются по очереди: время строки до следующей делится между словами по длине
  const sungWords = (i) => {
    const r = rows[i];
    const next = rows.slice(i + 1).find((x) => x.t != null)?.t ?? r.t + 4;
    const span = Math.min(next - r.t, 6);
    const ws = r.text.split(/(\s+)/);
    const total = r.text.replace(/\s+/g, "").length || 1;
    let acc = 0;
    return ws.map((w, k) => {
      if (/^\s+$/.test(w)) return w;
      const at = r.t + (span * acc) / total;
      acc += w.length;
      return <i key={k} className={player.pos >= at ? "is-sung" : ""}>{w}</i>;
    });
  };

  if (!rows) {
    return (
      <div className="mu-edit">
        <textarea className="mono mu-edit__area" value={text} autoFocus spellCheck={false}
          placeholder={tr("Вставь текст песни.\n\nС метками времени (LRC, [00:12.34] строка) - применится сразу.\nОбычный текст - дальше разметишь строки под трек пробелом.")}
          onChange={(e) => setText(e.target.value)} />
        <div className="mu-edit__bar">
          <span className="mono dim">{parseLrc(text).some((l) => l.text) ? tr("LRC: метки времени найдены") : tr("обычный текст: {0} строк, заголовки и мусор с сайта убраны", cleanLyrics(text).length)}</span>
          <span className="chips__spacer" />
          <button type="button" className="chip" onClick={onCancel}>{tr("Отмена")}</button>
          {!parseLrc(text).some((l) => l.text) && hlae && (
            <button type="button" className="chip" disabled={!cleanLyrics(text).length}
              title={tr("Нейросеть послушает трек и сама поставит каждую строку на свое место. Первый раз скачает ~170 МБ.")}
              onClick={() => { const ls = cleanLyrics(text).map((t) => ({ text: t, t: null })); setRows(ls); setCur(0); autoTime(ls); }}>
              {tr("Расставить тайминги сами")}
            </button>
          )}
          <button type="button" className="chip is-on" disabled={!text.trim()} onClick={apply}>
            {parseLrc(text).some((l) => l.text) ? tr("Применить") : tr("Дальше →")}
          </button>
        </div>
      </div>
    );
  }

  const done = rows.filter((r) => r.t != null).length;
  return (
    <div className="mu-edit">
      <div className="mu-sync">
        <button type="button" className={`mu-play ${player.playing ? "is-on" : ""}`} disabled={player.loading}
          onClick={() => (player.playing ? player.pause() : player.play())} aria-label={player.playing ? tr("Пауза") : tr("Играть")}>
          {player.loading ? <i className="mu-spin" /> : player.playing ? <i className="mu-ico-stop" /> : <i className="mu-ico-play" />}
        </button>
        <button type="button" className="chip" onClick={() => player.seek(player.now() - 5)}>{tr("−5 с")}</button>
        <b className="mono accent">{fmt(player.pos)}</b>
        <span className="dim mu-sync__hint">
          {player.playing ? <>{tr("жми")} <kbd>{tr("Пробел")}</kbd> {tr("в начале каждой строки ·")} <kbd>Backspace</kbd> {tr(" - назад")}</> : tr("включи трек, чтобы размечать")}
        </span>
        <span className="chips__spacer" />
        {hlae && <button type="button" className="chip" disabled={!!auto} onClick={() => autoTime()}>{tr("Авто-тайминг")}</button>}
        <button type="button" className="chip mu-tap" disabled={!player.playing || cur >= rows.length} onClick={tap}>{tr("Строка ↵")}</button>
      </div>
      {autoBar}
      <ol className="mu-rows" ref={listRef}>
        {rows.map((r, i) => (
          <li key={i} className={`${i === cur ? "is-cur" : ""} ${r.t != null ? "is-set" : ""} ${i === live ? "is-live" : ""}`} onClick={() => jump(i)}>
            <span className="mono dim">{r.t != null ? fmt(r.t) : "-:--"}</span>
            <em className="mu-words">{i === live ? sungWords(i) : r.text}</em>
          </li>
        ))}
      </ol>
      <div className="mu-edit__bar">
        <span className="mono dim">{tr("размечено")} {done} {tr("из")} {rows.length}{done && done < rows.length ? tr(" · неразмеченные строки не попадут") : ""}</span>
        <span className="chips__spacer" />
        <button type="button" className="chip" onClick={() => { player.pause(); setRows(null); }}>{tr("← К тексту")}</button>
        <button type="button" className="chip is-on" disabled={!done} onClick={() => { player.pause(); onDone(toLrc(rows)); }}>{tr("Готово")}</button>
      </div>
    </div>
  );
}

// Живое превью стиля текста для подсказки «?»: короткая строка на кадре из игры, по кругу
function LyricPreview({ style }) {
  const ref = useRef(null);
  const lang = useLang();
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv.getContext("2d");
    const img = new Image();
    img.src = previewBg;
    const W = cv.width, H = cv.height, k = H / 560;
    const p = style === "night"
      ? { text: tr("если я найду тебя"), t0: 0.35, t1: 2.0, end: 3.7 }
      : { text: tr("сделал эйс на миде"), t0: 0.35, t1: 2.2, end: 3.7 };
    if (style === "night") p.heart = heartWord(p.text);
    [lyricFont(style, 40), ...(lyricStyle(style).extraFonts || [])].forEach((f) => document.fonts.load(f, "Aa Яя").catch(() => {}));
    const start = performance.now();
    let raf;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      // подсказка закрыта — не рисуем
      if (cv.checkVisibility && !cv.checkVisibility({ visibilityProperty: true })) return;
      const t = ((now - start) / 1000) % 4.3;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, W, H);
      else { ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, W, H); }
      if (t < p.t0 || t >= p.end) return;
      const sc = Math.max(0, Math.min(1, (t - (p.end - 0.6)) / 0.6));
      ctx.setTransform(1, 0, 0, 1, W / 2, H * (lyricStyle(style).screen ? 0.5 : 0.42));
      drawLyricStyle(ctx, style, { p, t, size: 40 * k, k, pi: 3, sc, words: wordsOf(p), maxW: W * 0.86 });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [style, lang]);
  return (
    <span className="pv" style={{ aspectRatio: "16 / 9" }}>
      <canvas ref={ref} width={640} height={360} className="ly-canvas" />
      <em className="pv__tag">{tr("пример")}</em>
    </span>
  );
}

// Выбор стиля текста: строка с текущим стилем раскрывает список, у каждого стиля «?» с живым превью
function LyricStylePicker({ value, onChange, Hint }) {
  const [open, setOpen] = useState(false);
  const cur = lyricStyle(value);
  return (
    <div className="ly-pick">
      <button type="button" className={`ly-head ${open ? "is-open" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mono dim">{tr("стиль текста")}</span>
        <b style={{ fontFamily: cur.font, fontWeight: cur.weight }}>{tr(cur.label)}</b>
        <i className="ly-caret" aria-hidden="true" />
      </button>
      <div className={`ly-list ${open ? "is-open" : ""}`}>
        <div>
          {LYRIC_STYLES.map((s) => (
            <button key={s.id} type="button" className={`ly-item ${s.id === value ? "is-on" : ""}`}
              onClick={() => { onChange(s.id); setOpen(false); }}>
              <b style={{ fontFamily: s.font, fontWeight: s.weight }}>{tr(s.label)}</b>
              <span className="dim">{tr(s.short)}</span>
              {Hint && <Hint text={tr(s.help)} preview={<LyricPreview style={s.id} />} />}
              <i className="check" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- панель ---
function Equalizer({ on }) {
  return <span className={`mu-eq ${on ? "is-on" : ""}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

// Toggle — тумблер приложения (из HighlightRenderer), чтобы панель выглядела как остальные
export function MusicPanel({ music, setMusic, hlae, clipLen, Toggle, Hint }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const lines = useMemo(() => parseLrc(music.lrc), [music.lrc]);
  const len = Math.max(4, clipLen || 15);
  const set = (patch) => setMusic((m) => ({ ...m, ...patch }));

  const findLyrics = async (artist, title, duration) => {
    setBusy(tr("ищу текст...")); setErr("");
    try {
      // точный поиск, потом общий по строке «исполнитель название» — первый, где нашёлся
      // синхронизированный текст именно этой песни: общий поиск находит и чужие песни с тем же
      // названием («911» у десятка исполнителей), поэтому исполнитель должен совпасть, а длительность —
      // быть рядом с файлом
      const same = (x) => {
        const a = norm(artist), b = norm(x.artistName || "");
        const artistOk = !a || (b && (b.includes(a) || a.includes(b)));
        const durOk = !duration || !x.duration || Math.abs(x.duration - duration) <= 10;
        return artistOk && durOk;
      };
      const tries = [{ artist, title }, ...(artist ? [{ artist: "", title, q: `${artist} ${title}` }] : [])];
      let synced = [];
      for (const t of tries) {
        const list = JSON.parse(await invoke("lyrics_search", t));
        synced = list.filter((x) => x.syncedLyrics && same(x));
        if (synced.length) break;
      }
      // ближайший по длительности к файлу трека
      synced.sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration));
      const best = synced[0];
      if (!best) { set({ lrc: "" }); setErr(tr("В базе текстов этой песни нет. Нажми «Вставить свой», вставь текст - тайминги расставятся сами.")); }
      else {
        const l = parseLrc(best.syncedLyrics);
        set({ lrc: best.syncedLyrics, start: pickChorus(l, len) });
      }
    } catch (e) { setErr(String(e)); }
    setBusy("");
  };

  const pickTrack = async () => {
    const path = await openDialog({ filters: [{ name: tr("Трек"), extensions: ["mp3", "m4a", "wav", "ogg", "flac", "mp4", "aac"] }] });
    if (typeof path !== "string") return;
    setBusy(tr("читаю трек...")); setErr("");
    try {
      const info = await invoke("track_info", { hlae, path });
      set({ path, title: info.title, artist: info.artist, duration: info.duration, lrc: "", start: 0 });
      setBusy("");
      if (info.title) await findLyrics(info.artist, info.title, info.duration);
    } catch (e) { setErr(String(e)); setBusy(""); }
  };

  // при смене длины хайлайта окно припева пересчитываем, если пользователь его не двигал
  useEffect(() => {
    if (lines.length && music.autoStart !== false) set({ start: pickChorus(lines, len) });
  }, [len]); // eslint-disable-line react-hooks/exhaustive-deps

  const dur = music.duration || (lines.length ? lines[lines.length - 1].t + 5 : 0);
  const inWindow = lines.filter((l) => l.text && l.t >= music.start && l.t < music.start + len);
  const preview = usePreview(music.path, music.start, len, music.musicVol);
  // строка, которая звучит сейчас (последняя начавшаяся)
  const nowLine = preview.playing ? inWindow.filter((l) => l.t <= preview.pos).pop() : null;
  const counts = useMemo(() => {
    const m = new Map();
    for (const l of lines) if (l.text) m.set(norm(l.text), (m.get(norm(l.text)) || 0) + 1);
    return m;
  }, [lines]);

  return (
    <div className="mu">
      <Toggle label={tr("Свой трек и текст песни")} hint={tr("По умолчанию выключено")}
        help={tr("Под клип подкладывается твой трек - с того места, где припев. Текст песни появляется на экране сбоку, буквы - в такт строке. Игровой звук приглушается.")}
        checked={music.enabled} onChange={(v) => set({ enabled: v })} />

      <div className={`mu-body ${music.enabled ? "is-open" : ""}`} aria-hidden={!music.enabled}>
        <div className="mu-inner">
          {/* трек */}
          <div className={`mu-track ${music.path ? "has-track" : ""}`}>
            <span className="mu-cover"><Equalizer on={!!music.path} /></span>
            <span className="mu-track__text">
              {music.path ? (
                <>
                  <b>{music.title || tr("Без названия")}</b>
                  <span className="dim">{music.artist || tr("исполнитель неизвестен")}{dur ? ` · ${fmt(dur)}` : ""}</span>
                </>
              ) : (
                <>
                  <b>{tr("Трек не выбран")}</b>
                  <span className="dim">{tr("MP3, M4A, WAV, FLAC или MP4 - звук возьмется из файла")}</span>
                </>
              )}
            </span>
            <button type="button" className="go go--ghost mu-pick" onClick={pickTrack} disabled={!!busy}>
              {busy || (music.path ? tr("Сменить") : tr("Выбрать трек"))}
            </button>
          </div>

          {music.path && (
            <>
              {/* текст песни: статус и поиск по исполнителю/названию */}
              <div className="mu-lyrics-head">
                <span className={`mu-badge ${lines.length ? "is-ok" : ""}`}>
                  {lines.length ? tr("текст найден · {0} строк", lines.filter((l) => l.text).length) : tr("текста нет")}
                </span>
                <input className="mono mu-in" value={music.artist} placeholder={tr("исполнитель")} onChange={(e) => set({ artist: e.target.value })} />
                <input className="mono mu-in" value={music.title} placeholder={tr("название")} onChange={(e) => set({ title: e.target.value })} />
                <button type="button" className="chip" disabled={!!busy} onClick={() => findLyrics(music.artist, music.title, music.duration)}>{tr("Найти текст")}</button>
                <button type="button" className={`chip ${editing ? "is-on" : ""}`} onClick={() => setEditing((e) => !e)}>
                  {lines.length ? tr("Изменить текст") : tr("Вставить свой")}
                </button>
              </div>
              {editing && (
                <LyricsEditor key={music.path} path={music.path} hlae={hlae} initial={music.lrc}
                  onCancel={() => setEditing(false)}
                  onDone={(lrc) => {
                    setErr(""); setEditing(false);
                    set({ lrc, start: pickChorus(parseLrc(lrc), len), autoStart: true });
                  }} />
              )}

              {/* шкала трека: строки, припев и выбранный кусок под длину хайлайта */}
              {dur > 0 && (
                <div className="mu-timeline">
                  <div className="mu-bar">
                    {lines.filter((l) => l.text).map((l, i) => (
                      <i key={i} className={(counts.get(norm(l.text)) || 0) >= 2 ? "is-chorus" : ""} style={{ left: `${(l.t / dur) * 100}%` }} />
                    ))}
                    <span className="mu-win" style={{ left: `${(music.start / dur) * 100}%`, width: `${Math.min(100, (len / dur) * 100)}%` }} />
                    {preview.playing && <span className="mu-head" style={{ left: `${(preview.pos / dur) * 100}%` }} />}
                  </div>
                  <input type="range" className="mu-range" min={0} max={Math.max(0, dur - len)} step={0.1} value={Math.min(music.start, Math.max(0, dur - len))}
                    onChange={(e) => set({ start: +e.target.value, autoStart: false })} aria-label={tr("Начало фрагмента трека")} />
                  <div className="mu-legend mono dim">
                    <button type="button" className={`mu-play ${preview.playing ? "is-on" : ""}`} onClick={preview.toggle}
                      disabled={preview.loading} aria-label={preview.playing ? tr("Остановить") : tr("Прослушать кусок")}
                      title={preview.playing ? tr("Остановить") : tr("Прослушать кусок, который попадет в клип")}>
                      {preview.loading ? <i className="mu-spin" /> : preview.playing ? <i className="mu-ico-stop" /> : <i className="mu-ico-play" />}
                    </button>
                    <span>{preview.playing ? `${fmt(preview.pos)} · ` : ""}{tr("с")} {fmt(music.start)} {tr("по")} {fmt(music.start + len)} · {len.toFixed(0)} {tr("с")}</span>
                    <span><i className="mu-dot is-chorus" /> {tr("припев")} <i className="mu-dot" /> {tr("строки")}</span>
                    {lines.length > 0 && (
                      <button type="button" className="chip" onClick={() => set({ start: pickChorus(lines, len), autoStart: true })}>{tr("К припеву")}</button>
                    )}
                  </div>
                </div>
              )}

              {inWindow.length > 0 && (
                <ul className="mu-preview">
                  {inWindow.slice(0, 8).map((l, i) => (
                    <li key={i} className={l === nowLine ? "is-now" : preview.playing && l.t > preview.pos ? "is-next" : ""}>
                      <span className="mono dim">{fmt(l.t)}</span>{l.text}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mu-mix">
                <label className="field">
                  <span className="field__row"><span>{tr("Громкость трека")}</span><b className="mono accent">{Math.round(music.musicVol * 100)}%</b></span>
                  <input type="range" min={0} max={1.5} step={0.05} value={music.musicVol} style={{ "--pct": `${(music.musicVol / 1.5) * 100}%` }}
                    onChange={(e) => set({ musicVol: +e.target.value })} />
                </label>
                <label className="field">
                  <span className="field__row"><span>{tr("Звук игры под треком")}</span><b className="mono accent">{Math.round(music.gameVol * 100)}%</b></span>
                  <input type="range" min={0} max={1} step={0.05} value={music.gameVol} style={{ "--pct": `${music.gameVol * 100}%` }}
                    onChange={(e) => set({ gameVol: +e.target.value })} />
                </label>
              </div>
              <Toggle label={tr("Текст песни на экране")} hint={tr("Текст висит прямо на карте, стиль выбирается ниже")}
                checked={music.showLyrics} disabled={!lines.length} onChange={(v) => set({ showLyrics: v })} />
              <div className={`mu-sub ${music.showLyrics && lines.length ? "is-open" : ""}`}>
                <div>
                  <LyricStylePicker value={music.lyricStyle || "karaoke"} onChange={(id) => set({ lyricStyle: id })} Hint={Hint} />
                  <Toggle label={tr("Умная подача текста")} hint={tr("Текст в паузах, камера тянется к строке")}
                    help={tr("Строки, на которые приходится килл, не показываются, чтобы текст не закрывал фраг. Припев показывается всегда. Когда ничего не происходит, камера плавно наезжает на строку, а в долгих паузах строка встает крупно в центр экрана.")}
                    checked={music.smartLyrics !== false} onChange={(v) => set({ smartLyrics: v })} />
                </div>
              </div>
              <Toggle label={tr("Замедление на припеве")} hint={tr("Плавный slow-mo в момент, когда начинается припев")}
                help={tr("Программа находит в тексте припев (строки, которые повторяются) и в момент его начала очень плавно замедляет видео примерно в 3 раза, держит и так же плавно разгоняет обратно. Трек при этом не замедляется. Если припев в клип не попал - ничего не меняется.")}
                checked={!!music.chorusSlow} disabled={!lines.length} onChange={(v) => set({ chorusSlow: v })} />
              <div className={`mu-sub ${music.chorusSlow ? "is-open" : ""}`}>
                <Toggle label={tr("Припев - на последний килл")} hint={tr("Трек подгоняется под каждый клип: припев и замедление - на финальном фраге")}
                  help={tr("Для каждого клипа трек начинается с такого места, чтобы первая строка припева прозвучала ровно в момент последнего килла. Плавное замедление встает туда же - получается фраг, припев и slow-mo в одной точке. Выбранный на шкале кусок задает, какой из припевов брать. Если в клипе нет киллов, трек идет как выбрано на шкале.")}
                  checked={music.chorusOnKill !== false} disabled={!music.chorusSlow} onChange={(v) => set({ chorusOnKill: v })} />
              </div>
              <Toggle label={tr("Эффекты в такт")} hint={tr("Удар камеры на каждый удар трека")}
                help={tr("Программа находит удары в треке (бочка и бас) и на каждый делает \"панч\": кадр резко приближается на несколько процентов и плавно отпускает, а в режиме тряски еще и коротко дергается. Накладывается на готовую картинку, поэтому совпадает со звуком при любых замедлениях.")}
                checked={!!music.beatFx} onChange={(v) => set({ beatFx: v })} />
              <div className={`mu-sub ${music.beatFx ? "is-open" : ""}`}>
                <div className="mu-beat">
                  <div className="ratios" role="radiogroup" aria-label={tr("Эффект в такт")}>
                    {BEAT_MODES.map(([k, l]) => (
                      <button key={k} type="button" role="radio" aria-checked={(music.beatMode || "zoom") === k}
                        className={(music.beatMode || "zoom") === k ? "is-on" : ""} onClick={() => set({ beatMode: k })}>{tr(l)}</button>
                    ))}
                  </div>
                  <label className="field">
                    <span className="field__row"><span>{tr("Сила")}</span><b className="mono accent">{Math.round((music.beatAmount ?? 1) * 100)}%</b></span>
                    <input type="range" min={0.4} max={2} step={0.1} value={music.beatAmount ?? 1}
                      style={{ "--pct": `${(((music.beatAmount ?? 1) - 0.4) / 1.6) * 100}%` }}
                      onChange={(e) => set({ beatAmount: +e.target.value })} />
                  </label>
                </div>
              </div>
            </>
          )}
          {err && <p className="mono err">{trError(err)}</p>}
        </div>
      </div>
    </div>
  );
}
