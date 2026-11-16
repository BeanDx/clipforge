import { useState } from "react";
import { tagLabel } from "../demo/moments";
import { mapName, mapTint } from "../match/dossier";
import { tr } from "../../i18n";
import "./reel.css";

const group = (list) => {
  const demos = [];
  for (const e of list) {
    let d = demos.find((x) => x.path === e.demo);
    if (!d) demos.push((d = { path: e.demo, title: e.title, map: e.map, items: [] }));
    d.items.push(e);
  }
  return demos;
};

const Moments = ({ items }) => (
  <span className="xdemo__moments">
    {items.map((e) => {
      const c = e.clip;
      const lead = c.clutch ? `1v${c.clutch}` : (c.tags?.[0] ?? `${c.kills}K`);
      return (
        <span key={e.key} className={`tag tag--${c.kind || "multi"}`} title={`${e.player} · R${c.round}`}>
          R{String(c.round).padStart(2, "0")} {tagLabel(lead)}
        </span>
      );
    })}
  </span>
);

// «Ролик»: всё, что попадет в рендер, по демкам. Открытая демка — первой строкой, ниже — моменты,
// выбранные в других демках. «+ моменты из другой демки» оставляет выбор открытой в ролике
// и открывает следующую (из архива или файлом).
export function ReelPanel({ current, mine, others, archive, busy, onAdd, onPickFile, onOpen, onRemove, onClear }) {
  const [adding, setAdding] = useState(false);
  const demos = group(others);
  const total = mine.length + others.length;
  const nDemos = demos.length + (mine.length ? 1 : 0);
  const recent = archive
    .filter((d) => d.path !== current?.path)
    .sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0))
    .slice(0, 8);
  const add = (path) => { setAdding(false); onAdd(path); };

  return (
    <section className="xdemo span-2">
      <div className="xdemo__head">
        <b>{tr("Ролик")}</b>
        <span className="mono dim">
          {total ? tr("{0} клип. из {1} демок - все уйдет в один рендер", total, nDemos) : tr("пока пусто - кликни по моментам выше")}
        </span>
        <span className="chips__spacer" />
        {others.length > 0 && (
          <button type="button" className="chip chip--del" disabled={busy} onClick={onClear}>{tr("Убрать другие демки")}</button>
        )}
      </div>

      <ul className="xdemo__list">
        {current && (
          <li className="is-current" style={{ "--map": mapTint(current.map) }}>
            <span className="xdemo__name">
              {current.map && <b>{mapName(current.map)}</b>}
              <span className="mono dim" title={current.path}>{current.title}</span>
            </span>
            {mine.length ? <Moments items={mine} /> : <span className="xdemo__moments mono dim">{tr("ничего не выбрано")}</span>}
            <span className="xdemo__badge mono">{tr("открыта")}</span>
          </li>
        )}
        {demos.map((d) => (
          <li key={d.path} style={{ "--map": mapTint(d.map) }}>
            <span className="xdemo__name">
              {d.map && <b>{mapName(d.map)}</b>}
              <span className="mono dim" title={d.path}>{d.title}</span>
            </span>
            <Moments items={d.items} />
            <button type="button" className="chip" disabled={busy} onClick={() => onOpen(d.path)}
              title={tr("Открыть демку, чтобы поменять выбор")}>{tr("Изменить")}</button>
            <button type="button" className="chip chip--del xdemo__x" disabled={busy} onClick={() => onRemove(d.path)}
              title={tr("Не рендерить моменты этой демки")} aria-label={tr("Не рендерить моменты этой демки")}>✕</button>
          </li>
        ))}
      </ul>

      <div className="xdemo__add">
        <button type="button" className={`chip chip--add ${adding ? "is-on" : ""}`} disabled={busy} onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}>
          {tr("+ моменты из другой демки")}
        </button>
        <span className="mono dim">{tr("выбранное здесь останется в ролике, в новой демке выбери еще")}</span>
      </div>
      {adding && (
        <ul className="xdemo__pick">
          {recent.map((d) => (
            <li key={d.path}>
              <button type="button" disabled={busy} onClick={() => add(d.path)} style={{ "--map": mapTint(d.info?.map) }}>
                {d.info?.map && <b>{mapName(d.info.map)}</b>}
                <span className="mono">{d.title || d.file}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="xdemo__file" disabled={busy} onClick={() => { setAdding(false); onPickFile(); }}>
              <span className="mono">{tr("выбрать .dem файл...")}</span>
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}
