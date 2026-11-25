import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tr } from "../i18n";

// Системной шапки у окна нет (decorations: false в tauri.conf.json):
// кнопки окна живут в правом верхнем углу, тянуть окно — за пустое место сверху (data-tauri-drag-region).
// «Закрыть» идёт через обычный close: в lib.rs он, как и раньше, прячет окно в трей, если так настроено.
const currentWindow = () => { try { return getCurrentWindow(); } catch { return null; } };

export function WindowControls() {
  const [win] = useState(currentWindow);
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!win) return undefined;
    let off = null;
    const sync = () => win.isMaximized().then(setMax).catch(() => {});
    sync();
    win.onResized(sync).then((f) => { off = f; }).catch(() => {});
    return () => off?.();
  }, [win]);
  if (!win) return null;
  // после клика фокус с кнопки снимаем: иначе при возврате в окно на ней висит рамка фокуса
  return (
    <div className="wc" role="group" aria-label={tr("Окно")} onMouseUp={(e) => e.target.closest("button")?.blur()}>
      <button type="button" className="wc__btn" aria-label={tr("Свернуть")} title={tr("Свернуть")} onClick={() => win.minimize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
      </button>
      <button type="button" className="wc__btn" aria-label={max ? tr("Восстановить") : tr("Развернуть")} title={max ? tr("Восстановить") : tr("Развернуть")}
        onClick={() => win.toggleMaximize()}>
        {max ? (
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5V2h6.5v6.5H8.5M2 3.5h6.5V10H2z" /></svg>
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1" /></svg>
        )}
      </button>
      <button type="button" className="wc__btn wc__btn--close" aria-label={tr("Закрыть")} title={tr("Закрыть")} onClick={() => win.close()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
      </button>
    </div>
  );
}
