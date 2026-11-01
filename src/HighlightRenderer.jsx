import { useState, useRef, useMemo, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { videoDir, join } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import { parseDemo } from "./demo";
import { tierOf, tagLabel } from "./moments";
import { fontsReady, renderHudFrames } from "./hud";
import { SkinsPanel, planForRust, planIsEmpty } from "./skins";
import { MusicPanel, MUSIC_DEFAULT, renderLyricFrames, chorusDrops, alignChorusToKill, chainMusic } from "./music";
import { orbitPath } from "./cine";
import { lyricStyle } from "./lyricStyles";
import { MatchDossier, infoSummary, mapName, mapTint } from "./dossier";
import { drawCard } from "./card";
import { CompareModal } from "./compare";
import { Gallery } from "./gallery";
import shotHudMatch from "./assets/previews/hud-match.webp";
import shotHudDemo from "./assets/previews/hud-demo.webp";
import "./highlight-renderer.css";
import { version as APP_VERSION } from "../package.json";

import { tr, trError, getLang, setLang, useLang } from "./i18n";
const TABS = ["Демо", "Архив", "Хайлайты", "Рендер", "Очередь", "Библиотека", "Настройки"];
const DEMO_TAB = TABS.indexOf("Демо");
const ARCHIVE_TAB = TABS.indexOf("Архив");
const HIGHLIGHTS_TAB = TABS.indexOf("Хайлайты");
const SETTINGS_TAB = TABS.indexOf("Настройки");

// Вкладки блока «Настройки клипа»
const STUDIO_TABS = [
  { id: "video", label: "Видео", icon: "▶" },
  { id: "effects", label: "Эффекты", icon: "✦" },
  { id: "camera", label: "Камера", icon: "◉" },
  { id: "sound", label: "Звук", icon: "♪" },
  { id: "skins", label: "Скины", icon: "◆" },
];
// версия формата досье: при изменении scripts/info.cjs старый кэш пересчитывается
const INFO_V = 1;
// клавиши, которыми в игре запускается запись (имя для bind в CS2, подпись)
const START_KEYS = [["f10", "F10"], ["f9", "F9"], ["f8", "F8"], ["f7", "F7"], ["f6", "F6"], ["f11", "F11"], ["ins", "Insert"], ["home", "Home"], ["end", "End"], ["pgup", "Page Up"], ["pgdn", "Page Down"]];
const VIDEO_DEFAULT = { aspect: "16:9", resId: "1920x1080", stretch: true };
const FLASH_COLORS = [["pink", "Розовая"], ["white", "Белая"], ["gold", "Золотая"]];
const VOICE_MODES = [["none", "Выключено"], ["all", "Все"], ["team", "Тиммейты"], ["enemy", "Противники"]];

const RESOLUTIONS = [
  { id: "1280x720",  ratio: "16:9", label: "720p",  width: 1280, height: 720,  mbps: 12, crf: 20 },
  { id: "1920x1080", ratio: "16:9", label: "1080p", width: 1920, height: 1080, mbps: 20, crf: 18 },
  { id: "2560x1440", ratio: "16:9", label: "1440p", width: 2560, height: 1440, mbps: 40, crf: 16 },
  { id: "3840x2160", ratio: "16:9", label: "4K",    width: 3840, height: 2160, mbps: 80, crf: 15 },
  { id: "960x720",   ratio: "4:3",  label: "720p",  width: 960,  height: 720,  mbps: 10, crf: 20 },
  { id: "1280x960",  ratio: "4:3",  label: "960p",  width: 1280, height: 960,  mbps: 14, crf: 18 },
  { id: "1600x1200", ratio: "4:3",  label: "1200p", width: 1600, height: 1200, mbps: 18, crf: 17 },
  { id: "1080x1080", ratio: "1:1",  label: "1080p", width: 1080, height: 1080, mbps: 16, crf: 18 },
  { id: "1080x1920", ratio: "9:16", label: "1080p", width: 1080, height: 1920, mbps: 20, crf: 18 },
  { id: "720x1280",  ratio: "9:16", label: "720p",  width: 720,  height: 1280, mbps: 12, crf: 20 },
];
const RATIOS = ["16:9", "4:3", "1:1", "9:16"];

const DEFAULT_PATHS = {
  hlae: "C:\\Program Files (x86)\\HLAE\\HLAE.exe",
  cs2: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe",
  out: "", // подставляется при запуске: <папка «Видео» пользователя>\clipforge
};
const LEGACY_OUT = "C:\\Users\\Public\\Videos\\clipforge";

// "2026-10-30_15-40-12" — имя временной папки рендера и префикс готовых клипов
const renderStamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

// Чистый кадр — центр скриншота с HUD из матча без нижней полосы HUD (см. .pv img.is-crop)
const CLEAN = "3 / 1";

// Строка килфида поверх чистого кадра: в превью скриншота с ним нет
const KillfeedRow = () => (
  <span className="pv-kf"><b>you</b><i>AK-47</i><b className="pv-kf__t">enemy</b></span>
);

// Режимы интерфейса игры в записи. "match" — свой HUD игрока поверх видео (см. hud.js).
const HUD_MODES = [
  { id: "full", label: "Как в демке",
    help: "Интерфейс наблюдателя остается как есть: панель игрока внизу, деньги, оружие, килфид.",
    preview: <Shot src={shotHudDemo} ratio="360 / 84" /> },
  { id: "killfeed", label: "Только килфид",
    help: "Прячет весь интерфейс, кроме килфида в правом верхнем углу. Чистый кадр для монтажа.",
    preview: <Shot src={shotHudMatch} ratio={CLEAN} crop><KillfeedRow /></Shot> },
  { id: "match", label: "HUD из матча",
    help: "Интерфейс как у игрока в матче: деньги, здоровье, броня, патроны и оружие. Значения берутся из демки и меняются по ходу клипа, килфид остается игровым. Подстраивается под любой формат кадра.",
    preview: <HudZoom src={shotHudMatch} /> },
];

// Атмосфера: цветокоррекция при сборке + (по желанию) туман и небо в самой игре
const ATMOS = [
  { id: "", label: "Как в игре", help: "Освещение и цвета карты без изменений." },
  { id: "night", label: "Ночь", help: "Темная холодная картинка с синевой и виньеткой, темно-синее небо и туман вдали." },
  { id: "fog", label: "Туман", help: "Густой серый туман: дальние планы тонут в дымке, цвета приглушены." },
  { id: "sunset", label: "Закат", help: "Теплый оранжевый свет и розово-оранжевое небо, мягкая виньетка." },
  { id: "neon", label: "Неон", help: "Фиолетово-розовые тени и сочные цвета, как в эдитах в стиле synthwave." },
].map((a) => ({ ...a, preview: a.id && <Shot src={shotHudMatch} ratio={CLEAN} crop><span className={`pv-atmo pv-atmo--${a.id}`} /></Shot> }));

const GPU_NAMES ={ h264_nvenc: "NVIDIA NVENC", h264_amf: "AMD AMF", h264_qsv: "Intel Quick Sync" };

const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB");
const fmtDate = (t) => new Date(t).toLocaleString(getLang() === "en" ? "en-US" : "ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// Архив — только список путей в localStorage; сами .dem-файлы на диске не трогаем.
const loadArchive = () => {
  try { return JSON.parse(localStorage.getItem("cf-demos") || "[]"); } catch { return []; }
};

// Отклик интерфейса, которого нет в CSS: подсветка блока следует за курсором (--mx/--my на .frame)
// и «волна» от точки клика на кнопках. Один делегированный обработчик на всё приложение.
const RIPPLE_SEL = ".go, .chip, .presets button, .ratios button, .players button, .events button, .sk-card, .sk-types button";
function useInteractionFx(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0, last = null;
    const move = (e) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const f = last.target.closest?.(".frame");
        root.querySelectorAll(".frame.is-lit").forEach((el) => {
          if (el !== f) { el.classList.remove("is-lit"); el.style.removeProperty("--mx"); el.style.removeProperty("--my"); }
        });
        if (!f) return;
        const r = f.getBoundingClientRect();
        f.classList.add("is-lit");
        f.style.setProperty("--mx", `${last.clientX - r.left}px`);
        f.style.setProperty("--my", `${last.clientY - r.top}px`);
      });
    };
    const down = (e) => {
      const b = e.target.closest?.(RIPPLE_SEL);
      // кнопки с «?» не трогаем: overflow: hidden обрезал бы всплывающую подсказку
      if (!b || b.disabled || b.querySelector(".hint")) return;
      const r = b.getBoundingClientRect();
      const s = document.createElement("span");
      s.className = "ripple";
      s.style.setProperty("--x", `${e.clientX - r.left}px`);
      s.style.setProperty("--y", `${e.clientY - r.top}px`);
      s.style.setProperty("--d", `${Math.hypot(r.width, r.height) * 2}px`);
      b.classList.add("ripple-host");
      b.appendChild(s);
      s.addEventListener("animationend", () => s.remove(), { once: true });
    };
    root.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerdown", down);
    return () => { root.removeEventListener("pointermove", move); root.removeEventListener("pointerdown", down); cancelAnimationFrame(raf); };
  }, [rootRef]);
}

// Серый «?» рядом с названием: при наведении показывает короткое описание функции.
// Клик по нему не должен переключать тумблер или кнопку, внутри которой он стоит.
// Превью в подсказке: кадр-пример сверху, поверх — элементы, которых нет на скриншоте.
// crop — показать только верх картинки (кадр без HUD); долю задаёт ratio контейнера.
function Shot({ src, ratio, pos = "center", crop, children }) {
  return (
    <span className="pv" style={{ aspectRatio: ratio }}>
      <img src={src} alt="" className={crop ? "is-crop" : ""} style={{ objectPosition: pos }} />
      {children}
      <em className="pv__tag">{tr("пример")}</em>
    </span>
  );
}

