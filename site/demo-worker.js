// Разбор демки в браузере (Web Worker, чтобы страница не зависала). Парсер — demoparser2,
// собранный в WebAssembly (site/parser, см. site/README.md). Достаёт то же, что scripts/parse.cjs
// в приложении для оценки моментов: смерти, начала раундов, состав и экипировку, счёт, дефьюзы.
/* global wasm_bindgen */
importScripts("parser/demoparser2.js");
const ready = wasm_bindgen("parser/demoparser2_bg.wasm");

// serde_wasm_bindgen отдаёт словари как Map — приводим к обычным объектам, BigInt — к строкам
const plain = (v) => {
  if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[k] = plain(x); return o; }
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = plain(v[k]); return o; }
  return v;
};
const say = (stage, k) => postMessage({ type: "progress", stage, k });

self.onmessage = async (e) => {
  try {
    await ready;
    const file = new Uint8Array(e.data.buffer);
    const P = wasm_bindgen;
    say("header", 0.05);
    const header = plain(P.parseHeader(file));
    say("deaths", 0.15);
    const events = plain(P.parseEvent(file, "player_death", ["team_num"], ["total_rounds_played"]));
    say("rounds", 0.45);
    const starts = new Map();
    for (const x of plain(P.parseEvent(file, "round_freeze_end", [], ["total_rounds_played"]))) starts.set(Number(x.total_rounds_played) + 1, x.tick);
    const ends = [];
    try { for (const x of plain(P.parseEvent(file, "round_officially_ended", [], []))) ends.push(x.tick); } catch { /* нет события */ }
    const lastTick = Math.max(0, ...ends, ...events.map((x) => x.tick));
    say("teams", 0.65);
    const ticks = [...starts.values(), lastTick];
    const snap = plain(P.parseTicks(file, ["team_num", "current_equip_value", "team_rounds_total"], new Int32Array(ticks)));
    const at = new Map();
    for (const s of snap) {
      if (!at.has(s.tick)) at.set(s.tick, []);
      at.get(s.tick).push({ id: String(s.steamid), name: s.name, team: s.team_num, equip: s.current_equip_value ?? 0, score: s.team_rounds_total ?? 0 });
    }
    const rounds = [...starts.entries()].sort((a, b) => a[0] - b[0]).map(([round, tick]) => ({ round, start: tick, players: at.get(tick) || [] }));
    rounds.push({ round: null, start: lastTick, players: at.get(lastTick) || [] });
    say("defuses", 0.9);
    let defuses = [];
    try { defuses = plain(P.parseEvent(file, "bomb_defused", [], [])).map((d) => ({ tick: d.tick, id: String(d.user_steamid) })); } catch { /* нет события */ }
    postMessage({ type: "done", raw: { header, events, rounds, defuses } });
  } catch (err) {
    postMessage({ type: "error", message: String(err?.message || err) });
  }
};
