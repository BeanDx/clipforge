// Вкладка «FPS»: честный замер (timedemo по твоей демке, до и после), железо, которое режет FPS
// (частота и каналы памяти), графика CS2 с пресетами, фоновые программы и короткая сводка по Windows.
// Бэкенд: src-tauri/src/fps.rs, fps_video.rs, fps_procs.rs, fps_bench.rs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { tr, trError } from "../../i18n";
import { VIDEO, COST, PRESETS, KNOWN } from "./knowledge";
import "./fps.css";

const HISTORY = "clipforge.fps.bench";
const LAST_CHANGE = "clipforge.fps.change";
const PREV_PLAN = "clipforge.fps.prevPlan";
const BENCH_DEMO = "clipforge.fps.demo";

const loadJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : 0);
const r0 = (v) => (v == null ? "—" : Math.round(v));

// что меняли с прошлого замера — подпись к следующему
const noteChange = (text) => saveJson(LAST_CHANGE, text);

function Row({ state, title, value, hint, children }) {
  return (
    <div className={`fps-row is-${state}`}>
      <i className="fps-row__dot" aria-hidden="true" />
      <div className="fps-row__text">
        <span className="fps-row__title">{title}</span>
        {hint && <span className="mono dim fps-row__hint">{hint}</span>}
      </div>
      <span className="mono fps-row__value">{value}</span>
      <div className="fps-row__act">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- замер

const STAGES = {
  launch: "запускаю CS2…",
  load: "игра грузит карту…",
  run: "идёт замер, не трогай мышь…",
};

// кусок демки: с 3-й минуты, 2 минуты (короткую демку — пропорционально)
function rangeOf(d) {
  const sec = d?.info?.matchSec;
  const start = sec ? Math.min(180, Math.round(sec * 0.25)) : 180;
  const len = sec ? Math.max(30, Math.min(120, Math.round(sec * 0.5))) : 120;
  return { start: start * 64, end: (start + len) * 64 };
}

function Delta({ a, b }) {
  if (b == null || !b) return null;
  const d = pct(a, b);
  return <span className={`mono bench__delta ${d >= 0 ? "is-up" : "is-down"}`}>{d >= 0 ? "+" : ""}{d}%</span>;
}

const lowOf = (h) => h.low1 ?? 1000 / h.p95;

function Bench({ Frame, cs2, archive }) {
  const [history, setHistory] = useState(() => loadJson(HISTORY, []));
  const [demo, setDemo] = useState(() => localStorage.getItem(BENCH_DEMO) || archive[0]?.path || "");
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const off = listen("fps-bench", ({ payload }) => {
      if (payload.stage === "done") {
        setStage("");
        const path = localStorage.getItem(BENCH_DEMO);
        const d = archive.find((x) => x.path === path);
        const entry = { ...payload.result, demo: path, demoName: d?.title || d?.file || "", note: loadJson(LAST_CHANGE, "") };
        noteChange("");
        setHistory((h) => { const n = [entry, ...h].slice(0, 30); saveJson(HISTORY, n); return n; });
      } else if (payload.stage === "error") {
        setStage(""); setErr(payload.error || "");
      } else setStage(payload.stage);
    });
    return () => { off.then((f) => f()); };
  }, [archive]);

  const start = async () => {
    setErr("");
    const d = archive.find((x) => x.path === demo);
    if (!d) return setErr(tr("выбери демку из архива"));
    localStorage.setItem(BENCH_DEMO, demo);
    const { start: s, end: e } = rangeOf(d);
    try { await invoke("fps_bench_start", { cs2: cs2 || "", demo, start: s, end: e }); setStage("launch"); }
    catch (x) { setErr(String(x)); }
  };

  // сравнение — только замеры той же демки
  const same = history.filter((h) => h.demo === demo);
  const [last, prev] = same;
  const best = same.reduce((m, h) => (h.avg > (m?.avg ?? 0) ? h : m), null);

  return (
    <Frame title={tr("Замер FPS")} meta={same.length ? tr("{0} замеров", same.length) : tr("ещё не мерили")} className="span-2"
      help={tr("CS2 запускается с твоими настройками и прогоняет 2 минуты демки на максимальной скорости (команда timedemo), потом сама закрывается. Так видно, что реально дала каждая правка: сделай замер, поменяй что-нибудь ниже и замерь ещё раз на той же демке.")}>
      <div className="bench">
        <div className="bench__ctl">
          <select className="mono bench__demo" value={demo} disabled={!!stage} onChange={(e) => setDemo(e.target.value)}>
            {!archive.length && <option value="">{tr("в архиве нет демок")}</option>}
            {archive.map((d) => (
              <option key={d.path} value={d.path}>{(d.title || d.file) + (d.info?.map ? ` · ${d.info.map}` : "")}</option>
            ))}
          </select>
          {stage
            ? <button type="button" className="go go--ghost" onClick={() => invoke("fps_bench_cancel")}>{tr("Остановить")}</button>
            : <button type="button" className="go" disabled={!demo} onClick={start}>{tr("Замерить")}</button>}
        </div>
        {stage && <p className="mono accent pulse bench__stage">{tr(STAGES[stage] || stage)}</p>}
        {err && <p className="mono err">{trError(err)}</p>}

        {last ? (
          <div className="bench__now">
            <div className="bench__big">
              <span className="bench__num">{r0(last.avg)}</span>
              <span className="mono dim">{tr("средний FPS")}</span>
              {prev && <Delta a={last.avg} b={prev.avg} />}
            </div>
            <div className="bench__big">
              <span className="bench__num">{r0(lowOf(last))}</span>
              <span className="mono dim">{last.low1 != null ? tr("1% low") : tr("5% low")}</span>
              {prev && <Delta a={lowOf(last)} b={lowOf(prev)} />}
            </div>
            <div className="bench__big">
              <span className="bench__num">{last.p50.toFixed(1)}</span>
              <span className="mono dim">{tr("мс на кадр (медиана)")}</span>
            </div>
          </div>
        ) : (
          <p className="mono dim">{tr("Сделай первый замер: он займёт пару минут, игра откроется и закроется сама.")}</p>
        )}

        {same.length > 0 && (
          <ul className="bench__hist">
            {same.slice(0, 6).map((h) => (
              <li key={h.at} className={h === best && same.length > 1 ? "is-best" : ""}>
                <span className="mono dim">{new Date(h.at * 1000).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="bench__bar"><i style={{ width: `${(h.avg / (best?.avg || h.avg)) * 100}%` }} /></span>
                <span className="mono">{r0(h.avg)} FPS</span>
                <span className="mono dim">{h.low1 != null ? `1% ${r0(h.low1)}` : `5% ${r0(1000 / h.p95)}`}</span>
                <span className="mono dim bench__note">{h.note || ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- железо

function Hardware({ Frame, info }) {
  const ram = info.ram;
  const mods = ram.modules;
  const total = mods.reduce((s, m) => s + m.gb, 0);
  const configured = mods.length ? Math.min(...mods.map((m) => m.configured || m.speed)) : 0;
  const rated = Math.max(0, ...mods.map((m) => m.rated || 0));
  const jedecFloor = ram.kind === "DDR5" ? 4800 : 2666;
  const profile = ram.kind === "DDR5" ? "EXPO/XMP" : "XMP/DOCP";

  let freq;
  if (!mods.length) freq = { state: "info", value: "—", hint: tr("Windows не отдала данные о памяти") };
  else if (rated && configured < rated - 100) {
    freq = {
      state: "bad", value: tr("{0} из {1} МГц", configured, rated),
      hint: tr("планки умеют {0}, а работают на {1}: не включён {2} в BIOS. В CS2 это обычно 15–30% FPS, особенно 1% low", rated, configured, profile),
    };
  } else if (!rated && configured <= jedecFloor) {
    freq = {
      state: "warn", value: tr("{0} МГц", configured),
      hint: tr("похоже на стандартную частоту без разгона. Если на коробке планок написано больше — включи {0} в BIOS", profile),
    };
  } else {
    freq = {
      state: "ok", value: tr("{0} МГц", configured),
      hint: rated ? tr("работает на частоте из маркировки ({0})", mods[0].part) : tr("частота выше стандартной: профиль разгона включён"),
    };
  }

  const chan = ram.dual_channel === false
    ? { state: "bad", value: tr("одноканал"), hint: mods.length === 1 ? tr("одна планка: пропускная способность вдвое ниже. Вторая такая же планка даст CS2 заметный прирост") : tr("планки стоят в одном канале. Переставь их в слоты, которые советует инструкция платы (обычно A2 и B2)") }
    : ram.dual_channel ? { state: "ok", value: tr("двухканал"), hint: tr("{0} планки в разных каналах", mods.length) }
    : { state: "info", value: "—", hint: tr("по подписям слотов не понять. Проверь в CPU-Z: вкладка Memory → Channel") };

  return (
    <Frame title={tr("Железо")} meta={info.cpu || ""} className="span-2"
      help={tr("CS2 упирается в процессор и память сильнее, чем в видеокарту. Самая частая потеря FPS — память не на своей частоте или в одном канале: в Windows этого не видно, а разница огромная.")}>
      <div className="fps">
        <Row state={freq.state} title={tr("Частота памяти")} value={freq.value} hint={freq.hint} />
        <Row state={chan.state} title={tr("Каналы памяти")} value={chan.value} hint={chan.hint} />
        <Row state={total && total < 16 ? "warn" : "ok"} title={tr("Объём памяти")} value={total ? tr("{0} ГБ {1}", total, ram.kind) : "—"}
          hint={total && total < 16 ? tr("меньше 16 ГБ: с браузером и Discord начнутся подгрузки и фризы") : mods.map((m) => `${m.maker} ${m.part}`.trim()).filter(Boolean).join(" · ")} />
        {info.gpus.length > 0 && <Row state="info" title={tr("Видеокарта")} value="" hint={info.gpus.join(" · ")} />}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- графика CS2

function Graphics({ Frame }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // пресет под курсором: строки показывают, что поменяется

  const load = useCallback(() => invoke("fps_video").then((x) => { setV(x); setErr(""); }).catch((e) => setErr(String(e))), []);
  useEffect(() => { load(); }, [load]);

  const apply = async (id) => {
    const p = PRESETS[id];
    setBusy(true); setErr("");
    try {
      setV(await invoke("fps_video_apply", { account: v.account, settings: p.settings, contrast: p.contrast }));
      noteChange(tr("пресет «{0}»", tr(p.label)));
    } catch (e) { setErr(String(e)); load(); }
    setBusy(false);
  };
  const restore = async () => {
    setBusy(true); setErr("");
    try { setV(await invoke("fps_video_restore", { account: v.account })); noteChange(tr("свои настройки графики")); }
    catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  if (!v) {
    return (
      <Frame title={tr("Графика CS2")} className="span-2">
        {err ? <p className="mono err">{trError(err)}</p> : <p className="mono dim pulse">{tr("читаю настройки игры…")}</p>}
      </Frame>
    );
  }

  const target = preview ? PRESETS[preview].settings : null;
  const label = (row, val) => (row.values[val] ? tr(row.values[val]) : val ?? "—");
  const rows = VIDEO.filter((r) => v.settings[r.key] != null || target?.[r.key] != null);
  const contrastOn = v.contrast !== "0";

  return (
    <Frame title={tr("Графика CS2")} meta={v.name || v.account} className="span-2"
      help={tr("Настройки из cs2_video.txt аккаунта. Пресет меняет файл, пока игра закрыта, а перед первой правкой clipforge сохраняет твои настройки: «Вернуть мои» кладёт их обратно. Разрешение и режим окна пресеты не трогают.")}>
      <div className="cs2gfx">
        <div className="cs2gfx__presets">
          {Object.entries(PRESETS).map(([id, p]) => (
            <button key={id} type="button" className="cs2gfx__preset" disabled={busy || v.cs2_running}
              onMouseEnter={() => setPreview(id)} onMouseLeave={() => setPreview(null)} onFocus={() => setPreview(id)} onBlur={() => setPreview(null)}
              onClick={() => apply(id)}>
              <span>{tr(p.label)}</span><span className="mono dim">{tr(p.hint)}</span>
            </button>
          ))}
          {v.has_backup && (
            <button type="button" className="cs2gfx__preset cs2gfx__preset--back" disabled={busy || v.cs2_running} onClick={restore}>
              <span>{tr("Вернуть мои")}</span><span className="mono dim">{tr("как было до clipforge")}</span>
            </button>
          )}
        </div>
        {v.cs2_running && <p className="mono err">{tr("CS2 запущена: закрой её, иначе при выходе она перезапишет настройки")}</p>}
        {err && <p className="mono err">{trError(err)}</p>}
        <div className="cs2gfx__table">
          <div className="cs2gfx__row cs2gfx__row--head mono dim">
            <span>{tr("настройка")}</span><span>{tr("сейчас")}</span><span>{tr("цена в FPS")}</span><span>{tr("что даёт")}</span>
          </div>
          <div className={`cs2gfx__row ${target && !contrastOn ? "is-change" : ""}`}>
            <span>{tr("Усиление контраста игроков")}</span>
            <span className="mono">{contrastOn ? tr("вкл") : tr("выкл")}{target && !contrastOn && <em> → {tr("вкл")}</em>}</span>
            <span className="mono cs2gfx__cost is-low">{tr(COST.low)}</span>
            <span className="dim">{tr("модели игроков ярче на фоне карты. Включено почти у всех про")}</span>
          </div>
          {rows.map((r) => {
            const cur = v.settings[r.key];
            const next = target?.[r.key];
            const change = next != null && next !== cur;
            return (
              <div key={r.key} className={`cs2gfx__row ${change ? "is-change" : ""}`}>
                <span>{tr(r.label)}</span>
                <span className="mono">{label(r, cur)}{change && <em> → {label(r, next)}</em>}</span>
                <span className={`mono cs2gfx__cost is-${r.cost}`}>{tr(COST[r.cost])}</span>
                <span className="dim">{tr(r.vis)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- фоновые программы

// пауза между замерами: сам замер идёт секунду, итого обновление раз в ~3 секунды
const LIVE_GAP = 2000;
// программа остаётся в списке ещё столько после того, как перестала грузить — иначе строки мигают
const LIVE_HOLD = 10000;

function Background({ Frame }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState("");
  const paused = useRef(false); // пока открыт вопрос «Закрыть?»
  const seen = useRef({}); // имя → когда последний раз грузила заметно

  // живое обновление, пока вкладка открыта и окно на экране
  useEffect(() => {
    let alive = true, timer;
    const tick = async () => {
      if (!alive) return;
      if (!paused.current && document.visibilityState === "visible") {
        try { const r = await invoke("fps_processes"); if (alive) { setP(r); setErr(""); } }
        catch (e) { if (alive) setErr(String(e)); }
      }
      if (alive) timer = setTimeout(tick, LIVE_GAP);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const list = useMemo(() => {
    const now = Date.now();
    return (p?.list || []).filter((x) => {
      const n = x.name.toLowerCase();
      if (n === "cs2.exe") return false;
      const k = KNOWN[n];
      const loud = k ? k.always || x.cpu >= 1 || x.gpu >= 1 : x.cpu >= 3 || x.gpu >= 3;
      if (loud) seen.current[n] = now;
      return now - (seen.current[n] || 0) < LIVE_HOLD;
    }).slice(0, 12);
  }, [p]);

  const kill = async (x) => {
    const name = KNOWN[x.name.toLowerCase()]?.label || x.name;
    paused.current = true;
    const yes = await ask(tr("Закрыть {0}? Несохранённое в этой программе пропадёт.", name), { title: "clipforge", kind: "warning" });
    if (yes) {
      setErr("");
      try { await invoke("fps_kill", { name: x.name }); noteChange(tr("закрыт {0}", name)); delete seen.current[x.name.toLowerCase()]; }
      catch (e) { setErr(String(e)); }
    }
    paused.current = false;
  };

  return (
    <Frame title={tr("Фоновые программы")} meta={p ? <span className="live-meta"><i className="live-dot" aria-hidden="true" />{tr("сейчас: процессор {0}% · видеокарта {1}%", r0(p.cpu_total), r0(p.gpu_total))}</span> : ""} className="span-2"
      help={tr("Что прямо сейчас ест процессор и видеокарту, плюс программы, которые встраиваются в игру или пишут видео в фоне, даже если сейчас тихие. Обновляется само каждые пару секунд, как диспетчер задач.")}>
      <div className="fps">
        {!p && !err && <p className="mono dim pulse">{tr("смотрю, что запущено…")}</p>}
        {p && !list.length && <Row state="ok" title={tr("Ничего лишнего")} value="" hint={tr("в фоне ничего заметного не работает")} />}
        {list.map((x) => {
          const k = KNOWN[x.name.toLowerCase()];
          const heavy = x.cpu >= 5 || x.gpu >= 5;
          return (
            <Row key={x.name} state={heavy || k?.always ? "warn" : "info"} title={k?.label || x.name.replace(/\.exe$/i, "")}
              value={`${tr("ЦП")} ${x.cpu.toFixed(1)}% · ${tr("ГП")} ${x.gpu.toFixed(1)}%`}
              hint={k ? tr(k.note) : x.count > 1 ? tr("{0} процессов", x.count) : null}>
              {x.killable && <button type="button" className="chip svc__btn" onClick={() => kill(x)}>{tr("Закрыть")}</button>}
            </Row>
          );
        })}
        {p?.own?.count > 0 && (
          <Row state="ok" title="clipforge"
            value={`${tr("ЦП")} ${p.own.cpu.toFixed(1)}% · ${tr("ГП")} ${p.own.gpu.toFixed(1)}% · ${tr("{0} МБ", Math.round(p.own.mem_mb))}`}
            hint={tr("это сама программа: интерфейс и всё, что она запустила. Во время игры сверни её в трей — окно перестанет рисоваться, а статистика матча продолжит записываться")} />
        )}
        {err && <p className="mono err">{trError(err)}</p>}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- Windows

const PLAN_NAMES = { saver: "Экономия энергии", balanced: "Сбалансированная", high: "Высокая производительность", ultimate: "Максимальная производительность" };

function Windows({ Frame, info, cs2, reload }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const fix = async (what, extra = {}) => {
    setBusy(what); setErr("");
    try { await invoke("fps_fix", { what, cs2: cs2 || null, plan: null, ...extra }); await reload(); }
    catch (e) { setErr(String(e)); }
    setBusy("");
  };
  const openPage = (page) => invoke("fps_open_settings", { page }).catch((e) => setErr(String(e)));

  const active = info.plans.find((x) => x.guid === info.active_plan);
  const planKind = active?.kind || "custom";
  const planGood = planKind === "high" || planKind === "ultimate";
  const prevPlan = localStorage.getItem(PREV_PLAN);
  const gameMode = info.game_mode !== 0;
  const capture = info.capture === 1 || info.background_capture === 1;
  const hzLow = info.max_hz > info.hz;
  const multiGpu = info.gpus.length > 1;
  const gpuOk = info.gpu_pref === 2;
  const bad = [!planGood && tr("питание"), !gameMode && tr("игровой режим"), capture && tr("запись Game Bar"),
    hzLow && tr("частота экрана"), multiGpu && !gpuOk && tr("видеокарта для CS2")].filter(Boolean);

  return (
    <Frame title={tr("Windows")} className="span-2">
      <div className="fps">
        <Row state={bad.length ? "warn" : "ok"} title={bad.length ? tr("Есть что поправить") : tr("Всё в порядке")}
          value={bad.length ? bad.join(", ") : ""} hint={bad.length ? null : tr("питание, игровой режим, Game Bar, частота экрана")}>
          <button type="button" className="chip svc__btn" onClick={() => setOpen(!open)}>{open ? tr("свернуть") : tr("подробнее")}</button>
        </Row>
        {open && (
          <div className="fps__sub">
            <Row state={planGood ? "ok" : "warn"} title={tr("Схема питания")} value={PLAN_NAMES[planKind] ? tr(PLAN_NAMES[planKind]) : active?.name || "—"}
              hint={planGood ? null : info.battery ? tr("ноутбук от батареи: подключи зарядку, иначе FPS всё равно урежется") : tr("в «сбалансированной» процессор сбрасывает частоту, отсюда просадки и рваный кадр")}>
              {!planGood && <button type="button" className="chip svc__btn" disabled={!!busy} onClick={() => { if (info.active_plan) localStorage.setItem(PREV_PLAN, info.active_plan); fix("power").then(() => noteChange(tr("схема питания"))); }}>{tr("Исправить")}</button>}
              {planGood && prevPlan && prevPlan !== info.active_plan && <button type="button" className="chip svc__btn" disabled={!!busy} onClick={() => fix("power", { plan: prevPlan }).then(() => localStorage.removeItem(PREV_PLAN))}>{tr("Вернуть как было")}</button>}
            </Row>
            <Row state={gameMode ? "ok" : "warn"} title={tr("Игровой режим Windows")} value={gameMode ? tr("включён") : tr("выключен")}>
              {!gameMode && <button type="button" className="chip svc__btn" disabled={!!busy} onClick={() => fix("game_mode")}>{tr("Включить")}</button>}
            </Row>
            <Row state={capture ? "warn" : "ok"} title={tr("Запись Xbox Game Bar")} value={info.background_capture === 1 ? tr("пишет в фоне") : capture ? tr("включена") : tr("выключена")}
              hint={capture ? tr("фоновая запись постоянно кодирует видео и съедает FPS. Если записываешь через Game Bar — оставь") : null}>
              {capture && <button type="button" className="chip svc__btn" disabled={!!busy} onClick={() => fix("capture").then(() => noteChange(tr("запись Game Bar выключена")))}>{tr("Выключить")}</button>}
            </Row>
            <Row state={hzLow ? "warn" : "ok"} title={tr("Частота экрана")} value={info.hz ? `${info.hz} ${tr("Гц")}${hzLow ? ` / ${info.max_hz}` : ""}` : "—"}
              hint={hzLow ? tr("монитор умеет {0} Гц, а Windows выводит {1}: игра будет ощущаться медленнее", info.max_hz, info.hz) : null}>
              {hzLow && <button type="button" className="chip svc__btn" onClick={() => openPage("display")}>{tr("Открыть")}</button>}
            </Row>
            {multiGpu && (
              <Row state={gpuOk ? "ok" : "warn"} title={tr("Видеокарта для CS2")} value={gpuOk ? tr("производительная") : info.gpu_pref === 1 ? tr("энергосберегающая") : tr("решает Windows")}
                hint={gpuOk ? null : tr("видеокарт две ({0}), игра может запуститься на встроенной", info.gpus.join(", "))}>
                {!gpuOk && <button type="button" className="chip svc__btn" disabled={!!busy || !cs2} onClick={() => fix("gpu_pref")}>{tr("Исправить")}</button>}
              </Row>
            )}
          </div>
        )}
        {err && <p className="mono err">{trError(err)}</p>}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- вкладка

export function FpsOptimizer({ Frame, cs2, archive = [] }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => invoke("fps_check", { cs2: cs2 || "" }).then(setInfo).catch((e) => setErr(String(e))), [cs2]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <Bench Frame={Frame} cs2={cs2} archive={archive} />
      {info ? <Hardware Frame={Frame} info={info} /> : (
        <Frame title={tr("Железо")} className="span-2">
          {err ? <p className="mono err">{trError(err)}</p> : <p className="mono dim pulse">{tr("проверяю систему…")}</p>}
        </Frame>
      )}
      <Graphics Frame={Frame} />
      <Background Frame={Frame} />
      {info && <Windows Frame={Frame} info={info} cs2={cs2} reload={load} />}
    </>
  );
}
