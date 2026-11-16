// Вкладка «FACEIT» в разборе демки: одна таблица на 10 игроков (команды разделены полосой)
// и переключатели сверху — Обзор / Входы / Клатчи / Гранаты меняют колонки, как на faceit.com.
// Основа — FACEIT Data API (faceit.rs → faceit_match); входы, размены, клатчи 1v3–1v5 и гранаты
// по типам — из самой демки (scripts/info.cjs → players[].adv). Клик по нику — карточка игрока.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr, trError } from "../../i18n";
import { FaceitLevel } from "./dossier";
import { Rating } from "./Rating";
import { Avatar } from "./Avatar";
import { PlayerSheet } from "./PlayerSheet";

// матч уже закончен и не меняется: держим в памяти, пока открыта программа
const CACHE = new Map();
const VIEW_KEY = "cf-fx-view";

const fmtDate = (sec) => {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const nil = <span className="hm-nil">—</span>;

function Multi({ p }) {
  const l = [["2K", p.k2], ["3K", p.k3], ["4K", p.k4], ["ACE", p.k5]].filter(([, n]) => n);
  if (!l.length) return nil;
  return <span className="fx-multi">{l.map(([k, n]) => <em key={k} className={`is-${k.toLowerCase()}`}>{k}{n > 1 ? `×${n}` : ""}</em>)}</span>;
}

function Bar({ v, tone }) {
  return <span className="fx-bar"><b className="mono">{v}%</b><i className={tone ? `is-${tone}` : ""}><em style={{ width: `${v}%` }} /></i></span>;
}

// строка таблицы: p — игрок FACEIT, a — он же из демки (может не быть), rounds — раундов в матче.
// Колонка: [ключ, заголовок, подсказка, ячейка, число для подсветки лучшего (больше — лучше)]
const entryOf = (p, a) => (a ? [a.entryK, a.entryD] : [p.entryWins, p.entries - p.entryWins]);
const clutchOf = (p, a) => (a ? a.clutch : { 1: [p.c1w, p.c1 - p.c1w], 2: [p.c2w, p.c2 - p.c2w] });
const clutchSum = (c) => Object.values(c).reduce(([w, t], [cw, cl]) => [w + cw, t + cw + cl], [0, 0]);

const VIEWS = [
  ["overview", "Обзор", [
    ["rating", "Рейтинг", "Рейтинг clipforge по формуле HLTV 2.0", (p, a, R) => <Rating s={{ ...p, rounds: R }} />, (p) => p.rating],
    ["kda", "У/С/А", null, (p) => <span className="mono"><b>{p.kills}</b><i className="fx-sep">/</i>{p.deaths}<i className="fx-sep">/</i>{p.assists}</span>, (p) => p.kills],
    ["kd", "K/D", null, (p) => { const v = p.kills / Math.max(1, p.deaths); return <span className={`mono ${v >= 1.2 ? "fx-good" : v < 0.8 ? "fx-bad" : ""}`}>{v.toFixed(2)}</span>; }, (p) => p.kills / Math.max(1, p.deaths)],
    ["adr", "ADR", "Средний урон за раунд", (p) => <span className="mono">{p.adr.toFixed(0)}</span>, (p) => p.adr],
    ["hs", "HS%", null, (p) => <span className="mono">{p.hsp}%</span>, (p) => p.hsp],
    ["kast", "KAST", "Доля раундов, где игрок убил, помог, выжил или его смерть разменяли", (p, a) => (a?.kast != null ? <span className="mono">{a.kast}%</span> : nil), (p, a) => a?.kast ?? -1],
    ["multi", "Мульти", "Раунды с 2, 3, 4 и 5 киллами", (p) => <Multi p={p} />, (p) => p.k3 * 3 + p.k4 * 4 + p.k5 * 5],
  ]],
  ["entry", "Входы", [
    ["att", "Попыток", "Сколько раз участвовал в первой дуэли раунда", (p, a, R) => { const [k, dd] = entryOf(p, a); return <span className="mono">{k + dd}<em className="fx-dim"> · {pct(k + dd, R)}%</em></span>; }, (p, a) => entryOf(p, a).reduce((s, x) => s + x, 0)],
    ["ek", "Убил первым", null, (p, a) => <span className="mono">{entryOf(p, a)[0]}</span>, (p, a) => entryOf(p, a)[0]],
    ["ed", "Умер первым", null, (p, a) => <span className="mono">{entryOf(p, a)[1]}</span>, null],
    ["diff", "Разница", null, (p, a) => { const [k, dd] = entryOf(p, a); return <span className={`mono ${k > dd ? "fx-good" : k < dd ? "fx-bad" : ""}`}>{sign(k - dd)}</span>; }, (p, a) => { const [k, dd] = entryOf(p, a); return k - dd; }],
    ["succ", "Успешность", "Сколько первых дуэлей выиграл", (p, a) => { const [k, dd] = entryOf(p, a); return k + dd ? <Bar v={pct(k, k + dd)} tone={pct(k, k + dd) >= 50 ? "" : "red"} /> : nil; }, null],
    ["tk", "Отомстил", "Убил того, кто только что (до 5 с) убил напарника", (p, a) => (a ? <span className="mono">{a.tradeK}</span> : nil), (p, a) => a?.tradeK ?? -1],
    ["td", "Отомстили", "Его убийцу сразу убил напарник", (p, a) => (a ? <span className="mono">{a.tradedD}</span> : nil), null],
  ]],
  ["clutch", "Клатчи", [
    ["won", "Выиграно", "Остался один против одного или нескольких и выиграл раунд", (p, a) => { const [w, t] = clutchSum(clutchOf(p, a)); return t ? <span className="mono"><b>{w}</b><em className="fx-dim"> / {t}</em></span> : nil; }, (p, a) => clutchSum(clutchOf(p, a))[0]],
    ["rate", "Успех", null, (p, a) => { const [w, t] = clutchSum(clutchOf(p, a)); return t ? <Bar v={pct(w, t)} tone="yellow" /> : nil; }, null],
    ...[1, 2, 3, 4, 5].map((n) => [`c${n}`, `1v${n}`, null, (p, a) => {
      const c = clutchOf(p, a)[n];
      if (!c) return nil;
      const [w, l] = c;
      return w + l ? <span className={`fx-cl mono ${w ? "is-won" : ""}`}>{w}<em>/{w + l}</em></span> : <span className="fx-cl mono is-none">0</span>;
    }, (p, a) => clutchOf(p, a)[n]?.[0] ?? -1]),
  ]],
  ["nades", "Гранаты", [
    ["thrown", "Брошено", null, (p, a) => (a ? <span className="mono">{Object.values(a.nades).reduce((s, x) => s + x, 0)}</span> : nil), (p, a) => (a ? Object.values(a.nades).reduce((s, x) => s + x, 0) : -1)],
    ["he", "HE", null, (p, a) => (a ? <span className="mono">{a.nades.he}</span> : nil), (p, a) => a?.nades.he ?? -1],
    ["flash", "Флешки", null, (p, a) => (a ? <span className="mono">{a.nades.flash}</span> : nil), (p, a) => a?.nades.flash ?? -1],
    ["smoke", "Смоки", null, (p, a) => (a ? <span className="mono">{a.nades.smoke}</span> : nil), (p, a) => a?.nades.smoke ?? -1],
    ["molly", "Молотовы", null, (p, a) => (a ? <span className="mono">{a.nades.molly}</span> : nil), (p, a) => a?.nades.molly ?? -1],
    ["dmg", "Урон", "Урон гранатами и огнём", (p) => <span className="mono">{p.utilDmg}</span>, (p) => p.utilDmg],
    ["blind", "Ослепил", "Сколько раз ослепил врагов и на сколько секунд всего", (p, a) => (a ? <span className="mono">{a.flashEnemies}<em className="fx-dim"> · {a.flashEnemySec}с</em></span> : <span className="mono">{p.flashed}</span>), (p, a) => (a ? a.flashEnemySec : p.flashed)],
    ["team", "Своих", "Сколько раз ослепил напарников", (p, a) => (a ? <span className={`mono ${a.flashTeam ? "fx-bad" : ""}`}>{a.flashTeam}</span> : nil), null],
  ]],
];

export function FaceitTab({ id, faceitKey, playerId, info }) {
  const key = (faceitKey || "").trim();
  // ответ помнит, к какому матчу он относится: сменили демку — старый не показываем
  const [got, setGot] = useState({});
  const [sel, setSel] = useState(null); // открытая карточка игрока (id FACEIT)
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || "overview"; } catch { return "overview"; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* не запомним — не страшно */ } };
  useEffect(() => {
    if (!id || key.length < 32 || CACHE.has(id)) return;
    let alive = true;
    // FACEIT отвечает за полсекунды; дольше 20 с — что-то не так, не крутим заглушку вечно
    const slow = setTimeout(() => alive && setGot({ id, err: tr("FACEIT не ответил за 20 секунд. Проверь интернет и открой вкладку ещё раз.") }), 20_000);
    invoke("faceit_match", { key, id })
      .then((d) => { CACHE.set(id, d); if (alive) setGot({ id, data: d }); })
      .catch((e) => {
        const s = String(e?.message || e || "");
        // фронт обновился, а программа ещё старая: команды нет
        const msg = /not found|unknown command/i.test(s) ? tr("Перезапусти clipforge: этой вкладке нужна новая версия программы.") : trError(s) || tr("FACEIT не ответил");
        if (alive) setGot({ id, err: msg });
      })
      .finally(() => clearTimeout(slow));
    return () => { alive = false; clearTimeout(slow); };
  }, [id, key]);
  const state = CACHE.has(id) ? { data: CACHE.get(id) } : got.id === id ? got : {};

  if (!id) {
    return <div className="fx-empty"><b>FACEIT</b><p>{tr("Это не матч FACEIT. Вкладка оживает на демках, скачанных с FACEIT.")}</p></div>;
  }
  if (key.length < 32) {
    return <div className="fx-empty"><b>FACEIT</b><p>{tr("Укажи ключ FACEIT Data API в «Настройках», и здесь появится всё, что FACEIT знает об этом матче.")}</p></div>;
  }
  if (state.err) return <div className="fx-empty"><b>FACEIT</b><p className="err mono">{state.err}</p></div>;
  if (!state.data) {
    return (
      <div className="fx" aria-busy="true">
        <div className="fx-strip"><span className="fx-logo">FACEIT</span><span className="fx-strip__meta mono">{tr("гружу матч с FACEIT...")}</span></div>
        <div className="fx-skel" />
      </div>
    );
  }

  const d = state.data;
  const R = d.rounds;
  const all = d.teams.flatMap((t) => t.players.map((p) => ({ ...p, team: t.name })));
  // тот же игрок в разборе демки — по steamid
  const demoOf = (p) => info?.players?.find((x) => x.id === p.steamid);
  const advOf = (p) => demoOf(p)?.adv || null;
  const hasDemo = all.some((p) => advOf(p));
  const cols = (VIEWS.find(([k]) => k === view) || VIEWS[0])[2];
  // лучший в колонке подсвечивается
  const top = Object.fromEntries(cols.filter((c) => c[4]).map((c) => {
    const vals = all.map((p) => c[4](p, advOf(p), R));
    const max = Math.max(...vals);
    return [c[0], max > 0 ? max : null];
  }));
  const meta = [d.competition, d.region, d.bestOf > 1 ? `BO${d.bestOf}` : null, d.elo ? tr("на ELO") : tr("без ELO"), fmtDate(d.started)].filter(Boolean);
  const order = all.map((p) => p.id);
  const selP = all.find((p) => p.id === sel);
  const selTeam = selP && d.teams.find((t) => t.name === selP.team);
  const step = (dir) => setSel((cur) => order[(order.indexOf(cur) + dir + order.length) % order.length]);
  const [ta, tb] = d.teams;

  return (
    <div className="fx">
      <div className="fx-strip">
        <span className="fx-logo">FACEIT</span>
        <span className="fx-strip__meta mono">{meta.join(" · ")}</span>
        {ta && tb && <span className="fx-strip__score mono"><b className={ta.win ? "is-win" : ""}>{ta.score}</b><i>:</i><b className={tb.win ? "is-win" : ""}>{tb.score}</b></span>}
        {d.url && <button type="button" className="fx-open" onClick={() => invoke("faceit_open", { url: d.url }).catch(() => {})}>{tr("комната матча")} ↗</button>}
      </div>

      <div className="fx-bar-row">
        <div className="fx-views" role="tablist">
          {VIEWS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "is-on" : ""} onClick={() => pickView(k)}>{tr(l)}</button>
          ))}
        </div>
        <span className="fx-hint mono">{tr("нажми на игрока — вся его статистика")}</span>
      </div>

      <div className="dz-table-wrap">
        <table className={`fx-sb fx-sb--${view}`}>
          <thead>
            <tr>
              <th className="fx-sb__player">{tr("Игрок")}</th>
              {cols.map(([k, l, hint]) => <th key={k} title={hint ? tr(hint) : undefined} className={hint ? "has-hint" : ""}>{tr(l)}</th>)}
            </tr>
          </thead>
          {d.teams.map((t) => (
            <tbody key={t.name} className={t.win ? "is-win" : "is-loss"}>
              <tr className="fx-sb__team">
                <td colSpan={cols.length + 1}>
                  <span className="fx-sb__team-in">
                    <Avatar p={{ avatar: t.avatar, nick: t.name }} size={22} />
                    <b>{t.name}</b>
                    <em className="mono">{t.win ? tr("победа") : tr("поражение")} {t.score}</em>
                    <span className="mono fx-dim">{tr("половины")} {t.first} · {t.second}{t.ot ? ` · OT ${t.ot}` : ""}</span>
                  </span>
                </td>
              </tr>
              {t.players.map((p) => {
                const a = advOf(p);
                return (
                  <tr key={p.id} className={`fx-sb__row ${p.steamid && p.steamid === playerId ? "is-me" : ""}`} onClick={() => setSel(p.id)}>
                    <td className="fx-sb__player">
                      <button type="button" className="fx-nick" onClick={(e) => { e.stopPropagation(); setSel(p.id); }} title={tr("Полная статистика {0}", p.nick)}>
                        <Avatar p={p} size={28} /><FaceitLevel level={p.level} /><b>{p.nick}</b><i className="fx-nick__go">›</i>
                      </button>
                    </td>
                    {cols.map(([k, , , cell, val]) => {
                      const isTop = val && top[k] != null && val(p, a, R) === top[k];
                      return <td key={k} className={isTop ? "is-top" : ""}>{cell(p, a, R)}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>

      <p className="fx-note mono">
        {hasDemo ? tr("Входы, размены, клатчи и гранаты посчитаны по демке. Подсвечен лучший в колонке.") : tr("Размены, KAST и гранаты по типам появятся, когда демка разберётся.")}
        {" "}{tr("Рейтинг — clipforge по формуле HLTV 2.0: свой FACEIT наружу не отдаёт.")}
      </p>

      {selP && selTeam && (
        <PlayerSheet p={selP} team={selTeam} all={all} rounds={R} demo={demoOf(selP)} duels={info?.duels || null}
          onPick={setSel} onClose={() => setSel(null)} onStep={step} />
      )}
    </div>
  );
}
