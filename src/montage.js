// Эдит из нескольких демок (пресет Night): какие киллы брать и как разложить их по битам трека.
// Киллы оцениваются «для эдита»: хедшоты, AWP/SSG, резкий флик прицела, ноускоупы, прыжки, ножи.
// План монтажа: интро (ночной клип с текстом) целиком, дальше куски дневных клипов, где каждый
// килл встаёт ровно на удар трека — промежутки между киллами чуть ускоряются или замедляются.

const STEAM64_BASE = 76561197960265728n;
const TICK = 64;
const SNIPER = /awp|ssg08/;
const KNIFE = /knife|bayonet/;
const wname = (w) => String(w || "").replace(/^weapon_/, "");

// киллы игрока steamid из разбора демки (scripts/parse.cjs)
export function editKills(raw, steamid) {
  const id = String(steamid);
  return (raw.events || [])
    .filter((d) => String(d.attacker_steamid) === id && String(d.user_steamid) !== id
      && (d.attacker_team_num == null || d.attacker_team_num !== d.user_team_num))
    .map((d) => ({
      tick: Number(d.tick), round: Number(d.total_rounds_played) + 1, victim: String(d.user_steamid),
      weapon: wname(d.weapon), hs: !!d.headshot, noscope: !!d.noscope && SNIPER.test(wname(d.weapon)),
      wall: Number(d.penetrated) > 0, smoke: !!d.thrusmoke, air: !!d.attackerinair, blind: !!d.attackerblind,
      dist: Number(d.distance) || 0,
    }))
    .sort((a, b) => a.tick - b.tick);
}

// игрок, который есть во всех демках (это ты): чаще всего встречающийся steamid в составах
export function commonPlayer(raws, prefer) {
  const count = new Map();
  for (const r of raws) for (const p of r.players || []) count.set(String(p.steamid), (count.get(String(p.steamid)) || 0) + 1);
  if (prefer && count.get(String(prefer)) === raws.length) return String(prefer);
  let best = null, n = 0;
  for (const [id, c] of count) if (c > n) { best = id; n = c; }
  return n === raws.length ? best : null;
}

// флик: самая быстрая доворотка прицела за последние ~0.15 с до выстрела, градусов в секунду
export function flickOf(cam, tick) {
  const rows = (cam || []).filter((r) => r[0] <= tick && r[0] >= tick - 12);
  let best = 0;
  for (let i = 3; i < rows.length; i++) {
    const a = rows[i - 3], b = rows[i];
    const dy = ((((b[2] - a[2] + 180) % 360) + 360) % 360) - 180;
    const dp = b[1] - a[1];
    best = Math.max(best, (Math.hypot(dy, dp) / Math.max(1, b[0] - a[0])) * TICK);
  }
  return Math.round(best);
}

export function scoreKill(k) {
  let s = 10;
  const tags = [];
  const add = (pts, tag) => { s += pts; if (tag) tags.push(tag); };
  if (k.hs) add(14, "HS");
  if (SNIPER.test(k.weapon)) add(12, k.weapon === "ssg08" ? "SSG" : "AWP");
  if (k.weapon === "ssg08" && k.air) add(10, "прыжок SSG");
  else if (k.air) add(8, "в прыжке");
  if (k.noscope) add(18, "no-scope");
  if (k.flick >= 900) add(28, "флик");
  else if (k.flick >= 500) add(20, "флик");
  else if (k.flick >= 250) add(10, "доводка");
  if (k.wall) add(8, "прострел");
  if (k.smoke) add(6, "через смок");
  if (k.blind) add(8, "ослепленным");
  if (KNIFE.test(k.weapon)) add(25, "нож");
  if (k.dist >= 35) add(4, `${Math.round(k.dist)} м`);
  if (k.multi) add(6 * k.multi, `${k.multi + 1}K`);
  return { score: s, tags };
}

