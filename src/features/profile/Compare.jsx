// Сравнение двух игроков: шапка «A VS B» со счётом по показателям, строки статистики FACEIT
// с полосами от центра (у кого больше — подсвечен) и карты бок о бок.
import { tr, useLang } from "../../i18n";
import { mapName, mapTint } from "../match/dossier";
import { LVL_COLOR, summarize } from "./data";

const fmt = (v, digits = 0, suffix = "") => (v == null ? "—" : `${v.toFixed(digits)}${suffix}`);

export function Compare({ a, b, onClose, onSwap, onOpenB, onGoSettings, hasKey }) {
  useLang();
  const sa = summarize(a.fc), sb = summarize(b.fc);
  const rows = [
    { label: tr("эло FACEIT"), a: sa?.elo, b: sb?.elo },
    { label: tr("матчей"), a: sa?.matches, b: sb?.matches },
    { label: tr("винрейт"), a: sa?.wr, b: sb?.wr, suffix: "%" },
    { label: "K/D", a: sa?.kd, b: sb?.kd, digits: 2 },
    { label: tr("K/D за 30 матчей"), a: sa?.kd30, b: sb?.kd30, digits: 2 },
    { label: tr("в голову"), a: sa?.hs, b: sb?.hs, suffix: "%" },
    { label: "ADR", a: sa?.adr, b: sb?.adr, digits: 1 },
    { label: tr("лучшая серия"), a: sa?.streak, b: sb?.streak },
    { label: tr("побед из последних 5"), a: sa?.recentW, b: sb?.recentW },
  ].map((r) => ({ ...r, win: r.a == null || r.b == null || r.a === r.b ? 0 : r.a > r.b ? -1 : 1 }));
  const score = [rows.filter((r) => r.win < 0).length, rows.filter((r) => r.win > 0).length];

  // карты, сыгранные обоими, — по сумме матчей
  const byId = (s) => Object.fromEntries((s?.maps || []).map((m) => [m.id, m]));
  const ma = byId(sa), mb = byId(sb);
  const maps = [...new Set([...Object.keys(ma), ...Object.keys(mb)])]
    .map((id) => ({ id, a: ma[id], b: mb[id] }))
    .filter((m) => m.a && m.b)
    .sort((x, y) => (y.a.n + y.b.n) - (x.a.n + x.b.n))
    .slice(0, 8)
    .map((m) => ({ ...m, win: m.a.wr === m.b.wr ? 0 : m.a.wr > m.b.wr ? -1 : 1 }));

  const both = sa && sb;
  return (
    <div className="pvs">
      <div className="pvs-bar">
        <button type="button" className="pf-btn" onClick={onClose}>← {tr("к профилю")}</button>
        <span className="pvs-bar__gap" />
        <button type="button" className="pf-btn" onClick={onSwap} title={tr("поменять местами")}>⇄</button>
        <button type="button" className="pf-btn" onClick={onOpenB}>{tr("открыть профиль {0}", nameOf(b))}</button>
      </div>

      <section className="pvs-head">
        <Side d={a} s={sa} side="a" lead={both && score[0] > score[1]} />
        <div className="pvs-vs">
          <span className="pvs-vs__word">VS</span>
          {both && <b className="pvs-vs__score mono"><em className={score[0] > score[1] ? "is-lead" : ""}>{score[0]}</em>:<em className={score[1] > score[0] ? "is-lead" : ""}>{score[1]}</em></b>}
          {both && <span className="pvs-vs__sub mono">{tr("по показателям")}</span>}
        </div>
        <Side d={b} s={sb} side="b" lead={both && score[1] > score[0]} />
      </section>

      {!both ? (
        <section className="pf-card pf-cta">
          <div>
            <h2>{!hasKey ? tr("Подключи FACEIT") : tr("Сравнивать нечего")}</h2>
            <p className="dim">{!hasKey
              ? tr("Сравнение строится по статистике FACEIT: эло, винрейт, K/D, ADR и карты. Нужен бесплатный ключ FACEIT Data API.")
              : tr("У {0} нет профиля FACEIT для CS2 — сравнить статистику не получится.", !sa ? nameOf(a) : nameOf(b))}</p>
          </div>
          {!hasKey && <button type="button" className="pf-btn is-go" onClick={onGoSettings}>{tr("в настройки")}</button>}
        </section>
      ) : (
        <div className="pf-grid">
          <section className="pf-card pvs-stats span-2">
            <header className="pf-card__head"><h2>{tr("Статистика")}</h2><span className="mono dim">FACEIT · CS2</span></header>
            <div className="pvs-rows">
              {rows.map((r, i) => {
                const max = Math.max(r.a ?? 0, r.b ?? 0) || 1;
                return (
                  <div key={r.label} className="pvs-row" style={{ "--i": i }}>
                    <b className={`pvs-val is-a ${r.win < 0 ? "is-win" : r.win > 0 ? "is-lose" : ""}`}>{fmt(r.a, r.digits, r.suffix)}</b>
                    <span className="pvs-track is-a"><i style={{ width: `${((r.a ?? 0) / max) * 100}%` }} className={r.win < 0 ? "is-win" : ""} /></span>
                    <span className="pvs-label mono">{r.label}</span>
                    <span className="pvs-track is-b"><i style={{ width: `${((r.b ?? 0) / max) * 100}%` }} className={r.win > 0 ? "is-win" : ""} /></span>
                    <b className={`pvs-val is-b ${r.win > 0 ? "is-win" : r.win < 0 ? "is-lose" : ""}`}>{fmt(r.b, r.digits, r.suffix)}</b>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="pf-card pvs-maps span-2">
            <header className="pf-card__head"><h2>{tr("Карты")}</h2><span className="mono dim">{tr("винрейт и K/D на картах, сыгранных обоими")}</span></header>
            {maps.length ? (
              <div className="pvs-maplist">
                {maps.map((m, i) => (
                  <div key={m.id} className="pvs-map" style={{ "--tint": mapTint(m.id), "--i": i }}>
                    <MapSide m={m.a} win={m.win < 0} side="a" />
                    <span className="pvs-map__name">{mapName(m.id)}</span>
                    <MapSide m={m.b} win={m.win > 0} side="b" />
                  </div>
                ))}
              </div>
            ) : <p className="pf-empty">{tr("Общих карт пока нет")}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

const nameOf = (d) => d?.fc?.player?.nickname || d?.steam?.name || "?";

function Side({ d, s, side, lead }) {
  const avatar = d.steam?.avatar || d.fc?.player?.avatar;
  const c = s?.level ? LVL_COLOR(s.level) : "#2ee6c0";
  return (
    <div className={`pvs-side is-${side} ${lead ? "is-lead" : ""}`} style={{ "--c": c }}>
      <span className="pvs-ava">{avatar ? <img src={avatar} alt="" /> : <i />}{s?.level ? <em>{s.level}</em> : null}</span>
      <div className="pvs-who">
        <b>{nameOf(d)}</b>
        <span className="mono">{s?.elo != null ? `${s.elo} ELO` : tr("нет FACEIT")}{d.own ? ` · ${tr("это ты")}` : ""}</span>
      </div>
    </div>
  );
}

function MapSide({ m, win, side }) {
  return (
    <div className={`pvs-mapside is-${side} ${win ? "is-win" : ""}`}>
      <b className="mono">{Math.round(m.wr)}%</b>
      <span className="mono dim">{tr("{0} матчей", m.n)}{m.kd != null ? ` · K/D ${m.kd.toFixed(2)}` : ""}</span>
      <span className="pf-bar"><i style={{ width: `${Math.min(100, m.wr)}%` }} /></span>
    </div>
  );
}
