// Мастер первого запуска: язык → игра → движок записи → папка → клавиша → тестовые 5 секунд.
// Каждый шаг сам проверяет, что всё на месте (src-tauri/src/setup.rs), и подсказывает, что делать,
// если нет. Открывается сам при первом запуске; повторно — из «Настроек».
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tr, setLang } from "../../i18n";
import { markSetupDone } from "./setup";
import "./setup.css";

const STEPS = [
  { id: "hello", name: "Привет", icon: "✦" },
  { id: "game", name: "Игра", icon: "◎" },
  { id: "engine", name: "Запись", icon: "●" },
  { id: "folder", name: "Папка", icon: "▣" },
  { id: "key", name: "Клавиша", icon: "⌨" },
  { id: "test", name: "Тест", icon: "▶" },
];

// h264_nvenc → NVIDIA NVENC и т.п.
const encName = (e) => (/nvenc/.test(e) ? "NVIDIA NVENC" : /amf/.test(e) ? "AMD AMF" : /qsv/.test(e) ? "Intel Quick Sync" : e);
const fileOf = (p) => (p || "").split(/[\\/]/).pop();
const short = (p, n = 54) => (!p || p.length <= n ? p : `${p.slice(0, 18)}…${p.slice(-(n - 19))}`);

// Строка статуса: крутилка → галочка (рисуется) / крестик / предупреждение
function Status({ state, title, sub, children }) {
  return (
    <div className={`sw-status is-${state}`}>
      <span className="sw-status__ico" aria-hidden="true">
        {state === "wait" ? <i className="sw-spin" /> : (
          <svg viewBox="0 0 24 24">
            {state === "ok" && <path d="M5 12.5l4.5 4.5L19 7.5" />}
            {state === "bad" && <path d="M7 7l10 10M17 7L7 17" />}
            {state === "warn" && <path d="M12 6v8M12 17.5v.5" />}
          </svg>
        )}
      </span>
      <span className="sw-status__text">
        <b>{title}</b>
        {sub && <span className="mono dim">{sub}</span>}
      </span>
      {children && <span className="sw-status__act">{children}</span>}
    </div>
  );
}

function Bar({ load }) {
  const pct = load?.[1] ? Math.min(100, (load[0] / load[1]) * 100) : null;
  return (
    <span className={`sw-bar ${pct == null ? "is-indet" : ""}`}><i style={pct == null ? undefined : { width: `${pct}%` }} /></span>
  );
}