// киллы одного раунда подряд (до 4 с между ними) — один клип
export function groupKills(kills) {
  const groups = [];
  for (const k of kills) {
    const g = groups.at(-1);
    if (g && g.round === k.round && k.tick - g.kills.at(-1).tick <= 4 * TICK) g.kills.push(k);
    else groups.push({ round: k.round, kills: [k] });
  }
  for (const g of groups) g.kills.forEach((k) => { k.multi = g.kills.length - 1; });
  return groups;
}

// клип для рендера: интро длиннее (под текст песни), дневные — коротко вокруг киллов
export function clipOf(g, { steamid, name, slot, intro }) {
  const ticks = g.kills.map((k) => k.tick);
  const lead = intro ? 5.5 : 1.8, tail = intro ? 1.4 : 1.0;
  return {
    steamid, accountId: Number(BigInt(steamid) - STEAM64_BASE), name, slot, round: g.round,
    kills: ticks.length, hs: g.kills.filter((k) => k.hs).length,
    start: Math.max(0, Math.round(ticks[0] - lead * TICK)), end: Math.round(ticks.at(-1) + tail * TICK),
    killTicks: ticks, rawTicks: ticks, victims: g.kills.map((k) => k.victim),
    hsTicks: g.kills.filter((k) => k.hs).map((k) => k.tick), hits: [], night: !!intro,
  };
}

// длительность куска и секунды киллов в нём (без slow-mo и повторов — как рендерит эдит)
export const partInfo = (c) => ({ dur: (c.end - c.start) / TICK, kills: c.killTicks.map((t) => (t - c.start) / TICK) });

// План монтажа. parts — по порядку: { path, dur, kills: [секунды в куске], intro }.
// beats — удары трека в секундах от начала трека в эдите. Возвращает куски с нарезкой и скоростью,
// склейки (рывок) и удары зума на киллах — всё на итоговой шкале.
export function planMontage(parts, beats) {
  const grid = beats?.length > 8 ? beats : Array.from({ length: 400 }, (_, i) => i * 0.5);
  const next = (t) => grid.find((b) => b >= t) ?? t;
  const segments = [], whips = [], punches = [];
  let T = 0;
  for (const p of parts) {
    if (p.intro || !p.kills.length) {
      segments.push({ path: p.path, from: 0, to: p.dur, speed: 1 });
      p.kills.forEach((k) => punches.push(T + k));
      T += p.dur;
      whips.push(T);
      continue;
    }
    // заход: первый килл — на ближайший удар не раньше чем через 0.55 с после склейки
    const k0 = p.kills[0];
    let b = next(T + 0.55);
    const lead = b - T;
    const sp0 = k0 >= lead ? 1 : Math.max(0.05, k0) / lead;
    segments.push({ path: p.path, from: Math.max(0, k0 - lead * sp0), to: k0, speed: sp0 });
    punches.push(b);
    // каждый следующий килл — на удар: промежуток подгоняется скоростью (0.55..1.8)
    for (let j = 1; j < p.kills.length; j++) {
      const g = p.kills[j] - p.kills[j - 1];
      let best = null;
      for (const nb of grid) {
        if (nb <= b + 0.05) continue;
        const r = g / (nb - b);
        if (r < 0.55) break;
        if (r <= 1.8 && (best == null || Math.abs(Math.log(r)) < Math.abs(Math.log(g / (best - b))))) best = nb;
      }
      if (best == null) best = b + g;
      segments.push({ path: p.path, from: p.kills[j - 1], to: p.kills[j], speed: g / (best - b) });
      b = best;
      punches.push(b);
    }
    // хвост: до следующего удара хотя бы через 0.35 с
    const end = next(b + 0.35);
    const tail = end - b, left = p.dur - p.kills.at(-1);
    const spT = left >= tail ? 1 : Math.max(0.05, left) / tail;
    segments.push({ path: p.path, from: p.kills.at(-1), to: p.kills.at(-1) + tail * spT, speed: spT });
    T = end;
    whips.push(T);
  }
  whips.pop(); // после последнего куска склейки нет
  return { segments, whips, punches, total: T };
}
