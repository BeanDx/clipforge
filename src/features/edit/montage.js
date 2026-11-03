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
  // свои выстрелы: сколько пуль ушло за 0.6 с до килла (1–2 — тап, 5+ — спрей)
  const mine = (raw.fires || []).filter((f) => f[1] === id).map((f) => Number(f[0])).sort((a, b) => a - b);
  const shotsBefore = (tick) => {
    if (!raw.fires) return null;
    let n = 0;
    for (let i = mine.length - 1; i >= 0 && mine[i] >= tick - 0.6 * TICK; i--) if (mine[i] <= tick) n++;
    return n;
  };
  return (raw.events || [])
    .filter((d) => String(d.attacker_steamid) === id && String(d.user_steamid) !== id
      && (d.attacker_team_num == null || d.attacker_team_num !== d.user_team_num)
      && !(startOf.size && Number(d.tick) < (startOf.get(Number(d.total_rounds_played) + 1) ?? -Infinity)))
    .map((d) => ({
      tick: Number(d.tick), round: Number(d.total_rounds_played) + 1, victim: String(d.user_steamid),
      weapon: wname(d.weapon), hs: !!d.headshot, noscope: !!d.noscope && SNIPER.test(wname(d.weapon)),
      wall: Number(d.penetrated) > 0, smoke: !!d.thrusmoke, air: !!d.attackerinair, blind: !!d.attackerblind,
      dist: Number(d.distance) || 0, shots: shotsBefore(Number(d.tick)),
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
  // в эдите смотрится тап в голову: пуля сразу в голову, без спрея и доводки прицела
  if (k.shots != null && k.shots <= 2 && !KNIFE.test(k.weapon)) add(14, "тап");
  else if (k.shots >= 5) add(-14);
  if (SNIPER.test(k.weapon)) add(12, k.weapon === "ssg08" ? "SSG" : "AWP");
  if (k.weapon === "ssg08" && k.air) add(10, "прыжок SSG");
  else if (k.air) add(8, "в прыжке");
  if (k.noscope) add(18, "no-scope");
  if (k.flick >= 900) add(28, "флик");
  else if (k.flick >= 500) add(20, "флик");
  else if (k.flick >= 250) add(10, "доводка");
  if (k.wall) add(8, "прострел");
  if (k.smoke) add(16, "через смок"); // в эдите на нём рамка на противнике
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
    // киллы через смок: на них светящаяся рамка на противнике, как ВХ (nightfx.js, drawTargets)
    boxTicks: g.kills.filter((k) => k.smoke).map((k) => k.tick),
  };
}

// длительность куска и секунды киллов в нём (без slow-mo и повторов — как рендерит эдит)
// box — киллы с рамкой на цели (через смок): им нужен заход до выстрела, чтобы рамка была видна
export const partInfo = (c) => ({
  dur: (c.end - c.start) / TICK, kills: c.killTicks.map((t) => (t - c.start) / TICK),
  box: (c.boxTicks || []).map((t) => (t - c.start) / TICK),
});

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
// нет (красная на дропе и розовая после очереди слишком резали глаз).
// parts — { path, dur, kills, intro, score }; возвращает куски (gray — чёрно-белый), склейки,
// удары зума, вспышки { t, color } и общую длину.
// opts.dropAt — секунда дропа (начало припева от начала трека в эдите): интро подгоняется под неё.
// opts.grid — сетка из разбора всего трека (rhythm.js, gridFrom): точный темп и громкость каждого
// удара; без неё сетка строится по найденным ударам куска.
export function planRhythm(parts, beats, opts = {}) {
  const grid = opts.grid || beatGrid(beats);
  const { P, at, index } = grid;
  // ударов на килл — чтобы кусок был около секунды, как в референсе (126 BPM — 2 удара, 92 BPM — 1)
  const per = Math.max(1, Math.round(0.95 / P));
  // громкая часть трека (припев, крик) — киллы подряд, по одному на удар
  const perAt = (kb) => (per > 1 && P >= 0.45 && (grid.energyAt?.(kb) ?? 0) >= 0.6 ? 1 : per);
  const PRE = 0.03; // выстрел сразу после склейки: склейка на ударе, попадание — следом
  const segments = [], whips = [], punches = [], flashes = [];
  const boxes = []; // [от, до] на шкале эдита: рамка на цели через смок, текст в это время не рисуется
  let T = 0, k = 0; // k — номер удара, на котором сейчас стоит склейка
  const intro = parts.find((p) => p.intro);
  let rest = parts.filter((p) => !p.intro && p.kills.length);
  // очередь: до 8 самых слабых одиночных киллов, если моментов от 8
  const singles = rest.filter((p) => p.kills.length === 1).sort((a, b) => (a.score || 0) - (b.score || 0));
  // очередь имеет смысл от трёх кусков; пару одиночных оставляем обычными
  const burstN = Math.min(8, singles.length - 2);
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
  // Один килл — один кусок (как в референсе: в голову, в голову, в голову): склейка на ударе,
  // выстрел сразу за ней, дальше попадание и падение до следующей склейки через beatsLong ударов.
  // Доводка прицела до следующего килла не показывается — следующий килл мультикилла идёт
  // своим куском на следующем ударе. next — время следующего килла в том же куске (если есть):
  // до него хвост не доходит, при нехватке записи хвост замедляется.
  const shot = (p, kt, next, beatsLong, gray) => {
    // килл через смок: склейка на удар раньше — сначала рамка садится на противника, выстрел на следующем ударе
    const lead = p.box?.some((b) => Math.abs(b - kt) < 0.02) && kt > P + PRE ? 1 : 0;
    if (lead) { boxes.push([at(k), at(k + lead) + PRE + 0.45]); k += lead; }
    const t0 = at(k), end = at(k + beatsLong);
    segments.push({ path: p.path, from: Math.max(0, kt - PRE - lead * P), to: kt, speed: 1, gray });
    punches.push(t0 + PRE);
    const tail = end - t0 - PRE;
    const left = Math.max(0.04, (next != null ? next - PRE - 0.02 : p.dur) - kt);
    const sp = left >= tail ? 1 : Math.max(0.25, left / tail);
    segments.push({ path: p.path, from: kt, to: kt + tail * sp, speed: sp, gray });
    k += beatsLong;
    T = end;
  };
  // Там, где трек или текст стихает (и в конце эдита) — плавное слоу-мо с перемоткой: килл, время
  // замедляется, мягко отматывается назад (кадры задом наперёд: медленно — быстрее — медленно)
  // и тот же килл идёт ещё раз совсем медленно до склейки
  const slowShot = (p, kt, beatsLong) => {
    const t0 = at(k), end = at(k + beatsLong);
    const seg = (from, to, speed, reverse = false) => {
      segments.push({ path: p.path, from: Math.max(0, from), to, speed, reverse });
      return (to - Math.max(0, from)) / speed;
    };
    let t = t0;
    t += seg(kt - PRE, kt + 0.1, 1);
    punches.push(t0 + PRE);
    t += seg(kt + 0.1, kt + 0.16, 0.7);
    t += seg(kt + 0.16, kt + 0.22, 0.5);
    // перемотка назад: от kt + 0.22 до kt − 0.12, с разгоном и торможением
    t += seg(kt + 0.12, kt + 0.22, 0.6, true);
    t += seg(kt, kt + 0.12, 1, true);
    t += seg(kt - 0.12, kt, 0.6, true);
    // повтор килла: 0.35 и до конца
    const from = Math.max(0, kt - 0.12);
    const need = Math.max(0.05, end - t);
    const sp = Math.min(0.35, Math.max(0.25, (p.dur - from) / need));
    punches.push(t + (kt - from) / sp);
    segments.push({ path: p.path, from, to: from + need * sp, speed: sp });
    k += beatsLong;
    T = end;
  };
  // трек стихает: впереди 4 удара заметно тише, чем 4 удара до этого, или пауза в тексте (opts.quiet —
  // секунды эдита, где строка допета, а следующая ещё не началась)
  const avgE = (a) => [0, 1, 2, 3].reduce((s, d) => s + grid.energyAt(a + d), 0) / 4;
  const quietAt = (kb) => {
    const ahead = kb + perAt(kb);
    if (grid.energyAt && avgE(kb - 3) >= 0.5 && avgE(ahead) <= avgE(kb - 3) - 0.22) return true;
    return (opts.quiet || []).some((q) => q >= at(kb) && q < at(kb + 3));
  };
  let lastSlow = -Infinity, k0 = null; // k0 — удар дропа (первого килла после интро)
  const place = (p, isLast) => {
    k0 ??= k;
    const ks = p.kills;
    for (let j = 0; j < ks.length; j++) {
      // килл почти вплотную за предыдущим (двойной за 0.2 с) — в том же куске, без своей склейки
      let n = j;
      while (n + 1 < ks.length && ks[n + 1] - ks[n] < 0.22) n++;
      const next = ks[n + 1];
      for (let q = j + 1; q <= n; q++) punches.push(at(k) + PRE + (ks[q] - ks[j]));
      const lastKill = isLast && n === ks.length - 1;
      if (lastKill) slowShot(p, ks[j], 4);
      else if (k - lastSlow >= 12 && k - k0 >= 6 && quietAt(k)) { lastSlow = k; slowShot(p, ks[j], 3); }
      else shot(p, ks[j], next, perAt(k), false);
      j = n;
    }
  };
  const before = Math.ceil(rest.length / 3); // очередь — после первой трети
  rest.forEach((p, i) => {
    if (i === before && burst.length) {
      // очередь: по полудару, чёрно-белая; склейки жёсткие, в кадре только попадание
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
    }
    place(p, i === rest.length - 1);
  });
  return { segments, whips, punches, flashes, boxes, total: T, beat: P };
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
