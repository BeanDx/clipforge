// Копия src/features/demo/moments.js для разбора демки на сайте (без i18n приложения).
// Обновляется командой: node site/sync-moments.mjs
// «Умная» выборка моментов: каждый раунд каждого игрока получает баллы и метки — как у сервисов
// хайлайтов (Allstar, Medal), только по всем данным демки: клатчи, открытия, прострелы, ноускоупы,
// скорость мультикилла, эко-раунды, ниндзя-дефьюзы. В клипы попадают мультикиллы, выигранные клатчи
// и одиночные фраги, если они правда красивые (прострел, ноускоуп, нож…).


const SNIPER = /awp|ssg08|scar20|g3sg1/;
const KNIFE = /knife|bayonet/;
const wname = (w) => String(w || "").replace(/^weapon_/, "");

// Баллы — подобраны так, что: 2K ≈ 30, быстрый 3K ≈ 60, клатч 1v3 с тремя киллами ≈ 110, эйс ≈ 150+
const P = {
  kill: 10, hs: 4, wall: 8, smoke: 6, noscope: 12, air: 8, blind: 10, knife: 15, taser: 10, long: 5,
  multi: { 2: 8, 3: 22, 4: 45, 5: 90 }, collat: 15,
  fast: 14, quick: 7, allHs: 10, opening: 5, clutchPerEnemy: 20, clutchTry: 4, eco: 5, pistol: 4, decisive: 10, ninja: 25, defuse: 5,
};
const SINGLE_MIN = 22; // одиночный фраг попадает в клипы только если набрал столько (прострел в голову, ноускоуп…)

export const TIERS = [
  [130, "legend", "Легенда"],
  [80, "epic", "Эпик"],
  [45, "top", "Топ"],
  [25, "good", "Хорошо"],
  [0, "ok", "Обычный"],
];
export const tierOf = (s) => TIERS.find(([min]) => s >= min);

