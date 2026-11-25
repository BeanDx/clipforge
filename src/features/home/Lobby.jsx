// Игроки матча ММ / Premier на главной (эксперимент, включается в «Настройках»).
// Память CS2 (lobby.rs) читается, только пока в матч заходят игроки: раз в 15 с, пока не наберётся 10,
// и не дольше 3 минут. Один опрос сразу отдаёт всех игроков. Дальше память не трогаем: аватар, премьер,
// звание и FACEIT берутся по steamid из Steam, Leetify и FACEIT (lobby_profile), по разу на игрока.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr, trError } from "../../i18n";
import { FaceitLevel } from "../match/dossier";

const FULL = 10;
const POLL_MS = 15_000;
const GIVE_UP_MS = 3 * 60_000;
const RANKED = ["competitive", "premier"];

// цвета премьер-рейтинга как в игре
const tier = (r) => (r >= 30000 ? "gold" : r >= 25000 ? "red" : r >= 20000 ? "pink" : r >= 15000 ? "purple" : r >= 10000 ? "blue" : r >= 5000 ? "cyan" : "grey");
const fmtPremier = (r) => r.toLocaleString("ru-RU").replace(/\s/g, ",");

const YEAR = 365 * 86_400_000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmtN = (n) => Math.round(n).toLocaleString("ru-RU");
const mapLabel = (m) => String(m || "").replace(/^(de|cs)_/, "").replace(/^\w/, (c) => c.toUpperCase());
const PARTY_COLORS = ["#2ee6c0", "#ff5fa2", "#a98bff", "#7dff6a", "#ff8a3d"]; // без жёлтого и синего — это цвета сторон T и CT

// Пати: игроки, которые есть друг у друга в друзьях Steam (хватает связи с одной стороны)
function parties(players, prof) {
  const ids = players.map((p) => p.steamid);
  const up = Object.fromEntries(ids.map((id) => [id, id]));
  const root = (x) => (up[x] === x ? x : (up[x] = root(up[x])));
  for (const a of ids) for (const f of prof(a)?.friends || []) if (f in up) up[root(a)] = root(f);
  const groups = {};
  for (const id of ids) (groups[root(id)] ||= []).push(id);
  const out = {};
  Object.values(groups).filter((g) => g.length > 1)
    .forEach((g, i) => g.forEach((id) => { out[id] = { id: i, n: g.length, color: PARTY_COLORS[i % PARTY_COLORS.length] }; }));
  return out;
}

// Откуда статистика: FACEIT, если там от 10 побед, иначе Премьер, иначе ММ (Leetify)
const SOURCE = { faceit: "FACEIT", premier: "PREMIER", mm: "MM" };
function statHint(st, map) {
  const src = st.source === "faceit" ? tr("FACEIT, за всё время") : st.source === "premier" ? tr("Премьер (Leetify)") : tr("Матчмейкинг (Leetify)");
  const lines = [src];
  if (st.kd != null) lines.push(st.kd_games ? tr("K/D {0} — последние {1} матчей", st.kd.toFixed(2), st.kd_games) : `K/D ${st.kd.toFixed(2)}`);
  if (st.wr != null) lines.push(tr("{0}% побед из {1} матчей", Math.round(st.wr), st.matches));
  if (st.hs != null) lines.push(tr("{0}% в голову", Math.round(st.hs)));
  if (st.adr != null) lines.push(`ADR ${Math.round(st.adr)}`);
  if (st.map_matches) lines.push(tr("{0}: {1}% побед из {2}", map, Math.round(st.map_wr || 0), st.map_matches) + (st.map_kd != null ? ` · K/D ${st.map_kd.toFixed(2)}` : ""));
  return lines.join("\n");
}

// Друзья в списке команды встают подряд (на место первого из них), остальные — в прежнем порядке
function groupParties(list, party) {
  const out = [];
  for (const p of list) {
    const pt = party[p.steamid];
    if (pt && out.some((x) => party[x.steamid]?.id === pt.id)) continue;
    out.push(p);
    if (pt) out.push(...list.filter((x) => x !== p && party[x.steamid]?.id === pt.id));
  }
  return out;
}
// место игрока в скобке: начало, середина, конец
const linkRole = (list, i, party) => {
  const id = party[list[i].steamid]?.id;
  if (id == null) return "";
  const prev = party[list[i - 1]?.steamid]?.id === id, next = party[list[i + 1]?.steamid]?.id === id;
  return prev && next ? "mid" : prev ? "last" : next ? "first" : "";
};

