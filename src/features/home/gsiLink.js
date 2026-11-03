// Связь матчей, записанных из игры (src-tauri/src/gsi.rs), с демками: у демки и матча одна карта
// и совпадают твои киллы по раундам. Так закладки хайлайтов (3K, эйс, клавиша «запомни») находят
// свои раунды в скачанной демке.

// dk — Map(раунд → твоих киллов в демке); matches — история из gsi_home
export function linkMatch(map, dk, matches) {
  let best = null;
  for (const m of matches || []) {
    if (map && m.map && m.map !== map) continue;
    const rounds = (m.rounds || []).filter((r) => r.kills > 0);
    if (!rounds.length) continue;
    const same = rounds.filter((r) => dk.get(r.round) === r.kills).length;
    const total = [...dk.values()].reduce((s, x) => s + x, 0);
    // почти все раунды с киллами совпали и общее число киллов близко
    const ok = same >= Math.max(2, Math.ceil(rounds.length * 0.7)) && Math.abs(total - m.kills) <= Math.max(2, m.kills * 0.15);
    if (ok && (!best || same > best.same)) best = { m, same };
  }
  return best?.m || null;
}

// раунды-хайлайты матча: Map(раунд → метки)
export function highlightRounds(m) {
  return new Map((m?.rounds || []).filter((r) => r.tags?.length).map((r) => [r.round, r.tags]));
}

// киллы по раундам из списка киллов editKills
export function killsByRound(kills) {
  const dk = new Map();
  for (const k of kills) dk.set(k.round, (dk.get(k.round) || 0) + 1);
  return dk;
}
