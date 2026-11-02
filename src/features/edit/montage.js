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
// Разминка до матча не считается: начало раунда — последний конец фризтайма с этим номером
// (scripts/parse.cjs), всё раньше — разминка и рестарты (там ножевые драки выглядели как «нож 2K в R1»).
export function editKills(raw, steamid) {
  const id = String(steamid);
  const startOf = new Map((raw.rounds || []).filter((r) => r.round != null).map((r) => [r.round, r.start]));
  return (raw.events || [])
    .filter((d) => String(d.attacker_steamid) === id && String(d.user_steamid) !== id
      && (d.attacker_team_num == null || d.attacker_team_num !== d.user_team_num)
      && !(startOf.size && Number(d.tick) < (startOf.get(Number(d.total_rounds_played) + 1) ?? -Infinity)))
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

// Автовыбор n моментов с разным оружием: по кругу — лучший ещё не взятый момент каждого ствола
// (стволы по силе лучшего момента), пока не наберётся n. Иначе десять лучших — это десять AK.
export function pickDiverse(groups, n) {
  const byGun = new Map();
  for (const g of [...groups].sort((a, b) => b.score - a.score)) {
    if (!byGun.has(g.weapon)) byGun.set(g.weapon, []);
    byGun.get(g.weapon).push(g);
  }
  const guns = [...byGun.values()];
  const out = [];
  for (let round = 0; out.length < n && guns.some((l) => l.length > round); round++) {
    for (const l of guns) { if (l[round] && out.length < n) out.push(l[round]); }
  }
  return out;
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
// night — ночной вид (небо, светящееся оружие): у интро или у всех кусков, как выбрано.
// Интро — без HUD (чистый кадр) и длиннее: под строки текста, как в TikTok-эдитах.
export function clipOf(g, { steamid, name, slot, intro, night = !!intro }) {
  const ticks = g.kills.map((k) => k.tick);
  const lead = intro ? 7 : 1.8, tail = intro ? 1.4 : 1.0;
  return {
    steamid, accountId: Number(BigInt(steamid) - STEAM64_BASE), name, slot, round: g.round,
    kills: ticks.length, hs: g.kills.filter((k) => k.hs).length,
    start: Math.max(0, Math.round(ticks[0] - lead * TICK)), end: Math.round(ticks.at(-1) + tail * TICK),
    killTicks: ticks, rawTicks: ticks, victims: g.kills.map((k) => k.victim),
    hsTicks: g.kills.filter((k) => k.hs).map((k) => k.tick), hits: [], night: !!night, clean: !!intro,
  };
}

// длительность куска и секунды киллов в нём (без slow-mo и повторов — как рендерит эдит)
export const partInfo = (c) => ({ dur: (c.end - c.start) / TICK, kills: c.killTicks.map((t) => (t - c.start) / TICK) });

// Ровная сетка ударов по найденным: средний интервал (приведённый к 0.35..0.75 с, то есть
// 80..170 BPM) и сдвиг, при котором найденные удары ближе всего к сетке. Детектор пропускает
// и путает удары, а склейки должны идти ровно — поэтому сетка, а не сами найденные удары.
export function beatGrid(beats) {
  const b = (beats || []).filter((x) => x >= 0).sort((x, y) => x - y);
  const iv = b.slice(1).map((x, i) => x - b[i]).filter((d) => d > 0.2 && d < 1.6).sort((x, y) => x - y);
  let P = iv.length >= 4 ? iv[Math.floor(iv.length / 2)] : 0.5;
  while (P < 0.35) P *= 2;
  while (P > 0.75) P /= 2;
  // уточняем интервал и сдвиг: перебор вокруг медианы, лучший — с наименьшей суммой отклонений
  let best = { P, phase: 0, err: Infinity };
  for (let q = P * 0.97; q <= P * 1.03; q += P * 0.0025) {
    for (let ph = 0; ph < q; ph += q / 40) {
      const err = b.reduce((s, x) => { const d = ((x - ph) % q + q) % q; return s + Math.min(d, q - d); }, 0);
      if (err < best.err) best = { P: q, phase: ph, err };
    }
  }
  return { P: best.P, at: (k) => best.phase + k * best.P, index: (t) => Math.ceil((t - best.phase) / best.P - 1e-6) };
}

// План в ритме TikTok-эдитов (разобран по референсу): интро целиком, его последняя секунда
// замедляется до начала такта — там дроп. Дальше склейка ровно на удар, выстрел сразу за ней,
// кусок держится 2 удара; киллы мультикилла — каждый на свой удар. Слабые одиночные киллы
// (если моментов много) идут чёрно-белой очередью по полудару посередине. Вспышки цвета:
// красная на первом килле после дропа, розовая после очереди.
// parts — { path, dur, kills, intro, score }; возвращает куски (gray — чёрно-белый), склейки,
// удары зума, вспышки { t, color } и общую длину.
// opts.dropAt — секунда дропа (начало припева от начала трека в эдите): интро подгоняется под неё.
export function planRhythm(parts, beats, opts = {}) {
  const { P, at, index } = beatGrid(beats);
  // ударов на килл — чтобы кусок был около секунды, как в референсе (126 BPM — 2 удара, 92 BPM — 1)
  const per = Math.max(1, Math.round(0.95 / P));
  const PRE = 0.05; // выстрел чуть после склейки: склейка на ударе, вспышка выстрела — следом
  const segments = [], whips = [], punches = [], flashes = [];
  let T = 0, k = 0; // k — номер удара, на котором сейчас стоит склейка
  const intro = parts.find((p) => p.intro);
  let rest = parts.filter((p) => !p.intro && p.kills.length);
  // очередь: до 6 самых слабых одиночных киллов, если моментов от 8
  const singles = rest.filter((p) => p.kills.length === 1).sort((a, b) => (a.score || 0) - (b.score || 0));
  // очередь имеет смысл от трёх кусков; пару одиночных оставляем обычными
  const burstN = Math.min(6, singles.length - 2);
  const burst = rest.length >= 8 && burstN >= 3 ? singles.slice(0, burstN) : [];
  rest = rest.filter((p) => !burst.includes(p));
  if (intro && opts.dropAt != null) {
    // дроп в заданное время (начало припева): интро заполняет время до него — лишнее начало
    // срезается, хвост замедляется вдвое (если интро короче — замедляется сильнее, до 0.3)
    k = Math.max(1, Math.round((opts.dropAt - at(0)) / P));
    const fill = at(k);
    const tailIn = Math.min(1, intro.dur * 0.3);
    let from = intro.dur + tailIn - fill; // хвост на 0.5: tailIn секунд записи займут 2·tailIn
    let slow = 0.5;
    if (from < 0) { from = 0; slow = Math.max(0.3, tailIn / Math.max(tailIn, fill - (intro.dur - tailIn))); }
    from = Math.min(from, intro.dur - tailIn - 0.2);
    segments.push({ path: intro.path, from, to: intro.dur - tailIn, speed: 1 });
    intro.kills.filter((t) => t >= from && t < intro.dur - tailIn).forEach((t) => punches.push(t - from));
    segments.push({ path: intro.path, from: intro.dur - tailIn, to: intro.dur, speed: slow });
    T = intro.dur - tailIn - from + tailIn / slow;
    // если интро всё же не дотянуло до удара — последняя секунда держится дольше
    if (T < fill - 0.01) { segments.at(-1).speed = tailIn / (fill - (intro.dur - tailIn - from)); }
    T = fill;
  } else if (intro) {
    // замедленный хвост интро: последняя секунда тянется до начала такта (не меньше чем в 1.25 раза)
    const tailIn = Math.min(1, intro.dur * 0.3);
    segments.push({ path: intro.path, from: 0, to: intro.dur - tailIn, speed: 1 });
    intro.kills.filter((t) => t < intro.dur - tailIn).forEach((t) => punches.push(t));
    k = index(intro.dur - tailIn + tailIn * 1.25);
    while (k % 4) k++;
    const slow = tailIn / Math.max(tailIn, at(k) - (intro.dur - tailIn));
    segments.push({ path: intro.path, from: intro.dur - tailIn, to: intro.dur, speed: slow });
    T = at(k);
  } else {
    k = Math.max(0, index(0.2));
    T = at(k);
  }
  const place = (p, beatsLong, gray) => {
    const k0 = p.kills[0];
    let kb = k; // удар первого килла (склейка на нём же)
    segments.push({ path: p.path, from: Math.max(0, k0 - PRE), to: k0, speed: 1, gray });
    punches.push(at(kb) + PRE);
    let outT = at(kb) + PRE;
    // следующие киллы — на ближайший подходящий удар, промежуток подгоняется скоростью (0.6..1.7)
    for (let j = 1; j < p.kills.length; j++) {
      const g = p.kills[j] - p.kills[j - 1];
      // киллы далеко друг от друга (дольше ~2.5 ударов) — середину вырезаем: удар после первого,
      // склейка, и следующий килл сразу на следующем ударе, как отдельный кусок
      if (g > 2.5 * P) {
        const hold = at(kb + 1) - outT;
        segments.push({ path: p.path, from: p.kills[j - 1], to: p.kills[j - 1] + hold, speed: 1, gray });
        kb += 1;
        segments.push({ path: p.path, from: Math.max(0, p.kills[j] - PRE), to: p.kills[j], speed: 1, gray });
        outT = at(kb) + PRE;
        punches.push(outT);
        continue;
      }
      // удар, при котором скорость ближе всего к настоящей (реже ускоряем и замедляем)
      let nb = kb + 1, bestErr = Infinity;
      for (let c = kb + 1; c <= kb + 8; c++) {
        const r = g / (at(c) + PRE - outT);
        if (r < 0.6) break;
        if (r <= 1.7 && Math.abs(Math.log(r)) < bestErr) { bestErr = Math.abs(Math.log(r)); nb = c; }
      }
      const sp = Math.min(1.7, Math.max(0.6, g / (at(nb) + PRE - outT)));
      segments.push({ path: p.path, from: p.kills[j - 1], to: p.kills[j], speed: sp, gray });
      outT += g / sp;
      kb = nb;
      punches.push(outT);
    }
    // хвост до склейки через beatsLong ударов после последнего килла
    const end = at(kb + beatsLong);
    const tail = end - outT, left = p.dur - p.kills.at(-1);
    const sp = left >= tail ? 1 : Math.max(0.05, left) / tail;
    segments.push({ path: p.path, from: p.kills.at(-1), to: p.kills.at(-1) + tail * sp, speed: sp, gray });
    k = kb + beatsLong;
    T = end;
  };
  const before = Math.ceil(rest.length / 3); // очередь — после первой трети
  rest.forEach((p, i) => {
    if (i === 0 && intro) flashes.push({ t: at(k) + PRE, color: "red" });
    if (i === before && burst.length) {
      // очередь: по полудару, чёрно-белая; склейки жёсткие
      for (const b of burst) {
        const kk = b.kills[0];
        const half = P / 2;
        segments.push({ path: b.path, from: Math.max(0, kk - PRE), to: Math.max(0, kk - PRE) + half, speed: 1, gray: true });
        punches.push(T + PRE);
        T += half;
      }
      k = index(T);
      const pad = at(k) - T;
      if (pad > 0.01) { const last = segments.at(-1); last.to += pad; T = at(k); }
      flashes.push({ t: T, color: "pink" });
    }
    place(p, i === rest.length - 1 ? 4 : per, false);
  });
  return { segments, whips, punches, flashes, total: T, beat: P };
}

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
