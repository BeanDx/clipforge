// Общее для «Профиля», друзей и сравнения: загрузка игрока (Steam + FACEIT) и сводка его статистики.
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../../i18n";

// уровни FACEIT CS2: нижняя граница эло каждого уровня
export const LEVELS = [0, 100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
export const LVL_COLOR = (l) => (l >= 10 ? "#fe1f00" : l >= 8 ? "#ff6309" : l >= 4 ? "#ffc800" : l >= 2 ? "#1ce400" : "#eeeeee");
export const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const pad = (n) => String(n).padStart(2, "0");
// карта FACEIT («Dust2», «de_dust2») → внутреннее имя для mapName/mapTint
export const mapId = (m) => { const s = String(m || "").toLowerCase().replace(/\s+/g, ""); return s.includes("_") ? s : `de_${s}`; };
export const gameTime = (g) => num(g["Match Finished At"]) || Date.parse(g["Created At"] || "") || 0;
export const steamLike = (q) => /^7656\d{13}$/.test(q) || /steamcommunity\.com/i.test(q);

// кэш на время работы программы: вкладку переключают туда-сюда, а FACEIT и Steam считают запросы
const CACHE = new Map();
const TTL = 5 * 60_000;

// Игрок по SteamID, ссылке Steam/FACEIT или нику: { steam, fc, own, steamErr }. Не нашёлся — исключение.
export async function fetchPlayer(qs, { key, hasKey, ownId }) {
  const ck = `${qs}|${hasKey}`;
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let steam = null, fc = null, steamErr = null;
  // Steam может не ответить (429 — слишком много запросов): тогда показываем хотя бы FACEIT
  const steamOf = (query) => invoke("steam_profile", { query }).catch((e) => { steamErr = e; return null; });
  const isFaceit = /faceit\.com/i.test(qs);
  if (isFaceit || (!steamLike(qs) && hasKey)) {
    // ник или ссылка FACEIT; если такого ника нет — пробуем как короткое имя Steam
    fc = await invoke("faceit_profile", { key, steamid: null, nickname: qs });
    const sid = fc?.player?.steamid;
    if (sid) steam = await steamOf(String(sid));
    else if (!isFaceit) steam = await steamOf(qs);
  } else {
    steam = await steamOf(qs);
  }
  const sid64 = steam?.steamid || (qs.match(/7656\d{13}/) || [])[0];
  if (!fc && sid64 && hasKey) fc = await invoke("faceit_profile", { key, steamid: sid64, nickname: null });
  if (!steam && !fc) throw steamErr || tr("игрок не найден");
  const res = { steam, fc, own: !!ownId && (steam?.steamid === ownId || fc?.player?.steamid === ownId), steamErr: steam ? null : steamErr };
  // если Steam не ответил — не запоминаем, чтобы следующий заход попробовал снова
  if (steam && !steam.stale) CACHE.set(ck, { at: Date.now(), data: res });
  return res;
}

// Сводка FACEIT-статистики игрока (null — нет FACEIT)
export function summarize(fc) {
  if (!fc?.player) return null;
  const life = fc.lifetime || {};
  const games = [...(fc.games || [])].sort((a, b) => gameTime(a) - gameTime(b)); // старые → новые
  const g30 = games.reduce((a, g) => ({
    k: a.k + (num(g.Kills) || 0), d: a.d + (num(g.Deaths) || 0), w: a.w + (g.Result === "1"),
    adr: a.adr + (num(g.ADR) || 0), hs: a.hs + (num(g["Headshots %"]) || 0),
  }), { k: 0, d: 0, w: 0, adr: 0, hs: 0 });
  const maps = (fc.maps || []).map((m) => ({ ...m, id: mapId(m.map), n: num(m.stats?.Matches) || 0, wr: num(m.stats?.["Win Rate %"]) || 0, kd: num(m.stats?.["Average K/D Ratio"]) }))
    .filter((m) => m.n > 0).sort((a, b) => b.n - a.n);
  const recent = (life["Recent Results"] || []).slice(-5);
  return {
    level: num(fc.player.level), elo: num(fc.player.elo),
    matches: num(life.Matches), wins: num(life.Wins), wr: num(life["Win Rate %"]),
    kd: num(life["Average K/D Ratio"]), hs: num(life["Average Headshots %"]),
    kd30: games.length ? g30.k / Math.max(1, g30.d) : null,
    hs30: games.length ? g30.hs / games.length : null,
    adr: games.length ? g30.adr / games.length : num(life.ADR),
    streak: num(life["Longest Win Streak"]), current: num(life["Current Win Streak"]),
    recent, recentW: recent.length ? recent.filter((r) => r === "1").length : null,
    games, g30, maps,
    bestMap: maps.filter((m) => m.n >= 5).sort((a, b) => b.wr - a.wr)[0],
  };
}
