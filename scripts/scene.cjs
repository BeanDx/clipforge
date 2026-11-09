// Все игроки на отрезке демки — для 3D-превью клипа (src/features/scene3d).
// argv: <demo> <startTick> <endTick> [<steamid>]
// stdout: JSON { step, start, offset, players: [{ id, name, team, f: [[x, y, z, pitch, yaw, alive, duck, hp], ...] }], weapons }
// weapons — оружие в руках игрока steamid: [[номер кадра, имя], ...] со сменами
// kills — киллфид отрезка: [{ tick, a, an, at, v, vn, vt, w, hs, wb, smoke, blind, noscope, air, as, asn }]
// shots — выстрелы (без гранат и ножа): [[tick, steamid], ...]
// f[i] — состояние на тике start + i * step (null — игрока в этом тике нет).
// offset: game_time = tick / 64 + offset (время в XML mirv_campath — игровое).
const { parseTicks, parseEvent } = require("@laihoe/demoparser2");

const STEP = 2;

try {
  const [file, a, b, me] = process.argv.slice(2);
  const start = Math.max(0, Math.floor(Number(a)));
  const end = Math.max(start, Math.floor(Number(b)));
  const ticks = [];
  for (let t = start; t <= end; t += STEP) ticks.push(t);
  const rows = parseTicks(file, ["X", "Y", "Z", "pitch", "yaw", "is_alive", "team_num", "duck_amount", "game_time", "active_weapon_name", "health"], ticks);
  const n = ticks.length;
  const byId = new Map();
  const held = new Array(n).fill(null);
  let offset = null;
  for (const r of rows) {
    if (r.X == null || !r.steamid || String(r.steamid) === "0") continue;
    const id = String(r.steamid);
    if (!byId.has(id)) byId.set(id, { id, name: r.name || "", team: r.team_num, f: new Array(n).fill(null) });
    const p = byId.get(id);
    const i = Math.round((r.tick - start) / STEP);
    if (i < 0 || i >= n) continue;
    if (me && id === String(me) && r.active_weapon_name) held[i] = r.active_weapon_name;
    if (r.team_num === 2 || r.team_num === 3) p.team = r.team_num;
    p.f[i] = [+r.X.toFixed(1), +r.Y.toFixed(1), +r.Z.toFixed(1), +(r.pitch ?? 0).toFixed(2), +(r.yaw ?? 0).toFixed(2), r.is_alive ? 1 : 0, +(r.duck_amount || 0).toFixed(2), r.health ?? null];
    if (offset == null && r.game_time != null && r.tick % 64 === 0) offset = Math.round((r.game_time - r.tick / 64) * 64) / 64;
  }
  if (offset == null) {
    const r = rows.find((x) => x.game_time != null);
    offset = r ? Math.round((r.game_time - r.tick / 64) * 64) / 64 : 0;
  }
  const players = [...byId.values()].filter((p) => p.team === 2 || p.team === 3);
  const weapons = [];
  let cur = null;
  held.forEach((w, i) => { if (w && w !== cur) { weapons.push([i, w]); cur = w; } });
  const inRange = (r) => r.tick >= start && r.tick <= end;
  const kills = parseEvent(file, "player_death", [], []).filter(inRange).map((k) => ({
    tick: k.tick, a: k.attacker_steamid ? String(k.attacker_steamid) : null, an: k.attacker_name || "", at: k.attacker_team_num ?? null,
    v: String(k.user_steamid), vn: k.user_name || "", vt: k.user_team_num ?? null, w: k.weapon || "",
    hs: !!k.headshot, wb: Number(k.penetrated) > 0, smoke: !!k.thrusmoke, blind: !!k.attackerblind, noscope: !!k.noscope, air: !!k.attackerinair,
    as: k.assister_steamid ? String(k.assister_steamid) : null, asn: k.assister_name || "", flash: !!k.assistedflash,
  }));
  const NOT_GUN = /knife|bayonet|grenade|flashbang|molotov|incgrenade|decoy|smoke|c4|healthshot|taser/;
  const shots = parseEvent(file, "weapon_fire", [], []).filter((r) => inRange(r) && !NOT_GUN.test(r.weapon || ""))
    .map((r) => [r.tick, String(r.user_steamid)]);
  process.stdout.write(JSON.stringify({ step: STEP, start, offset, players, weapons, kills, shots }));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
