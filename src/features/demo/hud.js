// HUD «как в матче»: рисуется на canvas в разрешении записи и накладывается ffmpeg поверх видео.
// Раскладка повторяет HUD CS2: слева деньги, здоровье, броня; справа патроны и оружие.
// Все размеры заданы для 1080 пикселей по короткой стороне и масштабируются, поэтому HUD
// одинаково помещается в 16:9, 4:3, 1:1 и 9:16.

const TICKRATE = 64;
// Stratum2 — шрифт HUD CS2: если он установлен в системе, будет он; иначе близкий Bahnschrift
const FONT = '"Stratum2", "Stratum2 Bold", "Bahnschrift", "Arial Narrow", sans-serif';
const WHITE = "#f2f2f2";
const LOW = "#ff4040";

const KNIFE = /knife|bayonet|karambit|dagger|bowie|falchion|talon|ursus|navaja|stiletto|kukri|skeleton|nomad|survival|paracord|gut|flip|huntsman|butterfly|zeus/i;
const NADE = /grenade|flashbang|molotov|incendiary|decoy/i;
const PISTOL = /glock|usp|p2000|p250|five-seven|tec-9|cz75|berettas|desert eagle|r8/i;

// Порядок слотов как в инвентаре CS2: основное, пистолет, нож, гранаты, бомба
const slotOf = (w) => (/c4/i.test(w) ? 4 : NADE.test(w) ? 3 : KNIFE.test(w) ? 2 : PISTOL.test(w) ? 1 : 0);

const stateKey = (s) => JSON.stringify([s.hp, s.armor, s.helmet, s.kit, s.money, s.weapon, s.clip, s.reserve, s.inv]);

// Склеивает соседние замеры с одинаковым видом HUD: из ~16 замеров в секунду обычно
// остаются только моменты выстрелов, урона и смены оружия.
export function hudSegments(samples, clipStart) {
  const segs = [];
  for (const s of samples) {
    const key = stateKey(s);
    if (segs.length && segs[segs.length - 1].key === key) continue;
    segs.push({ key, state: s, t: Math.max(0, (s.t - clipStart) / TICKRATE) });
  }
  return segs;
}

export function fontsReady() {
  return Promise.all([`700 50px ${FONT}`, `600 24px ${FONT}`].map((f) => document.fonts.load(f).catch(() => {})));
}

function cross(ctx, x, y, r) {
  const t = r * 0.36;
  ctx.fillRect(x - t, y - r, t * 2, r * 2);
  ctx.fillRect(x - r, y - t, r * 2, t * 2);
}

function shield(ctx, x, y, r, helmet) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.85, y - r * 0.62);
  ctx.quadraticCurveTo(x + r * 0.8, y + r * 0.55, x, y + r);
  ctx.quadraticCurveTo(x - r * 0.8, y + r * 0.55, x - r * 0.85, y - r * 0.62);
  ctx.closePath();
  ctx.fill();
  if (helmet) {
    // шлем — вырез-«каска» на щите, как у иконки брони с шлемом
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y + r * 0.25, r * 0.42, Math.PI, 0);
    ctx.fill();
    ctx.restore();
  }
}

function bullets(ctx, x, y, h) {
  const w = h * 0.22;
  for (let i = 0; i < 3; i++) {
    const bx = x + i * w * 1.6;
    ctx.beginPath();
    ctx.moveTo(bx, y + h / 2);
    ctx.lineTo(bx, y - h * 0.15);
    ctx.quadraticCurveTo(bx + w / 2, y - h / 2 - w * 0.4, bx + w, y - h * 0.15);
    ctx.lineTo(bx + w, y + h / 2);
    ctx.closePath();
    ctx.fill();
  }
}

function bar(ctx, x, y, w, h, frac, color) {
  ctx.fillStyle = "rgba(255,255,255,.18)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
}

