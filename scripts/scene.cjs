// Все игроки на отрезке демки — для 3D-превью клипа (src/features/scene3d).
// argv: <demo> <startTick> <endTick> [<steamid>]
// stdout: JSON { step, start, offset, players: [{ id, name, team, f: [[x, y, z, pitch, yaw, alive, duck, hp], ...] }], weapons }
// weapons — оружие в руках игрока steamid: [[номер кадра, имя], ...] со сменами
// kills — киллфид отрезка: [{ tick, a, an, at, v, vn, vt, w, hs, wb, smoke, blind, noscope, air, as, asn }]
// shots — выстрелы (без гранат и ножа): [[tick, steamid], ...]
// zoom — прицел игрока steamid: [[номер кадра, 0 | 1 | 2], ...] со сменами (0 — без зума)
// nades — разрывы гранат: [{ k: smoke|fire|flash|he, t: тик начала, e: тик конца, x, y, z }]
// С флагом --grenades вместо всего этого — полёт гранат: { nades: [{ k, id, p: [[tick, x, y, z], ...] }] }
// f[i] — состояние на тике start + i * step (null — игрока в этом тике нет).
// offset: game_time = tick / 64 + offset (время в XML mirv_campath — игровое).
const { parseTicks, parseEvent, parseEvents, parseGrenades } = require("@laihoe/demoparser2");

const STEP = 2;

// полёт гранат: parseGrenades читает всю демку (на большой — секунды), поэтому отдельным вызовом:
// превью открывается без него, траектории дорисовываются, когда придут
function flights(file, start, end) {
  const KIND = { CSmokeGrenadeProjectile: "smoke", CMolotovProjectile: "fire", CFlashbangProjectile: "flash", CHEGrenadeProjectile: "he", CDecoyProjectile: "decoy" };
  const rows = parseGrenades(file).filter((r) => KIND[r.grenade_type] && r.x != null && r.tick >= start - 64 * 4 && r.tick <= end && r.tick % STEP === 0);
  rows.sort((x, y) => x.tick - y.tick);
  const by = new Map(), all = [];
  for (const r of rows) {
    // id сущности переиспользуется: новая граната — после паузы больше секунды
    let n = by.get(r.grenade_entity_id);
    if (!n || n.p[n.p.length - 1][0] < r.tick - 64) { n = { k: KIND[r.grenade_type], p: [] }; by.set(r.grenade_entity_id, n); all.push(n); }
    n.p.push([r.tick, +r.x.toFixed(1), +r.y.toFixed(1), +r.z.toFixed(1)]);
  }
  // после приземления сущность ещё лежит (дым — до конца, HE — секунды): хвост без движения убираем
  for (const n of all) {
    let last = 0;
    for (let i = 1; i < n.p.length; i++) {
      const [, x, y, z] = n.p[i], [, px, py, pz] = n.p[i - 1];
      if (Math.abs(x - px) + Math.abs(y - py) + Math.abs(z - pz) > 0.5) last = i;
    }
    n.p.length = last + 1;
  }
  return { nades: all.filter((n) => n.p.length > 1) };
}

function clipData(file, a, b, me) {
  const start = Math.max(0, Math.floor(Number(a)));
  const end = Math.max(start, Math.floor(Number(b)));
  const ticks = [];
  for (let t = start; t <= end; t += STEP) ticks.push(t);
  const rows = parseTicks(file, ["X", "Y", "Z", "pitch", "yaw", "is_alive", "team_num", "duck_amount", "game_time", "active_weapon_name", "health", "is_scoped", "zoom_lvl"], ticks);
  const n = ticks.length;
  const byId = new Map();
  const held = new Array(n).fill(null);
  const zoomed = new Array(n).fill(0);
  let offset = null;
  for (const r of rows) {
    if (r.X == null || !r.steamid || String(r.steamid) === "0") continue;
    const id = String(r.steamid);
    if (!byId.has(id)) byId.set(id, { id, name: r.name || "", team: r.team_num, f: new Array(n).fill(null) });
    const p = byId.get(id);
    const i = Math.round((r.tick - start) / STEP);
    if (i < 0 || i >= n) continue;
    if (me && id === String(me)) {
      if (r.active_weapon_name) held[i] = r.active_weapon_name;
      zoomed[i] = r.is_scoped ? Math.max(1, Math.min(2, r.zoom_lvl || 1)) : 0;
    }
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
  const zoom = [];
  zoomed.forEach((z, i) => { if (i === 0 || z !== zoomed[i - 1]) zoom.push([i, z]); });
  const inRange = (r) => r.tick >= start && r.tick <= end;
  // разрывы гранат; дым висит ~18 с, поэтому берём и брошенные до начала клипа
  const ev = parseEvents(file, ["smokegrenade_detonate", "smokegrenade_expired", "inferno_startburn", "inferno_expire", "flashbang_detonate", "hegrenade_detonate"]);
  const KIND = { smokegrenade_detonate: "smoke", inferno_startburn: "fire", flashbang_detonate: "flash", hegrenade_detonate: "he" };
  const LEN = { smoke: 64 * 18, fire: 64 * 7, flash: 20, he: 26 };
  const nades = [];
  for (const r of ev) {
    const k = KIND[r.event_name];
    if (!k || r.x == null) continue;
    // конец — ближайшее «погасло» той же сущности после начала
    const stop = k === "smoke" ? "smokegrenade_expired" : k === "fire" ? "inferno_expire" : null;
    const x = stop && ev.find((q) => q.event_name === stop && q.entityid === r.entityid && q.tick >= r.tick);
    const e = Math.min(x ? x.tick : r.tick + LEN[k], r.tick + 64 * 25);
    if (e < start || r.tick > end) continue;
    nades.push({ k, t: r.tick, e, x: +r.x.toFixed(1), y: +r.y.toFixed(1), z: +r.z.toFixed(1) });
  }
  const kills = parseEvent(file, "player_death", [], []).filter(inRange).map((k) => ({
    tick: k.tick, a: k.attacker_steamid ? String(k.attacker_steamid) : null, an: k.attacker_name || "", at: k.attacker_team_num ?? null,
    v: String(k.user_steamid), vn: k.user_name || "", vt: k.user_team_num ?? null, w: k.weapon || "",
    hs: !!k.headshot, wb: Number(k.penetrated) > 0, smoke: !!k.thrusmoke, blind: !!k.attackerblind, noscope: !!k.noscope, air: !!k.attackerinair,
    as: k.assister_steamid ? String(k.assister_steamid) : null, asn: k.assister_name || "", flash: !!k.assistedflash,
  }));
  const NOT_GUN = /knife|bayonet|grenade|flashbang|molotov|incgrenade|decoy|smoke|c4|healthshot|taser/;
  const shots = parseEvent(file, "weapon_fire", [], []).filter((r) => inRange(r) && !NOT_GUN.test(r.weapon || ""))
    .map((r) => [r.tick, String(r.user_steamid)]);
  return { step: STEP, start, offset, players, weapons, kills, shots, zoom, nades };
}

try {
  const args = process.argv.slice(2);
  const out = args[0] === "--grenades"
    ? flights(args[1], Math.floor(Number(args[2])), Math.floor(Number(args[3])))
    : clipData(...args);
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
