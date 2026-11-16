// Плашка рейтинга матча в стиле FACEIT: цифра, полоска и подсказка рядом.
// Рейтинг считает бэкенд (faceit.rs, приближение HLTV 2.0) — сам FACEIT его в Data API не отдаёт.
// Подсказка рисуется поверх окна (портал в .app): в таблицах и карточках её иначе обрезает overflow.
import { useState } from "react";
import { createPortal } from "react-dom";
import { tr } from "../../i18n";

const rtTier = (r) => (r >= 1.8 ? ["hi", "Сильное воздействие", "выше 1.8"] : r < 0.85 ? ["lo", "Слабое воздействие", "ниже 0.85"] : ["mid", "Обычное воздействие", "от 0.85 до 1.8"]);
const TIP_W = 280;

export function Rating({ s, big = false }) {
  const [t, name, range] = rtTier(s.rating);
  const [tip, setTip] = useState(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    // справа не влезает — показываем слева
    const flip = r.right + TIP_W + 16 > window.innerWidth;
    setTip({ x: flip ? r.left - 8 : r.right + 8, y: r.top + r.height / 2, flip, host: e.currentTarget.closest(".app") || document.body });
  };
  const hide = () => setTip(null);
  return (
    <span className={`hm-rt is-${t} ${big ? "is-big" : ""}`} tabIndex={0} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <b className="mono">{s.rating.toFixed(2)}</b>
      <i style={{ "--fill": `${Math.min(100, (s.rating / 2.5) * 100)}%` }} />
      {tip && createPortal(
        <span className={`hm-rt__tip is-${t}`} role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(${tip.flip ? "-100%" : "0"}, -50%)` }}>
          <strong>{tr(name)}</strong>
          <small>{tr(range)}</small>
          <small className="mono">{s.kills}/{s.deaths}/{s.assists} · ADR {s.adr.toFixed(1)}{s.rounds ? ` · ${tr("{0} раундов", s.rounds)}` : ""}</small>
          <small className="hm-rt__src">{tr("рейтинг clipforge, по формуле HLTV 2.0")}</small>
        </span>,
        tip.host,
      )}
    </span>
  );
}
