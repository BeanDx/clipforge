const fs = require("fs");
const { parseEvent, parsePlayerInfo, parseTicks } = require("@laihoe/demoparser2");

try {
  const file = process.argv[2];
  // Сначала чиним демку FACEIT с курицей (иначе CS2 падает на playdemo) — сам файл, до разбора.
  // Уже исправленная или обычная демка не меняется. Что-то пошло не так — просто разбираем как есть.
  let fixed = null;
  try { fixed = require("./fixdemo.cjs").fixInPlace(file); } catch {}
  // team_num — для клатчей и тимкиллов: сторона убийцы и жертвы (attacker_team_num / user_team_num)
  const events = parseEvent(file, "player_death", ["team_num"], ["total_rounds_played"]);
  // Порядок игроков в parsePlayerInfo совпадает с их слотом в демке
  // (slot = индекс в массиве + 1). Поля "slot" в самом парсере нет,
  // проверено сопоставлением вручную через spec_player 1..10 в игре.
  // Если на какой-то демке порядок окажется другим — это заметно по
  // ручной проверке/корректировке слота в интерфейсе перед рендером.
  const players = parsePlayerInfo(file).map((p, i) => ({ ...p, slot: i + 1 }));
  // Попадания — для оверлея цифр урона. Если событие не распарсилось, просто без них.
  let hurts = [];
  try { hurts = parseEvent(file, "player_hurt", [], []); } catch {}
  // выстрелы — [тик, steamid]: тап это или спрей (эдит берёт тапы в голову, src/features/edit/montage.js)
  let fires = [];
  try { fires = parseEvent(file, "weapon_fire", [], []).map((e) => [e.tick, String(e.user_steamid)]); } catch {}

  // Контекст раундов для «умной» оценки моментов (src/moments.js): кто за какую сторону и с какой
  // экипировкой начал раунд, счёт команды игрока — по нему видно, кто выиграл раунд (и клатч).
  // Начало раунда — последний конец фризтайма с этим номером: более ранние — разминка и рестарты.
  let rounds = [], defuses = [];
  try {
    const starts = new Map();
    for (const e of parseEvent(file, "round_freeze_end", [], ["total_rounds_played"])) starts.set(e.total_rounds_played + 1, e.tick);
    const ends = [];
    try { for (const e of parseEvent(file, "cs_win_panel_match", [], [])) ends.push(e.tick); } catch {}
    try { for (const e of parseEvent(file, "round_officially_ended", [], [])) ends.push(e.tick); } catch {}
    const lastTick = Math.max(0, ...ends, ...events.map((e) => e.tick));
    const ticks = [...starts.values(), lastTick];
    const snap = parseTicks(file, ["team_num", "current_equip_value", "team_rounds_total"], ticks);
    const at = new Map();
    for (const s of snap) {
      if (!at.has(s.tick)) at.set(s.tick, []);
      at.get(s.tick).push({ id: String(s.steamid), team: s.team_num, equip: s.current_equip_value ?? 0, score: s.team_rounds_total ?? 0 });
    }
    rounds = [...starts.entries()].sort((a, b) => a[0] - b[0]).map(([round, tick]) => ({ round, start: tick, players: at.get(tick) || [] }));
    rounds.push({ round: null, start: lastTick, players: at.get(lastTick) || [] }); // счёт в конце матча
    try { defuses = parseEvent(file, "bomb_defused", [], []).map((d) => ({ tick: d.tick, id: String(d.user_steamid) })); } catch {}
  } catch {}

  const json = JSON.stringify({ size: fs.statSync(file).size, events, players, hurts, rounds, defuses, fires, fixed },
    (_, v) => (typeof v === "bigint" ? v.toString() : v));
  process.stdout.write(json);
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