// Две увеличенные полосы низа кадра — левая и правая часть HUD, чтобы его было видно крупно
function HudZoom({ src }) {
  return (
    <span className="pv pv--zoom">
      <span className="pv-zoom" style={{ backgroundImage: `url(${src})`, backgroundPosition: "left bottom" }} />
      <span className="pv-zoom" style={{ backgroundImage: `url(${src})`, backgroundPosition: "right bottom" }} />
      <em className="pv__tag">{tr("пример")}</em>
    </span>
  );
}

// График скорости slow-mo: те же ступени, что в SLOWMO_RAMP в render.rs
function SlowmoCurve() {
  const steps = [[0, 1], [0.24, 0.75], [0.3, 0.5], [0.38, 0.35], [0.62, 0.5], [0.7, 0.75], [0.76, 1], [1, 1]];
  const y = (s) => 8 + (1 - s) * 70;
  const d = steps.map(([x, s], i) => `${i ? "H" : "M"}${x * 300} ${i ? `V${y(s)}` : y(s)}`).join(" ");
  return (
    <span className="pv pv--chart">
      <svg viewBox="0 0 300 92" aria-hidden="true">
        <line x1="150" y1="4" x2="150" y2="80" className="pv-kill" />
        <path d={d} className="pv-curve" />
        <text x="4" y="88">{tr("скорость")}</text>
        <text x="150" y="88" textAnchor="middle" className="pv-kill-t">{tr("килл")}</text>
        <text x="296" y="88" textAnchor="end">×1 → ×0.35 → ×1</text>
      </svg>
    </span>
  );
}

// Окошко подсказки поверх всего (в .app, position: fixed) — для «?» внутри прокручиваемых блоков,
// где обычное окошко обрезалось бы краем прокрутки (заголовки таблицы досье)
function FloatPop({ anchor, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const w = el.offsetWidth, h = el.offsetHeight, m = 8;
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - w / 2, m), window.innerWidth - w - m);
    const header = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const top = anchor.top - h - 9 >= header + m ? anchor.top - h - 9 : anchor.bottom + 9;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.classList.add("is-shown");
  }, [anchor]);
  return createPortal(
    <span ref={ref} className="hint__pop hint__float" role="tooltip"><span className="hint__text">{children}</span></span>,
    document.querySelector(".app") || document.body,
  );
}

function Hint({ text, preview, float }) {
  const popRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  if (float) {
    return (
      <span className="hint" aria-label={text}
        onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setAnchor(null)}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
        ?{anchor && <FloatPop anchor={anchor}>{text}</FloatPop>}
      </span>
    );
  }
  // Окошко центрируется над «?», но сдвигается, чтобы не вылезать за края окна,
  // и открывается вниз, если сверху его закрыла бы шапка.
  const place = (e) => {
    const pop = popRef.current;
    if (!pop) return;
    const r = e.currentTarget.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, m = 8;
    const left = r.left + r.width / 2 - w / 2;
    const dx = Math.min(Math.max(left, m), window.innerWidth - w - m) - left;
    const header = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    pop.style.setProperty("--dx", `${dx}px`);
    pop.classList.toggle("is-below", r.top - h - 9 < header + m);
  };
  return (
    <span className="hint" aria-label={text} onMouseEnter={place}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
      ?<span className={`hint__pop ${preview ? "has-pv" : ""}`} role="tooltip" ref={popRef}>
        {preview}
        <span className="hint__text">{text}</span>
      </span>
    </span>
  );
}

