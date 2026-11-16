// Полная статистика игрока в матче FACEIT — выезжающая справа карточка (по клику на ник во вкладке FACEIT).
// Основа — данные FACEIT, а то, чего FACEIT наружу не отдаёт (размены, клатчи 1v3–1v5, KAST, дуэли
// с каждым соперником, урон по каждому, гранаты по типам, флешки по своим), считается из самой демки
// (scripts/info.cjs → players[].adv и duels).
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { tr } from "../../i18n";
import { FaceitLevel } from "./dossier";
import { Rating } from "./Rating";
import { Avatar } from "./Avatar";

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

function Stat({ v, l, tone }) {
  return <div className={`ps-stat ${tone ? `is-${tone}` : ""}`}><b className="mono">{v}</b><span>{l}</span></div>;
}

function Meter({ value, tone = "teal" }) {
  return <span className={`ps-meter is-${tone}`}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

export function PlayerSheet({ p, team, all, rounds, demo, duels, onPick, onClose, onStep }) {
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); onStep(1); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); onStep(-1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, onStep]);

  const a = demo?.adv;
  // входы и клатчи 1v1/1v2 есть и у FACEIT; из демки — точнее и с 1v3–1v5
  const entryK = a ? a.entryK : p.entryWins, entryD = a ? a.entryD : p.entries - p.entryWins;
  const entries = entryK + entryD;
  const clutch = a ? a.clutch : { 1: [p.c1w, p.c1 - p.c1w], 2: [p.c2w, p.c2 - p.c2w] };
  const clW = Object.values(clutch).reduce((s, [w]) => s + w, 0), clT = Object.values(clutch).reduce((s, [w, l]) => s + w + l, 0);
  const nades = a?.nades;
  const thrown = nades ? Object.values(nades).reduce((s, x) => s + x, 0) : null;
  const maxNade = nades ? Math.max(1, ...Object.values(nades)) : 1;
  const kd = (p.kills / Math.max(1, p.deaths)).toFixed(2);

  // дуэли с каждым соперником: мои киллы, его киллы, урон туда и обратно
  const foes = all.filter((o) => o.team !== team.name);
  const duelRows = demo && duels ? foes.map((o) => {
    const mine = duels[demo.id]?.[o.steamid] || {}, theirs = duels[o.steamid]?.[demo.id] || {};
    return { o, k: mine.k || 0, d: theirs.k || 0, dmg: mine.dmg || 0, got: theirs.dmg || 0, ek: mine.ek || 0 };
  }).sort((x, y) => (y.k - y.d) - (x.k - x.d) || y.k - x.k) : null;
  const maxDuel = duelRows ? Math.max(1, ...duelRows.map((r) => Math.max(r.k, r.d))) : 1;

  const sheet = (
    <div className="ps-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="ps" role="dialog" aria-label={p.nick} style={{ "--team": team.win ? "var(--teal)" : "var(--red)" }}>
        <header className="ps-head">
          <div className="ps-head__glow" />
          <Avatar p={p} size={68} />
          <div className="ps-head__id">
            <span className="ps-head__team mono">{team.name} · <em className={team.win ? "is-win" : "is-loss"}>{team.win ? tr("победа") : tr("поражение")} {team.score}</em></span>
            <b className="ps-head__nick"><FaceitLevel level={p.level} />{p.nick}</b>
            <span className="ps-head__hint mono">{tr("↑ ↓ — другой игрок · Esc — закрыть")}</span>
          </div>
          <Rating s={{ ...p, rounds }} big />
          <button type="button" className="ps-x" onClick={onClose} aria-label={tr("закрыть")}>×</button>
        </header>

        <div className="ps-body">
          <div className="ps-strip">
            <Stat v={`${p.kills}/${p.deaths}/${p.assists}`} l={tr("У/С/А")} />
            <Stat v={kd} l="K/D" tone={kd >= 1.2 ? "good" : kd < 0.8 ? "bad" : ""} />
            <Stat v={p.adr.toFixed(0)} l="ADR" />
            <Stat v={`${p.hsp}%`} l="HS" />
            {a?.kast != null && <Stat v={`${a.kast}%`} l="KAST" tone={a.kast >= 75 ? "good" : a.kast < 60 ? "bad" : ""} />}
            <Stat v={p.mvps} l="MVP" />
          </div>

          <div className="ps-grid">
            <section className="ps-card ps-card--entry">
              <h4>{tr("Входы")}<small>{tr("первая дуэль раунда")}</small></h4>
              <div className="ps-big">
                <b className="mono">{pct(entryK, entries)}%</b><span>{tr("успешных")}</span>
                <Meter value={pct(entryK, entries)} tone={pct(entryK, entries) >= 50 ? "teal" : "red"} />
              </div>
              <div className="ps-rows">
                <div><span>{tr("попыток")}</span><b className="mono">{entries}<em className="dim"> · {pct(entries, rounds)}% {tr("раундов")}</em></b></div>
                <div><span>{tr("убил первым")}</span><b className="mono ps-good">{entryK}</b></div>
                <div><span>{tr("умер первым")}</span><b className="mono ps-bad">{entryD}</b></div>
                <div><span>{tr("разница")}</span><b className={`mono ${entryK - entryD > 0 ? "ps-good" : entryK - entryD < 0 ? "ps-bad" : ""}`}>{sign(entryK - entryD)}</b></div>
                {a && <div><span>{tr("смерть на входе разменяли")}</span><b className="mono">{a.entryTraded}</b></div>}
              </div>
            </section>

            <section className="ps-card ps-card--clutch">
              <h4>{tr("Клатчи")}<small>{tr("остался один против")}</small></h4>
              <div className="ps-big">
                <b className="mono">{clW}<span className="dim"> / {clT}</span></b><span>{tr("выиграно")}</span>
                <Meter value={pct(clW, clT)} tone="yellow" />
              </div>
              <div className="ps-clutch">
                {[1, 2, 3, 4, 5].map((n) => {
                  const [w, l] = clutch[n] || [0, 0];
                  return (
                    <div key={n} className={`ps-cl ${w ? "is-won" : w + l ? "is-tried" : ""}`}>
                      <span className="mono">1v{n}</span><b className="mono">{w}<em>/{w + l}</em></b>
                    </div>
                  );
                })}
              </div>
              {!a && <p className="ps-note dim">{tr("1v3–1v5 появятся, когда демка разберётся заново")}</p>}
            </section>

            {a && (
              <section className="ps-card ps-card--trade">
                <h4>{tr("Размены")}<small>{tr("в течение 5 секунд")}</small></h4>
                <div className="ps-duo">
                  <div><b className="mono ps-good">{a.tradeK}</b><span>{tr("отомстил за напарника")}</span></div>
                  <div><b className="mono">{a.tradedD}</b><span>{tr("за тебя отомстили")}</span></div>
                </div>
                <div className="ps-rows">
                  <div><span>{tr("смертей без размена")}</span><b className={`mono ${p.deaths - a.tradedD > rounds / 2 ? "ps-bad" : ""}`}>{Math.max(0, p.deaths - a.tradedD)}</b></div>
                </div>
              </section>
            )}

            <section className="ps-card ps-card--nade">
              <h4>{tr("Гранаты")}<small>{thrown != null ? tr("брошено {0}", thrown) : ""}</small></h4>
              {nades && (
                <div className="ps-nades">
                  {[["he", "HE"], ["flash", tr("флешки")], ["smoke", tr("смоки")], ["molly", tr("молотовы")], ["decoy", tr("декои")]].map(([k, l]) => (
                    <div key={k} className={`ps-nade is-${k}`}>
                      <span>{l}</span><i><em style={{ width: `${(nades[k] / maxNade) * 100}%` }} /></i><b className="mono">{nades[k]}</b>
                    </div>
                  ))}
                </div>
              )}
              <div className="ps-rows">
                <div><span>{tr("урон гранатами")}</span><b className="mono">{p.utilDmg}{a ? <em className="dim"> · HE {a.heDmg} · {tr("огонь")} {a.fireDmg}</em> : null}</b></div>
                <div><span>{tr("ослепил врагов")}</span><b className="mono">{a ? a.flashEnemies : p.flashed}{a ? <em className="dim"> · {a.flashEnemySec} {tr("с")}</em> : null}</b></div>
                {a && <div><span>{tr("ослепил своих")}</span><b className={`mono ${a.flashTeam ? "ps-bad" : ""}`}>{a.flashTeam}<em className="dim"> · {a.flashTeamSec} {tr("с")}</em></b></div>}
              </div>
            </section>
          </div>

          <section className="ps-card ps-duels">
            <h4>{tr("Дуэли")}<small>{tr("киллы друг на друга и урон")}</small></h4>
            {duelRows ? (
              <div className="ps-duel-list">
                {duelRows.map((r) => (
                  <button type="button" key={r.o.id} className="ps-duel" onClick={() => onPick(r.o.id)} title={tr("Открыть {0}", r.o.nick)}>
                    <span className="ps-duel__who"><Avatar p={r.o} size={26} /><FaceitLevel level={r.o.level} /><b>{r.o.nick}</b></span>
                    <span className="ps-duel__bar">
                      <i className="is-me" style={{ width: `${(r.k / maxDuel) * 50}%` }} />
                      <i className="is-foe" style={{ width: `${(r.d / maxDuel) * 50}%` }} />
                    </span>
                    <b className="ps-duel__score mono"><span className="ps-good">{r.k}</span> : <span className="ps-bad">{r.d}</span></b>
                    <span className={`ps-duel__net mono ${r.k > r.d ? "ps-good" : r.k < r.d ? "ps-bad" : ""}`}>{sign(r.k - r.d)}</span>
                    <span className="ps-duel__dmg mono"><b>{r.dmg}</b><span className="dim"> / {r.got}</span></span>
                  </button>
                ))}
                <div className="ps-duel ps-duel--legend mono dim">
                  <span>{tr("соперник")}</span><span>{tr("кто кого чаще")}</span><span>{tr("счёт")}</span><span>±</span><span>{tr("урон нанёс / получил")}</span>
                </div>
              </div>
            ) : <p className="ps-note dim">{tr("Дуэли считаются по демке: открой матч из «Архива», чтобы разобрать её.")}</p>}
          </section>
        </div>
      </aside>
    </div>
  );
  return createPortal(sheet, document.querySelector(".app") || document.body);
}
