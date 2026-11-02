// Стили текста песни. Общее для всех: кусок строки «висит» в мире (drawPart считает, куда он попал
// на экране, и разворачивает к камере), а стиль рисует слова в своей системе координат: центр
// строки — (0, 0). У каждого стиля свой шрифт, появление слов, подсветка спетого и исчезновение
// в конце строки. sc — доля исчезновения (0..1, последние 0.6 с строки).
export const LYRIC_STYLES = [
  { id: "karaoke", short: "желтая плашка, слова выпрыгивают", label: "Караоке", font: '"Unbounded"', weight: 800,
    help: "Слова выпрыгивают по одному, текущее заливается желтой плашкой слева направо. В конце строки буквы рассыпаются вниз." },
  { id: "world", short: "белые буквы закрашиваются по одной", label: "World", font: '"Rubik"', weight: 800,
    help: "Вся строка сразу висит в мире полупрозрачной, а спетые буквы по одной становятся сплошными белыми. В конце буквы растворяются вверх." },
  { id: "neon", short: "светящиеся трубки с мерцанием", label: "Неон", font: '"Comfortaa"', weight: 700,
    help: "Буквы - светящиеся розовые трубки. Слово загорается с мерцанием, когда его поют, а в конце строки буквы гаснут по одной." },
  { id: "typewriter", short: "печать с курсором на ленте", label: "Печатная машинка", font: '"PT Mono"', weight: 400,
    help: "Буквы печатаются по одной на темной ленте, с мигающим курсором. В конце строка стирается справа налево, как Backspace." },
  { id: "glitch", short: "RGB-разъезд и рваные полосы", label: "Глитч", font: '"Russo One"', weight: 400,
    help: "Слово появляется с RGB-разъездом и рваными полосами, потом встает ровно. В конце строки текст разрывает на полосы, и он исчезает." },
  { id: "accent", short: "одно слово крупно, акценты красным, под бит", label: "Акцент", font: '"Oswald"', weight: 700,
    screen: true, snap: true, multiply: true, extraFonts: ['800 40px "Rubik"'],
    help: "Как в TikTok-эдитах: по одному слову крупно в центре экрана. Слова сменяются ровно на ударах трека, буквы собираются вразнобой. Ударные слова огромные темно-красные и окрашивают саму карту, так что сквозь них видно текстуру: это весь припев и самое длинное слово каждой строки. Остальные слова белые, светятся и подсвечивают карту." },
  { id: "night", short: "сиреневое свечение, сердце вокруг слова", label: "Night", font: '"Fredoka"', weight: 700,
    extraFonts: ['700 40px "Nunito"'], inFrame: true,
    help: "Как в ночных эдитах: крупные розово-сиреневые буквы со свечением выпрыгивают по одной и висят в мире, длинная строка встает в два ряда. Вокруг слова вроде «тебя» или «you» светящейся линией рисуется сердце с искрами. В конце строка блекнет и рассыпается." },
];
export const lyricStyle = (id) => LYRIC_STYLES.find((s) => s.id === id) || LYRIC_STYLES[0];
export const lyricFont = (id, px) => { const s = lyricStyle(id); return `${s.weight} ${px}px ${s.font}, "Segoe UI", sans-serif`; };

const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutBack = (x) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Слова куска с таймингом: время звучания [t0, t1] делится между словами по их длине
export function wordsOf(p) {
  const words = p.text.split(/\s+/).filter(Boolean);
  const total = words.reduce((s, w) => s + w.length + 1, 0);
  let acc = 0;
  return words.map((w) => {
    const ws = p.t0 + ((p.t1 - p.t0) * acc) / total;
    acc += w.length + 1;
    return { w, ws, we: p.t0 + ((p.t1 - p.t0) * acc) / total };
  });
}

// раскладка строки: слова с шириной и позициями букв (центр строки — 0)
function layout(ctx, words, space) {
  const widths = words.map((w) => ctx.measureText(w.w).width);
  const total = widths.reduce((s, w) => s + w, 0) + space * (words.length - 1);
  let x = -total / 2;
  return { total, words: words.map((wd, i) => {
    const out = { ...wd, x, ww: widths[i], letters: [] };
    let lx = x;
    for (let c = 0; c < wd.w.length; c++) {
      const cw = ctx.measureText(wd.w[c]).width;
      // время буквы: слово звучит [ws, we], буквы по очереди
      out.letters.push({ ch: wd.w[c], x: lx, cw, at: wd.ws + ((wd.we - wd.ws) * c) / wd.w.length });
      lx += cw;
    }
    x += widths[i] + space;
    return out;
  }) };
}