export function SetupWizard({
  lang, paths, setPaths, defaultOut, hlae, ff, startKey, setStartKey, keys, archive,
  onTest, onStop, rendering, progress, stage, onClose, onOpenHighlights,
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1); // направление анимации шага
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(true);
  const [test, setTest] = useState({ state: "idle" }); // idle | run | ok | err
  const [demoPick, setDemoPick] = useState(null);
  const bodyRef = useRef(null);

  const rescan = async (p = paths) => {
    setScanning(true);
    try {
      const [s] = await Promise.all([
        invoke("setup_scan", { cs2: p.cs2 || "", hlae: p.hlae || "", out: p.out || "" }),
        new Promise((r) => setTimeout(r, 650)), // крутилка видна, а не мигает
      ]);
      setScan(s);
      if (s.cs2 && s.cs2 !== p.cs2) setPaths((x) => ({ ...x, cs2: s.cs2 }));
    } catch { setScan(null); }
    setScanning(false);
  };
  // при открытии и когда путь к папке или HLAE поменялся (скачался, выбрали руками) — перепроверяем;
  // таймер — заодно не дёргаем проверку на каждую букву, если путь печатают
  useEffect(() => {
    const t = setTimeout(() => rescan(), 120);
    return () => clearTimeout(t);
  }, [paths.out, paths.hlae, hlae.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc — закрыть, Enter — дальше (если можно)
  const go = (n) => { setDir(n > step ? 1 : -1); setStep(n); bodyRef.current?.scrollTo?.(0, 0); };
  const ready = {
    hello: true,
    game: !!scan?.cs2,
    engine: hlae.ready && !!ff.ready,
    folder: !!scan?.out_ok,
    key: true,
    test: true,
  };
  const cur = STEPS[step].id;
  const canNext = ready[cur] && !scanning;
  const last = step === STEPS.length - 1;
  const finish = () => { markSetupDone(); onClose(); };
  useEffect(() => {
    const on = (e) => {
      if (e.key === "Escape" && !rendering) finish();
      if (e.key === "Enter" && canNext && !last && e.target.tagName !== "BUTTON") go(step + 1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const pickCs2 = async () => {
    const f = await openDialog({ filters: [{ name: "cs2.exe", extensions: ["exe"] }], defaultPath: paths.cs2 || undefined });
    if (typeof f === "string") { const p = { ...paths, cs2: f }; setPaths(p); rescan(p); }
  };
  const pickHlae = async () => {
    const f = await openDialog({ filters: [{ name: "HLAE.exe", extensions: ["exe"] }], defaultPath: paths.hlae || undefined });
    if (typeof f === "string") setPaths((p) => ({ ...p, hlae: f }));
  };
  const pickOut = async () => {
    const d = await openDialog({ directory: true, defaultPath: paths.out || defaultOut || undefined });
    if (typeof d === "string") setPaths((p) => ({ ...p, out: d }));
  };
  const pickDemo = async () => {
    const f = await openDialog({ filters: [{ name: "CS2 demo", extensions: ["dem"] }] });
    if (typeof f === "string") setDemoPick(f);
  };
  const runTest = async () => {
    const path = demoPick || archive[0]?.path;
    if (!path) return;
    setTest({ state: "run" });
    try { await onTest(path); setTest({ state: "ok" }); }
    catch (e) { setTest({ state: "err", msg: String(e?.message || e) }); }
  };

  const keyLabel = keys.find(([k]) => k === startKey)?.[1] ?? "F10";
  const demos = archive.slice(0, 4);
  const chosen = demoPick || demos[0]?.path || null;
  const freeLow = scan?.free_gb != null && scan.free_gb < 10;

  const body = {
    hello: (
      <>
        <span className="sw-kicker mono">{tr("первый запуск")}</span>
        <h1 className="sw-h">{tr("Настроим clipforge")}<br /><em>{tr("за минуту")}</em></h1>
        <p className="sw-lead">{tr("Проверю, что игра и движок записи на месте, выберем папку и клавишу, а в конце запишем тестовые 5 секунд из демки. Почти всё найдется само.")}</p>
        <div className="sw-tiles">
          {[["◎", "Находит CS2", "во всех библиотеках Steam"], ["●", "Ставит HLAE", "сам скачает, если его нет"], ["▶", "Тест 5 секунд", "чтобы точно все работало"]].map(([i, t, s], n) => (
            <div className="sw-tile" key={t} style={{ "--d": `${n * 70}ms` }}>
              <span className="sw-tile__ico">{i}</span><b>{tr(t)}</b><span className="mono dim">{tr(s)}</span>
            </div>
          ))}
        </div>
        <div className="sw-lang" role="radiogroup" aria-label={tr("Язык")}>
          <span className="mono dim">{tr("язык")}</span>
          {[["ru", "Русский"], ["en", "English"]].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={lang === k} className={lang === k ? "is-on" : ""} onClick={() => setLang(k)}>{l}</button>
          ))}
        </div>
      </>
    ),
    game: (
      <>
        <span className="sw-kicker mono">{tr("шаг {0} из {1}", 1, STEPS.length - 1)}</span>
        <h1 className="sw-h">{tr("Ищу CS2")}</h1>
        <p className="sw-lead">{tr("clipforge проигрывает демку в самой игре и пишет кадры прямо из движка, поэтому нужна установленная CS2 из Steam.")}</p>
        {scanning || !scan ? (
          <Status state="wait" title={tr("Смотрю библиотеки Steam...")} />
        ) : scan.cs2 ? (
          <Status state="ok" title={tr("CS2 найдена")} sub={short(scan.cs2)}>
            <button type="button" className="sw-link" onClick={pickCs2}>{tr("другой путь")}</button>
          </Status>
        ) : (
          <>
            <Status state="bad" title={tr("CS2 не нашлась")}
              sub={scan.steam ? tr("Steam есть, но игры в его библиотеках нет") : tr("Steam тоже не найден")} />
            <div className="sw-help">
              <b>{tr("Что сделать")}</b>
              <ol>
                <li>{tr("Установи CS2 в Steam (она бесплатная) и нажми «Проверить снова»")}</li>
                <li>{tr("Или укажи cs2.exe сам: папка игры → game → bin → win64 → cs2.exe")}</li>
              </ol>
              <div className="sw-row">
                <button type="button" className="sw-btn is-go" onClick={pickCs2}>{tr("Указать cs2.exe")}</button>
                <button type="button" className="sw-btn" onClick={() => rescan()}>{tr("Проверить снова")}</button>
              </div>
            </div>
          </>
        )}
      </>
    ),
    engine: (
      <>
        <span className="sw-kicker mono">{tr("шаг {0} из {1}", 2, STEPS.length - 1)}</span>
        <h1 className="sw-h">{tr("Движок записи")}</h1>
        <p className="sw-lead">{tr("HLAE управляет игрой и камерой и пишет кадры, ffmpeg собирает из них видео. Ставить руками ничего не надо: если чего-то нет, скачаю сам.")}</p>
        {hlae.load ? (
          <Status state="wait" title={tr("Скачиваю HLAE")} sub={tr("{0} / {1} МБ", Math.round(hlae.load[0]), hlae.load[1] ? Math.round(hlae.load[1]) : "?")}><Bar load={hlae.load} /></Status>
        ) : hlae.err ? (
          <Status state="bad" title={tr("HLAE не скачался")} sub={hlae.err}>
            <button type="button" className="sw-btn" onClick={hlae.retry}>{tr("Повторить")}</button>
            <button type="button" className="sw-link" onClick={pickHlae}>{tr("указать HLAE.exe")}</button>
          </Status>
        ) : hlae.ready ? (
          <Status state="ok" title="HLAE" sub={short(paths.hlae)}><button type="button" className="sw-link" onClick={pickHlae}>{tr("другой путь")}</button></Status>
        ) : (
          <Status state="wait" title={tr("Ищу HLAE...")} />
        )}
        {ff.load ? (
          <Status state="wait" title={tr("Скачиваю ffmpeg")} sub={tr("{0} / {1} МБ", Math.round(ff.load[0]), ff.load[1] ? Math.round(ff.load[1]) : "?")}><Bar load={ff.load} /></Status>
        ) : ff.err ? (
          <Status state="bad" title={tr("ffmpeg не скачался")} sub={ff.err}><button type="button" className="sw-btn" onClick={ff.retry}>{tr("Повторить")}</button></Status>
        ) : ff.ready ? (
          <Status state="ok" title="ffmpeg" sub={ff.gpu ? tr("кодирует на видеокарте: {0}", encName(ff.gpu)) : ff.gpu === null ? tr("кодирует на процессоре") : tr("готов")} />
        ) : (
          <Status state="wait" title={hlae.ready ? tr("Ищу ffmpeg...") : tr("ffmpeg — после HLAE")} />
        )}
        <p className="sw-note mono dim">{tr("CS2 запускается через HLAE с -insecure: VAC в этой копии игры выключен, на сервера с VAC она не пустит. Это нормально — после записи clipforge закроет игру сам.")}</p>
      </>
    ),
    folder: (
      <>
        <span className="sw-kicker mono">{tr("шаг {0} из {1}", 3, STEPS.length - 1)}</span>
        <h1 className="sw-h">{tr("Куда класть клипы")}</h1>
        <p className="sw-lead">{tr("Сюда попадут готовые хайлайты. Во время записи рядом временно лежат сырые кадры, так что нужен диск со свободным местом — лучше SSD.")}</p>
        <button type="button" className="sw-folder" onClick={pickOut}>
          <span className="sw-folder__ico" aria-hidden="true" />
          <span className="sw-folder__text">
            <b>{fileOf(paths.out) || tr("папка не выбрана")}</b>
            <span className="mono dim">{short(paths.out, 64)}</span>
          </span>
          <span className="sw-link">{tr("Изменить")}</span>
        </button>
        {scanning || !scan ? <Status state="wait" title={tr("Проверяю папку...")} /> : scan.out_ok ? (
          <Status state={freeLow ? "warn" : "ok"} title={freeLow ? tr("Места маловато") : tr("Папка в порядке")}
            sub={scan.free_gb != null ? tr("свободно {0} ГБ{1}", scan.free_gb, freeLow ? tr(" · для длинных роликов нужно 10+ ГБ") : "") : undefined} />
        ) : (
          <Status state="bad" title={tr("В эту папку нельзя писать")} sub={tr("выбери другую, например в «Видео» или на другом диске")} />
        )}
        {paths.out !== defaultOut && defaultOut && (
          <button type="button" className="sw-link sw-link--line" onClick={() => setPaths((p) => ({ ...p, out: defaultOut }))}>{tr("вернуть папку по умолчанию")}</button>
        )}
      </>
    ),
    key: (
      <>
        <span className="sw-kicker mono">{tr("шаг {0} из {1}", 4, STEPS.length - 1)}</span>
        <h1 className="sw-h">{tr("Клавиша записи")}</h1>
        <p className="sw-lead">{tr("CS2 откроет демку и будет ждать. Запись начнется, только когда ты нажмешь эту клавишу — можно спокойно досмотреть. Поверх игры будет подсказка, в видео она не попадет.")}</p>
        <div className="sw-keycap-wrap">
          <span className="sw-keycap" key={startKey}><b>{keyLabel}</b></span>
          <span className="mono dim">{tr("нажми в игре — и можно свернуть ее")}</span>
        </div>
        <div className="sw-keys" role="radiogroup" aria-label={tr("Клавиша запуска записи")}>
          {keys.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={startKey === k} className={startKey === k ? "is-on" : ""} onClick={() => setStartKey(k)}>{l}</button>
          ))}
        </div>
        <p className="sw-note mono dim">{tr("выбери клавишу, которая в CS2 ни на что не назначена - иначе вместе с записью сработает и ее действие")}</p>
      </>
    ),
    test: (
      <>
        <span className="sw-kicker mono">{tr("шаг {0} из {1}", 5, STEPS.length - 1)}</span>
        <h1 className="sw-h">{test.state === "ok" ? <>{tr("Все работает")} <em className="sw-check">✓
          <span className="sw-burst" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ "--a": `${i * 22.5}deg`, "--d": `${(i % 4) * 45}ms` }} />)}</span>
        </em></> : tr("Тестовые 5 секунд")}</h1>
        {test.state === "ok" ? (
          <div className="sw-win">
            <div className="sw-recap">
              {[[tr("Игра"), fileOf(paths.cs2)], [tr("Запись"), "HLAE + ffmpeg"], [tr("Папка"), fileOf(paths.out)], [tr("Клавиша"), keyLabel]].map(([k, v], n) => (
                <div key={k} style={{ "--d": `${n * 60}ms` }}><span className="mono dim">{k}</span><b>{v}</b></div>
              ))}
            </div>
            <p className="sw-lead">{tr("Клип записан и лежит в «Хайлайтах». Дальше — кидай любую демку на вкладку «Демо», clipforge сам найдет лучшие моменты.")}</p>
            <div className="sw-row">
              <button type="button" className="sw-btn is-go" onClick={() => { finish(); onOpenHighlights(); }}>{tr("Посмотреть клип")}</button>
            </div>
          </div>
        ) : test.state === "run" ? (
          <div className="sw-rec">
            <div className="sw-rec__ring" style={{ "--p": progress || 0 }}>
              <span className="sw-rec__dot" /><b className="mono">{Math.round(progress || 0)}%</b>
            </div>
            <div className="sw-rec__text">
              <b>{stage || (progress > 0 ? tr("Пишу и собираю клип...") : tr("Открываю CS2 с демкой..."))}</b>
              {!progress && <span className="sw-rec__hint">{tr("Когда демка загрузится, нажми")} <kbd>{keyLabel}</kbd> {tr("в игре")}</span>}
              <span className="mono dim">{tr("первый запуск CS2 через HLAE может занять минуту-две")}</span>
              <button type="button" className="sw-link" onClick={onStop}>{tr("остановить")}</button>
            </div>
          </div>
        ) : (
          <>
            <p className="sw-lead">{tr("Возьму лучший килл из демки и запишу ровно 5 секунд без эффектов. Так сразу видно, что игра, HLAE и сборка видео дружат. Можно пропустить.")}</p>
            {test.state === "err" && <Status state="bad" title={tr("Тест не прошел")} sub={test.msg} />}
            <div className="sw-demos">
              {demos.map((d) => (
                <button key={d.path} type="button" className={`sw-demo ${chosen === d.path ? "is-on" : ""}`} onClick={() => setDemoPick(d.path)}>
                  <b>{d.title || d.info?.map || fileOf(d.path)}</b>
                  <span className="mono dim">{d.info?.map ? fileOf(d.path) : tr("{0} моментов", d.clips ?? "?")}</span>
                </button>
              ))}
              {demoPick && !demos.some((d) => d.path === demoPick) && (
                <button type="button" className="sw-demo is-on"><b>{fileOf(demoPick)}</b><span className="mono dim">{tr("выбрана")}</span></button>
              )}
              <button type="button" className="sw-demo sw-demo--add" onClick={pickDemo}><b>+ {tr("Выбрать .dem")}</b><span className="mono dim">{tr("с диска")}</span></button>
            </div>
            {!chosen && <p className="sw-note mono dim">{tr("Нет демки под рукой? Скачай свой последний матч на «Главной» (Premier, MM или FACEIT) — или пропусти тест.")}</p>}
            <div className="sw-row">
              <button type="button" className="sw-btn is-go is-big" disabled={!chosen || rendering} onClick={runTest}>
                <span className="sw-recdot" />{test.state === "err" ? tr("Попробовать снова") : tr("Записать 5 секунд")}
              </button>
            </div>
          </>
        )}
      </>
    ),
  }[cur];

  return (
    <div className="sw-back" role="dialog" aria-modal="true" aria-label={tr("Мастер настройки")}>
      <div className="sw">
        <aside className="sw-rail">
          <div className="sw-brand"><i className="brand__mark" /><span>clipforge</span></div>
          <ol className="sw-steps">
            {STEPS.map((s, i) => {
              return (
                <li key={s.id} className={`${i === step ? "is-cur" : ""} ${i < step ? "is-done" : ""}`}>
                  <button type="button" disabled={i > step && !STEPS.slice(0, i).every((x) => ready[x.id])} onClick={() => !rendering && go(i)}>
                    <span className="sw-steps__n">{i < step || (s.id === "test" && test.state === "ok") ? "✓" : s.icon}</span>
                    <span>{tr(s.name)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="sw-rail__meter"><i style={{ height: `${(step / (STEPS.length - 1)) * 100}%` }} /></div>
          <span className="mono dim sw-rail__foot">{tr("все можно поменять потом в «Настройках»")}</span>
        </aside>

        <section className="sw-main">
          <button type="button" className="sw-x" aria-label={tr("Закрыть")} disabled={rendering} onClick={finish}>×</button>
          <div className="sw-body" ref={bodyRef}>
            <div className={`sw-page ${dir > 0 ? "is-fwd" : "is-back"}`} key={cur}>{body}</div>
          </div>
          <footer className="sw-foot">
            {step > 0 && !rendering && <button type="button" className="sw-btn is-ghost" onClick={() => go(step - 1)}>← {tr("Назад")}</button>}
            {step === 0 && <button type="button" className="sw-btn is-ghost" onClick={finish}>{tr("Пропустить, настрою сам")}</button>}
            <span className="sw-foot__gap" />
            {last ? (
              test.state === "ok" ? (
                <button type="button" className="sw-btn is-go" onClick={finish}>{tr("Начать пользоваться")} →</button>
              ) : test.state !== "run" && (
                <button type="button" className="sw-btn" onClick={finish}>{tr("Пропустить тест и начать")}</button>
              )
            ) : (
              <button type="button" className="sw-btn is-go" disabled={!canNext} onClick={() => go(step + 1)}>
                {step === 0 ? tr("Поехали") : tr("Дальше")} →
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
