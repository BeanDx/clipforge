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

const RANKS = ["", "Silver I", "Silver II", "Silver III", "Silver IV", "Silver Elite", "Silver Elite Master",
  "Gold Nova I", "Gold Nova II", "Gold Nova III", "Gold Nova Master", "Master Guardian I", "Master Guardian II",
  "Master Guardian Elite", "Distinguished Master Guardian", "Legendary Eagle", "Legendary Eagle Master",
  "Supreme Master First Class", "The Global Elite"];
const RANK_SHORT = ["", "S1", "S2", "S3", "S4", "SE", "SEM", "GN1", "GN2", "GN3", "GNM", "MG1", "MG2", "MGE", "DMG", "LE", "LEM", "SMFC", "GE"];
// цвета премьер-рейтинга как в игре
const tier = (r) => (r >= 30000 ? "gold" : r >= 25000 ? "red" : r >= 20000 ? "pink" : r >= 15000 ? "purple" : r >= 10000 ? "blue" : r >= 5000 ? "cyan" : "grey");
const fmtPremier = (r) => r.toLocaleString("ru-RU").replace(/\s/g, ",");

// переживает переключение вкладок: вернулся на главную — память не читается заново
let memo = { key: "", players: [], reads: 0, done: false, started: 0 };
const profiles = new Map(); // steamid → профиль (или промис, пока грузится)

export function Lobby({ enabled, live, place, faceitKey, me }) {
  const ranked = live?.connected && place.kind === "official" && RANKED.includes(live.mode);
  const on = enabled && ranked;
  const matchKey = on ? `${live.map}|${live.mode}|${live.server?.addr || ""}` : "";
  const [state, setState] = useState(memo);
  const [err, setErr] = useState("");
  const [, setTick] = useState(0); // перерисовка, когда пришёл чей-то профиль

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
  useEffect(() => {
    for (const p of state.players) {
      if (profiles.has(p.steamid)) continue;
      profiles.set(p.steamid, invoke("lobby_profile", { steamid: p.steamid, map: live?.map || "", key })
        .then((pr) => { profiles.set(p.steamid, pr); setTick((n) => n + 1); })
        .catch(() => { profiles.set(p.steamid, { steamid: p.steamid }); setTick((n) => n + 1); }));
    }
  }, [state.players, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on) return null;
  const myTeam = state.players.find((p) => p.steamid === me)?.team || live?.team || "";
  const teams = [
    { id: "mine", side: myTeam, title: tr("твоя команда"), list: state.players.filter((p) => myTeam && p.team === myTeam) },
    { id: "enemy", side: myTeam === "CT" ? "T" : myTeam === "T" ? "CT" : "", title: tr("соперники"), list: state.players.filter((p) => !myTeam || p.team !== myTeam) },
  ];
  const premier = live.mode === "premier";
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
      <div className="lb__teams">
        {teams.map((t) => (
          <div key={t.id} className={`lb__team is-${t.id} side-${t.side || "x"}`}>
            <h3 className="lb__title mono">{t.title}{t.side && <em>{t.side}</em>}</h3>
            <ul>
              {t.list.map((p) => {
                const pr = profiles.get(p.steamid);
                const ready = pr && !(pr instanceof Promise);
                return (
                  <li key={p.steamid} className={`lb-card ${p.steamid === me ? "is-me" : ""}`}
                    onClick={() => invoke("open_profile_link", { url: `https://steamcommunity.com/profiles/${p.steamid}` }).catch(() => {})}
                    title={tr("Открыть профиль Steam")}>
                    <span className="lb-card__ava">{ready && pr.avatar ? <img src={pr.avatar} alt="" loading="lazy" /> : <i>{(p.name || "?").slice(0, 1).toUpperCase()}</i>}</span>
                    <span className="lb-card__who">
                      <b>{p.name || p.steamid}</b>
                      <small className="mono dim">
                        {!ready ? tr("загружаю...")
                          : [pr.matches ? tr("{0} матчей", pr.matches) : "", pr.winrate != null && pr.matches ? tr("{0}% побед", Math.round(pr.winrate * 100)) : "", pr.vac ? "VAC" : ""].filter(Boolean).join(" · ") || tr("нет данных")}
                      </small>
                    </span>
                    {ready && (premier || !pr.comp) && pr.premier
                      ? <span className={`lb-prem tier-${tier(pr.premier)}`} title={tr("Премьер-рейтинг (Leetify)")}>{fmtPremier(pr.premier)}</span>
                      : ready && pr.comp ? <span className="lb-rank mono" title={RANKS[pr.comp]}>{RANK_SHORT[pr.comp]}</span>
                      : <span className="lb-prem is-none">—</span>}
                    <span className="lb-card__fc">{ready && pr.faceit ? <FaceitLevel level={pr.faceit} elo={pr.faceit_elo} /> : <span className="lb-card__nofc mono" title={tr("нет аккаунта FACEIT")}>—</span>}</span>
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