// ---- Караоке: выпрыгивающие слова, желтая плашка, рассыпание вниз ----
function karaoke(ctx, { p, t, size, k, pi, sc, words }) {
  ctx.font = lyricFont("karaoke", size);
  const L = layout(ctx, words, size * 0.32);
  L.words.forEach((wd, wi) => {
    if (t < wd.ws) return;
    const active = sc === 0 && t < wd.we && t < p.t1 + 0.05;
    const pop = easeOutBack(Math.min(1, (t - wd.ws) / 0.18));
    ctx.save();
    ctx.translate(wd.x + wd.ww / 2, 0);
    ctx.scale(0.6 + 0.4 * pop, 0.6 + 0.4 * pop);
    if (active) {
      const fill = Math.min(1, (t - wd.ws) / Math.max(wd.we - wd.ws, 0.05));
      const px = size * 0.28, ph = size * 1.35;
      ctx.shadowColor = "rgba(245,197,24,.55)";
      ctx.shadowBlur = 18 * k;
      roundRect(ctx, -wd.ww / 2 - px, -ph / 2, wd.ww + px * 2, ph, size * 0.22);
      ctx.fillStyle = "rgba(245,197,24,.28)";
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#f5c518";
      ctx.fillRect(-wd.ww / 2 - px, -ph / 2, (wd.ww + px * 2) * fill, ph);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
    ctx.shadowColor = "rgba(0,0,0,.8)";
    ctx.shadowBlur = active ? 0 : 14 * k;
    wd.letters.forEach((l, c) => {
      const seed = pi * 997 + wi * 61 + c * 13;
      const e = sc * sc;
      ctx.save();
      ctx.translate(l.x - wd.x - wd.ww / 2 + l.cw / 2 + (rnd(seed) - 0.5) * 2.4 * size * sc,
        (rnd(seed + 1) * 0.8 + 0.3) * size * sc + e * size * 1.8);
      ctx.rotate((rnd(seed + 2) - 0.5) * 2.6 * sc);
      ctx.globalAlpha = 1 - Math.pow(sc, 1.2);
      ctx.fillStyle = active ? "#0b0d11" : "#ffffff";
      ctx.fillText(l.ch, -l.cw / 2, 0);
      ctx.restore();
    });
    ctx.restore();
  });
}

// ---- World: строка видна сразу полупрозрачной, спетые буквы становятся сплошными ----
function world(ctx, { p, t, size, k, pi, sc, words }) {
  const fs = size * 1.08;
  ctx.font = lyricFont("world", fs);
  const L = layout(ctx, words, fs * 0.3);
  const appear = clamp01((t - p.t0) / 0.22);
  ctx.translate(0, (1 - appear) * fs * 0.25);
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 10 * k;
  L.words.forEach((wd, wi) => wd.letters.forEach((l, c) => {
    const seed = pi * 991 + wi * 53 + c * 17;
    // растворение: буквы по очереди со случайной задержкой уходят вверх и тают
    const d = clamp01((sc - rnd(seed) * 0.45) / 0.55);
    const lit = t >= l.at;
    const flash = lit ? clamp01((t - l.at) / 0.09) : 1; // «щелчок» при закрашивании
    ctx.save();
    ctx.translate(l.x + l.cw / 2, -d * fs * 0.6);
    const s = lit ? 1.14 - 0.14 * flash : 1;
    ctx.scale(s, s);
    ctx.globalAlpha = appear * (1 - d) * (lit ? 1 : 0.32);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(l.ch, -l.cw / 2, 0);
    ctx.restore();
  }));
}

// ---- Неон: контур-трубка, спетое загорается с мерцанием, в конце гаснет по буквам ----
function neon(ctx, { p, t, size, k, pi, sc, words }) {
  const fs = size * 1.3;
  ctx.font = lyricFont("neon", fs);
  const up = words.map((w) => ({ ...w, w: w.w.toUpperCase() }));
  const L = layout(ctx, up, fs * 0.28);
  const appear = clamp01((t - p.t0) / 0.3);
  ctx.lineJoin = "round";
  L.words.forEach((wd, wi) => wd.letters.forEach((l, c) => {
    const seed = pi * 983 + wi * 59 + c * 19;
    // гаснет: у каждой буквы свой момент, перед ним пара вспышек
    const off = 0.15 + rnd(seed) * 0.7;
    const dying = sc > off - 0.12 && sc < off ? (rnd(seed + Math.floor(t * 40)) > 0.5 ? 1 : 0.15) : sc >= off ? 0 : 1;
    const lit = t >= wd.ws;
    // загорание: первые 0.18 с слова лампа «дергается»
    const ign = lit && t - wd.ws < 0.18 ? (rnd(seed + Math.floor(t * 50)) > 0.35 ? 1 : 0.2) : 1;
    const a = appear * dying;
    if (a <= 0) return;
    ctx.save();
    ctx.translate(l.x, 0);
    if (lit) {
      ctx.globalAlpha = a * ign;
      ctx.shadowColor = "#ff3dc8";
      ctx.shadowBlur = 26 * k;
      ctx.strokeStyle = "#ff6ad5";
      ctx.lineWidth = 3.2 * k;
      ctx.strokeText(l.ch, 0, 0);
      ctx.shadowBlur = 12 * k;
      ctx.fillStyle = "#ffe6f7";
      ctx.fillText(l.ch, 0, 0);
    } else {
      ctx.globalAlpha = a * 0.55;
      ctx.strokeStyle = "rgba(255,110,210,.45)";
      ctx.lineWidth = 1.6 * k;
      ctx.strokeText(l.ch, 0, 0);
    }
    ctx.restore();
  }));
}

// ---- Печатная машинка: буквы печатаются на ленте с курсором, в конце стираются ----
function typewriter(ctx, { p, t, size, k, sc, words }) {
  const fs = size * 0.95;
  ctx.font = lyricFont("typewriter", fs);
  const L = layout(ctx, words, fs * 0.6);
  const all = L.words.flatMap((w) => w.letters);
  // сколько букв видно: напечатанные минус стертые Backspace'ом в конце
  const typed = all.filter((l) => t >= l.at).length;
  const shown = Math.max(0, Math.round(typed * (1 - sc)));
  if (!shown && sc > 0) return;
  const vis = all.slice(0, shown);
  const right = vis.length ? vis[vis.length - 1].x + vis[vis.length - 1].cw : all[0]?.x ?? 0;
  const left = all[0]?.x ?? 0;
  const padX = fs * 0.35, h = fs * 1.45;
  ctx.fillStyle = "rgba(8,10,14,.72)";
  ctx.fillRect(left - padX, -h / 2, right - left + padX * 2 + fs * 0.6, h);
  ctx.fillStyle = "#f2f2ea";
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 4 * k;
  vis.forEach((l) => ctx.fillText(l.ch, l.x, 0));
  // курсор мигает 2 раза в секунду, пока строка звучит
  if (Math.floor(t * 4) % 2 === 0 || t < p.t1) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#f5c518";
    ctx.fillRect(right + fs * 0.08, -fs * 0.45, fs * 0.45, fs * 0.9);
  }
}