// Premier прямо из игры (то же чтение, что и steamid); нет — с Leetify
const PREMIER_TYPE = 11;
const gameRating = (p) => (p?.live?.rank_type === PREMIER_TYPE && p.live.rank > 0 ? p.live.rank : null);
const premierOf = (p, pr) => gameRating(p) ?? pr?.premier ?? null;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");
// прогноз игры: в одних версиях это новый рейтинг, в других — сразу разница. Разница при поражении ≤ 0,
// а новый рейтинг всегда больше нуля, так что различаем по поражению
const forecastDelta = (l) => (l.loss <= 0 ? { win: l.win, loss: l.loss, tie: l.tie } : { win: l.win - l.rank, loss: l.loss - l.rank, tie: l.tie - l.rank });

// Почему игрок похож на смурфа или подозрительный
function suspicion(pr, p) {
  if (!pr) return [];
  const why = [];
  const live = p?.live;
  if (live?.rank_type === PREMIER_TYPE && live.wins > 0 && live.wins < 40 && live.rank >= 18000)
    why.push(tr("всего {0} побед в Premier при рейтинге {1}", live.wins, fmtPremier(live.rank)));
  if (pr.vac || pr.bans) why.push(tr("были баны"));
  const since = Date.parse(pr.since || "");
  if (since && Date.now() - since < YEAR) why.push(tr("аккаунту меньше года"));
  const strong = (premierOf(p, pr) || 0) >= 18000 || (pr.faceit || 0) >= 9 || (pr.aim || 0) >= 85;
  if (pr.matches != null && pr.matches < 150 && strong) why.push(tr("мало матчей при высоком уровне"));
  if (pr.steam_ok && !pr.public) why.push(tr("закрытый профиль"));
  // ни FACEIT, ни Leetify, ни рейтинга — истории матчей нет нигде
  if (!pr.stat && !pr.faceit && !pr.premier && !pr.matches) why.push(tr("нигде нет истории матчей: новый или скрытый аккаунт"));
  if (pr.limited) why.push(tr("ограниченный аккаунт Steam"));
  return why;
}

// Лучшие в лобби по Leetify: бейдж получает один игрок на каждую категорию
function standouts(players, prof) {
  const pick = (get, better) => {
    let best = null;
    for (const p of players) {
      const v = get(prof(p.steamid));
      if (v != null && (best == null || better(v, best.v))) best = { id: p.steamid, v };
    }
    return best;
  };
  const out = {};
  const add = (b, label, hint) => { if (b) (out[b.id] ||= []).push({ label, hint }); };
  add(pick((pr) => pr?.aim, (a, b) => a > b), tr("аим"), tr("лучший аим в лобби (Leetify)"));
  add(pick((pr) => pr?.reaction_ms, (a, b) => a < b), tr("реакция"), tr("самая быстрая реакция в лобби (Leetify)"));
  add(pick((pr) => pr?.opening, (a, b) => a > b), tr("энтри"), tr("лучший в стартовых дуэлях (Leetify)"));
  add(pick((pr) => pr?.utility, (a, b) => a > b), tr("гранаты"), tr("лучшие гранаты в лобби (Leetify)"));
  return out;
}

// Шансы по среднему рейтингу: премьер, если он известен хотя бы у двоих с каждой стороны, иначе эло FACEIT
function strength(team, prof) {
  const prem = team.map((p) => premierOf(p, prof(p.steamid))).filter(Boolean);
  const elo = team.map((p) => prof(p.steamid)?.faceit_elo).filter(Boolean);
  return { prem: avg(prem), premN: prem.length, elo: avg(elo), eloN: elo.length };
}
function winChance(a, b) {
  if (a.premN >= 2 && b.premN >= 2) return 1 / (1 + 10 ** ((b.prem - a.prem) / 8000));
  if (a.eloN >= 2 && b.eloN >= 2) return 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
  return null;
}

// переживает переключение вкладок: вернулся на главную — память не читается заново
let memo = { key: "", players: [], reads: 0, done: false, started: 0 };
const profiles = new Map(); // steamid → профиль (или промис, пока грузится)

