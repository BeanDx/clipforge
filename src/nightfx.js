// Эффекты пресета Night поверх кадра: светящаяся пыль в мире и рамка на цели перед киллом.
// Рисуются на тех же кадрах, что и текст песни (renderLyricFrames), в итоговом времени клипа.

const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const RAD = Math.PI / 180;
const GLOW = "#d63bff";

// Пыль: пылинки закреплены по направлениям в мире (как звёзды) — при повороте камеры плывут
// вместе с картой, сами медленно поднимаются, качаются и мерцают
const MOTES = Array.from({ length: 170 }, (_, i) => ({
  yaw: (rnd(i * 3.1) - 0.5) * 220,
  pitch: -32 + rnd(i * 5.7) * 62,
  size: 0.8 + Math.pow(rnd(i * 7.3), 3) * 3.4,
  rise: 0.6 + rnd(i * 9.1) * 1.6, // градусов в секунду
  sway: rnd(i * 11.9) * Math.PI * 2,
  tw: 1.5 + rnd(i * 13.7) * 3,
  pink: rnd(i * 17.3) > 0.55,
}));

export function drawDust(ctx, { t, view, proj, k, alpha = 1 }) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const m of MOTES) {
    // подъём по кругу: пылинка уходит вверх и появляется снизу
    const pitch = m.pitch - ((t * m.rise) % 62);
    const pw = pitch < -32 ? pitch + 62 : pitch;
    const rel = wrap(m.yaw + Math.sin(t * 0.7 + m.sway) * 1.2 - view.yaw);
    if (Math.abs(rel) > 70) continue;
    const x = proj.cx - proj.f * Math.tan(rel * RAD);
    const y = proj.cy - proj.f * Math.tan((view.pitch - pw) * RAD);
    if (x < -20 || y < -20 || x > proj.cx * 2 + 20 || y > proj.cy * 2 + 20) continue;
    const tw = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(t * m.tw + m.sway * 3), 2);
    const r = m.size * k * 1.6;
    ctx.globalAlpha = alpha * tw;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, m.pink ? "rgba(255,190,255,1)" : "rgba(214,120,255,1)");
    g.addColorStop(0.25, m.pink ? "rgba(240,110,255,.55)" : "rgba(170,70,255,.5)");
    g.addColorStop(1, "rgba(150,40,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
  }
  ctx.restore();
}

// Проекция точки мира в кадр: глаз, углы взгляда (pitch вниз положительный, как в CS)
function project(P, eye, view, proj) {
  const p = view.pitch * RAD, y = view.yaw * RAD;
  const fwd = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  const right = [Math.sin(y), -Math.cos(y), 0];
  const up = [Math.sin(p) * Math.cos(y), Math.sin(p) * Math.sin(y), Math.cos(p)];
  const d = [P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]];
  const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
  if (z < 8) return null;
  const x = d[0] * right[0] + d[1] * right[1];
  const yy = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  return [proj.cx + (proj.f * x) / z, proj.cy - (proj.f * yy) / z];
}

