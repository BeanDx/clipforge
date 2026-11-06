// Блок «Достижения» своего профиля: бейджи по ступеням (бронза / серебро / золото) и прогресс
// до следующей. Правила и подсчёт — в badges.js.
import { useEffect, useMemo, useState } from "react";
import { tr } from "../../i18n";
import { evaluate, onAchievements, TIER_NAMES, TIER_COLOR } from "./badges";

export function Achievements({ history }) {
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => onAchievements(() => setTick((t) => t + 1)), []);
  const list = useMemo(() => evaluate(history), [history, tick]); // eslint-disable-line react-hooks/exhaustive-deps -- tick: подвиги из демок обновились
  const open = list.filter((a) => a.tier).length;
  // открытые — сначала лучшие; закрытые — ближе всего к открытию
  const sorted = [...list].sort((a, b) => (b.tier ? 1 : 0) - (a.tier ? 1 : 0) || b.rank - a.rank || b.progress - a.progress);
  const shown = all ? sorted : sorted.slice(0, 12);

  return (
    <section className="pf-card pf-ach span-2">
      <header className="pf-card__head">
        <h2>{tr("Достижения")}</h2>
        <span className="mono dim">{tr("открыто {0} из {1}", open, list.length)}</span>
      </header>
      <div className="pf-ach__grid">
        {shown.map((a, i) => <Badge key={a.id} a={a} i={i} />)}
      </div>
      {list.length > 12 && (
        <button type="button" className="pf-btn pf-ach__more" onClick={() => setAll((v) => !v)}>
          {all ? tr("свернуть") : tr("показать все · ещё {0}", list.length - 12)}
        </button>
      )}
      <p className="pf-ach__note dim">{tr("Считается по матчам, сыгранным с открытым clipforge, и по демкам, которые ты в нём открывал. Старые демки засчитаются, когда откроешь их.")}</p>
    </section>
  );
}

function Badge({ a, i }) {
  const single = a.steps.length === 1;
  const tierName = !a.tier ? tr("закрыто") : single ? tr("редкое") : tr(TIER_NAMES[a.tier - 1]);
  const desc = tr(a.desc, a.next);
  return (
    <div className={`pf-ach__item ${a.tier ? "is-open" : "is-locked"} ${a.max ? "is-max" : ""}`}
      style={{ "--c": TIER_COLOR[a.level], "--i": i }} title={desc}>
      <div className="pf-ach__icon" aria-hidden="true">
        <span>{a.icon}</span>
        {!single && (
          <i className="pf-ach__pips">{a.steps.map((_, k) => <b key={k} className={k < a.tier ? "on" : ""} />)}</i>
        )}
      </div>
      <div className="pf-ach__body">
        <div className="pf-ach__top">
          <b>{tr(a.name)}</b>
          <span className="mono pf-ach__tier">{tierName}</span>
        </div>
        <span className="pf-ach__desc dim">{desc}</span>
        {!a.max && (
          <div className="pf-ach__prog">
            <span className="pf-bar"><i style={{ width: `${a.progress * 100}%` }} /></span>
            <span className="mono dim">{Math.min(a.value, a.next)} / {a.next}</span>
          </div>
        )}
      </div>
    </div>
  );
}
