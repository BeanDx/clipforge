// Разбор трека для эдита: темп, удары по всему треку, громкость и акцент каждого удара.
// env — огибающие с шагом hop секунд (music.rs, track_env): low — логарифм энергии низких частот
// (бочка, бас), rms — громкость всего сигнала. Склейки эдита идут по этой сетке, а громкие части
// трека (припев, крик) получают самые плотные серии киллов.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ранги 0..1: 0 — самое тихое место трека, 1 — самое громкое (не зависит от общей громкости файла)
function ranks(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  idx.forEach(([, i], n) => { r[i] = v.length > 1 ? n / (v.length - 1) : 0.5; });
  return r;
}

// значение огибающей между отсчётами
const sample = (a, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return 0;
  return a[i] + (a[i + 1] - a[i]) * (x - i);
};

export function analyzeTrack(env) {
  const { hop, low, rms } = env;
  const n = Math.min(low.length, rms.length);
  if (n < 200) return null;
  // сила начала звука: прирост низких частот плюс прирост общей громкости (вокал, хлопки)
  const lr = rms.map((x) => Math.log(1e-4 + x));
  const on = new Array(n).fill(0);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, low[i] - low[i - 1]) + 0.5 * Math.max(0, lr[i] - lr[i - 1]);
  // локальный порог: убираем постоянный фон, чтобы громкие куски не перекрывали тихие
  const W = Math.round(0.5 / hop);
  const pre = [0];
  for (let i = 0; i < n; i++) pre.push(pre[i] + on[i]);
  const o = on.map((x, i) => {
    const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
    return Math.max(0, x - (pre[b] - pre[a]) / (b - a));
  });

  // темп: автокорреляция силы ударов на лагах 0.3..1.2 с, с подсказкой «около 120 BPM»
  // и проверкой кратных лагов (настоящий удар повторяется и через 2, и через 4 удара)
  const ac = (L) => { let s = 0; for (let i = 0; i + L < n; i++) s += o[i] * o[i + L]; return s / (n - L); };
  const lo = Math.round(0.3 / hop), hi = Math.round(1.2 / hop);
  const A = [];
  for (let L = 0; L <= 4 * hi; L++) A.push(L >= lo / 2 ? ac(L) : 0);
  let bestL = lo, bestS = -Infinity;
  for (let L = lo; L <= hi; L++) {
    const per = L * hop;
    const prior = Math.exp(-0.5 * (Math.log2(per / 0.5) / 0.9) ** 2);
    const s = (A[L] + 0.5 * A[2 * L] + 0.25 * A[4 * L]) * prior;
    if (s > bestS) { bestS = s; bestL = L; }
  }
  // уточнение интервала (доли отсчёта) и сдвига сетки: сумма силы ударов в точках сетки
  let best = { P: bestL, ph: 0, s: -Infinity };
  for (let P = bestL - 1.5; P <= bestL + 1.5; P += 0.02) {
    for (let ph = 0; ph < P; ph += 0.5) {
      let s = 0;
      for (let x = ph; x < n - 1; x += P) s += Math.max(sample(o, x - 1), sample(o, x), sample(o, x + 1));
      if (s > best.s) best = { P, ph, s };
    }
  }
  let P = best.P * hop, phase = best.ph * hop;
  // слишком быстрая сетка (скорее всего восьмые) — берём через один удар
  while (P < 0.35) P *= 2;
  while (P > 0.9) P /= 2;
  phase %= P;
  const beats = [];
  for (let t = phase; t < n * hop - 0.05; t += P) beats.push(t);

  // громкость удара: средняя за удар; сглаживаем по соседям — важна часть трека, а не один удар
  const e = beats.map((t) => {
    const a = Math.round(t / hop), b = Math.min(n, Math.round((t + P) / hop));
    let s = 0;
    for (let i = a; i < b; i++) s += rms[i];
    return s / Math.max(1, b - a);
  });
  const es = e.map((_, i) => {
    let s = 0, c = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < e.length) { s += e[j]; c++; }
    return s / c;
  });
  const energy = ranks(es);
  // акцент удара: самый сильный удар звука в ±40 мс от него
  const acc = beats.map((t) => {
    const c = Math.round(t / hop), d = Math.round(0.04 / hop);
    let m = 0;
    for (let i = c - d; i <= c + d; i++) if (i >= 0 && i < n) m = Math.max(m, o[i]);
    return m;
  });
  const accent = ranks(acc);
  return { P, phase, beats, energy, accent, dur: n * hop };
}

// Сетка для planRhythm на шкале эдита, если трек в эдите начинается с секунды start
export function gridFrom(rh, start) {
  const { P } = rh;
  const ph = (((rh.phase - start) % P) + P) % P;
  const i0 = Math.round((start + ph - rh.phase) / P); // удар трека, на котором удар 0 эдита
  const beats = rh.beats.filter((t) => t >= start - 1e-6).map((t) => t - start);
  return {
    P, beats,
    at: (k) => ph + k * P,
    index: (t) => Math.ceil((t - ph) / P - 1e-6),
    energyAt: (k) => rh.energy[clamp(i0 + k, 0, rh.energy.length - 1)] ?? 0.5,
  };
}

// Где начинать трек в эдите: дроп (первый килл после интро) — на удар, с которого начинается
// самая громкая часть трека не раньше from (начало, выбранное ползунком). Интро идёт до него.
// need — сколько секунд нужно под киллы. Возвращает { start, dropBeat } (номер удара в analyzeTrack).
export function pickDrop(rh, { from = 0, introLen = 6, need = 30 }) {
  const { beats, energy, P } = rh;
  const look = Math.max(8, Math.round(Math.min(need, 16) / P)); // сколько ударов громкой части оценивать
  const back = Math.max(4, Math.round(4 / P));
  let best = null;
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t - introLen < from - 0.01) continue;
    if (t + Math.min(need, 12) > rh.dur) break;
    const after = energy.slice(i, i + look);
    const before = energy.slice(Math.max(0, i - back), i);
    const ma = after.reduce((s, x) => s + x, 0) / after.length;
    const mb = before.length ? before.reduce((s, x) => s + x, 0) / before.length : ma;
    // громко после и тише до (настоящий дроп), плюс акцент на самом ударе; дальние места чуть хуже
    const score = ma + 0.6 * clamp(ma - mb, 0, 1) + 0.15 * rh.accent[i] - 0.002 * (t - from - introLen);
    if (!best || score > best.score) best = { i, score };
  }
  if (!best) return { start: from, dropBeat: Math.max(0, Math.ceil((from + introLen - rh.phase) / P)) };
  return { start: Math.max(0, beats[best.i] - introLen), dropBeat: best.i };
}