// ---- Глитч: RGB-разъезд и рваные полосы при появлении, в конце разрывает ----
function glitch(ctx, { p, t, size, k, pi, sc, words }) {
  const fs = size * 1.2;
  ctx.font = lyricFont("glitch", fs);
  const up = words.map((w) => ({ ...w, w: w.w.toUpperCase() }));
  const L = layout(ctx, up, fs * 0.25);
  L.words.forEach((wd, wi) => {
    if (t < wd.ws) return;
    const g = Math.max(1 - (t - wd.ws) / 0.28, sc); // сила глитча: на входе и на выходе
    const alpha = 1 - Math.pow(sc, 1.5);
    const tick = Math.floor(t * 30);
    const split = g * fs * 0.12;
    const bands = 5;
    for (let b = 0; b < bands; b++) {
      const y0 = -fs * 0.6 + (fs * 1.2 * b) / bands, bh = (fs * 1.2) / bands;
      const shift = (rnd(pi * 977 + wi * 41 + b * 7 + tick) - 0.5) * 2 * g * fs * 0.5;
      ctx.save();
      ctx.beginPath();
      ctx.rect(wd.x - fs, y0, wd.ww + fs * 2, bh + 0.5);
      ctx.clip();
      ctx.translate(shift, 0);
      ctx.globalAlpha = alpha;
      if (split > 0.5) {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgba(255,40,80,.85)";
        ctx.fillText(wd.w, wd.x - split, 0);
        ctx.fillStyle = "rgba(40,230,255,.85)";
        ctx.fillText(wd.w, wd.x + split, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.shadowColor = "rgba(0,0,0,.6)";
      ctx.shadowBlur = 8 * k;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(wd.w, wd.x, 0);
      ctx.restore();
    }
  });
}

// ---- Акцент: одно слово крупно в центре экрана ----
// Ударные слова — тёмно-красные и «берут текстуру карты»: их рисуем на слое умножения (mul, белый фон),
// ffmpeg перемножает его с видео, и сквозь буквы видны стены и пол. В превью слоя нет — там то же
// самое даёт режим наложения multiply прямо на картинке. Обычные слова — округлым шрифтом, белые
// и светятся.
const WHITE_FONT = (px) => `800 ${px}px "Rubik", "Segoe UI", sans-serif`;

function letterStates(ctx, text, enter, seed) {
  const w0 = ctx.measureText(text).width;
  let x = -w0 / 2;
  const letters = [...text].map((ch, c) => {
    const cw = ctx.measureText(ch).width;
    const d = rnd(seed + c * 7) * 0.14;
    const s0 = 0.45 + rnd(seed + c * 7 + 1) * 0.9;
    const l = { ch, cw, cx: x + cw / 2, a: clamp01((enter - d) / 0.09), s: s0 + (1 - s0) * easeOutBack(clamp01((enter - d) / 0.2)) };
    x += cw;
    return l;
  }).filter((l) => l.a > 0);
  return { w0, letters };
}

function eachLetter(ctx, letters, alpha, draw) {
  for (const l of letters) {
    ctx.save();
    ctx.translate(l.cx, 0);
    ctx.scale(l.s, l.s);
    ctx.globalAlpha = alpha * l.a;
    draw(l);
    ctx.restore();
  }
}

function redWord(ctx, mul, text, { fs, k, alpha, enter, seed, maxW }) {
  // на слое умножения (или на самой картинке в превью)
  const target = mul || ctx;
  target.save();
  target.textBaseline = "middle";
  if (!mul) target.globalCompositeOperation = "multiply";
  target.font = lyricFont("accent", fs);
  const { w0, letters } = letterStates(target, text, enter, seed);
  const fit = Math.min(1, maxW / Math.max(w0, 1));
  const punch = 1 + 0.12 * (1 - clamp01(enter / 0.16));
  target.scale(fit * punch, fit * punch);
  const depth = Math.max(2, Math.round(fs * 0.07));
  const g = target.createLinearGradient(0, -fs * 0.45, 0, fs * 0.45);
  g.addColorStop(0, "#ff5a4a"); g.addColorStop(0.5, "#e2141a"); g.addColorStop(1, "#7c0008");
  // объём и тень затемняют саму карту, лицевая сторона окрашивает её в красный
  eachLetter(target, letters, alpha, (l) => {
    target.shadowColor = "rgba(0,0,0,.55)";
    target.shadowBlur = 22 * k;
    target.shadowOffsetY = 6 * k;
    target.fillStyle = "#3a0004";
    for (let i = depth; i >= 1; i--) target.fillText(l.ch, -l.cw / 2 + i * 0.7, i);
  });
  eachLetter(target, letters, alpha, (l) => {
    target.fillStyle = g;
    target.fillText(l.ch, -l.cw / 2, 0);
  });
  target.restore();
}

function whiteWord(ctx, text, { fs, k, alpha, enter, seed, maxW }) {
  ctx.save();
  ctx.font = WHITE_FONT(fs);
  const { w0, letters } = letterStates(ctx, text, enter, seed);
  const fit = Math.min(1, maxW / Math.max(w0, 1));
  const punch = 1 + 0.1 * (1 - clamp01(enter / 0.16));
  ctx.scale(fit * punch, fit * punch);
  // буквы: два прохода свечения и чистая белая сторона
  eachLetter(ctx, letters, alpha, (l) => {
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(255,250,240,.95)";
    ctx.shadowBlur = 30 * k;
    ctx.fillText(l.ch, -l.cw / 2, 0);
    ctx.shadowBlur = 10 * k;
    ctx.fillText(l.ch, -l.cw / 2, 0);
  });
  ctx.restore();
}

function accent(ctx, { p, t, size, k, pi, sc, words, maxW = size * 22, mul }) {
  // текущее слово — последнее начавшееся; оно держится до следующего или до конца строки
  let i = -1;
  words.forEach((w, wi) => { if (t >= w.ws) i = wi; });
  if (i < 0) return;
  // акцент: весь припев, иначе самое длинное слово строки (от 4 букв)
  const letters = (w) => w.w.replace(/[^\p{L}\p{N}]/gu, "").length; // без запятых и знаков
  const longest = words.reduce((b, w, wi) => (letters(w) > letters(words[b]) ? wi : b), 0);
  const isRed = (wi) => !!p.chorus || (wi === longest && letters(words[wi]) >= 4);
  const alpha = 1 - Math.pow(sc, 1.4);
  const drawWord = (wi, a, enter) => {
    const text = words[wi].w.toUpperCase();
    const opts = { k, alpha: a, enter, seed: pi * 911 + wi * 37, maxW, t };
    if (isRed(wi)) redWord(ctx, mul, text, { ...opts, fs: size * 3.6 });
    else whiteWord(ctx, text, { ...opts, fs: size * 2.3 });
  };
  const enter = t - words[i].ws;
  // предыдущее слово быстро гаснет под новым
  if (i > 0 && enter < 0.1) drawWord(i - 1, alpha * (1 - enter / 0.1), 1);
  ctx.save(); mul?.save();
  ctx.translate(0, -sc * size * 0.4); mul?.translate(0, -sc * size * 0.4);
  drawWord(i, alpha, enter);
  ctx.restore(); mul?.restore();
}

// Слова встают на удары трека: начало слова переносится на ближайший удар (до 0.22 с),
// но порядок слов сохраняется и между ними остаётся хотя бы 0.08 с
export function snapWords(words, beats) {
  if (!beats?.length) return words;
  let last = -Infinity;
  return words.map((w) => {
    let ws = w.ws;
    let best = null;
    for (const b of beats) if (Math.abs(b - ws) <= 0.22 && (best == null || Math.abs(b - ws) < Math.abs(best - ws))) best = b;
    if (best != null) ws = best;
    ws = Math.max(ws, last + 0.08);
    last = ws;
    return { ...w, ws };
  });
}

// ---- Night: как в ночных эдитах — розово-сиреневые буквы со свечением выпрыгивают по одной,
// строка «висит» в мире в два ряда, вокруг ключевого слова светящейся линией рисуется сердце
// с искрами. В конце строка блекнет до полупрозрачной и рассыпается. ----
const NIGHT_FONT = (px) => `700 ${px}px "Fredoka", "Nunito", "Segoe UI", sans-serif`;
const NIGHT_GLOW = "#d63bff";

// строка -> ряды: длинная (3+ слова) делится на два, нижний крупнее (как «IF I / GET YOU»)
function nightRows(words) {
  if (words.length < 3) return [{ words, scale: 1 }];
  const cut = Math.max(1, Math.round(words.length * 0.42));
  return [{ words: words.slice(0, cut), scale: 0.86 }, { words: words.slice(cut), scale: 1.12 }];
}

// точки сердца (параметрическое) от нижнего острия по часовой: [x, y] в долях ширины/высоты
const HEART = Array.from({ length: 90 }, (_, i) => {
  const a = Math.PI + (i / 89) * Math.PI * 2;
  const x = 16 * Math.pow(Math.sin(a), 3);
  const y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
  return [x / 34, y / 30];
});

// путь пера: росчерк приходит справа снизу и переходит в сердце вокруг слова
function heartPath(cx, cy, w, h) {
  const pts = [];
  const tip = [cx + HEART[0][0] * w, cy + HEART[0][1] * h + h * 0.06];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    pts.push([tip[0] + (1 - u) * w * 2.3, tip[1] + (1 - u) * h * 0.18 - Math.sin(u * Math.PI) * h * 0.08]);
  }
  for (const [x, y] of HEART) pts.push([cx + x * w, cy + y * h + h * 0.06]);
  let len = 0;
  const acc = pts.map((p, i) => (i ? (len += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])) : 0));
  return { pts, acc, len };
}