export function Lobby({ enabled, live, place, faceitKey, me }) {
  // В начале матча сервер ещё не определён (place.kind "game"): режимы ММ и Премьер бывают только у Valve.
  // На распознанном комьюнити-сервере, локальной игре и в демке не читаем.
  const ranked = live?.connected && (place.kind === "official" || place.kind === "game") && RANKED.includes(live.mode);
  const on = enabled && ranked;
  const matchKey = on ? `${live.map}|${live.mode}|${live.match_started || live.session_started || ""}` : "";
  const [state, setState] = useState(memo);
  const [err, setErr] = useState("");
  const [, setTick] = useState(0); // перерисовка, когда пришёл чей-то профиль
  const [hotParty, setHotParty] = useState(null); // наведён игрок из пати — подсвечиваем всю пати

  const read = () => invoke("lobby_players", { inMatch: true }).then((list) => {
    memo = { ...memo, reads: memo.reads + 1 };
    // игроки только добавляются: тот, кто вышел, остаётся в списке
    const known = new Map(memo.players.map((p) => [p.steamid, p]));
    for (const p of list) known.set(p.steamid, { ...known.get(p.steamid), ...p, team: p.team || known.get(p.steamid)?.team || "" });
    const players = [...known.values()];
    memo = { ...memo, players, done: memo.done || players.length >= FULL };
    setState(memo);
    setErr("");
  }).catch((e) => setErr(trError(e)));

  useEffect(() => {
    if (!matchKey) return;
    if (memo.key !== matchKey) { memo = { key: matchKey, players: [], reads: 0, done: false, started: Date.now() }; }
    setState(memo); // eslint-disable-line react-hooks/set-state-in-effect
    if (memo.done) return;
    let alive = true;
    const step = () => {
      if (!alive || memo.done) return;
      if (Date.now() - memo.started > GIVE_UP_MS) { memo = { ...memo, done: true }; setState(memo); return; }
      read();
    };
    step();
    const t = setInterval(step, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [matchKey]);

  // профили — по одному запросу на игрока за всё время работы программы (кэш в profiles)
  const key = (faceitKey || "").trim();
  // Steam не ответил (режет частые запросы) — через минуту пробуем ещё раз, максимум дважды.
  // Leetify и FACEIT при повторе берутся из кэша программы, память игры не трогается.
  const load = (id, attempt) => {
    profiles.set(id, invoke("lobby_profile", { steamid: id, map: live?.map || "", key })
      .then((pr) => {
        profiles.set(id, pr); setTick((n) => n + 1);
        if (!pr.steam_ok && attempt < 2) setTimeout(() => load(id, attempt + 1), 60_000);
      })
      .catch(() => { profiles.set(id, { steamid: id }); setTick((n) => n + 1); }));
  };
  useEffect(() => {
    for (const p of state.players) {
      if (profiles.has(p.steamid)) continue;
      load(p.steamid, 0);
    }
  }, [state.players, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on) return null;
  const myTeam = state.players.find((p) => p.steamid === me)?.team || live?.team || "";
  const teams = [
    { id: "mine", side: myTeam, title: tr("твоя команда"), list: state.players.filter((p) => myTeam && p.team === myTeam) },
    { id: "enemy", side: myTeam === "CT" ? "T" : myTeam === "T" ? "CT" : "", title: tr("соперники"), list: state.players.filter((p) => !myTeam || p.team !== myTeam) },
  ];
  const prof = (id) => { const pr = profiles.get(id); return pr && !(pr instanceof Promise) ? pr : null; };
  const party = parties(state.players, prof);
  const stars = standouts(state.players, prof);
  const [sa, sb] = [strength(teams[0].list, prof), strength(teams[1].list, prof)];
  const chance = teams[0].list.length && teams[1].list.length ? winChance(sa, sb) : null;
  const map = mapLabel(live.map);
  // ровно одно чтение по кнопке
  const retry = () => read().then(() => { memo = { ...memo, done: true }; setState(memo); });

  return (
    <section className="lb">
      <header className="lb__head">
        <span className="hm-kicker mono">{tr("игроки матча")}</span>
        <span className="lb__status mono dim">
          {err ? <span className="lb__err">{err}</span>
            : state.done ? tr("найдено {0} из {1} · память больше не читается", state.players.length, FULL)
            : tr("ищу игроков... {0} из {1}", state.players.length, FULL)}
        </span>
        {state.done && <button type="button" className="hm-btn" onClick={retry} title={tr("Прочитать список игроков из CS2 ещё раз")}>{tr("перечитать")}</button>}
      </header>
      {(sa.premN + sa.eloN + sb.premN + sb.eloN) > 0 && (
        <div className="lb-power">
          <div className="lb-power__side side-mine">
            {sa.prem != null && <span><b className="mono">{fmtN(sa.prem)}</b> {tr("премьер")}</span>}
            {sa.elo != null && <span><b className="mono">{fmtN(sa.elo)}</b> {tr("эло")}</span>}
          </div>
          <div className="lb-power__mid">
            {chance != null ? <>
              <div className="lb-power__bar" style={{ "--p": `${Math.round(chance * 100)}%` }}><i /></div>
              <span className="mono">{tr("шансы {0}% : {1}%", Math.round(chance * 100), 100 - Math.round(chance * 100))}</span>
            </> : <span className="mono dim">{tr("мало данных для шансов")}</span>}
          </div>
          <div className="lb-power__side side-enemy">
            {sb.prem != null && <span><b className="mono">{fmtN(sb.prem)}</b> {tr("премьер")}</span>}
            {sb.elo != null && <span><b className="mono">{fmtN(sb.elo)}</b> {tr("эло")}</span>}
          </div>
        </div>
      )}
      <div className="lb__teams">
        {teams.map((t) => (
          <div key={t.id} className={`lb__team is-${t.id} side-${t.side || "x"}`}>
            <h3 className="lb__title mono">{t.title}{t.side && <em>{t.side}</em>}</h3>
            <ul>
              {groupParties(t.list, party).map((p, i, list) => {
                const pr = profiles.get(p.steamid);
                const ready = pr && !(pr instanceof Promise);
                const sus = ready ? suspicion(pr, p) : [];
                const live = p.live;
                const prem = premierOf(p, ready ? pr : null);
                const fromGame = gameRating(p) != null;
                const forecast = live?.rank_type === PREMIER_TYPE && live.rank > 0 && (live.win || live.loss) ? forecastDelta(live) : null;
                const pt = party[p.steamid];
                const role = linkRole(list, i, party);
                const st = ready ? pr.stat : null;
                return (
                  <li key={p.steamid} className={`lb-card ${p.steamid === me ? "is-me" : ""} ${pt ? "in-party" : ""} ${pt && hotParty === pt.id ? "is-hot" : ""}`}
                    style={pt ? { "--party": pt.color, "--i": i } : undefined}
                    onMouseEnter={pt ? () => setHotParty(pt.id) : undefined} onMouseLeave={pt ? () => setHotParty(null) : undefined}
                    onClick={() => invoke("open_profile_link", { url: `https://steamcommunity.com/profiles/${p.steamid}` }).catch(() => {})}
                    title={live?.ping ? `${tr("Открыть профиль Steam")}
${tr("пинг {0}", live.ping)}` : tr("Открыть профиль Steam")}>
                    {role && <span className={`lb-link is-${role}`} title={tr("друзья в Steam: скорее всего, играют вместе ({0})", pt.n)}><i /></span>}
                    <span className="lb-card__ava">{ready && pr.avatar ? <img src={pr.avatar} alt="" loading="lazy" /> : <i>{(p.name || "?").slice(0, 1).toUpperCase()}</i>}</span>
                    <span className="lb-card__who">
                      <b>
                        {ready && /^[a-z]{2}$/.test(pr.country || "") && <img className="lb-flag" src={`https://flagcdn.com/20x15/${pr.country}.png`} alt={pr.country.toUpperCase()} title={pr.country.toUpperCase()} />}
                        {sus.length > 0 && <span className="lb-tag is-sus" title={sus.join("\n")}>⚠</span>}
                        {(stars[p.steamid] || []).map((b) => <span key={b.label} className="lb-tag is-star" title={b.hint}>{b.label}</span>)}
                      </b>
                      <small className="mono dim lb-stat" title={st ? statHint(st, map) : undefined}>
                        {!ready ? tr("загружаю...") : st ? <>
                          <em className={`lb-src is-${st.source}`}>{SOURCE[st.source]}</em>
                          {[st.kd != null ? `K/D ${st.kd.toFixed(2)}` : "", st.wr != null ? tr("{0}% побед", Math.round(st.wr)) : "",
                            st.map_matches ? `${map} ${Math.round(st.map_wr || 0)}%` : ""].filter(Boolean).join(" · ")}
                        </> : tr("нет данных")}
                      </small>
                    </span>
                    {prem
                      ? <span className="lb-prem-box">
                          <span className={`lb-prem tier-${tier(prem)}`}
                            title={fromGame ? tr("Премьер-рейтинг из игры, побед: {0}", live.wins) : tr("Премьер-рейтинг (Leetify)")}>{fmtPremier(prem)}</span>
                          {forecast && <small className="lb-prem__fc mono" title={tr("Прогноз игры: победа {0}, поражение {1}, ничья {2}", signed(forecast.win), signed(forecast.loss), signed(forecast.tie))}>
                            <b className="is-up">{signed(forecast.win)}</b><b className="is-down">{signed(forecast.loss)}</b>
                          </small>}
                        </span>
                      : <span className="lb-prem is-none" title={tr("премьер-рейтинга нет ни в игре, ни на Leetify")}>—</span>}
                    <span className="lb-card__fc">
                      {ready && pr.faceit
                        ? <><FaceitLevel level={pr.faceit} elo={pr.faceit_elo} />{pr.faceit_elo && <b className="mono">{pr.faceit_elo}</b>}</>
                        : <span className="lb-card__nofc mono" title={tr("нет аккаунта FACEIT")}>—</span>}
                    </span>
                  </li>
                );
              })}
              {!t.list.length && <li className="lb-card is-empty mono dim">{tr("пока никого")}</li>}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
