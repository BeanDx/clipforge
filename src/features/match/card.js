// Карточка игрока 1080×1920 (сторис / Discord): карта, счёт, итог и статистика из «Досье матча».
import { mapName, mapTint } from "./dossier";

import { tr } from "../../i18n";
import { TIER_COLOR } from "../profile/badges";
const W = 1080, H = 1920, PAD = 80;
const C = { bg: "#07090d", line: "#1c2430", lineHi: "#2c3a4b", text: "#d6dde6", dim: "#6c7a8c", yellow: "#f5c518", teal: "#2ee6c0", red: "#e5484d" };
const DISPLAY = '"Unbounded", sans-serif';
const MONO = '"JetBrains Mono", Consolas, monospace';
const FACEIT_COLOR = (l) => (l >= 10 ? "#fe1f00" : l >= 8 ? "#ff6309" : l >= 4 ? "#ffc800" : l >= 2 ? "#1ce400" : "#eeeeee");
const WEAPON = (w) => (w || "").replace(/_silencer$/, "-S").toUpperCase();

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// крупный текст уменьшается, пока не влезет в ширину
function fit(ctx, text, maxW, size, weight, family) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 20);
}

function label(ctx, text, x, y, color = C.dim, size = 26, align = "left") {
  ctx.font = `600 ${size}px ${MONO}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.letterSpacing = "3px";
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = "0px";
}

function box(ctx, x, y, w, h, stroke = C.line, fill = "rgba(12,16,22,.72)") {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

// уголки как у рамок в приложении
function corners(ctx, x, y, w, h, color, len = 34) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    ctx.moveTo(cx + dx * len, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * len);
  }
  ctx.stroke();
}

export async function drawCard({ info, player: p, faceit, badges = [] }) {
  await Promise.all([
    // шрифты Google разбиты по алфавитам (unicode-range) — грузим и латиницу, и кириллицу
    ...[`800 100px ${DISPLAY}`, `600 30px ${MONO}`, `400 30px ${MONO}`].map((f) => document.fonts.load(f, "Aa0 Яя")),
  ]).catch(() => {});
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const tint = mapTint(info.map);
  ctx.textBaseline = "alphabetic";

  // фон: свечение цвета карты, тонкая штриховка, затемнение книзу
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.3, 260, 0, W * 0.3, 260, 1000);
  g.addColorStop(0, hexA(tint, 0.32)); g.addColorStop(0.55, hexA(tint, 0.06)); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W, H, 0, W, H, 900);
  g.addColorStop(0, "rgba(46,230,192,.10)"); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.028)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -H; x < W; x += 26) { ctx.moveTo(x, H); ctx.lineTo(x + H, 0); }
  ctx.stroke();
  corners(ctx, 36, 36, W - 72, H - 72, hexA(C.yellow, 0.8));

  // шапка
  label(ctx, tr("clipforge · итог матча"), PAD, 128);
  label(ctx, info.source || "", W - PAD, 128, tint, 26, "right");

  // карта
  ctx.save();
  ctx.shadowColor = hexA(tint, 0.65); ctx.shadowBlur = 60;
  fit(ctx, mapName(info.map).toUpperCase(), W - PAD * 2, 150, 800, DISPLAY);
  ctx.fillStyle = "#fff"; ctx.textAlign = "left";
  ctx.fillText(mapName(info.map).toUpperCase(), PAD - 6, 300);
  ctx.restore();
  ctx.fillStyle = tint; ctx.fillRect(PAD, 334, 120, 6);
  label(ctx, tr("{0} · {1} мин · {2} раундов", info.map, Math.round(info.matchSec / 60), info.rounds), PAD + 140, 344, C.dim, 26);

  // счёт: команда игрока подсвечена
  const teams = info.teams || [];
  const mine = teams.find((t) => t.side === p.side);
  const other = teams.find((t) => t.side !== p.side);
  const tw = (W - PAD * 2 - 24) / 2;
  [mine, other].forEach((t, i) => {
    if (!t) return;
    const x = PAD + i * (tw + 24), y = 410;
    const win = other && mine && t.score > (i ? mine : other).score;
    box(ctx, x, y, tw, 210, i === 0 ? hexA(C.yellow, 0.45) : C.line);
    ctx.fillStyle = t.side === "CT" ? "#5d9cec" : "#e0a33c";
    ctx.fillRect(x, y, 6, 210);
    label(ctx, i === 0 ? tr("{0} · твоя команда", t.side) : t.side, x + 34, y + 54, i === 0 ? C.yellow : C.dim, 22);
    ctx.font = `800 120px ${DISPLAY}`;
    const sw = ctx.measureText(String(t.score)).width;
    fit(ctx, t.name, tw - 34 - 30 - sw - 24, 40, 600, MONO);
    ctx.fillStyle = C.text; ctx.textAlign = "left";
    ctx.fillText(t.name, x + 34, y + 160);
    ctx.font = `800 120px ${DISPLAY}`;
    ctx.textAlign = "right";
    ctx.fillStyle = win ? C.yellow : C.dim;
    if (win) { ctx.save(); ctx.shadowColor = hexA(C.yellow, 0.45); ctx.shadowBlur = 30; }
    ctx.fillText(String(t.score), x + tw - 30, y + 165);
    if (win) ctx.restore();
  });

  // итог
  const res = !mine || !other ? null : mine.score > other.score ? [tr("победа"), C.teal] : mine.score < other.score ? [tr("поражение"), C.red] : [tr("ничья"), C.dim];
  if (res) {
    ctx.font = `800 40px ${DISPLAY}`;
    const w = ctx.measureText(res[0].toUpperCase()).width + 64;
    ctx.fillStyle = hexA(res[1], 0.12); ctx.fillRect(PAD, 670, w, 76);
    ctx.strokeStyle = res[1]; ctx.lineWidth = 2; ctx.strokeRect(PAD + 1, 671, w - 2, 74);
    ctx.fillStyle = res[1]; ctx.textAlign = "left";
    ctx.fillText(res[0].toUpperCase(), PAD + 32, 725);
  }

  // лучшие достижения своего аккаунта (profile/badges.js) — справа от итога, сколько влезет
  {
    ctx.font = `800 40px ${DISPLAY}`;
    let x = PAD + (res ? ctx.measureText(res[0].toUpperCase()).width + 64 + 18 : 0);
    for (const b of badges) {
      const c = TIER_COLOR[b.level] || C.yellow, name = tr(b.name).toUpperCase();
      ctx.font = `600 22px ${MONO}`; ctx.letterSpacing = "3px"; // как в label()
      const w = 76 + ctx.measureText(name).width + 24;
      ctx.letterSpacing = "0px";
      if (x + w > W - PAD) break;
      box(ctx, x, 670, w, 76, hexA(c, 0.7), hexA(c, 0.1));
      ctx.save();
      ctx.shadowColor = hexA(c, 0.6); ctx.shadowBlur = 18;
      ctx.font = `700 34px ${DISPLAY}, "Segoe UI Symbol", sans-serif`; ctx.fillStyle = c; ctx.textAlign = "center";
      ctx.fillText(b.icon, x + 42, 721);
      ctx.restore();
      label(ctx, name, x + 76, 717, c, 22);
      x += w + 14;
    }
  }

  // игрок
  const lvl = faceit?.[p.id]?.[0];
  let nx = PAD;
  if (lvl) {
    const c = FACEIT_COLOR(lvl);
    ctx.save();
    ctx.shadowColor = c; ctx.shadowBlur = 24;
    ctx.strokeStyle = c; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(PAD + 50, 858, 44, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.font = `800 44px ${DISPLAY}`; ctx.fillStyle = c; ctx.textAlign = "center";
    ctx.fillText(String(lvl), PAD + 50, 875);
    nx = PAD + 124;
  }
  fit(ctx, p.name, W - nx - PAD, 92, 800, DISPLAY);
  ctx.fillStyle = "#fff"; ctx.textAlign = "left";
  ctx.fillText(p.name, nx, 892);
  const team = info.players.filter((x) => x.side === p.side).sort((a, b) => b.kills - a.kills);
  const place = team.findIndex((x) => x.id === p.id) + 1;
  const top = info.players.reduce((a, b) => (b.kills > a.kills ? b : a), p).id === p.id;
  const sub = [top ? tr("топ-фраггер матча") : tr("#{0} в команде по киллам", place), p.fav && tr("любимое оружие {0}", WEAPON(p.fav)), faceit?.[p.id]?.[1] && tr("{0} эло", faceit[p.id][1])]
    .filter(Boolean).join(" · ");
  label(ctx, sub, PAD, 958, top ? C.yellow : C.dim, 24);

  // K / D / A крупно и K/D справа
  box(ctx, PAD, 1010, W - PAD * 2, 230, C.lineHi);
  label(ctx, "k / d / a", PAD + 40, 1066);
  ctx.save();
  fit(ctx, `${p.kills}/${p.deaths}/${p.assists}`, 560, 118, 800, DISPLAY);
  ctx.fillStyle = C.yellow; ctx.textAlign = "left";
  ctx.shadowColor = hexA(C.yellow, 0.35); ctx.shadowBlur = 36;
  ctx.fillText(`${p.kills}/${p.deaths}/${p.assists}`, PAD + 34, 1196);
  ctx.restore();
  const kd = p.deaths ? p.kills / p.deaths : p.kills;
  label(ctx, "k/d", W - PAD - 40, 1066, C.dim, 26, "right");
  ctx.font = `800 80px ${DISPLAY}`; ctx.textAlign = "right";
  ctx.fillStyle = kd >= 1 ? C.teal : C.red;
  ctx.fillText(kd.toFixed(2), W - PAD - 40, 1190);

  // сетка статистики 3×2
  const cells = [
    ["adr", p.adr, p.adr >= 85],
    [tr("хедшоты"), `${p.hs}%`, p.hs >= 50],
    [tr("точность"), p.accuracy != null ? `${p.accuracy}%` : "-", p.accuracy >= 20],
    [tr("контрстрейф"), p.strafe != null ? `${p.strafe}%` : "-", p.strafe >= 85],
    ["ttk", p.ttk != null ? tr("{0}мс", p.ttk) : "-", p.ttk != null && p.ttk <= 150],
    [tr("открытия"), `${p.openK}–${p.openD}`, p.openK > p.openD],
  ];
  const cw = (W - PAD * 2 - 2 * 20) / 3, ch = 180;
  cells.forEach(([l, v, good], i) => {
    const x = PAD + (i % 3) * (cw + 20), y = 1270 + Math.floor(i / 3) * (ch + 20);
    box(ctx, x, y, cw, ch, good ? hexA(C.teal, 0.45) : C.line);
    label(ctx, l, x + 28, y + 52, C.dim, 22);
    fit(ctx, String(v), cw - 56, 64, 800, DISPLAY);
    ctx.fillStyle = good ? C.teal : C.text; ctx.textAlign = "left";
    ctx.fillText(String(v), x + 28, y + 140);
  });

  // полоса фактов
  const fy = 1690;
  box(ctx, PAD, fy, W - PAD * 2, 130, hexA(tint, 0.5), hexA(tint, 0.07));
  const facts = [
    [tr("дальний килл"), tr("{0} м", p.longest)],
    [tr("пробежал"), tr("{0} км", (p.dist / 1000).toFixed(1))],
    [tr("слепил врагов"), tr("{0} с", p.flashSec)],
  ];
  const fw = (W - PAD * 2) / 3;
  facts.forEach(([l, v], i) => {
    const x = PAD + i * fw + 34;
    label(ctx, l, x, fy + 50, C.dim, 20);
    ctx.font = `800 46px ${DISPLAY}`; ctx.fillStyle = i === 0 ? tint : C.text; ctx.textAlign = "left";
    ctx.fillText(v, x, fy + 108);
  });

  // подпись
  ctx.strokeStyle = C.dim; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(PAD, 1866); ctx.lineTo(PAD + 22, 1866); ctx.moveTo(PAD + 11, 1855); ctx.lineTo(PAD + 11, 1877); ctx.stroke();
  label(ctx, "made with clipforge", PAD + 40, 1875, C.dim, 20);
  label(ctx, tr("патч {0}", info.patch || "-"), W - PAD, 1875, C.dim, 20, "right");
  return cv;
}