function drawHeart(ctx, { cx, cy, w, h, u, k, alpha, seed, t }) {
  const { pts, acc, len } = heartPath(cx, cy, w, h);
  const T = 24; // точки 0..T — росчерк, дальше — само сердце
  const upto = len * u;
  let tip = pts[0];
  // ломаная от точки from до пройденной пером длины upto
  const path = (from, to) => {
    ctx.beginPath();
    ctx.moveTo(pts[from][0], pts[from][1]);
    for (let i = from + 1; i <= to && acc[i - 1] < upto; i++) {
      let [x, y] = pts[i];
      if (acc[i] > upto) {
        const f = (upto - acc[i - 1]) / (acc[i] - acc[i - 1]);
        x = pts[i - 1][0] + (x - pts[i - 1][0]) * f; y = pts[i - 1][1] + (y - pts[i - 1][1]) * f;
      }
      ctx.lineTo(x, y);
      tip = [x, y];
    }
  };
  const glowLine = (glow, core) => {
    ctx.lineWidth = h * 0.075; ctx.strokeStyle = glow; ctx.shadowColor = NIGHT_GLOW; ctx.shadowBlur = 34 * k; ctx.stroke();
    ctx.lineWidth = h * 0.034; ctx.strokeStyle = core; ctx.shadowBlur = 12 * k; ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.globalAlpha = alpha;
  // росчерк: тает от начала к сердцу, а когда сердце дорисовано — гаснет целиком
  const done = clamp01((upto - acc[T]) / (len - acc[T]));
  const tailA = 1 - done;
  if (tailA > 0) {
    const g1 = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[T][0], pts[T][1]);
    g1.addColorStop(0, "rgba(226,90,255,0)"); g1.addColorStop(1, `rgba(226,90,255,${0.9 * tailA})`);
    const g2 = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[T][0], pts[T][1]);
    g2.addColorStop(0, "rgba(255,227,253,0)"); g2.addColorStop(1, `rgba(255,227,253,${tailA})`);
    path(0, T);
    glowLine(g1, g2);
  }
  if (upto > acc[T]) { path(T, pts.length - 1); glowLine("rgba(226,90,255,.9)", "#ffe3fd"); }
  else path(0, T);
  // искры летят от пера
  ctx.globalCompositeOperation = "lighter";
  if (u < 1) for (let s = 0; s < 16; s++) {
    const f = Math.floor(t * 30);
    const ang = rnd(seed + s * 3 + f) * Math.PI * 2;
    const r = rnd(seed + s * 5 + f + 1) * h * 0.5;
    const x = tip[0] + Math.cos(ang) * r, y = tip[1] + Math.sin(ang) * r * 0.7 + r * 0.3;
    ctx.globalAlpha = alpha * (1 - r / (h * 0.5));
    ctx.fillStyle = s % 3 ? "#f6a8ff" : "#ffffff";
    ctx.shadowColor = NIGHT_GLOW; ctx.shadowBlur = 8 * k;
    const sz = (1.2 + rnd(seed + s) * 2.4) * k;
    ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
  }
  ctx.restore();
}