// точка трека [[tick, x, y, z], ...] на дробном тике — линейно между соседними
export function trackAt(pts, tick) {
  if (!pts?.length) return null;
  if (tick <= pts[0][0]) return pts[0].slice(1);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= tick) {
      const a = pts[i - 1], b = pts[i], f = (tick - a[0]) / Math.max(1, b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return pts[pts.length - 1].slice(1);
}

const LEAD = 0.85; // секунд до килла рамка уже на цели
const BURST = 0.35; // вспышка после килла

// Рамка на цели: светящийся прямоугольник в перспективе вокруг жертвы и луч света вниз.
// targets: [{ kill: тик, pts: [[tick, x, y, z]] }], eye: [[tick, x, y, z]] (глаз игрока)
export function drawTargets(ctx, { tick, eye, targets, view, proj, k }) {
  const E = trackAt(eye, tick);
  if (!E) return;
  for (const tg of targets) {
    const dt = (tick - tg.kill) / 64;
    if (dt < -LEAD || dt > BURST) continue;
    const V = trackAt(tg.pts, Math.min(tick, tg.kill));
    if (!V) continue;
    // плоскость рамки повернута к камере по горизонтали, чуть с наклоном — как карточка в мире
    const dx = V[0] - E[0], dy = V[1] - E[1];
    const h = Math.hypot(dx, dy) || 1;
    const sx = (-dy / h) * 22, sy = (dx / h) * 22, tilt = 9;
    const corners = [
      [V[0] - sx, V[1] - sy, V[2] - 2], [V[0] + sx, V[1] + sy, V[2] - 2 + tilt * 0.3],
      [V[0] + sx + tilt * 0.2, V[1] + sy, V[2] + 78], [V[0] - sx + tilt * 0.2, V[1] - sy, V[2] + 78 - tilt * 0.3],
    ].map((c) => project(c, E, view, proj));
    if (corners.some((c) => !c)) continue;
    // появление: рамка «прилетает» крупнее и садится на цель; после килла — вспышка и разлёт
    const inn = clamp01((dt + LEAD) / 0.22);
    const burst = clamp01(dt / BURST);
    const cx = corners.reduce((s, c) => s + c[0], 0) / 4, cy = corners.reduce((s, c) => s + c[1], 0) / 4;
    const s = (1 + (1 - inn) * 0.8) * (1 + burst * 0.5);
    const pts = corners.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
    const a = inn * (1 - burst) * (0.85 + 0.15 * Math.sin(tick * 0.45));
    const span = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    const lw = Math.max(1.5 * k, Math.min(5 * k, span * 0.05));
    ctx.save();
    ctx.lineJoin = "round";
    // луч вниз от рамки: мягкий столб света к полу
    const bot = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const len = Math.max(span * 2.2, 40 * k);
    const g = ctx.createLinearGradient(bot[0], bot[1], bot[0], bot[1] + len);
    g.addColorStop(0, `rgba(226,110,255,${0.55 * a})`);
    g.addColorStop(1, "rgba(160,60,255,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[1][0] + span * 0.15, pts[1][1] + len); ctx.lineTo(pts[0][0] - span * 0.15, pts[0][1] + len);
    ctx.closePath();
    ctx.fill();
    // сама рамка: широкое свечение и тонкая светлая линия
    const quad = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = a;
    quad();
    ctx.shadowColor = GLOW; ctx.shadowBlur = 24 * k;
    ctx.strokeStyle = "rgba(220,90,255,.9)"; ctx.lineWidth = lw * 2.2; ctx.stroke();
    ctx.shadowBlur = 8 * k;
    ctx.strokeStyle = "#ffe6fe"; ctx.lineWidth = lw; ctx.stroke();
    // лёгкая заливка внутри рамки
    ctx.shadowBlur = 0;
    ctx.globalAlpha = a * 0.12 + burst * 0.3 * (1 - burst);
    ctx.fillStyle = "#e07bff";
    ctx.fill();
    ctx.restore();
  }
}

// ---- Звёздное небо для ночного вида ----
// Панорама (360° по горизонтали, от 70° вверх до 12° вниз) рисуется один раз; на кадр вырезается
// кусок по направлению камеры — небо поворачивается вместе с картой. Луна стоит в мире на moonYaw.
const SKY_TOP = -70, SKY_BOTTOM = 12;

export function buildSkyPano(ppd, moonYaw) {
  const PW = Math.round(360 * ppd), PH = Math.round((SKY_BOTTOM - SKY_TOP) * ppd);
  const cv = document.createElement("canvas");
  cv.width = PW; cv.height = PH;
  const c = cv.getContext("2d");
  const g = c.createLinearGradient(0, 0, 0, PH);
  g.addColorStop(0, "#0a0e55"); g.addColorStop(0.4, "#1a28c4"); g.addColorStop(0.78, "#3036d6"); g.addColorStop(1, "#4632c0");
  c.fillStyle = g; c.fillRect(0, 0, PW, PH);
  const blob = (x, y, r, col, a) => {
    for (const ox of [0, -PW, PW]) {
      const rg = c.createRadialGradient(x + ox, y, 0, x + ox, y, r);
      rg.addColorStop(0, col.replace("A", a)); rg.addColorStop(1, col.replace("A", 0));
      c.fillStyle = rg; c.fillRect(x + ox - r, y - r, r * 2, r * 2);
    }
  };
  // туманность: мягкие облака вдоль диагональной полосы
  for (let i = 0; i < 260; i++) {
    const u = rnd(i * 1.7);
    const x = u * PW, y = PH * (0.15 + 0.5 * Math.abs(Math.sin(u * Math.PI * 2 + 0.7))) + (rnd(i * 2.3) - 0.5) * PH * 0.25;
    const col = ["rgba(150,90,255,A)", "rgba(120,150,255,A)", "rgba(210,200,255,A)", "rgba(60,40,160,A)", "rgba(230,120,255,A)"][i % 5];
    blob(x, y, (14 + rnd(i * 3.1) * 70) * ppd / 12, col, 0.06 + rnd(i * 4.1) * 0.14);
  }
  // светлые облачные разводы (как млечный путь) и фиолетовые пятна туманности
  for (let i = 0; i < 150; i++) {
    const u = rnd(i * 31.7);
    const x = u * PW, y = PH * (0.1 + 0.55 * Math.abs(Math.sin(u * Math.PI * 3 + 1.3))) + (rnd(i * 32.3) - 0.5) * PH * 0.15;
    c.save();
    c.translate(x, y); c.rotate((rnd(i * 33.1) - 0.5) * 0.8); c.scale(2.6, 1);
    blob(0, 0, (8 + rnd(i * 34.7) * 28) * ppd / 12, i % 3 ? "rgba(225,235,255,A)" : "rgba(190,150,255,A)", 0.12 + rnd(i * 35.3) * 0.22);
    c.restore();
  }
  for (let i = 0; i < 26; i++) {
    blob(rnd(i * 41.1) * PW, rnd(i * 42.7) * PH * 0.7, (40 + rnd(i * 43.3) * 60) * ppd / 12, "rgba(150,60,255,A)", 0.22);
  }
  // звёзды: много мелких, часть ярких с лучиками
  c.globalCompositeOperation = "lighter";
  for (let i = 0; i < 11000; i++) {
    const x = rnd(i * 5.3) * PW, y = Math.pow(rnd(i * 6.1), 1.2) * PH * 0.92;
    const s = (0.7 + Math.pow(rnd(i * 7.7), 5) * 2.4) * ppd / 12;
    c.globalAlpha = 0.45 + rnd(i * 8.3) * 0.55;
    c.fillStyle = rnd(i * 9.9) > 0.7 ? "#d9c8ff" : "#ffffff";
    c.fillRect(x, y, s, s);
  }
  for (let i = 0; i < 160; i++) {
    const x = rnd(i * 11.3) * PW, y = rnd(i * 12.7) * PH * 0.8, r = (1 + rnd(i * 13.1) * 2) * ppd / 12;
    c.globalAlpha = 0.9;
    blob(x, y, r * 4, "rgba(200,190,255,A)", 0.55);
    c.fillStyle = "#ffffff";
    c.fillRect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
  }
  c.globalAlpha = 1;
  // облака у горизонта: сиреневые клубы
  c.globalCompositeOperation = "source-over";
  for (let i = 0; i < 70; i++) {
    blob(rnd(i * 14.9) * PW, PH * (0.85 + rnd(i * 15.3) * 0.2), (30 + rnd(i * 16.1) * 70) * ppd / 12, "rgba(70,60,170,A)", 0.3);
  }
  // луна: ореол, диск с лёгкими кратерами
  const mx = ((((-moonYaw) % 360) + 360) % 360) * ppd, my = (-24 - SKY_TOP) * ppd, mr = 5.2 * ppd;
  c.globalCompositeOperation = "lighter";
  blob(mx, my, mr * 5, "rgba(150,140,255,A)", 0.3);
  blob(mx, my, mr * 1.9, "rgba(245,240,255,A)", 0.7);
  c.globalCompositeOperation = "source-over";
  for (const ox of [0, -PW, PW]) {
    const dg = c.createRadialGradient(mx + ox - mr * 0.3, my - mr * 0.3, mr * 0.1, mx + ox, my, mr);
    dg.addColorStop(0, "#ffffff"); dg.addColorStop(0.7, "#f1ecff"); dg.addColorStop(1, "#cfc2ff");
    c.fillStyle = dg;
    c.beginPath(); c.arc(mx + ox, my, mr, 0, Math.PI * 2); c.fill();
    c.fillStyle = "rgba(140,130,190,.09)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 21.1) * Math.PI * 2, d = Math.sqrt(rnd(i * 22.7)) * mr * 0.8, r = mr * (0.04 + rnd(i * 23.3) * 0.12);
      c.beginPath(); c.arc(mx + ox + Math.cos(a) * d, my + Math.sin(a) * d, r, 0, Math.PI * 2); c.fill();
    }
  }
  return { cv, ppd, PW };
}

// кусок неба для взгляда камеры: центр кадра — направление view (yaw растёт влево)
export function drawSky(ctx, pano, view, W, H) {
  const { cv, ppd, PW } = pano;
  const cx = ((((-view.yaw) % 360) + 360) % 360) * ppd;
  const dy = H / 2 + (SKY_TOP - view.pitch) * ppd;
  ctx.fillStyle = "#4632c0";
  ctx.fillRect(0, 0, W, H);
  for (const ox of [-PW, 0, PW]) ctx.drawImage(cv, W / 2 - cx + ox, dy);
}

// ---- Скайбокс для самой игры (mirv_sky material) ----
// Равнопромежуточная панорама 2:1: x — азимут неба 0..360, y — от зенита до надира. Из неё
// resourcecompiler (Workshop Tools) собирает материал неба CS2, и игра рисует его вместо своего:
// правильная перспектива, без швов у пальм и проводов, HUD и игроки не задеваются.
// Азимут на текстуре = -yaw камеры в CS (проверено в игре по небу с подписанными градусами).
export const skyAzOfYaw = (yaw) => ((((-yaw) % 360) + 360) % 360);

export function buildSkyEquirect(moonAz, W = 4096) {
  const H = W / 2;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const P = (az, el) => [((((az % 360) + 360) % 360) / 360) * W, ((90 - el) / 180) * H];
  // у полюсов круг на панораме растянут по горизонтали
  const sx = (el) => 1 / Math.max(0.12, Math.cos((el * Math.PI) / 180));
  const s = W / 4096;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#070a40"); g.addColorStop(0.25, "#0f1792"); g.addColorStop(0.42, "#1c2ad0");
  g.addColorStop(0.5, "#3b34d4"); g.addColorStop(0.56, "#2a1f8a"); g.addColorStop(1, "#0a0820");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const blob = (az, el, r, col, a, stretch = 1) => {
    const [x, y] = P(az, el);
    for (const ox of [-W, 0, W]) {
      c.save();
      c.translate(x + ox, y);
      c.scale(sx(el) * stretch, 1);
      const rg = c.createRadialGradient(0, 0, 0, 0, 0, r * s);
      rg.addColorStop(0, col.replace("A", a)); rg.addColorStop(1, col.replace("A", 0));
      c.fillStyle = rg; c.fillRect(-r * s, -r * s, r * s * 2, r * s * 2);
      c.restore();
    }
  };
  // туманность-полоса через всё небо, светлые облачка и фиолетовые пятна
  for (let i = 0; i < 520; i++) {
    const az = rnd(i * 1.7) * 360;
    const el = 8 + 45 * (0.5 + 0.5 * Math.sin((az * Math.PI) / 180 + 0.6)) + (rnd(i * 2.3) - 0.5) * 22;
    const col = ["rgba(150,90,255,A)", "rgba(120,150,255,A)", "rgba(220,225,255,A)", "rgba(70,50,190,A)", "rgba(230,120,255,A)"][i % 5];
    blob(az, el, 18 + rnd(i * 3.1) * 70, col, 0.07 + rnd(i * 4.1) * 0.13, 1.8);
  }
  for (let i = 0; i < 40; i++) blob(rnd(i * 41.1) * 360, 5 + rnd(i * 42.7) * 70, 60 + rnd(i * 43.3) * 80, "rgba(150,60,255,A)", 0.2);
  // звёзды равномерно по сфере, часть ярких с ореолом
  c.globalCompositeOperation = "lighter";
  for (let i = 0; i < 26000; i++) {
    const az = rnd(i * 5.3) * 360;
    const el = (Math.asin(rnd(i * 6.1) * 1.06 - 0.06) * 180) / Math.PI;
    const [x, y] = P(az, el);
    const r = (0.8 + Math.pow(rnd(i * 7.7), 6) * 2.6) * s;
    c.globalAlpha = 0.4 + rnd(i * 8.3) * 0.6;
    c.fillStyle = rnd(i * 9.9) > 0.72 ? "#d9ccff" : "#ffffff";
    c.fillRect(x, y, r * sx(el), r);
  }
  for (let i = 0; i < 260; i++) {
    const az = rnd(i * 11.3) * 360, el = (Math.asin(rnd(i * 12.7)) * 180) / Math.PI;
    const r = (1.4 + rnd(i * 13.1) * 2.6);
    c.globalAlpha = 1;
    blob(az, el, r * 5, "rgba(205,195,255,A)", 0.6);
    const [x, y] = P(az, el);
    c.fillStyle = "#ffffff";
    c.fillRect(x - r * s * 0.7 * sx(el), y - r * s * 0.7, r * s * 1.4 * sx(el), r * s * 1.4);
  }
  c.globalAlpha = 1;
  // луна: 32° над горизонтом, ореол и диск с кратерами
  const moonEl = 32, mr = 42 * s;
  blob(moonAz, moonEl, 42 * 6, "rgba(150,140,255,A)", 0.35);
  blob(moonAz, moonEl, 42 * 2.2, "rgba(245,240,255,A)", 0.75);
  c.globalCompositeOperation = "source-over";
  for (const ox of [-W, 0, W]) {
    const [x0, y] = P(moonAz, moonEl);
    c.save(); c.translate(x0 + ox, y); c.scale(sx(moonEl), 1);
    const dg = c.createRadialGradient(-mr * 0.3, -mr * 0.3, mr * 0.1, 0, 0, mr);
    dg.addColorStop(0, "#ffffff"); dg.addColorStop(0.7, "#f2edff"); dg.addColorStop(1, "#d3c6ff");
    c.fillStyle = dg; c.beginPath(); c.arc(0, 0, mr, 0, Math.PI * 2); c.fill();
    c.fillStyle = "rgba(140,130,190,.1)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 21.1) * Math.PI * 2, d = Math.sqrt(rnd(i * 22.7)) * mr * 0.8, r = mr * (0.04 + rnd(i * 23.3) * 0.12);
      c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }
  return cv;
}