export function buildMoments(raw, tickrate = 64, before = 1.5, after = 2) {
  const rounds = (raw.rounds || []).filter((r) => r.round != null);
  const endSnap = (raw.rounds || []).find((r) => r.round == null);
  const byNum = new Map(rounds.map((r) => [r.round, r]));
  const lastRound = rounds.length ? Math.max(...rounds.map((r) => r.round)) : 0;
  const half = 13; // MR12: пистолетки — 1-й и 13-й раунды

  // выиграл ли раунд игрок: счёт его команды вырос к началу следующего раунда (смена сторон не мешает —
  // счёт берём у самого игрока, а не у стороны)
  const scoreOf = (snap, id) => snap?.players.find((p) => p.id === id)?.score;
  const wonRound = (r, id) => {
    const a = scoreOf(byNum.get(r), id);
    const b = scoreOf(byNum.get(r + 1) || endSnap, id);
    return a != null && b != null ? b > a : null;
  };

  // смерти по раундам; всё, что раньше начала раунда (разминка, рестарты), отбрасываем
  const deathsBy = new Map();
  for (const d of raw.events || []) {
    const r = Number(d.total_rounds_played) + 1;
    const st = byNum.get(r);
    if (rounds.length && (!st || d.tick < st.start)) continue;
    if (!deathsBy.has(r)) deathsBy.set(r, []);
    deathsBy.get(r).push(d);
  }

  const moments = [];
  for (const [r, list] of deathsBy) {
    list.sort((a, b) => a.tick - b.tick);
    const st = byNum.get(r);
    const teamOf = new Map((st?.players || []).map((p) => [p.id, p.team]));
    const equipOf = new Map((st?.players || []).map((p) => [p.id, p.equip]));
    const alive = { 2: new Set(), 3: new Set() };
    for (const p of st?.players || []) if (p.team === 2 || p.team === 3) alive[p.team].add(p.id);
    const other = (t) => (t === 2 ? 3 : 2);
    const clutch = {}; // сторона -> { id, vs, tick } — момент, когда игрок остался один
    const per = new Map(); // игрок -> киллы в раунде
    let opened = false;

    const checkClutch = (tick) => {
      if (!st) return;
      for (const t of [2, 3]) {
        if (!clutch[t] && alive[t].size === 1 && alive[other(t)].size >= 1) {
          clutch[t] = { id: [...alive[t]][0], vs: alive[other(t)].size, tick };
        }
      }
    };

    for (const d of list) {
      const victim = String(d.user_steamid || "");
      const attacker = String(d.attacker_steamid || "");
      const vt = teamOf.get(victim) ?? d.user_team_num;
      const at = teamOf.get(attacker) ?? d.attacker_team_num;
      alive[vt]?.delete(victim);
      const real = attacker && attacker !== "0" && attacker !== victim && at !== vt;
      if (real) {
        const w = wname(d.weapon);
        const k = {
          tick: Number(d.tick), victim, weapon: w,
          hs: !!d.headshot, wall: Number(d.penetrated) > 0, smoke: !!d.thrusmoke,
          noscope: !!d.noscope && SNIPER.test(w), air: !!d.attackerinair, blind: !!d.attackerblind,
          knife: KNIFE.test(w), taser: /taser/.test(w), dist: Number(d.distance) || 0,
          opening: !opened,
        };
        opened = true;
        if (!per.has(attacker)) per.set(attacker, { id: attacker, name: d.attacker_name, team: at, kills: [] });
        per.get(attacker).kills.push(k);
      }
      checkClutch(Number(d.tick));
    }

    // разминирование: «ниндзя», если террористы ещё живы (их смерти до этого тика уже учтены выше —
    // пересчитываем живых на момент дефьюза)
    const next = byNum.get(r + 1)?.start ?? Infinity;
    for (const df of (raw.defuses || []).filter((x) => st && x.tick >= st.start && x.tick < next)) {
      const tAlive = new Set((st.players || []).filter((p) => p.team === 2).map((p) => p.id));
      for (const d of list) if (d.tick <= df.tick) tAlive.delete(String(d.user_steamid));
      if (!per.has(df.id)) per.set(df.id, { id: df.id, name: null, team: teamOf.get(df.id), kills: [] });
      per.get(df.id).defuse = { tick: df.tick, ninja: tAlive.size > 0 };
    }

    for (const m of per.values()) {
      const ks = m.kills;
      const n = ks.length;
      let s = 0;
      const tags = [];
      const add = (pts, tag) => { s += pts; if (tag && !tags.includes(tag)) tags.push(tag); };
      for (const k of ks) {
        s += P.kill;
        if (k.hs) s += P.hs;
        if (k.wall) add(P.wall, "сквозь стену");
        if (k.smoke) add(P.smoke, "через смок");
        if (k.noscope) add(P.noscope, "no-scope");
        if (k.air) add(P.air, "в прыжке");
        if (k.blind) add(P.blind, "ослепленным");
        if (k.knife) add(P.knife, "ножом");
        if (k.taser) add(P.taser, "зевс");
      }
      // дальний фраг — одна метка с самым дальним расстоянием
      const far = Math.max(0, ...ks.map((k) => k.dist));
      if (far >= 40) add(P.long, `${Math.round(far)} м`);
      // два трупа одной пулей (киллы в один тик) — коллатерал
      if (ks.some((k, i) => i > 0 && k.tick - ks[i - 1].tick <= 1)) add(P.collat, "коллатерал");
      if (n >= 2) s += P.multi[Math.min(n, 5)];
      if (n >= 2) {
        const span = (ks[n - 1].tick - ks[0].tick) / tickrate;
        if (span <= 3) add(P.fast, `за ${span.toFixed(1)} с`);
        else if (span <= 6) add(P.quick, `за ${span.toFixed(1)} с`);
      }
      const hs = ks.filter((k) => k.hs).length;
      if (n >= 3 && hs === n) add(P.allHs, "все в голову");
      if (ks[0]?.opening) add(P.opening, "открытие");

      // клатч: игрок остался последним на своей стороне
      const cl = clutch[m.team]?.id === m.id ? clutch[m.team] : null;
      const won = wonRound(r, m.id);
      let clutchWon = false;
      if (cl) {
        const after = ks.filter((k) => k.tick >= cl.tick).length;
        if (won) { clutchWon = true; add(P.clutchPerEnemy * cl.vs, `клатч 1v${cl.vs}`); }
        else if (after) s += P.clutchTry * after;
      }
      // эко: сам почти без снаряжения против закупленных
      const me = equipOf.get(m.id) ?? 0;
      const enemies = (st?.players || []).filter((p) => p.team && p.team !== m.team && (p.team === 2 || p.team === 3));
      const enemyAvg = enemies.length ? enemies.reduce((a, p) => a + p.equip, 0) / enemies.length : 0;
      if (n && me && me <= 1500 && enemyAvg >= 3500) add(P.eco * n, "эко");
      if ((r === 1 || r === half) && n >= 2) add(P.pistol, "пистолетка");
      if (r === lastRound && won) add(P.decisive, "решающий раунд");
      if (m.defuse) add(m.defuse.ninja ? P.ninja : P.defuse, m.defuse.ninja ? "ниндзя-дефьюз" : null);

      const ninja = !!m.defuse?.ninja;
      if (!(n >= 2 || clutchWon || ninja || (n === 1 && s >= SINGLE_MIN))) continue;

      const kind = n >= 5 ? "ace" : clutchWon ? "clutch" : n >= 2 ? "multi" : ninja ? "clutch" : "skill";
      const lead = n >= 5 ? "ACE" : n >= 2 ? `${n}K` : null;
      const ticks = ks.map((k) => k.tick);
      const from = Math.min(...ticks, m.defuse ? m.defuse.tick - 6 * tickrate : Infinity, cl && clutchWon ? cl.tick - tickrate : Infinity);
      const to = Math.max(...ticks, m.defuse?.tick ?? -Infinity);
      moments.push({
        steamid: m.id, name: m.name, round: r, kills: n, hs, score: s, kind,
        tags: lead ? [lead, ...tags] : tags,
        clutch: clutchWon ? cl.vs : 0,
        start: Math.max(0, Math.round(from - before * tickrate)),
        end: Math.round(to + after * tickrate),
        killTicks: [...ticks].sort((a, b) => a - b),
        rawTicks: ticks,
        victims: ks.map((k) => k.victim),
        hsTicks: ks.filter((k) => k.hs).map((k) => k.tick),
      });
    }
  }
  return moments.sort((a, b) => a.start - b.start);
}
