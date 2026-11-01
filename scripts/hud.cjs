// Состояние игрока для HUD «как в матче» по тикам клипов.
// argv: <demo> <steamid> <JSON [[start,end], ...]>  →  stdout: JSON [[sample, ...], ...] по клипу
const { parseTicks, parseEvent } = require("@laihoe/demoparser2");

const STEP = 4; // 16 замеров в секунду — HUD меняется не чаще
const PROPS = ["health", "armor_value", "has_helmet", "has_defuser", "balance",
  "active_weapon_name", "active_weapon_ammo", "inventory"];

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

  const out = ranges.map(([start, end]) => {
    // считаем с конца заморозки раунда, чтобы учесть перезарядки до начала клипа
    const from = freezeEnds.filter((t) => t <= start).pop() ?? start;
    const ticks = [];
    for (let t = from; t < start; t += STEP) ticks.push(t);
    for (let t = start; t <= end; t += STEP) ticks.push(t);
    const rows = parseTicks(file, PROPS, ticks, [steamid])
      .filter((r) => String(r.steamid) === String(steamid))
      .sort((a, b) => a.tick - b.tick);

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
      });
    }
    return samples;
  });
  process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