// Рисует один кадр HUD. Мёртвый игрок — пустой кадр: в матче HUD после смерти пропадает.
export function drawHud(ctx, s, W, H) {
  ctx.clearRect(0, 0, W, H);
  if (!s || s.hp <= 0) return;
  const k = Math.min(W, H) / 1080;
  const pad = 34 * k;
  const base = H - 30 * k; // базовая линия крупных цифр
  const mid = base - 18 * k; // центр иконок по высоте

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,.65)";
  ctx.shadowBlur = 6 * k;

  // подложки: тёмный градиент от краёв, как в CS2
  ctx.shadowBlur = 0;
  const bandH = 96 * k;
  let g = ctx.createLinearGradient(0, 0, 560 * k, 0);
  g.addColorStop(0, "rgba(0,0,0,.62)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H - bandH, 560 * k, bandH);
  g = ctx.createLinearGradient(W, 0, W - 460 * k, 0);
  g.addColorStop(0, "rgba(0,0,0,.62)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(W - 460 * k, H - bandH, 460 * k, bandH);
  ctx.shadowBlur = 6 * k;

  // деньги
  let x = pad;
  ctx.fillStyle = "#8fd16a";
  ctx.font = `700 ${30 * k}px ${FONT}`;
  ctx.fillText("$", x, mid + 11 * k);
  x += ctx.measureText("$").width + 3 * k;
  ctx.fillStyle = WHITE;
  ctx.fillText(String(s.money), x, mid + 11 * k);
  x += ctx.measureText(String(s.money)).width + 34 * k;

  // здоровье
  const hpColor = s.hp <= 20 ? LOW : WHITE;
  ctx.fillStyle = hpColor;
  cross(ctx, x + 14 * k, mid, 14 * k);
  x += 38 * k;
  ctx.font = `700 ${52 * k}px ${FONT}`;
  const hpW = Math.max(ctx.measureText("100").width, ctx.measureText(String(s.hp)).width);
  ctx.fillText(String(s.hp), x, base);
  ctx.shadowBlur = 0;
  bar(ctx, x, base + 8 * k, hpW, 4 * k, s.hp / 100, hpColor);
  ctx.shadowBlur = 6 * k;
  x += hpW + 30 * k;

  // броня
  ctx.fillStyle = s.armor > 0 ? WHITE : "rgba(242,242,242,.35)";
  shield(ctx, x + 13 * k, mid, 16 * k, s.helmet);
  x += 38 * k;
  ctx.font = `700 ${52 * k}px ${FONT}`;
  const arW = Math.max(ctx.measureText("100").width, ctx.measureText(String(s.armor)).width);
  ctx.fillText(String(s.armor), x, base);
  ctx.shadowBlur = 0;
  bar(ctx, x, base + 8 * k, arW, 4 * k, s.armor / 100, WHITE);
  ctx.shadowBlur = 6 * k;

  // патроны: «30 / 90» справа, у ножа и гранат их нет
  const right = W - pad;
  if (s.clip != null) {
    ctx.textAlign = "right";
    ctx.font = `600 ${28 * k}px ${FONT}`;
    ctx.fillStyle = "rgba(242,242,242,.7)";
    const res = String(s.reserve ?? 0);
    ctx.fillText(res, right, base);
    let rx = right - ctx.measureText(res).width - 10 * k;
    ctx.fillText("/", rx, base);
    rx -= ctx.measureText("/").width + 10 * k;
    ctx.font = `700 ${52 * k}px ${FONT}`;
    ctx.fillStyle = s.clip === 0 ? LOW : WHITE;
    ctx.fillText(String(s.clip), rx, base);
    rx -= ctx.measureText(String(s.clip)).width + 18 * k;
    ctx.fillStyle = WHITE;
    bullets(ctx, rx - 26 * k, mid, 26 * k);
    ctx.textAlign = "left";
  }

  // инвентарь столбиком над патронами, активное оружие ярче
  const items = [...(s.inv || [])].sort((a, b) => slotOf(a) - slotOf(b));
  if (s.kit) items.push("Defuse Kit");
  ctx.textAlign = "right";
  ctx.font = `600 ${21 * k}px ${FONT}`;
  let iy = H - bandH - 14 * k;
  for (let i = items.length - 1; i >= 0; i--) {
    const w = items[i];
    const on = w === s.weapon;
    ctx.fillStyle = on ? WHITE : "rgba(242,242,242,.42)";
    ctx.fillText(w.toUpperCase(), right, iy);
    if (on) {
      ctx.shadowBlur = 0;
      ctx.fillRect(right - ctx.measureText(w.toUpperCase()).width - 14 * k, iy - 15 * k, 4 * k, 15 * k);
      ctx.shadowBlur = 6 * k;
    }
    iy -= 30 * k;
  }
  ctx.restore();
}

const pngOf = (canvas) => new Promise((ok, fail) =>
  canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => ok(new Uint8Array(a)), fail) : fail(new Error("canvas.toBlob"))), "image/png"));

// Рисует все кадры HUD клипа и отдаёт их в save(name, bytes); возвращает текст ffconcat.
export async function renderHudFrames(samples, clipStart, W, H, save) {
  const segs = hudSegments(samples, clipStart);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const cache = new Map(); // одинаковый вид HUD (например, вернулось то же оружие) — один файл
  let list = "ffconcat version 1.0\n";
  if (!segs.length || segs[0].t > 0) segs.unshift({ key: "empty", state: null, t: 0 });
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let name = cache.get(s.key);
    if (!name) {
      name = `f${String(cache.size).padStart(4, "0")}.png`;
      drawHud(ctx, s.state, W, H);
      await save(name, await pngOf(canvas));
      cache.set(s.key, name);
    }
    list += `file '${name}'\n`;
    // последний кадр держится до конца клипа (overlay повторяет последний кадр)
    if (i + 1 < segs.length) list += `duration ${(segs[i + 1].t - s.t).toFixed(4)}\n`;
  }
  // ffconcat не учитывает duration у последней записи — повторяем её
  list += `file '${cache.get(segs[segs.length - 1].key)}'\n`;
  return list;
}
