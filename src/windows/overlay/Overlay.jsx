// Окно-подсказка поверх CS2 (окно "overlay", его создаёт src-tauri/src/overlay.rs).
// Пока запись не началась — какую клавишу нажать, потом — компактная плашка с ходом записи.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./overlay.css";

import { tr, useLang } from "../../i18n";
export default function Overlay() {
  useLang();
  const [s, setS] = useState(null);
  useEffect(() => {
    document.documentElement.classList.add("ov-root");
    const un = listen("overlay-state", (e) => setS(e.payload));
    return () => { un.then((f) => f()); };
  }, []);
  if (!s) return null;

  if (s.phase === "wait") {
    return (
      <div className="ov ov--wait" key="wait">
        <span className="ov-key">{s.key}</span>
        <div className="ov-text">
          <b>{tr("Дождись загрузки демки и нажми")} <em>{s.key}</em></b>
          <span>{tr("начнется запись · клипов:")} {s.total} {tr("· эта подсказка в видео не попадет")}</span>
        </div>
      </div>
    );
  }
  if (s.phase === "done") {
    return (
      <div className="ov ov--done" key="done">
        <i className="ov-check" />
        <div className="ov-text">
          <b>{tr("Запись готова")}</b>
          <span>{tr("дальше программа сама соберет видео, прогресс - в окне clipforge")}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ov ov--rec" key="rec">
      <i className="ov-dot" />
      <b>REC</b>
      <span>{tr("клип")} {s.clip} {tr("из")} {s.total}</span>
      <span className="ov-bar"><i style={{ width: `${Math.min(100, s.pct)}%` }} /></span>
      <span className="ov-pct">{Math.round(s.pct)}%</span>
      <span className="ov-hint">{tr("можно переключиться в другое окно, запись идет дальше")}</span>
    </div>
  );
}
