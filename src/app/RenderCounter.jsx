// Низ «Настроек»: сколько клипов и эдитов отрендерено во всех clipforge (src/features/profile/counter.js).
// Число — одометр: каждая цифра прокручивается к своему значению, старшие разряды позже младших.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { fetchGlobalRenders, globalRendersCached } from "../features/profile/counter";
import { renderCount, onAchievements } from "../features/profile/badges";
import { tr } from "../i18n";

function Odometer({ value }) {
  // сначала все нули той же длины — потом через кадр настоящие цифры, и они прокатываются
  const target = String(Math.max(0, Math.floor(value)));
  const [shown, setShown] = useState(() => "0".repeat(target.length));
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(target)));
    return () => cancelAnimationFrame(id);
  }, [target]);
  const digits = shown.padStart(target.length, "0").slice(-target.length).split("");
  return (
    <span className="odo" aria-label={target}>
      {digits.map((d, i) => {
        const fromRight = digits.length - 1 - i;
        return (
          <span key={fromRight} className={`odo__slot ${fromRight > 0 && fromRight % 3 === 0 ? "is-group" : ""}`} aria-hidden="true">
            <span className="odo__strip" style={{ transform: `translateY(-${Number(d) * 10}%)`, transitionDelay: `${i * 90}ms` }}>
              {"0123456789".split("").map((n) => <span key={n}>{n}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function RenderCounter({ Frame }) {
  const [global, setGlobal] = useState(globalRendersCached);
  const [online, setOnline] = useState(null); // null — спрашиваем, false — сервер не ответил
  const [mine, setMine] = useState(renderCount);

  useEffect(() => {
    let alive = true;
    const refresh = () => fetchGlobalRenders().then((v) => {
      if (!alive) return;
      setOnline(v != null);
      if (v != null) setGlobal(v);
    });
    refresh();
    const offA = onAchievements(() => setMine(renderCount()));
    // рендер закончился, пока открыты настройки: /hit уходит из HighlightRenderer, чуть ждём и перечитываем
    let t;
    const offR = listen("render-done", () => { clearTimeout(t); t = setTimeout(refresh, 1500); });
    return () => { alive = false; clearTimeout(t); offA(); offR.then((f) => f()); };
  }, []);

  const value = Math.max(global, mine);
  return (
    <Frame title={tr("Счётчик")} meta={online === false ? tr("офлайн") : "abacus"} className="span-2"
      help={tr("Ради прикола: после каждого готового рендера clipforge отправляет один пустой запрос на abacus.jasoncameron.dev — без имени файла и без данных из демки.")}>
      <div className="rcount">
        <span className="rcount__label">{tr("отрендерено клипов и эдитов")}</span>
        <Odometer value={value} />
        <span className="mono dim">{tr("у всех пользователей · твоих {0}", mine)}</span>
      </div>
    </Frame>
  );
}
