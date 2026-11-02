// «До / после»: шторка поверх двух кадров одного момента — слева сырая запись из демки,
// справа готовый клип со всеми эффектами. Кадры достаёт ffmpeg (grab_frame) из кэша последнего рендера.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { tr } from "../../i18n";
// секунда готового клипа -> секунда сырой записи (обратно к отрезкам slow-mo из render.rs)
function toIn(segs, t) {
  let acc = 0;
  for (const [a, b, s] of segs) {
    if (b == null) return a + (t - acc);
    const len = (b - a) / s;
    if (t < acc + len) return a + (t - acc) * s;
    acc += len;
  }
  return t;
}

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function useFrame(hlae, path, t) {
  const [url, setUrl] = useState(null);
  const req = useRef(0);
  useEffect(() => {
    if (!path) return;
    const id = ++req.current;
    const timer = setTimeout(async () => {
      try {
        const buf = await invoke("grab_frame", { hlae, path, t, width: 1280 });
        if (id !== req.current) return;
        const next = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
        setUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return next; });
      } catch { /* кадр за концом видео — оставляем прошлый */ }
    }, 90);
    return () => clearTimeout(timer);
  }, [hlae, path, t]);
  useEffect(() => () => setUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }), []);
  return url;
}

export function CompareModal({ hlae, list, onClose }) {
  const [idx, setIdx] = useState(0);
  const [t, setT] = useState(0);
  const [cut, setCut] = useState(50);
  const [drag, setDrag] = useState(false);
  const boxRef = useRef(null);
  const item = list[idx];
  const tIn = item ? toIn(item.segs, t) : 0;
  const before = useFrame(hlae, item?.take, tIn);
  const after = useFrame(hlae, item?.out, t);

  useEffect(() => { setT(Math.min(1.5, item?.dur || 0)); }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setT((x) => Math.min(item.dur - 0.05, x + (e.shiftKey ? 1 : 0.1)));
      if (e.key === "ArrowLeft") setT((x) => Math.max(0, x - (e.shiftKey ? 1 : 0.1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  const moveCut = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    setCut(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };

  if (!item) return null;
  return (
    <div className="card-modal" onClick={onClose}>
      <div className="cmp" onClick={(e) => e.stopPropagation()}>
        <div className="cmp__clips">
          {list.map((c, i) => (
            <button key={c.out} type="button" className={`chip ${i === idx ? "is-on" : ""}`} onClick={() => setIdx(i)}>
              {c.name.replace(/\.mp4$/, "").replace(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d /, "")}
            </button>
          ))}
          <span className="chips__spacer" />
          <button type="button" className="chip" onClick={onClose}>{tr("Закрыть")}</button>
        </div>

        <div ref={boxRef} className={`cmp__view ${drag ? "is-drag" : ""}`}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); moveCut(e); }}
          onPointerMove={(e) => drag && moveCut(e)}
          onPointerUp={() => setDrag(false)}>
          {after ? <img src={after} alt={tr("После")} draggable={false} /> : <span className="cmp__wait mono dim">{tr("достаю кадр...")}</span>}
          {before && <img src={before} alt={tr("До")} draggable={false} className="cmp__before" style={{ clipPath: `inset(0 ${100 - cut}% 0 0)` }} />}
          <span className="cmp__tag cmp__tag--l mono">{tr("до · демка")}</span>
          <span className="cmp__tag cmp__tag--r mono">{tr("после · clipforge")}</span>
          <span className="cmp__handle" style={{ left: `${cut}%` }}><i /></span>
        </div>

        <div className="cmp__time field">
          <span className="mono accent">{fmt(t)}</span>
          <input type="range" min={0} max={Math.max(0.1, item.dur - 0.05)} step={1 / 30} value={t}
            style={{ "--pct": `${(t / Math.max(0.1, item.dur - 0.05)) * 100}%` }}
            onChange={(e) => setT(+e.target.value)} aria-label={tr("Момент клипа")} />
          <span className="mono dim">{fmt(item.dur)}</span>
        </div>
        <p className="mono dim cmp__hint">{tr("тяни шторку мышью · ← → по 0.1 с, с Shift по 1 с · в записи \"до\" тот же момент с учетом замедлений")}</p>
      </div>
    </div>
  );
}
