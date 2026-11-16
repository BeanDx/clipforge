// Состояние игрока для HUD «как в матче» по тикам клипов.
// argv: <demo> <steamid> <JSON [[start,end], ...]>  →  stdout: JSON [[sample, ...], ...] по клипу
const { parseTicks, parseEvent } = require("@laihoe/demoparser2");

const STEP = 4; // 16 замеров в секунду — HUD меняется не чаще
const PROPS = ["health", "armor_value", "has_helmet", "has_defuser", "balance",
  "active_weapon_name", "active_weapon_ammo", "inventory"];

// Табло сверху: время раунда (mp_roundtime 1:55 на FACEIT и в матчмейкинге) и таймер бомбы
const ROUND_SECS = 115, BOMB_SECS = 40, TICKRATE = 64;
const TOP_PROPS = ["team_num", "health", "team_rounds_total", "total_rounds_played"];

// Запас патронов парсер не отдаёт (total_ammo_left всегда 0), поэтому считаем сами:
// стандартный запас минус патроны, ушедшие на перезарядки с начала раунда.
const RESERVE = {
  "AK-47": 90, "M4A4": 90, "M4A1-S": 80, "Galil AR": 90, "FAMAS": 90, "AUG": 90, "SG 553": 90,
  "AWP": 30, "SSG 08": 90, "G3SG1": 90, "SCAR-20": 90,
  "MAC-10": 100, "MP9": 120, "MP7": 120, "MP5-SD": 120, "UMP-45": 100, "P90": 100, "PP-Bizon": 120,
  "Nova": 32, "XM1014": 32, "MAG-7": 32, "Sawed-Off": 32, "M249": 200, "Negev": 300,
  "Glock-18": 120, "USP-S": 24, "P2000": 52, "P250": 26, "Five-SeveN": 100, "Tec-9": 90,
  "CZ75-Auto": 12, "Dual Berettas": 120, "Desert Eagle": 35, "R8 Revolver": 8,
};

try {
  const [file, steamid, rangesJson] = process.argv.slice(2);
  const ranges = JSON.parse(rangesJson);
  const freezeEnds = parseEvent(file, "round_freeze_end", [], []).map((e) => Number(e.tick)).sort((a, b) => a - b);
  const ticksOf = (name) => { try { return parseEvent(file, name, [], []).map((e) => Number(e.tick)).sort((a, b) => a - b); } catch { return []; } };
  const roundEnds = ticksOf("round_end").filter((t) => t > 1);
  const plants = ticksOf("bomb_planted");
  const lastBefore = (list, t) => { let r = null; for (const x of list) { if (x > t) break; r = x; } return r; };

  // Табло на тик: счёт сторон, номер раунда, живые по сторонам, таймер (null — раунд кончился)
  function topAt(rows, t, mySide) {
    const side = (n) => rows.filter((r) => Number(r.team_num) === n);
    const ct = side(3), tt = side(2);
    if (!ct.length && !tt.length) return null;
    const fe = lastBefore(freezeEnds, t), re = lastBefore(roundEnds, t), pl = lastBefore(plants, t);
    let time = null, bomb = false;
    if (fe != null && !(re != null && re >= fe)) {
      if (pl != null && pl > fe) { bomb = true; time = BOMB_SECS - (t - pl) / TICKRATE; }
      else time = ROUND_SECS - (t - fe) / TICKRATE;
      time = Math.max(0, Math.ceil(time));
    }
    const any = rows[0] || {};
    return {
      ct: Number(ct[0]?.team_rounds_total ?? 0), t: Number(tt[0]?.team_rounds_total ?? 0),
      round: Number(any.total_rounds_played ?? 0) + 1,
      ctAlive: ct.filter((r) => (r.health ?? 0) > 0).length, tAlive: tt.filter((r) => (r.health ?? 0) > 0).length,
      ctN: Math.min(5, ct.length), tN: Math.min(5, tt.length),
      time, bomb, side: mySide,
    };
  }

  const out = ranges.map(([start, end]) => {
    // считаем с конца заморозки раунда, чтобы учесть перезарядки до начала клипа
    const from = freezeEnds.filter((t) => t <= start).pop() ?? start;
    const ticks = [];
    for (let t = from; t < start; t += STEP) ticks.push(t);
    for (let t = start; t <= end; t += STEP) ticks.push(t);
    const rows = parseTicks(file, PROPS, ticks, [steamid])
      .filter((r) => String(r.steamid) === String(steamid))
      .sort((a, b) => a.tick - b.tick);

    // все игроки на тиках клипа — для табло сверху
    let all = [];
    try { all = parseTicks(file, TOP_PROPS, ticks.filter((t) => t >= start)); } catch { /* старая демка — без табло */ }
    const byTick = new Map();
    for (const r of all) { const k = Number(r.tick); if (!byTick.has(k)) byTick.set(k, []); byTick.get(k).push(r); }

    const reserve = {}, lastClip = {};
    const samples = [];
    for (const r of rows) {
      const w = r.active_weapon_name ?? null;
      const clip = r.active_weapon_ammo ?? null;
      if (w && clip != null && w in RESERVE) {
        if (!(w in reserve)) reserve[w] = RESERVE[w];
        if (w in lastClip && clip > lastClip[w]) reserve[w] = Math.max(0, reserve[w] - (clip - lastClip[w]));
        lastClip[w] = clip;
      }
      if (r.tick < start) continue;
      samples.push({
        t: r.tick,
        hp: r.health ?? 0, armor: r.armor_value ?? 0, helmet: !!r.has_helmet, kit: !!r.has_defuser,
        money: r.balance ?? 0, weapon: w, clip: w in RESERVE ? clip : null,
        reserve: w in RESERVE ? reserve[w] : null, inv: r.inventory ?? [],
        top: byTick.has(Number(r.tick))
          ? topAt(byTick.get(Number(r.tick)), Number(r.tick), Number(byTick.get(Number(r.tick)).find((p) => String(p.steamid) === String(steamid))?.team_num ?? 0))
          : null,
      });
    }
    return samples;
  });
  process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
