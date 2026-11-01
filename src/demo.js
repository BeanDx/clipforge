// Группирует убийства из player_death (JSON от scripts/parse.cjs) в клипы-моменты.
import { buildMoments } from "./moments";

const STEAM64_BASE = 76561197960265728n;

export function parseDemo(raw, tickrate = 64, before = 1.5, after = 2) {
  const ev = raw.events;
  // Полный состав матча (все 10 игроков, даже без киллов) — нужен для выбора,
  // чей голосовой чат слушать (tv_listen_voice_indices), а не только для списка
  // с кликами по фрагам ниже.
  const roster = (raw.players || []).map((p) => ({
    id: String(p.steamid),
    name: p.name,
    team: p.team_number,
    slot: p.slot,
  }));
  const slotBySteamid = new Map(roster.map((p) => [p.id, p.slot]));

  const byRound = new Map(); // "steamid:round" -> убийства
  const players = new Map();
  for (const k of ev) {
    const id = String(k.attacker_steamid || "");
    if (!id || id === "0" || id === String(k.user_steamid)) continue;
    const round = Number(k.total_rounds_played) + 1;
    const key = `${id}:${round}`;
    if (!byRound.has(key)) byRound.set(key, { id, name: k.attacker_name, round, ticks: [], hs: 0, hsTicks: [], victims: [] });
    const g = byRound.get(key);
    g.ticks.push(Number(k.tick));
    g.victims.push(String(k.user_steamid));
    g.hs += k.headshot ? 1 : 0;
    if (k.headshot) g.hsTicks.push(Number(k.tick));
    const p = players.get(id) || {
      id,
      name: k.attacker_name,
      kills: 0,
      slot: slotBySteamid.get(id) ?? null,
      accountId: Number(BigInt(id) - STEAM64_BASE),
    };
    p.kills++;
    players.set(id, p);
  }

  // Умная выборка (src/moments.js): баллы, метки, клатчи, одиночные красивые фраги.
  // Без данных о раундах (старая демка) — как раньше: раунды с 2+ киллами.
  const smart = raw.rounds?.length ? buildMoments(raw, tickrate, before, after) : null;
  const nameOf = new Map(roster.map((p) => [p.id, p.name]));
  const clips = smart ? smart.map((m) => ({
    ...m,
    accountId: Number(BigInt(m.steamid) - STEAM64_BASE),
    slot: slotBySteamid.get(m.steamid) ?? null,
    name: m.name || nameOf.get(m.steamid) || "",
  })) : [...byRound.values()]
    .filter((g) => g.ticks.length >= 2)
    .map((g) => ({
      steamid: g.id,
      accountId: Number(BigInt(g.id) - STEAM64_BASE),
      slot: slotBySteamid.get(g.id) ?? null,
      name: g.name,
      round: g.round,
      kills: g.ticks.length,
      hs: g.hs,
      start: Math.max(0, Math.min(...g.ticks) - Math.round(before * tickrate)),
      end: Math.max(...g.ticks) + Math.round(after * tickrate),
      killTicks: [...g.ticks].sort((a, b) => a - b), // для slow-motion
      hsTicks: g.hsTicks, // киллы в голову — для зума на хедшот
      victims: g.victims, // цифры урона показываем только по тем, кого убил
      rawTicks: g.ticks, // тики в порядке событий — пара к victims (повторы глазами жертв)
    }))
    .sort((a, b) => a.start - b.start);

  // Попадания игроков: урон в одном тике (дробовик, прострел) складываем в одну цифру.
  const hurtMap = new Map();
  for (const h of raw.hurts || []) {
    const id = String(h.attacker_steamid || "");
    if (!id || id === "0" || id === String(h.user_steamid)) continue;
    const key = `${id}:${h.tick}:${h.user_steamid}`;
    const head = h.hitgroup === 1 || h.hitgroup === "head";
    const prev = hurtMap.get(key);
    if (prev) { prev.dmg += Number(h.dmg_health) || 0; prev.head ||= head; }
    else hurtMap.set(key, { steamid: id, victim: String(h.user_steamid), tick: Number(h.tick), dmg: Number(h.dmg_health) || 0, head });
  }
  const hurts = [...hurtMap.values()].map((h) => ({ ...h, dmg: Math.min(h.dmg, 100) }));

  return {
    players: [...players.values()].sort((a, b) => b.kills - a.kills),
    roster,
    clips,
    hurts,
    maxRound: Math.max(24, ...[...byRound.values()].map((g) => g.round)),
  };
}