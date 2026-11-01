// Досье матча: заголовок демки, счёт и «гиковская» статистика по игрокам.
// Всё считается из событий и свойств игроков, которые пишет сервер (demoparser2).
const { parseHeader, parseEvent, parseTicks } = require("@laihoe/demoparser2");

const TICK = 64;
const M_PER_UNIT = 0.0254; // 1 юнит Source ≈ 1 дюйм
const NOT_GUN = /knife|bayonet|grenade|flashbang|molotov|incgrenade|decoy|inferno|c4|taser|world/;
// максимальная скорость с оружием в руках: точный выстрел — при скорости ниже 34% от неё
const MAX_SPEED = { ak47: 215, m4a1: 225, m4a1_silencer: 225, galilar: 215, famas: 220, aug: 220, sg556: 210, awp: 200, ssg08: 230 };

const wname = (w) => String(w || "").replace(/^weapon_/, "");
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

try {
  const file = process.argv[2];
  const header = parseHeader(file);
  // всё до begin_new_match — разминка, её не считаем
  const begin = safe(() => parseEvent(file, "begin_new_match", [], []), []);
  const startTick = begin.length ? begin[begin.length - 1].tick : 0;
  const live = (list) => list.filter((e) => e.tick >= startTick);
  const deaths = live(parseEvent(file, "player_death", ["team_num"], ["total_rounds_played"]));
  const hurts = live(safe(() => parseEvent(file, "player_hurt", ["team_num"], []), []));
  const fires = live(safe(() => parseEvent(file, "weapon_fire", ["velocity_X", "velocity_Y", "is_airborne"], []), []));
  const blinds = live(safe(() => parseEvent(file, "player_blind", ["team_num"], []), []));
  const chat = safe(() => parseEvent(file, "chat_message", [], []), []); // чат и в разминке интересен
  const steps = live(safe(() => parseEvent(file, "player_footstep", [], []), []));
  const plants = live(safe(() => parseEvent(file, "bomb_planted", [], []), []));
  const defuses = live(safe(() => parseEvent(file, "bomb_defused", [], []), []));
  const freezeEnds = safe(() => parseEvent(file, "round_freeze_end", [], []), []).map((e) => e.tick);
  const winPanel = safe(() => parseEvent(file, "cs_win_panel_match", [], []), []);
  const cvars = safe(() => parseEvent(file, "server_cvar", [], []), []);

  const lastDeath = deaths.reduce((m, d) => Math.max(m, d.tick), 0);
  const endTick = winPanel[0]?.tick ?? lastDeath + TICK;
  const finalProps = ["team_num", "team_name", "team_clan_name", "team_rounds_total", "kills_total", "deaths_total", "assists_total",
    "damage_total", "headshot_kills_total", "utility_damage_total", "enemies_flashed_total", "mvps", "cash_spent_total", "crosshair_code"];
  let final = safe(() => parseTicks(file, finalProps, [endTick]), []);
  if (!final.length) final = safe(() => parseTicks(file, finalProps, [lastDeath]), []);

  // путь и пинг: каждые 8 тиков, шаги длиннее 100 юнитов (респаун, телепорт) не считаем
  const track = safe(() => {
    const ticks = [];
    for (let t = startTick; t <= endTick; t += 8) ticks.push(t);
    return parseTicks(file, ["X", "Y", "is_alive", "ping"], ticks);
  }, []);

  const P = new Map();
  const get = (id, name) => {
    if (!id || id === "0") return null;
    if (!P.has(id)) P.set(id, { id, name, shots: 0, rifleShots: 0, still: 0, hits: 0, firstKills: 0, firstDeaths: 0, ttk: [], steps: 0,
      dist: 0, pings: [], longest: 0, wallbangs: 0, noscopes: 0, smokeKills: 0, airKills: 0, blindKills: 0, flashSec: 0, weapons: {} });
    const p = P.get(id);
    if (name) p.name = name;
    return p;
  };

  for (const f of fires) {
    const w = wname(f.weapon);
    if (NOT_GUN.test(w)) continue;
    const p = get(f.user_steamid, f.user_name);
    if (!p) continue;
    p.shots++;
    if (MAX_SPEED[w]) {
      p.rifleShots++;
      const v = Math.hypot(f.user_velocity_X || 0, f.user_velocity_Y || 0);
      if (!f.user_is_airborne && v < MAX_SPEED[w] * 0.34) p.still++;
    }
  }
  // попадания: по противникам, из огнестрела; тики попаданий пары атакующий→жертва — для TTK
  const hitTicks = new Map();
  for (const h of hurts) {
    if (NOT_GUN.test(wname(h.weapon)) || h.attacker_team_num === h.user_team_num) continue;
    const p = get(h.attacker_steamid, h.attacker_name);
    if (!p) continue;
    p.hits++;
    const key = `${h.attacker_steamid}|${h.user_steamid}`;
    if (!hitTicks.has(key)) hitTicks.set(key, []);
    hitTicks.get(key).push(h.tick);
  }
  // TTK: от первого попадания серии (паузы не дольше 1.5 с) до смерти
  const firstOfChain = (key, death) => {
    const ts = (hitTicks.get(key) || []).filter((t) => t <= death);
    if (!ts.length || death - ts[ts.length - 1] > 1.5 * TICK) return null;
    let i = ts.length - 1;
    while (i > 0 && ts[i] - ts[i - 1] <= 1.5 * TICK) i--;
    return ts[i];
  };

  // первый килл раунда, дальний, сквозь стены и т.п.
  const roundFirst = new Map();
  let longest = null;
  const fx = { wallbangs: 0, smoke: 0, noscope: 0, air: 0, blind: 0, knife: 0, team: 0, hs: 0 };
  let fastestOpen = null;
  for (const d of deaths) {
    const a = get(d.attacker_steamid, d.attacker_name);
    const v = get(d.user_steamid, d.user_name);
    if (!a || !v || a === v) continue;
    if (d.attacker_team_num === d.user_team_num) { fx.team++; continue; }
    const w = wname(d.weapon);
    a.weapons[w] = (a.weapons[w] || 0) + 1;
    if (d.headshot) fx.hs++;
    if (d.penetrated > 0) { a.wallbangs++; fx.wallbangs++; }
    if (d.noscope) { a.noscopes++; fx.noscope++; }
    if (d.thrusmoke) { a.smokeKills++; fx.smoke++; }
    if (d.attackerinair) { a.airKills++; fx.air++; }
    if (d.attackerblind) { a.blindKills++; fx.blind++; }
    if (/knife|bayonet/.test(w)) fx.knife++;
    const dist = d.distance || 0;
    if (dist > a.longest) a.longest = dist;
    if (!longest || dist > longest.dist) longest = { dist, name: a.name, victim: v.name, weapon: w, round: (d.total_rounds_played ?? 0) + 1 };
    const r = d.total_rounds_played ?? 0;
    if (!roundFirst.has(r)) {
      roundFirst.set(r, true);
      a.firstKills++; v.firstDeaths++;
      const fe = freezeEnds.filter((t) => t <= d.tick).pop();
      if (fe != null) {
        const s = (d.tick - fe) / TICK;
        if (!fastestOpen || s < fastestOpen.sec) fastestOpen = { sec: s, name: a.name, victim: v.name, weapon: w, round: r + 1 };
      }
    }
    const first = firstOfChain(`${d.attacker_steamid}|${d.user_steamid}`, d.tick);
    if (first != null && d.tick - first < 5 * TICK && !NOT_GUN.test(w)) a.ttk.push(((d.tick - first) / TICK) * 1000);
  }
  for (const b of blinds) {
    if (b.attacker_team_num === b.user_team_num) continue;
    const p = get(b.attacker_steamid, b.attacker_name);
    if (p) p.flashSec += b.blind_duration || 0;
  }
  for (const s of steps) { const p = get(s.user_steamid, s.user_name); if (p) p.steps++; }

  const prevPos = new Map();
  for (const t of track) {
    const p = get(t.steamid, t.name);
    if (!p) continue;
    if (t.ping > 0) p.pings.push(t.ping);
    const prev = prevPos.get(t.steamid);
    if (t.is_alive && prev?.alive) {
      const step = Math.hypot(t.X - prev.X, t.Y - prev.Y);
      if (step < 100) p.dist += step;
    }
    prevPos.set(t.steamid, { X: t.X, Y: t.Y, alive: t.is_alive });
  }

  // счёт: команды по номеру стороны на конец матча
  const teams = new Map();
  for (const f of final) {
    if (f.team_num !== 2 && f.team_num !== 3) continue;
    teams.set(f.team_num, { side: f.team_num === 2 ? "T" : "CT", name: String(f.team_clan_name || f.team_name).replace(/^team_/, ""), score: f.team_rounds_total ?? 0 });
  }
  const rounds = [...teams.values()].reduce((s, t) => s + t.score, 0) || roundFirst.size || 1;

  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const players = final.filter((f) => f.team_num === 2 || f.team_num === 3).map((f) => {
    const p = get(f.steamid, f.name) || {};
    const fav = Object.entries(p.weapons || {}).sort((a, b) => b[1] - a[1])[0];
    return {
      id: String(f.steamid), name: f.name, side: f.team_num === 2 ? "T" : "CT",
      kills: f.kills_total ?? 0, deaths: f.deaths_total ?? 0, assists: f.assists_total ?? 0,
      adr: Math.round((f.damage_total ?? 0) / rounds),
      hs: f.kills_total ? Math.round(((f.headshot_kills_total ?? 0) / f.kills_total) * 100) : 0,
      util: f.utility_damage_total ?? 0, flashed: f.enemies_flashed_total ?? 0, mvps: f.mvps ?? 0, spent: f.cash_spent_total ?? 0,
      crosshair: f.crosshair_code || "",
      shots: p.shots, accuracy: p.shots ? Math.round((p.hits / p.shots) * 100) : null,
      strafe: p.rifleShots >= 20 ? Math.round((p.still / p.rifleShots) * 100) : null,
      ttk: avg(p.ttk) != null ? Math.round(avg(p.ttk)) : null,
      openK: p.firstKills, openD: p.firstDeaths, steps: p.steps, dist: Math.round(p.dist * M_PER_UNIT),
      ping: avg(p.pings) != null ? Math.round(avg(p.pings)) : null,
      longest: Math.round(p.longest || 0), wallbangs: p.wallbangs, noscopes: p.noscopes, smokeKills: p.smokeKills,
      airKills: p.airKills, blindKills: p.blindKills, flashSec: Math.round(p.flashSec * 10) / 10,
      fav: fav ? fav[0] : null,
    };
  }).sort((a, b) => b.kills - a.kills);

  const server = header.server_name || "";
  const faceitId = (file.match(/1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
  const cv = Object.fromEntries(cvars.map((c) => [c.name, c.value]));
  const out = {
    map: header.map_name, server, patch: header.patch_version, demoVersion: header.demo_version_name,
    source: /faceit/i.test(server) ? "FACEIT" : /valve/i.test(server) ? "Valve MM" : header.client_name === "SourceTV Demo" ? "SourceTV" : "POV",
    faceitId, ticks: endTick, tickrate: TICK,
    matchSec: Math.round((endTick - startTick) / TICK), rounds,
    teams: [...teams.values()].sort((a, b) => (a.side > b.side ? -1 : 1)),
    players,
    facts: {
      longest, fastestOpen, ...fx, kills: deaths.length,
      shots: fires.filter((f) => !NOT_GUN.test(wname(f.weapon))).length,
      plants: plants.length, defuses: defuses.length, footsteps: steps.length,
    },
    cvars: ["mp_maxrounds", "mp_overtime_enable", "mp_friendlyfire", "sv_cheats", "mp_freezetime", "mp_roundtime", "tv_delay", "sv_maxrate"]
      .filter((k) => cv[k] != null).map((k) => [k, cv[k]]),
    chat: chat.map((c) => ({ tick: c.tick, name: c.user_name, text: c.chat_message })).slice(0, 200),
  };
  process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