function night(ctx, { p, t, size, k, pi, sc, words, maxW = size * 30 }) {
  const fs0 = size * 3.1;
  const up = words.map((w) => ({ ...w, w: w.w.toUpperCase() }));
  const rows = nightRows(up);
  // длинная строка уменьшается, чтобы целиком влезть примерно в две трети кадра
  const widest = Math.max(...rows.map((row) => {
    ctx.font = NIGHT_FONT(fs0 * row.scale);
    return row.words.reduce((s, w) => s + ctx.measureText(w.w).width, 0) + fs0 * row.scale * 0.26 * (row.words.length - 1) + fs0 * 0.8;
  }));
  const fit = Math.min(1, (maxW * 0.62) / Math.max(1, widest));
  ctx.scale(fit, fit);
  // выход: строка блекнет до призрачной, потом буквы гаснут вразнобой
  const ghost = clamp01(sc / 0.45);
  let y = -((rows.length - 1) * fs0 * 0.55);
  rows.forEach((row, ri) => {
    const fs = fs0 * row.scale;
    ctx.font = NIGHT_FONT(fs);
    const L = layout(ctx, row.words, fs * 0.26);
    // ряды чуть сдвинуты: верхний левее, нижний правее
    const rx = rows.length > 1 ? (ri ? fs0 * 0.35 : -fs0 * 0.45) : 0;
    L.words.forEach((wd, wi) => {
      wd.letters.forEach((l, c) => {
        const seed = pi * 1013 + ri * 211 + wi * 67 + c * 23;
        const e = t - l.at;
        if (e < 0) return;
        const pop = clamp01(e / 0.17);
        const out = clamp01((sc - 0.45 - rnd(seed + 9) * 0.3) / 0.25);
        const a = clamp01(e / 0.05) * (1 - ghost * 0.62) * (1 - out);
        if (a <= 0) return;
        const rest = (rnd(seed) - 0.5) * 0.13;
        const s = (0.93 + rnd(seed + 1) * 0.15) * (pop < 1 ? easeOutBack(pop) : 1);
        ctx.save();
        ctx.translate(rx + l.x + l.cw / 2, y + (rnd(seed + 2) - 0.5) * fs * 0.07 + (1 - pop) * fs * 0.35 - out * fs * 0.3);
        ctx.rotate(rest + (1 - pop) * (rnd(seed + 3) - 0.5) * 0.9);
        ctx.scale(s, s);
        ctx.globalAlpha = a;
        // свежая буква вспыхивает
        const flash = 1 - clamp01(e / 0.22);
        const g = ctx.createLinearGradient(0, -fs * 0.4, 0, fs * 0.4);
        g.addColorStop(0, "#ffe8fc"); g.addColorStop(1, "#eba8f1");
        ctx.shadowColor = NIGHT_GLOW;
        ctx.shadowBlur = (30 + flash * 30) * k * (1 - ghost * 0.8);
        ctx.fillStyle = g;
        ctx.fillText(l.ch, -l.cw / 2, 0);
        ctx.shadowBlur = (10 + flash * 14) * k * (1 - ghost);
        ctx.fillText(l.ch, -l.cw / 2, 0);
        if (flash > 0) {
          ctx.globalAlpha = a * flash;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(l.ch, -l.cw / 2, 0);
        }
        ctx.restore();
      });
      // сердце вокруг ключевого слова
      if (p.heart != null && up.indexOf(row.words[wi]) === p.heart && t > wd.ws + 0.08) {
        const u = clamp01((t - wd.ws - 0.08) / 0.75);
        drawHeart(ctx, {
          cx: rx + wd.x + wd.ww / 2, cy: y - fs * 0.12, w: Math.max(wd.ww * 1.38, fs * 1.9), h: fs * 2.15,
          u: 1 - Math.pow(1 - u, 2), k, alpha: 1 - clamp01(sc / 0.6), seed: pi * 37, t,
        });
      }
    });
    y += fs0 * 1.1;
  });
}

// слово для сердца: «любовное» слово строки, иначе последнее слово (если строка помечена heart)
const HEART_WORDS = /^(you|love|heart|baby|ты|тебя|тобой|тебе|люблю|любовь|сердце|моя|мой)$/i;
export function heartWord(text) {
  const ws = text.split(/\s+/).filter(Boolean);
  const i = ws.findIndex((w) => HEART_WORDS.test(w.replace(/[^\p{L}]/gu, "")));
  return i;
}

const DRAW = { karaoke, world, neon, typewriter, glitch, accent, night };

// Рисует кусок строки стилем style в уже настроенной системе координат (центр строки — 0, 0)
export function drawLyricStyle(ctx, style, args) {
  ctx.save();
  ctx.textBaseline = "middle";
  (DRAW[style] || karaoke)(ctx, args);
  ctx.restore();
}
