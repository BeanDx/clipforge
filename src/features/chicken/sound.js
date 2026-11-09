// Звуки курицы синтезируются на лету (WebAudio) — никаких файлов. Тихо и коротко,
// и только когда окно в фокусе: поверх игры курица молчит.
let ctx = null;
let out = null;
let noiseBuf = null;
let on = true;
let lastAt = 0;

export const setSoundOn = (v) => { on = v; };

function audio() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    out = ctx.createGain();
    out.gain.value = 0.16;
    out.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// первый клик по курице «разрешает» звук (браузер не даёт играть звук без жеста)
export const unlockAudio = () => { if (on) audio(); };

const rnd = (a, b) => a + Math.random() * (b - a);

// один «голос»: осциллятор → резонансный фильтр (даёт «о»-образную гласную) → огибающая
function voice(t, { f0, f1, f2, dur, type = "square", vol = 0.8, cutoff = 1500, q = 5, vib = 0 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f2) {
    o.frequency.linearRampToValueAtTime(f1, t + dur * 0.35);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  } else {
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  }
  if (vib) {
    const l = ctx.createOscillator();
    const lg = ctx.createGain();
    l.frequency.value = vib;
    lg.gain.value = f0 * 0.07;
    l.connect(lg).connect(o.frequency);
    l.start(t);
    l.stop(t + dur + 0.05);
  }
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = cutoff;
  lp.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp).connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.03);
}

function noise(t, dur, vol = 0.3, freq = 2500) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(hp).connect(g).connect(out);
  s.start(t);
  s.stop(t + dur + 0.02);
}

function bok(t, pitch = 1, vol = 0.8) {
  const j = pitch * rnd(0.93, 1.07);
  voice(t, { f0: 430 * j, f1: 300 * j, dur: 0.07, cutoff: 1300, vol });
  voice(t + 0.085, { f0: 570 * j, f1: 380 * j, dur: 0.11, cutoff: 1700, vol: vol * 0.9 });
  noise(t, 0.02, 0.25 * vol);
}

const KINDS = {
  cluck: (t) => bok(t),
  // удивлённое «кхе?!» — когда разбудили или схватили
  startle: (t) => voice(t, { f0: 720, f1: 1250, f2: 900, dur: 0.18, type: "sawtooth", cutoff: 2600, vol: 0.7 }),
  // натыкали: три коротких и длинное возмущённое «БААК»
  bawk: (t) => {
    bok(t, 1.1); bok(t + 0.1, 1.15); bok(t + 0.2, 1.2);
    voice(t + 0.34, { f0: 620, f1: 980, f2: 520, dur: 0.42, type: "sawtooth", cutoff: 2200, vib: 26, vol: 0.8 });
  },
  // довольное урчание, когда гладят
  purr: (t) => voice(t, { f0: 220, f1: 185, dur: 0.38, type: "triangle", cutoff: 700, vib: 22, vol: 0.55 }),
  // радость: лесенка вверх
  party: (t) => {
    bok(t, 1); bok(t + 0.13, 1.12); bok(t + 0.26, 1.25);
    voice(t + 0.42, { f0: 600, f1: 1050, dur: 0.22, type: "sawtooth", cutoff: 2400, vol: 0.6 });
  },
  panic: (t) => { for (let i = 0; i < 7; i++) bok(t + i * rnd(0.11, 0.17), rnd(1.1, 1.4), 0.7); },
  peep: (t) => {
    voice(t, { f0: 2300, f1: 3100, dur: 0.07, type: "sine", cutoff: 9000, q: 1, vol: 0.45 });
    voice(t + 0.11, { f0: 2400, f1: 3300, dur: 0.08, type: "sine", cutoff: 9000, q: 1, vol: 0.4 });
  },
  pop: (t) => { noise(t, 0.06, 0.5, 1400); voice(t, { f0: 900, f1: 260, dur: 0.06, type: "triangle", cutoff: 3000, q: 1, vol: 0.5 }); },
};

export function sfx(kind) {
  if (!on || !document.hasFocus()) return;
  const now = performance.now();
  if (kind !== "peep" && now - lastAt < 90) return; // не превращаем частые клики в кашу
  lastAt = now;
  const a = audio();
  if (!a) return;
  try { KINDS[kind]?.(a.currentTime + 0.01); } catch { /* звук — не главное */ }
}
