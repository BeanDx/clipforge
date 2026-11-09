import { tagLabel } from "../demo/moments";
import { mapName, mapTint } from "../match/dossier";
import { tr } from "../../i18n";
import "./reel.css";

// Моменты, выбранные в других демках: они рендерятся вместе с выбранными в открытой.
// По демке — строка: карта, название, какие моменты; «Открыть» — поменять выбор, × — не рендерить.
export function OtherDemos({ list, rendering, onOpen, onRemove, onClear }) {
  const demos = [];
  for (const e of list) {
    let d = demos.find((x) => x.path === e.demo);
    if (!d) demos.push((d = { path: e.demo, title: e.title, map: e.map, items: [] }));
    d.items.push(e);
  }
  return (
    <section className="xdemo span-2">
      <div className="xdemo__head">
        <b>{tr("Еще в рендере - из других демок")}</b>
        <span className="mono dim">{tr("{0} клип. · откроешь демку - выбор можно поменять", list.length)}</span>
        <span className="chips__spacer" />
        <button type="button" className="chip chip--del" disabled={rendering} onClick={onClear}>{tr("Убрать все")}</button>
      </div>
      <ul className="xdemo__list">
        {demos.map((d) => (
          <li key={d.path} style={{ "--map": mapTint(d.map) }}>
            <span className="xdemo__name">
              {d.map && <b>{mapName(d.map)}</b>}
              <span className="mono dim" title={d.path}>{d.title}</span>
            </span>
            <span className="xdemo__moments">
              {d.items.map((e) => {
                const c = e.clip;
                const lead = c.clutch ? `1v${c.clutch}` : (c.tags?.[0] ?? `${c.kills}K`);
                return (
                  <span key={e.key} className={`tag tag--${c.kind || "multi"}`} title={`${e.player} · R${c.round}`}>
                    R{String(c.round).padStart(2, "0")} {tagLabel(lead)}
                  </span>
                );
              })}
            </span>
            <button type="button" className="chip" disabled={rendering} onClick={() => onOpen(d.path)}>{tr("Открыть")}</button>
            <button type="button" className="chip chip--del xdemo__x" disabled={rendering} onClick={() => onRemove(d.path)}
              title={tr("Не рендерить моменты этой демки")} aria-label={tr("Не рендерить моменты этой демки")}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