function Frame({ title, meta, help, children, className = "" }) {
  return (
    <section className={`frame ${className}`}>
      <header className="frame__head">
        <h2>{title}{help && <Hint text={help} />}</h2>
        <span className="frame__rule" />
        {meta && <span className="mono dim">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

function Slider({ label, help, value, min, max, step = 1, unit = "", onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="field">
      <span className="field__row">
        <span>{label}{help && <Hint text={help} />}</span>
        <b className="mono accent">{value}{unit}</b>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        style={{ "--pct": `${pct}%` }}
        onChange={(e) => onChange(+e.target.value)}
      />
      <span className="field__row mono dim"><span>{min}</span><span>{max}</span></span>
    </label>
  );
}

function Toggle({ label, hint, help, preview, checked, onChange, disabled = false }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle__text">
        <span>{label}{help && <Hint text={help} preview={preview} />}</span>
        {hint && <small className="dim">{hint}</small>}
      </span>
      <span className="toggle__track"><i /></span>
    </button>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <label className="num">
      <span className="mono dim">{label}</span>
      <input className="mono" type="number" step="0.1" value={value}
        onChange={(e) => onChange(+e.target.value)} />
    </label>
  );
}

export default function HighlightRenderer() {
  const lang = useLang();
  const [tab, setTab] = useState(0);
  const [openClip, setOpenClip] = useState(null); // клип, который надо открыть в «Хайлайтах»

  // Рамка активной вкладки — один элемент, который переезжает под нужную кнопку.
  const tabRefs = useRef([]);
  const [ink, setInk] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const b = tabRefs.current[tab];
      if (b) setInk({ left: b.offsetLeft, width: b.offsetWidth });
    };
    measure();
    document.fonts?.ready.then(measure); // ширина кнопок меняется после загрузки шрифта
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tab]);
  const [demo, setDemo] = useState(null);
  const [over, setOver] = useState(false);
  const [clips, setClips] = useState([]);
  const [players, setPlayers] = useState([]);
  const [playerId, setPlayerId] = useState(null);
  const [roster, setRoster] = useState([]);
  const [voice, setVoice] = useState("none"); // none | all | team | enemy — по умолчанию без голосов
  const [studioTab, setStudioTab] = useState(() => { try { return localStorage.getItem("cf-studio") || "video"; } catch { return "video"; } });
  useEffect(() => { try { localStorage.setItem("cf-studio", studioTab); } catch {} }, [studioTab]);
  const [maxRound, setMaxRound] = useState(24);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [paths, setPaths] = useState(() => JSON.parse(localStorage.getItem("cf-paths") || "null") || DEFAULT_PATHS);
  useEffect(() => localStorage.setItem("cf-paths", JSON.stringify(paths)), [paths]);

  // Если HLAE по указанному пути нет (например, настройки сбросились), ищем его в стандартных местах:
  // от него зависят ffmpeg (трек, склейка) и поиск GPU-кодировщика
  useEffect(() => {
    invoke("locate_hlae", { current: paths.hlae })
      .then((found) => { if (found && found !== paths.hlae) setPaths((p) => ({ ...p, hlae: found })); })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Папка клипов по умолчанию — «Видео»\clipforge. Старый дефолт (Public\Videos) тоже заменяем.
  const [defaultOut, setDefaultOut] = useState("");
  useEffect(() => {
    videoDir().then((v) => join(v, "clipforge")).then((dir) => {
      setDefaultOut(dir);
      setPaths((p) => (!p.out || p.out === LEGACY_OUT ? { ...p, out: dir } : p));
    }).catch(() => {});
  }, []);
  const pickOutDir = async () => {
    const dir = await openDialog({ directory: true, defaultPath: paths.out || defaultOut || undefined });
    if (typeof dir === "string") setPaths((p) => ({ ...p, out: dir }));
  };
  const [startKey, setStartKey] = useState(() => { try { return localStorage.getItem("cf-start-key") || "f10"; } catch { return "f10"; } });
  useEffect(() => { try { localStorage.setItem("cf-start-key", startKey); } catch {} }, [startKey]);
  const [archive, setArchive] = useState(loadArchive);
  useEffect(() => localStorage.setItem("cf-demos", JSON.stringify(archive)), [archive]);
  const [renaming, setRenaming] = useState(null); // path демки, которую переименовываем
  const [archiveOpen, setArchiveOpen] = useState(null); // path демки с раскрытым досье в архиве

  // Досье матча (scripts/info.cjs) считается в фоне после загрузки демки и кэшируется по пути файла
  const [info, setInfo] = useState(null);
  const [infoBusy, setInfoBusy] = useState(false);
  const [faceit, setFaceit] = useState(null);
  const [faceitErr, setFaceitErr] = useState("");
  const [faceitKey, setFaceitKey] = useState(() => { try { return localStorage.getItem("cf-faceit-key") || ""; } catch { return ""; } });
  useEffect(() => { try { localStorage.setItem("cf-faceit-key", faceitKey.trim()); } catch {} }, [faceitKey]);
  const infoReq = useRef(0);
  const cachedInfo = (path) => { try { return JSON.parse(localStorage.getItem(`cf-info:${path}`) || "null"); } catch { return null; } };
  const saveInfo = (path, i) => { try { localStorage.setItem(`cf-info:${path}`, JSON.stringify(i)); } catch {} };
  const loadInfo = async (path) => {
    const req = ++infoReq.current;
    const cached = cachedInfo(path);
    setInfo(cached); setFaceit(cached?.faceit || null); setFaceitErr("");
    if (cached?.v === INFO_V) return;
    setInfoBusy(true);
    try {
      const i = { ...JSON.parse(await invoke("demo_info", { path })), v: INFO_V };
      if (req !== infoReq.current) return;
      setInfo(i);
      saveInfo(path, i);
      setArchive((list) => list.map((d) => (d.path === path ? { ...d, info: infoSummary(i) } : d)));
    } catch (e) {
      if (req === infoReq.current) setFaceitErr(tr("не удалось разобрать матч: {0}", e));
    } finally {
      if (req === infoReq.current) setInfoBusy(false);
    }
  };
  // уровни FACEIT — только с ключом API (UUID из 36 символов), один раз на демку
  useEffect(() => {
    const key = faceitKey.trim();
    if (!info || !demo || info.faceit || key.length < 32) return;
    let alive = true;
    const path = demo.path;
    invoke("faceit_levels", { key, steamids: info.players.map((p) => p.id) })
      .then((l) => {
        if (!alive) return;
        const i = { ...info, faceit: l };
        setFaceit(l); setInfo(i); saveInfo(path, i);
      })
      .catch((e) => alive && setFaceitErr(String(e)));
    return () => { alive = false; };
  }, [info, faceitKey, demo]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState({ ace: true, clutch: true, multi: true, skill: true });
  const [momentSort, setMomentSort] = useState(() => { try { return localStorage.getItem("cf-moment-sort") || "score"; } catch { return "score"; } });
  useEffect(() => { try { localStorage.setItem("cf-moment-sort", momentSort); } catch {} }, [momentSort]);
  const [picked, setPicked] = useState(new Set());

  // Номера слотов (1–10) игроков в текущей демке. Определяются автоматически
  // по порядку из parsePlayerInfo (см. scripts/parse.cjs), пользователь их не видит.
  const [slots, setSlots] = useState({});
  const playerSlot = slots[playerId] ?? "";

  const [fps, setFps] = useState(120);
  const [blur, setBlur] = useState(true);
  const [fov, setFov] = useState(90);
  // формат видео по умолчанию (задаётся в «Настройках», переживает перезапуск) — с него стартует каждый клип
  const [videoDefault, setVideoDefault] = useState(() => {
    try { return { ...VIDEO_DEFAULT, ...JSON.parse(localStorage.getItem("cf-video-default") || "{}") }; } catch { return VIDEO_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem("cf-video-default", JSON.stringify(videoDefault)); } catch {} }, [videoDefault]);
  const [aspect, setAspect] = useState(videoDefault.aspect);
  const [stretch, setStretch] = useState(videoDefault.stretch); // 4:3 — растягивать до 16:9 (как в игре)
  // несколько клипов — склеить в один ролик (по умолчанию да); выбор переживает перезапуск
  const [merge, setMerge] = useState(() => { try { return JSON.parse(localStorage.getItem("cf-merge") || "null") ?? { on: true, keep: false }; } catch { return { on: true, keep: false }; } });
  useEffect(() => { try { localStorage.setItem("cf-merge", JSON.stringify(merge)); } catch {} }, [merge]);
  const [resId, setResId] = useState(videoDefault.resId);
  // новый формат по умолчанию сразу применяется и к текущему клипу
  const applyVideoDefault = (patch) => {
    const next = { ...videoDefault, ...patch };
    if (patch.aspect && !RESOLUTIONS.some((r) => r.ratio === next.aspect && r.id === next.resId)) {
      next.resId = RESOLUTIONS.find((r) => r.ratio === next.aspect)?.id;
    }
    setVideoDefault(next);
    setAspect(next.aspect); setResId(next.resId); setStretch(next.stretch);
  };
  const [trim, setTrim] = useState(true);
  const [pad, setPad] = useState({ before: 1.5, after: 2 });
  const [vm, setVm] = useState({ fov: 68, x: 2.5, y: 0, z: -1.5, bob: false });
  const [hurts, setHurts] = useState([]);

  // Свой трек и текст песни — по умолчанию выключено, настройки переживают перезапуск
  const [music, setMusic] = useState(() => {
    try { return { ...MUSIC_DEFAULT, ...JSON.parse(localStorage.getItem("cf-music") || "{}") }; } catch { return MUSIC_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem("cf-music", JSON.stringify(music)); } catch {} }, [music]);

  // Выбранные скины — свои для каждой демки и игрока, переживают перезапуск
  const skinKey = demo && playerId ? `cf-skins:${demo.path}|${playerId}` : null;
  const [skinPlan, setSkinPlan] = useState({});
  useEffect(() => {
    try { setSkinPlan(skinKey ? JSON.parse(localStorage.getItem(skinKey) || "{}") : {}); } catch { setSkinPlan({}); }
  }, [skinKey]);
  useEffect(() => {
    if (!skinKey) return;
    try { planIsEmpty(skinPlan) ? localStorage.removeItem(skinKey) : localStorage.setItem(skinKey, JSON.stringify(skinPlan)); } catch {}
  }, [skinKey, skinPlan]);
  const [fx, setFx] = useState({ slowmo: false, damage: false, xray: false, hideDemoUi: true, hud: "full", camVictim: true, camOrbit: false, killFlash: false, flashColor: "pink", atmo: "", atmoGame: true, hsZoom: false });

  // Аппаратный кодировщик ищем в ffmpeg из папки HLAE: null — нет, undefined — ещё проверяем.
  const [gpuEnc, setGpuEnc] = useState(undefined);
  const [useGpu, setUseGpu] = useState(true);
  useEffect(() => {
    let alive = true;
    setGpuEnc(undefined);
    invoke("detect_gpu_encoder", { hlae: paths.hlae })
      .then((e) => alive && setGpuEnc(e ?? null))
      .catch(() => alive && setGpuEnc(null));
    return () => { alive = false; };
  }, [paths.hlae]);

  const resOptions = useMemo(() => RESOLUTIONS.filter((r) => r.ratio === aspect), [aspect]);
  const res = resOptions.find((r) => r.id === resId) ?? resOptions[0];

  // при смене пропорции переключаемся на первое доступное разрешение в ней
  useEffect(() => {
    if (!resOptions.some((r) => r.id === resId)) setResId(resOptions[0]?.id);
  }, [aspect]); // eslint-disable-line react-hooks/exhaustive-deps

  const [progress, setProgress] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [stage, setStage] = useState(""); // подготовительный шаг до запуска игры (кадры HUD)
  // сырая запись прошлого рендера (для «Пересобрать без игры»); обновляем после каждого рендера
  const [lastRender, setLastRender] = useState(null);
  useEffect(() => {
    if (rendering || !paths.out) return;
    invoke("last_render", { out: paths.out }).then(setLastRender).catch(() => setLastRender(null));
    invoke("compare_list", { out: paths.out }).then(setCompareList).catch(() => setCompareList([]));
  }, [rendering, paths.out]);
  // «До / после» по клипам последнего рендера
  const [compareList, setCompareList] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const cancelRef = useRef(false); // нажата «Остановить» во время подготовки
  const fileRef = useRef(null);
  const appRef = useRef(null);
  useInteractionFx(appRef);

  const loadPath = useCallback(async (path) => {
    if (!path?.toLowerCase().endsWith(".dem")) return;
    setError(""); setParsing(true);
    try {
      const raw = JSON.parse(await invoke("parse_demo", { path }));
      const r = parseDemo(raw, 64, pad.before, pad.after);
      setDemo({ path, name: path.split(/[\\/]/).pop(), size: raw.size });
      setClips(r.clips); setPlayers(r.players); setMaxRound(r.maxRound); setRoster(r.roster); setHurts(r.hurts);
      const auto = {};
      r.players.forEach((p) => { if (p.slot) auto[p.id] = String(p.slot); });
      setSlots(auto);
      setPlayerId(r.players[0]?.id ?? null);
      setArchive((list) => {
        const prev = list.find((d) => d.path === path);
        const entry = {
          path, file: path.split(/[\\/]/).pop(), title: prev?.title ?? "",
          size: raw.size, clips: r.clips.length, info: prev?.info,
          addedAt: prev?.addedAt ?? Date.now(), openedAt: Date.now(),
        };
        return [entry, ...list.filter((d) => d.path !== path)];
      });
      loadInfo(path);
    } catch (e) { setError(String(e)); }
    setParsing(false);
  }, [pad]);

  const openFromArchive = (path) => { setTab(DEMO_TAB); loadPath(path); };
  const renameDemo = (path, title) =>
    setArchive((list) => list.map((d) => (d.path === path ? { ...d, title: title.trim() } : d)));
  const removeDemo = (path) => setArchive((list) => list.filter((d) => d.path !== path));
  const demoTitle = demo && (archive.find((d) => d.path === demo.path)?.title || demo.name);

  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "over" || t === "enter") setOver(true);
      else if (t === "drop") { setOver(false); loadPath(e.payload.paths?.[0]); }
      else setOver(false);
    });
    return () => { un.then((f) => f()); };
  }, [loadPath]);

  const pickFile = async () => loadPath(await openDialog({ filters: [{ name: "CS2 demo", extensions: ["dem"] }] }));

  const myClips = useMemo(() => clips.filter((c) => c.steamid === playerId), [clips, playerId]);
  // карточка игрока (src/card.js): превью в окне, сохранить PNG или скопировать в буфер для Discord
  const [card, setCard] = useState(null);
  const [cardMsg, setCardMsg] = useState("");
  const makeCard = async () => {
    const p = info?.players.find((x) => x.id === playerId) || info?.players[0];
    if (!p) return;
    const cv = await drawCard({ info, player: p, faceit });
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    setCardMsg("");
    setCard((c) => {
      if (c) URL.revokeObjectURL(c.url);
      return { url: URL.createObjectURL(blob), blob, name: `${info.map}_${p.name}.png`.replace(/[\\/:*?"<>|]+/g, "_") };
    });
  };
  const saveCard = async () => {
    const path = await saveDialog({ defaultPath: `${paths.out || defaultOut}\\${card.name}`, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (typeof path !== "string") return;
    try {
      await invoke("save_file", new Uint8Array(await card.blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(path) } });
      setCardMsg(tr("сохранено · {0}", path.split(/[\\/]/).pop()));
    } catch (e) { setCardMsg(tr("не сохранилось: {0}", e)); }
  };
  const copyCard = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": card.blob })]);
      setCardMsg(tr("скопировано - вставь в Discord через Ctrl+V"));
    } catch (e) { setCardMsg(tr("не скопировалось: {0}", e)); }
  };
  useEffect(() => {
    if (!card) return;
    const onKey = (e) => e.key === "Escape" && setCard(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card]);

  const clipCount = useMemo(() => {
    const m = {};
    for (const c of clips) m[c.steamid] = (m[c.steamid] || 0) + 1;
    return m;
  }, [clips]);
  // Диапазоны тиков выбранных клипов — по ним ищем оружие, которое попадёт в кадр
  const pickedRanges = useMemo(() => myClips.filter((c) => picked.has(c.round)).map((c) => [c.start, c.end]), [myClips, picked]);
  // средняя длина выбранных клипов в секундах — под неё подбирается кусок трека с припевом
  const clipLen = pickedRanges.length ? pickedRanges.reduce((s, [a, b]) => s + (b - a), 0) / pickedRanges.length / 64 : 15;
  // Слот — то же число 1–10, что и в spec_player. Маска — бит (slot-1) выставлен
// в 1 для тех, кого нужно слушать. Подтверждённый механизм: tv_listen_voice_indices
// (+ _h для слотов 33–64, нам не нужен) принимает именно такую битовую маску.
const voiceMasks = useMemo(() => {
  if (!playerId || roster.length === 0) return { team: 0, enemy: 0 };
  const self = roster.find((p) => p.id === playerId);
  const maskOf = (list) => list.reduce((m, p) => m | (1 << (p.slot - 1)), 0);
  return {
    team: maskOf(roster.filter((p) => p.team === self?.team)),
    enemy: maskOf(roster.filter((p) => p.team !== self?.team)),
  };
}, [roster, playerId]);

const voicePayload = useMemo(() => {
  if (voice === "team") return { indices: voiceMasks.team, indicesHigh: 0 };
  if (voice === "enemy") return { indices: voiceMasks.enemy, indicesHigh: 0 };
  if (voice === "none") return { indices: 0, indicesHigh: 0 };
  return { indices: -1, indicesHigh: -1 }; // all
}, [voice, voiceMasks]);

  // раунды матча: момент игрока в раунде (если есть) с баллами, метками и видом (src/moments.js)
  const rounds = useMemo(() => Array.from({ length: maxRound }, (_, i) => {
    const c = myClips.find((x) => x.round === i + 1);
    const kind = c ? c.kind || (c.kills >= 5 ? "ace" : "multi") : null;
    return { round: i + 1, kills: c?.kills ?? 0, clutch: c?.clutch ?? 0, ace: kind === "ace", kind,
      score: c?.score ?? (c ? c.kills * 15 : 0), tags: c?.tags ?? (c ? [`${c.kills}K`] : []) };
  }), [myClips, maxRound]);
  // по умолчанию выбраны сильные моменты: эйсы, клатчи и всё от «Топ» (45 баллов) и выше
  const bestRounds = (min = 45) => myClips.filter((c) => c.kind === "ace" || c.kind === "clutch" || (c.score ?? 99) >= min).map((c) => c.round);
  useEffect(() => setPicked(new Set(bestRounds())), [myClips]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = (r) => !!r.kind && !!filter[r.kind];

  const events = useMemo(() => {
    const l = rounds.filter(shown);
    return momentSort === "score" ? [...l].sort((a, b) => b.score - a.score || a.round - b.round) : l;
  }, [rounds, filter, momentSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => {
    const s = { ace: 0, clutch: 0, multi: 0, skill: 0 };
    for (const r of rounds) if (r.kind) s[r.kind]++;
    return s;
  }, [rounds]);
  const topScore = Math.max(60, ...rounds.map((r) => r.score));

  const toggleRound = (n) =>
    setPicked((p) => { const s = new Set(p); s.has(n) ? s.delete(n) : s.add(n); return s; });

  useEffect(() => {
    const subs = [
      listen("render-progress", (e) => setProgress(e.payload)),
      listen("render-done", () => { setRendering(false); setStage(""); setProgress(100); }),
      // «Смотреть» в уведомлении «хайлайт готов» — открываем клип на вкладке «Хайлайты»
      listen("open-clip", (e) => { setOpenClip(String(e.payload)); setTab(HIGHLIGHTS_TAB); }),
      listen("render-error", (e) => { setRendering(false); setStage(""); setError(String(e.payload)); }),
    ];
    return () => subs.forEach((p) => p.then((f) => f()));
  }, []);

  const validSlot = playerSlot !== "" &&
    Number.isInteger(Number(playerSlot)) &&
    Number(playerSlot) >= 1 && Number(playerSlot) <= 10;

  // reuse — «Пересобрать без игры»: эффекты заново на сырой записи прошлого рендера
  const startRender = async (reuse = false) => {
    if (!validSlot) {
      setError(tr("Не удалось определить слот игрока в демке - попробуй другую демку или сообщи разработчику"));
      return;
    }
    const { width, height, crf } = res;
    const sel = myClips
      .filter((c) => picked.has(c.round))
      .map((c) => trim
        ? { ...c, start: Math.max(0, c.start + Math.round((1.5 - pad.before) * 64)), end: c.end + Math.round((pad.after - 2) * 64) }
        : { ...c, start: Math.max(0, c.start - 192), end: c.end + 192 })
      .map((c) => ({
        ...c, slot: Number(playerSlot),
        hits: hurts.filter((h) => h.steamid === c.steamid && c.victims?.includes(h.victim)
          && h.tick >= c.start && h.tick <= c.end),
      }));
    // замедление на припеве: момент в записи каждого клипа, который придётся на начало припева
    // «припев на последний килл» — ещё и своё начало трека для каждого клипа (musicStart)
    if (music.enabled && music.path && music.chorusSlow && music.lrc) {
      for (const c of sel) {
        const onKill = music.chorusOnKill !== false && alignChorusToKill({ lrc: music.lrc, start: music.start, clip: c, slowmo: fx.slowmo });
        if (onKill) { c.musicStart = onKill.start; c.drops = onKill.drops; }
        else c.drops = chorusDrops({ lrc: music.lrc, start: music.start, clip: c, slowmo: fx.slowmo });
      }
    }
    // HLAE не запускает вторую CS2 («already running») — предлагаем закрыть открытую
    if (!reuse && await invoke("cs2_running").catch(() => false)) {
      const ok = await ask(tr("CS2 уже запущена (например, осталась от прошлого рендера). Закрыть ее и начать рендер?"),
        { title: "clipforge", kind: "warning", okLabel: tr("Закрыть и начать"), cancelLabel: tr("Отмена") });
      if (!ok) return;
    }
    setError(""); setProgress(0); setRendering(true);
    cancelRef.current = false;
    // подготовка (HUD, скины) идёт до запуска игры — между шагами проверяем «Остановить»
    const stopped = () => { if (cancelRef.current) throw new Error(tr("рендер остановлен")); };
    const stamp = renderStamp();
    try {
      if (!reuse) {
        setStage(tr("закрываю CS2..."));
        await invoke("close_cs2");
        setStage("");
      }
      if (fx.hud === "match") {
        // Кадры HUD готовим заранее: по одной папке hud_N на клип внутри временной папки рендера
        setStage(tr("готовлю HUD..."));
        const states = JSON.parse(await invoke("parse_hud", {
          path: demo.path, steamid: playerId, ranges: JSON.stringify(sel.map((c) => [c.start, c.end])),
        }));
        await fontsReady();
        const work = await join(paths.out, ".clipforge_tmp", stamp);
        for (let i = 0; i < sel.length; i++) {
          stopped();
          const dir = await join(work, `hud_${i}`);
          const save = (name, bytes) => invoke("save_file", bytes, { headers: { "x-path": encodeURIComponent(`${dir}\\${name}`) } });
          const list = await renderHudFrames(states[i] || [], sel[i].start, width, height, save);
          await save("hud.ffconcat", new TextEncoder().encode(list));
        }
      }
      // кинокамера: повтор глазами каждой жертвы клипа (по очереди после клипа) и облёт на последнем фраге.
      // Повторы нужны и при пересборке без игры — по ним считается длина клипа (они уже есть в записи).
      if (fx.camVictim || (!reuse && fx.camOrbit)) {
        setStage(tr("кинокамера..."));
        const kills = sel.map((c) => c.killTicks?.[c.killTicks.length - 1] ?? null);
        const orbitOn = !reuse && fx.camOrbit;
        const data = orbitOn
          ? JSON.parse(await invoke("parse_cine", { path: demo.path, steamid: playerId, kills: JSON.stringify(kills.filter((k) => k != null)) }))
          : [];
        let di = 0;
        sel.forEach((c, i) => {
          const kill = kills[i];
          if (kill == null) return;
          // killTicks отсортированы, а victims идут в порядке событий демки — сортируем пары вместе
          const order = (c.rawTicks || c.killTicks).map((t, j) => [t, c.victims?.[j]]).sort((a, b) => a[0] - b[0]);
          const victims = fx.camVictim
            ? order.map(([t, v]) => ({ kill: t, slot: roster.find((p) => p.id === v)?.slot })).filter((v) => v.slot != null)
            : [];
          const orbit = orbitOn ? orbitPath(data[di++], kill, c.end, fov) : null;
          c.cine = { kill, victimSlot: victims.at(-1)?.slot ?? null, victims, orbitXml: orbit?.xml ?? null, orbitEnd: orbit?.end ?? null };
        });
        stopped();
      }
      // Клипы склеиваются в один ролик — песня идёт через них подряд, без перескоков назад
      // (длина клипа известна только теперь: в неё входят повторы глазами жертв)
      if (merge.on && sel.length >= 2 && music.enabled && music.path) {
        chainMusic({ clips: sel, lrc: music.lrc, start: music.start, slowmo: fx.slowmo,
          chorusSlow: !!music.chorusSlow, chorusOnKill: music.chorusOnKill !== false });
      }
      // Текст песни: кадры на каждый клип (папки lyr_N), накладываются после slow-mo
      const withMusic = music.enabled && music.path;
      if (withMusic && music.showLyrics && music.lrc) {
        setStage(tr("текст песни: углы камеры..."));
        // куда смотрела камера на каждом тике клипов — текст «закрепляется» в мире
        const cams = JSON.parse(await invoke("parse_cam", {
          path: demo.path, steamid: playerId, ranges: JSON.stringify(sel.map((c) => [c.start, c.end])),
        }));
        const work = await join(paths.out, ".clipforge_tmp", stamp);
        for (let i = 0; i < sel.length; i++) {
          stopped();
          const dir = await join(work, `lyr_${i}`);
          const save = (name, bytes) => invoke("save_file", bytes, { headers: { "x-path": encodeURIComponent(`${dir}\\${name}`) } });
          // для стилей «под бит» слова встают на удары трека: находим их в куске под этот клип
          const lyricStart = sel[i].musicStart ?? music.start;
          const beats = lyricStyle(music.lyricStyle).snap
            ? (await invoke("track_beats", { hlae: paths.hlae, path: music.path, offset: lyricStart, dur: 120 }).catch(() => [])).map((b) => lyricStart + b)
            : [];
          const list = await renderLyricFrames({
            lrc: music.lrc, start: sel[i].musicStart ?? music.start, clip: sel[i], cam: cams[i] || [], slowmo: fx.slowmo, drops: sel[i].drops || [], fov, fps,
            W: width, H: height, save, style: music.lyricStyle, beats, smart: music.smartLyrics !== false,
            onFrame: (f, n) => { stopped(); setStage(tr("текст песни: клип {0}/{1} · {2}%", i + 1, sel.length, Math.round((f / n) * 100))); },
          });
          await save("lyrics.ffconcat", new TextEncoder().encode(list));
        }
      }
      // Скины: игра проигрывает переписанную копию демки, оригинал не трогаем
      let demoPath = demo.path;
      // скины — часть записи: при пересборке без игры они уже такие, какими были записаны
      if (!reuse && !planIsEmpty(skinPlan)) {
        setStage(tr("перекрашиваю демку..."));
        demoPath = await join(paths.out, ".clipforge_tmp", stamp, "skins.dem");
        await invoke("rewrite_skins", {
          input: demo.path, output: demoPath, steamid: playerId,
          ranges: sel.map((c) => [c.start, c.end]), plan: planForRust(skinPlan),
        });
      }
      stopped();
      setStage("");
      await invoke("start_render", { job: { demo: demoPath, hlae: paths.hlae, cs2: paths.cs2, out: paths.out,
        clips: sel, fps, blur, fov, width, height, crf, vmFov: vm.fov, vmX: vm.x, vmY: vm.y, vmZ: vm.z,
        voiceIndices: voicePayload.indices, voiceIndicesHigh: voicePayload.indicesHigh,
        gpuEncoder: useGpu && gpuEnc ? gpuEnc : null, ...fx, stamp, startKey, stretch: stretch && aspect === "4:3", merge: merge.on, keepParts: merge.keep,
        music: withMusic ? {
          path: music.path, offset: music.start, musicVol: music.musicVol, gameVol: music.gameVol,
          beatFx: music.beatFx ? music.beatMode || "zoom" : null, beatAmount: music.beatAmount ?? 1,
        } : null,
        reuseLast: reuse } });
    } catch (e) { setRendering(false); setStage(""); setError(String(e.message || e)); }
  };

  // «Остановить»: до запуска игры прерывает подготовку, после — Rust закрывает игру и выходит
  const stopRender = () => {
    cancelRef.current = true;
    setStage(tr("останавливаю..."));
    invoke("cancel_render").catch(() => {});
  };

  const canRender = demo && picked.size > 0 && validSlot && !rendering && paths.hlae && paths.cs2 && paths.out;

  // коротко, что включено на каждой вкладке «Настроек клипа»
  const onList = (pairs, none) => pairs.filter(([on]) => on).map(([, l]) => l).join(" · ") || none;
  const skinCount = Object.keys(skinPlan.weapons || {}).length + (skinPlan.knife ? 1 : 0) + (skinPlan.gloves ? 1 : 0);
  const studioSummary = {
    video: `${res.label} · ${aspect} · ${fps} fps${blur ? " · blur" : ""}`,
    effects: onList([[fx.slowmo, "slow-mo"], [fx.damage, tr("урон")], [fx.killFlash, tr("вспышка")], [fx.hsZoom, tr("зум на HS")], [!!fx.atmo, tr(ATMOS.find((a) => a.id === fx.atmo)?.label ?? "").toLowerCase()], [fx.xray, "x-ray"], [fx.hud !== "full", fx.hud === "match" ? tr("HUD матча") : tr("килфид")]], tr("без эффектов")),
    camera: onList([[fx.camVictim, tr("повтор")], [fx.camOrbit, tr("облет")]], tr("обычная")),
    sound: onList([[voice !== "none", tr("голоса: {0}", tr(VOICE_MODES.find(([k]) => k === voice)?.[1] ?? "").toLowerCase())], [music.enabled && music.path, tr("трек")], [music.enabled && music.path && music.beatFx, tr("в такт")]], tr("звук игры")),
    skins: skinCount ? tr("изменено: {0}", skinCount) : tr("как в демке"),
  };
  const estSize = Math.round(((picked.size * 14 + 10) * res.mbps) / 8);

  const resetPaths = () => setPaths({ ...DEFAULT_PATHS, out: defaultOut });

  return (
    <div className="app" ref={appRef}>
      <div className="hazard" />
      <nav className="topbar">
        <div className="brand"><i className="brand__mark" /><span>clipforge</span><em className="mono dim">cs2</em></div>
        <ul role="tablist" className="tabs">
          {TABS.map((t, i) => (
            <li key={t}>
              <button role="tab" aria-selected={tab === i} className={tab === i ? "is-active" : ""}
                ref={(el) => (tabRefs.current[i] = el)} onClick={() => setTab(i)}>{tr(t)}</button>
            </li>
          ))}
          {ink && <li className="tabs__ink" aria-hidden="true" style={{ "--x": `${ink.left}px`, width: ink.width }} />}
        </ul>
        <div className="status mono"><i className="dot" /> {tr("CS2 найден")}</div>
      </nav>

      {tab === HIGHLIGHTS_TAB ? (
        <main className="grid" key={tab}>
          <Gallery hlae={paths.hlae} out={paths.out} refreshKey={`${rendering}${openClip}`} openPath={openClip} onOpened={() => setOpenClip(null)} />
        </main>
      ) : tab === ARCHIVE_TAB ? (
        <main className="grid" key={tab}>
          <Frame title={tr("Архив демок")} meta={tr("{0} файлов", archive.length)} className="span-2">
            {archive.length === 0 ? (
              <p className="empty dim">{tr("Здесь появятся все демки, которые ты когда-либо открывал.")}</p>
            ) : (
              <ul className="archive">
                {archive.map((d) => (
                  <li key={d.path} className={demo?.path === d.path ? "is-current" : ""}>
                    {renaming === d.path ? (
                      <input className="archive__input mono" autoFocus defaultValue={d.title || d.file}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") { e.currentTarget.dataset.cancel = "1"; e.currentTarget.blur(); }
                        }}
                        onBlur={(e) => {
                          if (!e.currentTarget.dataset.cancel) {
                            const v = e.currentTarget.value.trim();
                            renameDemo(d.path, v === d.file ? "" : v);
                          }
                          setRenaming(null);
                        }} />
                    ) : (
                      <button type="button" className="archive__open" onClick={() => openFromArchive(d.path)}
                        title={tr("Открыть демку")}>
                        <b>
                          {d.info?.map && <span className="ar-map" style={{ "--map": mapTint(d.info.map) }}>{mapName(d.info.map)}</span>}
                          {d.title || d.file}
                          {d.info?.score && <span className="ar-score mono">{d.info.score}</span>}
                        </b>
                        <span className="mono dim">
                          {d.title && `${d.file} · `}{d.info?.source && `${d.info.source} · `}{d.info?.matchSec ? tr("{0} мин · ", Math.round(d.info.matchSec / 60)) : ""}
                          {fmtSize(d.size)} · {d.clips} {tr("хайлайтов ·")} {fmtDate(d.openedAt)}
                        </span>
                        <span className="mono dim archive__path">{d.path}</span>
                      </button>
                    )}
                    <div className="archive__acts">
                      {cachedInfo(d.path) && (
                        <button type="button" className={`chip ${archiveOpen === d.path ? "is-on" : ""}`}
                          onClick={() => setArchiveOpen((o) => (o === d.path ? null : d.path))}>{tr("Досье")}</button>
                      )}
                      <button type="button" className="chip" onClick={() => setRenaming(d.path)}>{tr("Переименовать")}</button>
                      <button type="button" className="chip chip--del" onClick={() => removeDemo(d.path)}
                        title={tr("Убрать из архива. Файл на диске останется")}>{tr("Убрать")}</button>
                    </div>
                    {archiveOpen === d.path && (
                      <div className="archive__dz">
                        <MatchDossier info={cachedInfo(d.path)} faceit={cachedInfo(d.path)?.faceit} Hint={Hint} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="mono err">{trError(error)}</p>}
          </Frame>
        </main>
      ) : tab === SETTINGS_TAB ? (
        <main className="grid" key={tab}>
          <Frame title={tr("Пути")} meta="HLAE + CS2" className="span-2">
            <div className="nums">
              {[["hlae", "HLAE.exe"], ["cs2", "cs2.exe"]].map(([k, l]) => (
                <label className="num" key={k}>
                  <span className="mono dim">{l}</span>
                  <input className="mono" value={paths[k]} onChange={(e) => setPaths({ ...paths, [k]: e.target.value })} />
                </label>
              ))}
            </div>
            <label className="num">
              <span className="mono dim">{tr("куда сохранять хайлайты")}</span>
              <span className="path-pick">
                <input className="mono" value={paths.out} onChange={(e) => setPaths({ ...paths, out: e.target.value })} />
                <button type="button" className="chip" onClick={pickOutDir}>{tr("Выбрать...")}</button>
              </span>
            </label>
            {error && <p className="mono err">{trError(error)}</p>}
          </Frame>

          <Frame title={tr("Язык")} meta={lang === "ru" ? "Русский" : "English"} className="span-2"
            help={tr("При первом запуске язык берется из системы. Переключается сразу, без перезапуска.")}>
            <div className="ratios lang-pick" role="radiogroup" aria-label={tr("Язык")}>
              {[["ru", "Русский"], ["en", "English"]].map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={lang === k} className={lang === k ? "is-on" : ""}
                  onClick={() => setLang(k)}>{l}</button>
              ))}
            </div>
          </Frame>

          <Frame title={tr("Видео по умолчанию")} className="span-2"
            meta={`${videoDefault.aspect} · ${RESOLUTIONS.find((r) => r.id === videoDefault.resId)?.label ?? ""}${videoDefault.aspect === "4:3" && videoDefault.stretch ? tr(" · растянуто") : ""}`}
            help={tr("С этого формата начинается каждый клип после запуска программы. В \"Настройках клипа\" его можно поменять для конкретного рендера - по умолчанию останется этот.")}>
            <span className="mono dim sub">{tr("пропорции")}</span>
            <div className="ratios" role="radiogroup" aria-label={tr("Пропорции по умолчанию")}>
              {RATIOS.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={videoDefault.aspect === r}
                  className={videoDefault.aspect === r ? "is-on" : ""} onClick={() => applyVideoDefault({ aspect: r })}>{r}</button>
              ))}
            </div>
            <span className="mono dim sub">{tr("разрешение")}</span>
            <div className="presets" role="radiogroup" aria-label={tr("Разрешение по умолчанию")}>
              {RESOLUTIONS.filter((r) => r.ratio === videoDefault.aspect).map((r) => (
                <button key={r.id} role="radio" aria-checked={videoDefault.resId === r.id} type="button"
                  className={videoDefault.resId === r.id ? "is-on" : ""} onClick={() => applyVideoDefault({ resId: r.id })}>
                  <b className="mono">{r.label}</b>
                  <small className="mono dim">{r.width}×{r.height}</small>
                </button>
              ))}
            </div>
            <div className={`mu-sub ${videoDefault.aspect === "4:3" ? "is-open" : ""}`}>
              <Toggle label={tr("Растягивать 4:3 до 16:9")} hint={tr("Stretched, как в игре - без черных полос")}
                checked={videoDefault.stretch} disabled={videoDefault.aspect !== "4:3"} onChange={(v) => applyVideoDefault({ stretch: v })} />
            </div>
          </Frame>

          <Frame title={tr("Запуск записи")} meta={tr("клавиша {0}", START_KEYS.find(([k]) => k === startKey)?.[1])} className="span-2"
            help={tr("После запуска рендера игра открывает демку, и ничего не пишется, пока ты не нажмешь эту клавишу: можно спокойно досмотреть демку. Поверх игры висит подсказка с клавишей - в запись она не попадает.")}>
            <div className="ratios start-keys" role="radiogroup" aria-label={tr("Клавиша запуска записи")}>
              {START_KEYS.map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={startKey === k} className={startKey === k ? "is-on" : ""}
                  onClick={() => setStartKey(k)}>{l}</button>
              ))}
            </div>
            <p className="mono dim" style={{ margin: 0, fontSize: ".75rem" }}>
              {tr("выбери клавишу, которая в CS2 ни на что не назначена - иначе вместе с записью сработает и ее действие")}
            </p>
          </Frame>

          <Frame title="FACEIT" meta={faceitKey.trim() ? tr("ключ указан") : tr("необязательно")} className="span-2"
            help={tr("В самой демке уровней FACEIT нет - их отдает только FACEIT по ключу API. Ключ бесплатный: developers.faceit.com → App Studio → создать приложение → API Keys → Server side. Ключ хранится только на этом компьютере.")}>
            <label className="num">
              <span className="mono dim">{tr("ключ FACEIT Data API - для уровней и эло игроков в \"Досье матча\"")}</span>
              <input className="mono" value={faceitKey} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false}
                onChange={(e) => setFaceitKey(e.target.value)} />
            </label>
          </Frame>

          <Frame title={tr("О приложении")} meta="clipforge">
            <div className="about">
              <div className="about__row"><span className="mono dim">{tr("версия")}</span><span className="mono">{APP_VERSION}</span></div>
              <div className="about__row"><span className="mono dim">{tr("движок записи")}</span><span className="mono">HLAE + ffmpeg</span></div>
              <div className="about__row"><span className="mono dim">{tr("парсер демок")}</span><span className="mono">demoparser2</span></div>
            </div>
          </Frame>

          <Frame title={tr("Сброс")} meta={tr("локальные настройки")}>
            <p className="dim" style={{ margin: 0 }}>
              {tr("Вернуть пути к HLAE, CS2 и папке вывода к значениям по умолчанию.")}
            </p>
            <button type="button" className="go go--ghost" onClick={resetPaths}>
              {tr("Сбросить пути")}
            </button>
          </Frame>
        </main>
      ) : (
        <main className="grid" key={tab}>
          <Frame title={tr("Демо-файл")} meta={demo ? tr("загружено") : tr("ожидание")} className="span-2">
            <div
              className={`drop ${over ? "is-over" : ""} ${demo ? "is-loaded" : ""}`}
              onClick={pickFile}
              role="button" tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && pickFile()}
            >
              <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
              {demo ? (
                <div className="drop__file">
                  <b className="mono">{demoTitle}</b>
                  <span className="mono dim">
                    {info && `${mapName(info.map)} · ${info.teams?.map((t) => t.score).join(":") || ""} · `}
                    {fmtSize(demo.size)} · {players.length} {tr("игроков ·")} {clips.length} {tr("моментов")}
                  </span>
                </div>
              ) : (
                <div className="drop__empty">
                  <b>{parsing ? tr("Анализирую демку...") : tr("Перетащи .dem сюда")}</b>
                  <span className="dim">{tr("или нажми, чтобы выбрать файл. Хайлайты найдутся автоматически.")}</span>
                </div>
              )}
            </div>
            {error && <p className="mono err">{trError(error)}</p>}
          </Frame>

          {demo && (
            <Frame title={tr("Досье матча")} meta={infoBusy ? tr("разбираю...") : info ? tr("{0} игроков · {1} киллов", info.players.length, info.facts?.kills ?? 0) : ""} className="span-2"
              help={tr("Все, что можно вытащить из демки сверх обычного: прицелы игроков, точность, контрстрейф, время до убийства, пробежка, чат, настройки сервера. Уровни FACEIT - если в \"Настройках\" указан ключ API.")}>
              <MatchDossier info={info} busy={infoBusy} playerId={playerId} faceit={faceit} faceitErr={faceitErr} Hint={Hint}
                clipCount={clipCount} onPick={(id) => players.some((p) => p.id === id) && setPlayerId(id)}
                onCard={() => makeCard()} />
            </Frame>
          )}

          <Frame title={tr("Анализ матча")} meta={tr("{0} событий", events.length)} className="span-2">
            {/* игрок выбирается кликом по нику в «Досье матча»; пока досье считается — здесь */}
            {players.length > 0 && !info && (
              <div className="players" role="radiogroup" aria-label={tr("Игрок")}>
                {players.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={playerId === p.id}
                    className={playerId === p.id ? "is-on" : ""} onClick={() => setPlayerId(p.id)}>
                    <b>{p.name}</b>
                    <span className="mono dim">{p.kills} K · {clips.filter((c) => c.steamid === p.id).length} {tr("клипов")}</span>
                  </button>
                ))}
              </div>
            )}

            {info && playerId && (
              <p className="an-player mono dim">
                {tr("игрок")} <b>{players.find((p) => p.id === playerId)?.name}</b> · {myClips.length} {tr("клип. · сменить - клик по нику в досье")}
              </p>
            )}
            <div className="chips">
              {[["ace", tr("Эйсы"), stats.ace], ["clutch", tr("Клатчи"), stats.clutch], ["multi", tr("2-4 килла"), stats.multi], ["skill", tr("Красивые фраги"), stats.skill]].map(([k, l, n]) => (
                <button key={k} type="button" className={`chip chip--${k} ${filter[k] ? "is-on" : ""}`}
                  onClick={() => setFilter((f) => ({ ...f, [k]: !f[k] }))}>
                  {l} <b className="mono">{n}</b>
                </button>
              ))}
              <span className="chips__spacer" />
              <span className="mono dim">{tr("выбрано")} {picked.size}</span>
            </div>
            {rounds.some((r) => r.kind) && (
              <div className="mo-bar">
                <div className="ratios mo-sort" role="radiogroup" aria-label={tr("Порядок моментов")}>
                  {[["score", tr("По крутости")], ["round", tr("По раундам")]].map(([k, l]) => (
                    <button key={k} type="button" role="radio" aria-checked={momentSort === k} className={momentSort === k ? "is-on" : ""}
                      onClick={() => setMomentSort(k)}>{l}</button>
                  ))}
                </div>
                <span className="chips__spacer" />
                <button type="button" className="chip" onClick={() => setPicked(new Set(bestRounds()))}
                  title={tr("Эйсы, клатчи и все моменты от \"Топ\" и выше")}>{tr("✦ Лучшие")}</button>
                <button type="button" className="chip" onClick={() => setPicked(new Set(events.map((r) => r.round)))}>{tr("Все показанные")}</button>
                <button type="button" className="chip" onClick={() => setPicked(new Set())}>{tr("Снять")}</button>
              </div>
            )}

            {rounds.length === 0 ? (
              <p className="empty dim">{tr("Загрузи демку, и здесь появится шкала раундов с найденными моментами.")}</p>
            ) : (
              <>
                <div className="scale" style={{ gridTemplateColumns: `repeat(${rounds.length}, 1fr)` }} role="group" aria-label={tr("Раунды матча")}>
                  {rounds.map((r, i) => {
                    const hit = shown(r);
                    const type = r.kind || "none";
                    return (
                      <button key={r.round} type="button"
                        className={`bar bar--${hit ? type : "none"} ${picked.has(r.round) && hit ? "is-picked" : ""}`}
                        style={{ "--h": `${r.kind ? 14 + (r.score / topScore) * 86 : 8}%`, "--i": i }}
                        disabled={!hit} onClick={() => toggleRound(r.round)}
                        title={r.kind ? tr("Раунд {0} · {1} баллов · {2}", r.round, r.score, r.tags.map(tagLabel).join(", ")) : tr("Раунд {0}", r.round)}>
                        <span className="bar__fill" />
                      </button>
                    );
                  })}
                </div>
                <div className="scale__axis mono dim"><span>R1</span><span>R12</span><span>R24</span></div>

                <ul className="events mo-list">
                  {events.map((r, i) => {
                    const [, tier, tierName] = tierOf(r.score);
                    const lead = r.clutch ? `1v${r.clutch}` : r.tags[0];
                    const rest = r.tags.filter((t) => t !== lead && !t.startsWith("клатч"));
                    return (
                      <li key={r.round} style={{ "--i": i }}>
                        <button type="button" className={`mo mo--${tier} ${picked.has(r.round) ? "is-picked" : ""}`} onClick={() => toggleRound(r.round)}>
                          <span className="mo-head">
                            <span className="mono dim">R{String(r.round).padStart(2, "0")}</span>
                            <span className={`tag tag--${r.kind}`}>{tagLabel(lead)}</span>
                            <span className={`mo-tier mo-tier--${tier}`}>{tr(tierName)}</span>
                            <b className="mo-score mono">{r.score}</b>
                            <i className="check" />
                          </span>
                          <span className="mo-meter"><i style={{ width: `${Math.min(100, (r.score / topScore) * 100)}%` }} /></span>
                          {rest.length > 0 && (
                            <span className="mo-tags">{rest.slice(0, 5).map((t) => <em key={t}>{tagLabel(t)}</em>)}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Frame>

{/* Все настройки клипа — один блок с вкладками: короче страница, а сводка на вкладке
              показывает, что включено, не открывая её */}
          <Frame title={tr("Настройки клипа")} meta={tr("все, что попадет в рендер")} className="span-2 studio"
            help={tr("Настройки разложены по вкладкам. Под названием каждой вкладки - коротко, что сейчас включено.")}>
            <div className="studio__tabs" role="tablist" aria-label={tr("Настройки клипа")}>
              {STUDIO_TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={studioTab === t.id}
                  className={studioTab === t.id ? "is-on" : ""} onClick={() => setStudioTab(t.id)}>
                  <span className="studio__ico" aria-hidden="true">{t.icon}</span>
                  <span className="studio__name">{tr(t.label)}</span>
                  <small className="studio__sum mono">{studioSummary[t.id]}</small>
                </button>
              ))}
            </div>

            <div className="studio__body" key={studioTab}>
              {studioTab === "video" && (
                <div className="studio-cols">
                  <div className="studio-col">
                    <span className="mono dim sub">{tr("пропорции")}<Hint text={tr("16:9 - YouTube и обычные видео, 9:16 - TikTok, Shorts и Reels, 1:1 - посты, 4:3 - растянутый \"про\"-формат.")} /></span>
                    <div className="ratios" role="radiogroup" aria-label={tr("Соотношение сторон")}>
                      {RATIOS.map((r) => (
                        <button key={r} type="button" role="radio" aria-checked={aspect === r}
                          className={aspect === r ? "is-on" : ""} onClick={() => setAspect(r)}>{r}</button>
                      ))}
                    </div>
                    <div className={`mu-sub ${aspect === "4:3" ? "is-open" : ""}`}>
                      <Toggle label={tr("Растянуть до 16:9")} hint={tr("Stretched, как в игре на 4:3 - во весь экран без черных полос")}
                        checked={stretch} disabled={aspect !== "4:3"} onChange={setStretch}
                        help={tr("Игра пишется в 4:3, а готовое видео растягивается по ширине до 16:9 - как выглядит игра у тех, кто играет на растянутом разрешении. Плееры и YouTube покажут его во весь экран, без полос по бокам.")} />
                    </div>
                    <Toggle label={tr("Склеить клипы в один ролик")} hint={tr("Несколько хайлайтов - одно видео подряд")}
                      checked={merge.on} onChange={(v) => setMerge((m) => ({ ...m, on: v }))}
                      help={tr("Если выбрано несколько моментов, после рендера они склеиваются в один ролик по порядку раундов. Видео не пережимается, поэтому склейка занимает секунды. Отдельные клипы по умолчанию убираются из папки, чтобы не мешали, но остаются доступны в \"До / после\".")} />
                    <div className={`mu-sub ${merge.on ? "is-open" : ""}`}>
                      <Toggle label={tr("Оставить и отдельные клипы")} hint={tr("Рядом с роликом будут лежать клипы по одному")}
                        checked={merge.keep} disabled={!merge.on} onChange={(v) => setMerge((m) => ({ ...m, keep: v }))} />
                    </div>
                    <span className="mono dim sub">{tr("разрешение")}<Hint text={tr("Чем выше, тем четче картинка, но дольше запись и тяжелее файл.")} /></span>
                    <div className="presets" role="radiogroup" aria-label={tr("Разрешение")}>
                      {resOptions.map((r) => (
                        <button key={r.id} role="radio" aria-checked={resId === r.id} type="button"
                          className={resId === r.id ? "is-on" : ""} onClick={() => setResId(r.id)}>
                          <b className="mono">{r.label}</b>
                          <small className="mono dim">{r.width}×{r.height}</small>
                        </button>
                      ))}
                    </div>
                    <Slider label={tr("Целевой FPS")} value={fps} min={30} max={240} step={30} onChange={setFps}
                      help={tr("Частота кадров готового клипа. 60 - стандарт для соцсетей, 120+ - для плавного монтажа и замедлений.")} />
                    <Slider label="FOV" value={fov} min={60} max={120} onChange={setFov}
                      help={tr("Угол обзора камеры. Больше - видно шире, но края картинки растягиваются. В игре по умолчанию 90.")} />
                  </div>
                  <div className="studio-col">
                    <Toggle label="Motion Blur" hint={tr("Смешивание субкадров")} checked={blur} onChange={setBlur}
                      help={tr("Игра пишется с тройной частотой кадров, и каждые три кадра смешиваются в один. Движения выглядят мягко и \"кинематографично\".")} />
                    <Toggle label={tr("Кодировать на GPU")}
                      help={tr("Сжимать видео на видеокарте, а не на процессоре. В разы быстрее, качество почти то же. Если не получится, программа сама перейдет на CPU.")}
                      hint={gpuEnc === undefined ? tr("Проверяю видеокарту...") : gpuEnc ? tr("{0} · в разы быстрее CPU", GPU_NAMES[gpuEnc]) : tr("Аппаратный кодировщик не найден")}
                      checked={useGpu && !!gpuEnc} disabled={!gpuEnc} onChange={setUseGpu} />
                    <Toggle label={tr("Обрезать тишину")} hint={tr("Убрать мертвое время вокруг фрага")} checked={trim} onChange={setTrim}
                      help={tr("Клип начинается и заканчивается рядом с киллами. Поля \"до\" и \"после\" задают, сколько секунд оставить вокруг них.")} />
                    <div className={`nums ${trim ? "" : "is-off"}`}>
                      <NumField label={tr("до, сек")} value={pad.before} onChange={(v) => setPad({ ...pad, before: v })} />
                      <NumField label={tr("после, сек")} value={pad.after} onChange={(v) => setPad({ ...pad, after: v })} />
                    </div>
                    <span className="mono dim sub">viewmodel<Hint text={tr("Положение оружия в руках на экране: угол обзора модели и смещение по осям X, Y, Z. Как viewmodel-настройки в игре.")} /></span>
                    <div className="nums nums--4">
                      <NumField label="fov" value={vm.fov} onChange={(v) => setVm({ ...vm, fov: v })} />
                      <NumField label="x" value={vm.x} onChange={(v) => setVm({ ...vm, x: v })} />
                      <NumField label="y" value={vm.y} onChange={(v) => setVm({ ...vm, y: v })} />
                      <NumField label="z" value={vm.z} onChange={(v) => setVm({ ...vm, z: v })} />
                    </div>
                  </div>
                </div>
              )}

              {studioTab === "effects" && (
                <>
                  <div className="toggles">
                    <Toggle label={tr("Slow-motion на фрагах")} hint={tr("Разгон → замедление → разгон вокруг каждого килла")}
                      checked={fx.slowmo} onChange={(v) => setFx({ ...fx, slowmo: v })}
                      help={tr("Вокруг каждого килла видео плавно замедляется примерно в 3 раза и снова разгоняется. Звук замедляется вместе с картинкой.")}
                      preview={<SlowmoCurve />} />
                    <Toggle label={tr("Цифры урона")} hint={tr("Всплывают у прицела, хедшоты желтым")}
                      checked={fx.damage} onChange={(v) => setFx({ ...fx, damage: v })}
                      help={tr("Рядом с прицелом всплывает урон, нанесенный тем, кого ты убил в этом клипе. Попадания в голову желтые. Рисуется поверх готового видео.")}
                      preview={
                        <Shot src={shotHudMatch} ratio={CLEAN} crop>
                          <span className="pv-dmg" style={{ left: "57%", top: "38%" }}>27</span>
                          <span className="pv-dmg pv-dmg--head" style={{ left: "61%", top: "58%" }}>100</span>
                        </Shot>
                      } />
                    <div>
                    <Toggle label={tr("Вспышка на килле")} hint={tr("Мягкое свечение кадра в момент фрага")}
                      checked={fx.killFlash} onChange={(v) => setFx({ ...fx, killFlash: v })}
                      help={tr("На каждом килле кадр за долю секунды мягко засвечивается: картинка будто светится изнутри, с легким оттенком, и плавно гаснет. Совпадает с киллом и при slow-mo.")}
                      preview={
                        <Shot src={shotHudMatch} ratio={CLEAN} crop>
                          <span className={`pv-flash pv-flash--${fx.flashColor}`} />
                        </Shot>
                      } />
                    <div className={`mu-sub ${fx.killFlash ? "is-open" : ""}`}>
                      <div className="ratios flash-colors" role="radiogroup" aria-label={tr("Оттенок вспышки")}>
                        {FLASH_COLORS.map(([k, l]) => (
                          <button key={k} type="button" role="radio" aria-checked={fx.flashColor === k}
                            className={fx.flashColor === k ? "is-on" : ""} onClick={() => setFx({ ...fx, flashColor: k })}>
                            <i className={`flash-dot flash-dot--${k}`} />{tr(l)}
                          </button>
                        ))}
                      </div>
                    </div>
                    </div>
                    <Toggle label={tr("Зум на хедшот")} hint={tr("Кадр на полсекунды наезжает на цель при килле в голову")}
                      checked={fx.hsZoom} onChange={(v) => setFx({ ...fx, hsZoom: v })}
                      help={tr("На каждом убийстве в голову картинка быстро приближается к прицелу (там и была голова цели), держится четверть секунды и плавно возвращается. Время считается на готовом клипе, поэтому совпадает и при slow-mo.")}
                      preview={<Shot src={shotHudMatch} ratio={CLEAN} crop><span className="pv-hszoom" /></Shot>} />
                    <Toggle label="X-ray" hint={tr("Подсветка игроков сквозь стены · spec_show_xray")}
                      checked={fx.xray} onChange={(v) => setFx({ ...fx, xray: v })}
                      help={tr("Обводка игроков сквозь стены, как у наблюдателя в демке. Выключи, чтобы клип выглядел как обычная игра.")} />
                    <Toggle label={tr("Скрыть демо-панель")} hint={tr("Закрыть demoui перед записью")}
                      checked={fx.hideDemoUi} onChange={(v) => setFx({ ...fx, hideDemoUi: v })}
                      help={tr("Закрывает панель управления демкой (перемотка, скорость), чтобы она не попала в кадр.")} />
                  </div>
                  <hr className="sep" />
                  <span className="mono dim sub">{tr("интерфейс игры")}<Hint text={tr("Что из игрового HUD будет видно в записи.")} /></span>
                  <div className="ratios hud-modes" role="radiogroup" aria-label={tr("Интерфейс игры")}>
                    {HUD_MODES.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={fx.hud === m.id}
                        aria-disabled={m.soon || undefined}
                        className={`${fx.hud === m.id ? "is-on" : ""} ${m.soon ? "is-soon" : ""}`}
                        onClick={() => !m.soon && setFx({ ...fx, hud: m.id })}>
                        {tr(m.label)}{m.soon && <em className="soon">{tr("скоро")}</em>}<Hint text={tr(m.help)} preview={m.preview} />
                      </button>
                    ))}
                  </div>
                  <hr className="sep" />
                  <span className="mono dim sub">{tr("атмосфера")}<Hint text={tr("Время суток и погода. Цвет и свет меняются при сборке клипа, поэтому работает и \"Пересобрать без игры\".")} /></span>
                  <div className="ratios atmos" role="radiogroup" aria-label={tr("Атмосфера")}>
                    {ATMOS.map((a) => (
                      <button key={a.id || "off"} type="button" role="radio" aria-checked={fx.atmo === a.id}
                        className={`atmo-btn atmo-btn--${a.id || "off"} ${fx.atmo === a.id ? "is-on" : ""}`}
                        onClick={() => setFx({ ...fx, atmo: a.id })}>
                        <i />{tr(a.label)}<Hint text={tr(a.help)} preview={a.preview} />
                      </button>
                    ))}
                  </div>
                  <div className={`mu-sub ${fx.atmo ? "is-open" : ""}`}>
                    <Toggle label={tr("Туман и небо в самой игре")} hint={tr("Экспериментально · fog_override и mirv_sky во время записи")}
                      checked={fx.atmoGame} disabled={!fx.atmo} onChange={(v) => setFx({ ...fx, atmoGame: v })}
                      help={tr("Кроме цветокоррекции, во время записи в CS2 включается туман нужного цвета, а небо и облака перекрашиваются через HLAE. Так дальние планы правда тонут в тумане. Если туман в клипе выглядит странно - выключи, останется только цветокоррекция.")} />
                  </div>
                </>
              )}

              {studioTab === "camera" && (
                <div className="toggles">
                  <Toggle label={tr("Повтор от лица убитого")} hint={tr("После клипа - каждый фраг глазами его жертвы")}
                    checked={fx.camVictim} onChange={(v) => setFx({ ...fx, camVictim: v })}
                    help={tr("Клип идет как обычно - видно, как ты убиваешь. Потом по очереди для каждого килла демка отматывается примерно на 1.2 с назад и показывает его глазами убитого, до его смерти. Повторы дописываются в конец клипа: 4 килла - 4 коротких повтора по ~1.5 с.")} />
                  <Toggle label={tr("Облет после фрага")} hint={tr("Кинокамера от третьего лица · экспериментально")}
                    checked={fx.camOrbit} onChange={(v) => setFx({ ...fx, camOrbit: v })}
                    help={tr("Сразу после последнего килла клипа камера HLAE (mirv_campath) плавно облетает игрока по дуге: начинает из-за плеча и уходит в сторону, слегка отдаляясь. HUD и руки с оружием на это время прячутся. Стены камера не учитывает - в тесном месте может заглянуть в текстуру.")} />
                </div>
              )}

              {studioTab === "sound" && (
                <>
                  <span className="mono dim sub">{tr("голосовой чат")}<Hint text={tr("Чьи голоса из демки попадут в звук клипа: ничьи, всех, только твоей команды или только соперников.")} /></span>
                  <div className="ratios" role="radiogroup" aria-label={tr("Голосовой чат")}>
                    {VOICE_MODES.map(([k, l]) => (
                      <button key={k} type="button" role="radio" aria-checked={voice === k}
                        className={voice === k ? "is-on" : ""} onClick={() => setVoice(k)}>{tr(l)}</button>
                    ))}
                  </div>
                  <hr className="sep" />
                  <MusicPanel music={music} setMusic={setMusic} hlae={paths.hlae} clipLen={clipLen} Toggle={Toggle} Hint={Hint} />
                </>
              )}

              {studioTab === "skins" && (
                <SkinsPanel demo={demo} playerId={playerId} ranges={pickedRanges} plan={skinPlan} setPlan={setSkinPlan} />
              )}
            </div>
          </Frame>

          <section className="launch span-2">
            <div className="launch__info mono">
              <span>{picked.size} {tr("клипов")}</span>
              <span className="dim">≈ {estSize} MB</span>
              <span className={`accent ${rendering ? "pulse" : ""}`}>{stage || (rendering ? tr("рендер...") : progress >= 100 ? tr("готово") : tr("ожидание"))}</span>
            </div>
            <div className={`meter ${rendering ? "is-running" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
              <div className="meter__track">
                <div className="meter__fill" style={{ width: `${progress}%` }} />
                {Array.from({ length: 19 }, (_, i) => <i key={i} style={{ left: `${(i + 1) * 5}%` }} />)}
              </div>
              <div className="meter__legend mono">
                <span className="y">{progress.toFixed(1)}%</span>
                <span className="dim">{Math.round((progress / 100) * picked.size)} / {picked.size}</span>
              </div>
            </div>
            {rendering ? (
              <button type="button" className="go go--stop" onClick={stopRender}>{tr("Остановить")}</button>
            ) : (
              <div className="launch__btns">
                {lastRender && (
                  <button type="button" className="go go--ghost go--reuse" disabled={!canRender} onClick={() => startRender(true)}
                    title={tr("Заново наложить музыку, текст, замедления, цифры урона и HUD на запись прошлого рендера - без запуска CS2. Клипы и разрешение должны совпадать; скины, X-ray, FOV и viewmodel остаются как были записаны.")}>
                    {tr("Пересобрать без игры")}
                    <small className="mono">{lastRender.clips.length} {tr("клип. ·")} {lastRender.width}×{lastRender.height}</small>
                  </button>
                )}
                {compareList.length > 0 && (
                  <button type="button" className="go go--ghost" onClick={() => setCompareOpen(true)}
                    title={tr("Шторка: слева сырая запись из демки, справа готовый клип с эффектами - тот же момент")}>
                    {tr("До / после")}
                  </button>
                )}
                <button type="button" className="go" disabled={!canRender} onClick={() => startRender(false)}>{tr("Запустить рендер")}</button>
              </div>
            )}
          </section>
        </main>
      )}

      {compareOpen && compareList.length > 0 && (
        <CompareModal hlae={paths.hlae} list={compareList} onClose={() => setCompareOpen(false)} />
      )}
      {card && (
        <div className="card-modal" onClick={() => setCard(null)}>
          <div className="card-modal__box" onClick={(e) => e.stopPropagation()}>
            <img src={card.url} alt={tr("Карточка игрока")} />
            <div className="card-modal__acts">
              <span className="mono dim">{cardMsg || "1080 × 1920 · PNG"}</span>
              <span className="chips__spacer" />
              <button type="button" className="chip" onClick={() => setCard(null)}>{tr("Закрыть")}</button>
              <button type="button" className="chip" onClick={copyCard}>{tr("Копировать")}</button>
              <button type="button" className="go" onClick={saveCard}>{tr("Сохранить PNG")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}