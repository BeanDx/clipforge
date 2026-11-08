// Главная: что сейчас в игре, часы в CS2, история матчей, хайлайты, отмеченные во время игры
// (src-tauri/src/gsi.rs), итог последней сессии и тренд по демкам (процент в голову, тапы и спреи).
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tr, trError, useLang } from "../../i18n";
import { mapName, mapTint } from "../match/dossier";
import { editKills } from "../edit/montage";
import { placeOf, roundless, modeName } from "./place";

const DAY = 86_400_000;
const WEAPON = (w) => ({ ssg08: "SSG 08", awp: "AWP", ak47: "AK-47", m4a1_silencer: "M4A1-S", m4a1: "M4A4", deagle: "Deagle", usp_silencer: "USP-S", glock: "Glock", "?": "?" }[w] || (w || "").replace(/_/g, " ").toUpperCase());
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hours = (min) => (min >= 600 ? Math.round(min / 60) : Math.round(min / 6) / 10);
const fmtH = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} ${tr("ч")} ${Math.round((sec % 3600) / 60)} ${tr("мин")}` : `${Math.round(sec / 60)} ${tr("мин")}`);
const kd = (k, d) => (k / Math.max(1, d)).toFixed(2);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function when(t) {
  const d = new Date(t), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayKey(t) === dayKey(now)) return tr("сегодня {0}", hm);
  if (dayKey(t) === dayKey(now - DAY)) return tr("вчера {0}", hm);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`;
}
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
// итог матча: у режимов без команд (бой насмерть) победы нет и «конца» тоже — пишем сам режим;
// матч, конец которого программа не увидела (вышел раньше, закрыл игру), — «не доиграл»
const resultOf = (m) => (m.result === "win" ? tr("победа") : m.result === "loss" ? tr("поражение") : m.result === "draw" ? tr("ничья")
  : roundless(m.mode) ? modeName(m.mode) : m.finished ? "" : tr("не доиграл"));
const LEFT_HINT = "clipforge не увидел конец этого матча: ты вышел раньше или закрыл игру";
const leftOf = (m) => !m.result && !m.finished && !roundless(m.mode);
// карта на комьюнити-серверах приходит вместе с названием сервера: «de_dust2 | AWPDM #12 | Moscow — CYBERSHOKE.NET»
const splitMap = (raw) => { const [map, ...rest] = String(raw || "").split(" | "); return { map: map.trim(), server: rest.join(" | ").trim() }; };
// в истории не показываем бой насмерть и заходы короче 2 минут: демок у них нет, они только забивают список
const SHORT_VISIT = 2 * 60_000;
const noise = (m) => roundless(m.mode) || (m.ended || m.started) - m.started < SHORT_VISIT;

// кэш разбора демок для тренда: путь|размер → статистика (разбор ~2 с на демку, второй раз не нужен)
const STATS_KEY = "cf-home-demo-stats";
const loadStats = () => { try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; } catch { return {}; } };

// скачанная демка, похожая на матч: та же карта и файл появился после матча (в течение 3 дней)
const demoFor = (m, replays) => replays.find((r) => r.map === m.map && r.modified >= m.started && r.modified - (m.ended || m.started) < 3 * DAY);
// демка FACEIT узнаётся по имени файла: 1-<uuid матча>-1-1.dem
const faceitDemo = (f, replays) => f && replays.find((r) => r.path.toLowerCase().includes(f.id.toLowerCase()));
// матч из игры ↔ матч FACEIT: та же карта и начались почти одновременно (FACEIT считает начало с выбора карты)
const faceitFor = (m, fc) => fc.find((f) => f.map === m.map && Math.abs(f.started - m.started) < 20 * 60_000)
  || fc.find((f) => (!f.map || f.map === m.map) && m.started >= f.started - 5 * 60_000 && m.started <= (f.finished || f.started + 3_600_000));
const FC_WAIT = 10 * 60_000; // сколько ждём файл в «Загрузках» после нажатия «скачать демку»
// матчмейкинг и Premier (valve.rs): список последних матчей у координатора Valve, хранится до следующего запроса
const VALVE_KEY = "cf-valve-matches";
const VALVE_AUTO = 30 * 60_000; // после первого ручного запроса список обновляется сам, если старше 30 минут
const loadValve = () => { try { return JSON.parse(localStorage.getItem(VALVE_KEY)) || null; } catch { return null; } };
// демка Valve узнаётся по имени файла: match730_<reservation>_<port>_<ip>.dem
const valveDemo = (v, replays) => v && replays.find((r) => r.path.toLowerCase().includes(v.name));
// матч из игры ↔ матч Valve: та же карта (если Valve её назвала) и начало игры внутри матча (±10 минут)
const valveFor = (m, vm) => vm.find((v) => (!v.map || v.map === m.map)
  && m.started >= v.started - (v.duration * 1000 + 10 * 60_000) && m.started <= v.started + v.duration * 1000 + 10 * 60_000);
const mb = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1));

// сколько строк видно в свёрнутом списке
const SHORT = 3;

// Плавное раскрытие: высота анимируется через grid-template-rows 0fr → 1fr (CSS .hm-collapse).
// Свёрнутое содержимое недоступно для Tab и скринридеров (inert).
function Collapse({ open, children }) {
  return (
    <div className={`hm-collapse ${open ? "is-open" : ""}`} inert={!open}>
      <div>{children}</div>
    </div>
  );
}

// «показать все (N)» / «свернуть» под длинным списком; при трёх и меньше строках кнопки нет
function MoreToggle({ total, open, onToggle }) {
  if (total <= SHORT) return null;
  return (
    <button type="button" className={`hm-more mono ${open ? "is-open" : ""}`} onClick={() => onToggle(!open)}>
      {open ? tr("свернуть") : tr("показать все · ещё {0}", total - SHORT)}
      <i aria-hidden="true" />
    </button>
  );
}

export function Home({ cs2, faceitKey, onOpenEdit, onOpenDemo }) {
  useLang();
  const [home, setHome] = useState(null); // { history, live }
  const [pt, setPt] = useState(null); // часы из Steam
  const [replays, setReplays] = useState([]);
  const [stats, setStats] = useState(loadStats);
  // длинные списки (история игр, матчи сессии) свёрнуты до трёх последних
  const [histOpen, setHistOpen] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [gsi, setGsi] = useState(null); // null | "ok" | "restart" | "error: ..."
  const [copied, setCopied] = useState(false);
  const [fcAll, setFc] = useState([]); // последние матчи на FACEIT (faceit.rs)
  const [fcErr, setFcErr] = useState("");
  const [waiting, setWaiting] = useState(null); // { id, until } — ждём скачанную демку FACEIT
  const [fcFixed, setFcFixed] = useState(0); // сколько забранных демок FACEIT было сломано курицей и исправлено
  const [valve, setValve] = useState(loadValve); // { at, list } — матчи Valve
  const [vBusy, setVBusy] = useState(false);
  const [vErr, setVErr] = useState("");
  const [vProg, setVProg] = useState({}); // id → [МБ, всего МБ], пока качается

  const refresh = () => invoke("gsi_home").then(setHome).catch(() => {});
  useEffect(() => {
    refresh();
    invoke("steam_playtime").then(setPt).catch(() => {});
    const uns = [
      listen("gsi-update", (e) => setHome((h) => (h ? { ...h, live: e.payload } : h))),
      listen("gsi-match-end", refresh),
      listen("gsi-session-end", refresh),
      listen("gsi-mark", refresh),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);
  const loadReplays = () => cs2 && invoke("list_replays", { cs2 }).then(setReplays).catch(() => {});
  useEffect(() => {
    if (!cs2) return;
    loadReplays();
    // конфиг для игры: если он новый, а игра уже открыта — данные пойдут после перезапуска CS2
    invoke("gsi_install", { cs2 }).then(async (fresh) => {
      const running = fresh && await invoke("cs2_running").catch(() => false);
      setGsi(running ? "restart" : "ok");
    }).catch((e) => setGsi(`error: ${e}`));
  }, [cs2]); // eslint-disable-line react-hooks/exhaustive-deps

  // матчи FACEIT — только с ключом Data API из «Настроек»
  const key = (faceitKey || "").trim();
  const fc = key.length >= 32 ? fcAll : [];
  useEffect(() => {
    if (key.length < 32) return;
    let alive = true;
    (async () => {
      const me = pt?.steamid || (await invoke("steam_users").catch(() => []))[0];
      if (!me) return;
      invoke("faceit_recent", { key, steamid: String(me) })
        .then((l) => { if (alive) { setFc(l); setFcErr(""); } })
        .catch((e) => alive && setFcErr(trError(e)));
    })();
    return () => { alive = false; };
  }, [key, pt?.steamid]);
  // забираем скачанные демки FACEIT из «Загрузок»: один раз при открытии и каждые 3 с, пока ждём файл
  const importDemos = () => cs2 && invoke("faceit_import", { cs2 }).then((got) => {
    if (got.length) { loadReplays(); setWaiting(null); }
    const fixed = got.filter((d) => d.fixed).length;
    if (fixed) setFcFixed(fixed);
  }).catch((e) => { setFcErr(trError(e)); setWaiting(null); });
  useEffect(() => { importDemos(); }, [cs2]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => (Date.now() > waiting.until ? setWaiting(null) : importDemos()), 3000);
    return () => clearInterval(t);
  }, [waiting, cs2]); // eslint-disable-line react-hooks/exhaustive-deps
  const download = (f) => {
    setFcErr("");
    invoke("faceit_open", { url: f.url }).then(() => setWaiting({ id: f.id, until: Date.now() + FC_WAIT })).catch((e) => setFcErr(trError(e)));
  };
  // кнопка у матча без демки: открыть комнату FACEIT / ждём файл
  const dlBtn = (f) => (waiting?.id === f.id
    ? <button type="button" className="hm-btn is-wait" onClick={() => setWaiting(null)} title={tr("Нажми на FACEIT «Watch demo» — clipforge сам заберёт файл из «Загрузок». Нажми, чтобы перестать ждать.")}>{tr("жду файл...")}</button>
    : <button type="button" className="hm-btn is-go" onClick={() => download(f)} title={tr("Откроет матч на FACEIT: нажми там «Watch demo», а clipforge сам заберёт демку из «Загрузок»")}>{tr("скачать демку")}</button>);

  // матчи Valve: по кнопке, а дальше сами при открытии главной (если CS2 закрыта и список устарел)
  const fetchValve = () => {
    setVBusy(true); setVErr("");
    invoke("valve_recent").then((list) => {
      const v = { at: Date.now(), list };
      setValve(v);
      try { localStorage.setItem(VALVE_KEY, JSON.stringify(v)); } catch { /* нет места — просто не запомним */ }
    }).catch((e) => setVErr(trError(e))).finally(() => setVBusy(false));
  };
  useEffect(() => {
    if (!valve || Date.now() - valve.at < VALVE_AUTO) return;
    invoke("cs2_running").then((r) => { if (!r) fetchValve(); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const un = listen("valve-progress", (e) => { const [id, d, t] = e.payload; setVProg((p) => (p[id] ? { ...p, [id]: [d, t] } : p)); });
    return () => { un.then((f) => f()); };
  }, []);
  const downloadValve = (v) => {
    setVErr("");
    setVProg((p) => ({ ...p, [v.id]: [0, 0] }));
    invoke("valve_download", { cs2, id: v.id, url: v.url, name: v.name, info: v.info })
      .then(() => loadReplays())
      .catch((e) => setVErr(trError(e)))
      .finally(() => setVProg((p) => { const n = { ...p }; delete n[v.id]; return n; }));
  };
  const vBtn = (v) => {
    const pr = vProg[v.id];
    if (pr) return <button type="button" className="hm-btn is-wait" disabled>{pr[1] ? tr("качаю {0}/{1} МБ", mb(pr[0]), mb(pr[1])) : tr("качаю...")}</button>;
    return <button type="button" className="hm-btn is-go" disabled={!cs2} onClick={() => downloadValve(v)} title={tr("Скачает демку с серверов Valve прямо в папку повторов CS2")}>{tr("скачать демку")}</button>;
  };
  const vm = valve?.list || [];

  const hist = home?.history || { matches: [], sessions: [], days: {} };
  const live = home?.live;
  const matches = useMemo(() => hist.matches.map((m) => ({ ...m, ...splitMap(m.map) })).sort((a, b) => b.started - a.started), [hist.matches]);
  const now = Date.now();
  const week = matches.filter((m) => m.started >= now - 7 * DAY);
  const wk = week.reduce((a, m) => ({ k: a.k + m.kills, d: a.d + m.deaths, hs: a.hs + m.hs, w: a.w + (m.result === "win") }), { k: 0, d: 0, hs: 0, w: 0 });

  // часы по дням за 14 дней: свои записи (с тех пор как программа открыта во время игры)
  const days = Array.from({ length: 14 }, (_, i) => {
    const t = now - (13 - i) * DAY;
    return { key: dayKey(t), wd: WD[new Date(t).getDay()], sec: hist.days?.[dayKey(t)] || 0 };
  });
  const tracked = days.reduce((s, d) => s + d.sec, 0);
  // шкала часов: шаг по максимуму, верх графика — ближайшая отметка сверху
  const maxH = Math.max(1, ...days.map((d) => d.sec / 3600));
  const stepH = maxH <= 2 ? 0.5 : maxH <= 4 ? 1 : maxH <= 10 ? 2 : 4;
  const topH = Math.ceil(maxH / stepH) * stepH;
  const ticks = Array.from({ length: Math.round(topH / stepH) }, (_, i) => (i + 1) * stepH);
  // дни, когда реально играл (от 5 минут), и самый долгий из них
  const active = days.filter((d) => d.sec >= 300);
  const longest = active.reduce((b, d) => (!b || d.sec > b.sec ? d : b), null);

  // последняя сессия
  const lastS = [...(hist.sessions || [])].sort((a, b) => b.started - a.started)[0];
  const sm = lastS ? matches.filter((m) => lastS.matches.includes(m.id)) : [];
  const sessRow = (m) => <li key={m.id}><span className="dim">{mapName(m.map)}</span><b className={`hm-res is-${m.result || (leftOf(m) ? "left" : "none")}`} title={leftOf(m) ? tr(LEFT_HINT) : undefined}>{resultOf(m)} · {m.kills}/{m.deaths}</b></li>;
  const ss = sm.reduce((a, m) => ({ k: a.k + m.kills, d: a.d + m.deaths, hs: a.hs + m.hs }), { k: 0, d: 0, hs: 0 });
  const bestRound = sm.flatMap((m) => m.rounds.map((r) => ({ ...r, map: m.map }))).sort((a, b) => b.kills - a.kills || b.hs - a.hs)[0];
  const guns = {};
  sm.forEach((m) => Object.entries(m.weapons || {}).forEach(([w, n]) => { guns[w] = (guns[w] || 0) + n; }));
  const topGun = Object.entries(guns).sort((a, b) => b[1] - a[1])[0];

  // хайлайты из игры по свежим матчам
  const fcOf = (m) => faceitFor(m, fc);
  // матч FACEIT не бывает матчем Valve
  const vOf = (m) => (fcOf(m) ? undefined : valveFor(m, vm));
  const demoOf = (m) => faceitDemo(fcOf(m), replays) || valveDemo(vOf(m), replays) || demoFor(m, replays);
  const highlights = matches.flatMap((m) => m.rounds.filter((r) => r.tags?.length).map((r) => ({ m, r, demo: demoOf(m), f: fcOf(m), v: vOf(m) }))).slice(0, 12);

  // история: матчи из игры + скачанные демки, которых нет среди матчей
  // + матчи FACEIT и Valve, которых игра не записала (программа была закрыта)
  const shown = matches.filter((m) => !noise(m));
  const hidden = matches.length - shown.length;
  const gsiRows = shown.map((m) => ({ t: m.started, m, f: fcOf(m), v: vOf(m), demo: demoOf(m) }));
  const fcLinked = new Set(gsiRows.map((x) => x.f?.id).filter(Boolean));
  const fcRows = fc.filter((f) => !fcLinked.has(f.id)).map((f) => ({ t: f.started, f, demo: faceitDemo(f, replays) }));
  const vLinked = new Set(gsiRows.map((x) => x.v?.id).filter(Boolean));
  const vRows = vm.filter((v) => !vLinked.has(v.id)).map((v) => ({ t: v.started, v, demo: valveDemo(v, replays) }));
  const linked = new Set([...gsiRows, ...fcRows, ...vRows].map((x) => x.demo?.path).filter(Boolean));
  const rows = [
    ...gsiRows, ...fcRows, ...vRows,
    ...replays.filter((r) => !linked.has(r.path)).map((r) => ({ t: r.modified, demo: r })),
  ].sort((a, b) => b.t - a.t).slice(0, 30);
  // где в списке матчи Valve: свежие бывают старше FACEIT и уходят под «показать все»
  const vFirst = rows.findIndex((x) => x.v);
  const vLast = vm[0];
  const fcRes = (f) => (f.result === "win" ? tr("победа") : f.result === "loss" ? tr("поражение") : f.result === "draw" ? tr("ничья") : "");

  // тренд по демкам
  const trend = replays.map((r) => ({ r, s: stats[`${r.path}|${r.size}`] })).filter((x) => x.s).sort((a, b) => a.r.modified - b.r.modified).slice(-12);
  const tAll = trend.reduce((a, { s }) => ({ k: a.k + s.kills, hs: a.hs + s.hs, tap: a.tap + s.taps, spray: a.spray + s.sprays }), { k: 0, hs: 0, tap: 0, spray: 0 });
  const toCount = replays.slice(0, 12).filter((r) => !stats[`${r.path}|${r.size}`]);
  const countDemos = async () => {
    const me = pt?.steamid || (await invoke("steam_users").catch(() => []))[0];
    if (!me) return;
    const next = { ...stats };
    for (let i = 0; i < toCount.length; i++) {
      const r = toCount[i];
      setBusy(tr("разбираю демку {0}/{1}...", i + 1, toCount.length));
      try {
        const raw = JSON.parse(await invoke("parse_demo", { path: r.path }));
        const ks = editKills(raw, me);
        const deaths = (raw.events || []).filter((d) => String(d.user_steamid) === String(me)).length;
        next[`${r.path}|${r.size}`] = {
          kills: ks.length, hs: ks.filter((k) => k.hs).length, deaths,
          taps: ks.filter((k) => k.shots != null && k.shots <= 2).length, sprays: ks.filter((k) => k.shots >= 5).length,
        };
        setStats({ ...next });
        try { localStorage.setItem(STATS_KEY, JSON.stringify(next)); } catch {}
      } catch { /* битая демка — пропускаем */ }
    }
    setBusy("");
  };

  const place = placeOf(live);
  const inGame = live?.connected && live.map && place.kind !== "demo";
  const myScore = live?.team === "CT" ? [live.score_ct, live.score_t] : [live?.score_t || 0, live?.score_ct || 0];
  const name = pt?.name || "";

  return (
    <div className="hm">
      {/* шапка: привет и что сейчас в игре */}
      <section className={`hm-hero ${inGame ? "is-live" : ""}`} style={{ "--tint": inGame ? mapTint(live.map) : "#2ee6c0" }}>
        <div className="hm-hero__bg" aria-hidden="true" />
        <div className="hm-hero__left">
          <span className="hm-kicker mono">{inGame ? tr("сейчас в игре") : tr("clipforge · главная")}</span>
          <h1 className="hm-hello">{name ? tr("Привет, {0}", name) : tr("Привет")}</h1>
          {live?.connected && (
            <div className={`hm-place is-${place.kind}`}>
              <span className="hm-place__badge mono">{place.badge}</span>
              <div className="hm-place__text">
                <b>{place.title}</b>
                {place.sub && <span>{place.sub}</span>}
              </div>
            </div>
          )}
          {inGame ? (
            <p className="hm-hero__line">
              {!roundless(live.mode) && <>{tr("раунд {0}", live.round)} · <b className="mono">{myScore[0]}:{myScore[1]}</b>{" "}· </>}
              <span className="mono">{live.kills}/{live.deaths}</span> · {tr("{0}% в голову", pct(live.hs, live.kills))}
            </p>
          ) : (
            <p className="hm-hero__line dim">
              {live?.session_started ? tr("Сессия идёт") : tr("Зайди в CS2 — матчи, хайлайты и часы будут записываться сами")}
            </p>
          )}
          <div className="hm-hero__chips">
            <span className={`hm-chip ${gsi === "ok" ? "is-ok" : gsi === "restart" ? "is-warn" : ""}`}>
              <i />{gsi === "restart" ? tr("перезапусти CS2, чтобы включить запись матчей") : gsi?.startsWith("error") ? tr("не получилось подключиться к CS2") : tr("связь с игрой включена")}
            </span>
            <span className="hm-chip"><kbd>{live?.mark_key || "F8"}</kbd>{tr("в игре — запомнить момент")}</span>
            {place.hint && (
              <button type="button" className="hm-chip is-warn hm-chip--btn" title={tr("Steam → CS2 → Свойства → Параметры запуска: -condebug, потом перезапусти CS2")}
                onClick={() => { navigator.clipboard?.writeText("-condebug").catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2500); }}>
                <i />{copied ? tr("скопировано: вставь в Steam → CS2 → Свойства → Параметры запуска") : place.hint}
                {!copied && <kbd>{tr("копировать")}</kbd>}
              </button>
            )}
          </div>
        </div>
        <div className="hm-hero__right">
          {inGame ? (
            <div className="hm-live">
              {roundless(live.mode)
                ? <div className="hm-live__rk"><b>{live.kills}</b><span>{tr("киллов за матч")}</span></div>
                : <div className="hm-live__rk"><b>{live.round_kills}</b><span>{tr("киллов в раунде")}</span></div>}
              <div className="hm-live__hl">
                {live.highlights.length ? live.highlights.slice(-4).map((r) => <em key={r.round}>R{r.round} · {tr(r.tags[0])}</em>) : <span className="dim">{tr("хайлайты матча появятся здесь")}</span>}
              </div>
            </div>
          ) : (
            <div className="hm-hours">
              <b>{pt ? hours(pt.two_weeks) : "—"}</b>
              <span>{tr("часов за 2 недели")}</span>
            </div>
          )}
        </div>
      </section>

      {/* цифры */}
      <section className="hm-tiles">
        <Tile label={tr("часов за 2 недели")} value={pt ? hours(pt.two_weeks) : "—"} sub={tr("по Steam")} />
        <Tile label={tr("всего часов в CS2")} value={pt ? Math.round(pt.total / 60).toLocaleString("ru-RU") : "—"} sub={pt?.last_played ? tr("последний раз {0}", when(pt.last_played * 1000)) : ""} />
        <Tile label={tr("матчей за неделю")} value={week.length} sub={week.length ? tr("{0} побед", wk.w) : tr("пока не записано")} />
        <Tile label={tr("K/D за неделю")} value={week.length ? kd(wk.k, wk.d) : "—"} sub={week.length ? `${wk.k} / ${wk.d}` : ""} accent />
        <Tile label={tr("в голову за неделю")} value={week.length ? `${pct(wk.hs, wk.k)}%` : "—"} sub={week.length ? tr("{0} хедшотов", wk.hs) : ""} />
      </section>

      <div className="hm-grid">
        {/* часы по дням */}
        <section className="hm-card hm-days">
          <header className="hm-card__head"><h2>{tr("Игра по дням")}</h2><span className="mono dim">{tracked ? fmtH(tracked) + " · 14 " + tr("дней") : tr("считаю с сегодняшнего дня")}</span></header>
          {tracked > 0 && (
            <div className="hm-sess hm-days__sum">
              <div><b>{active.length ? fmtH(tracked / active.length) : "—"}</b><span>{tr("в среднем за день")}</span></div>
              <div><b>{longest ? fmtH(longest.sec) : "—"}</b><span>{longest ? tr("самый долгий · {0}", tr(longest.wd)) : tr("самый долгий день")}</span></div>
              <div><b>{active.length}<small className="dim">/14</small></b><span>{tr("дней в игре")}</span></div>
            </div>
          )}
          <div className="hm-chart">
            <div className="hm-bars">
              {ticks.map((h) => (
                <span key={h} className="hm-tick" style={{ bottom: `${(h / topH) * 100}%` }}>{h} {tr("ч")}</span>
              ))}
              {days.map((d, i) => (
                <div key={d.key} className={`hm-bar ${i === 13 ? "is-today" : ""}`} title={`${d.key}: ${fmtH(d.sec)}`}>
                  <i style={{ height: `${Math.max(1.5, (d.sec / 3600 / topH) * 100)}%`, "--d": `${i * 30}ms` }} />
                </div>
              ))}
            </div>
            <div className="hm-days__wd">
              {days.map((d, i) => <span key={d.key} className={i === 13 ? "is-today" : ""}>{tr(d.wd)}</span>)}
            </div>
          </div>
          {!tracked && <p className="hm-note dim">{tr("Часы по дням пишутся, пока программа открыта (можно свернуть). За 2 недели по Steam: {0} ч.", pt ? hours(pt.two_weeks) : "—")}</p>}
        </section>

        {/* итог последней сессии */}
        <section className="hm-card hm-session">
          <header className="hm-card__head"><h2>{tr("Итог сессии")}</h2><span className="mono dim">{lastS ? when(lastS.started) : ""}</span></header>
          {lastS && sm.length ? (
            <>
              <div className="hm-sess">
                <div><b>{sm.length}</b><span>{tr("матчей")}</span></div>
                <div><b className="accent">{kd(ss.k, ss.d)}</b><span>K/D</span></div>
                <div><b>{pct(ss.hs, ss.k)}%</b><span>{tr("в голову")}</span></div>
                <div><b>{fmtH((lastS.ended - lastS.started) / 1000)}</b><span>{tr("в игре")}</span></div>
              </div>
              <ul className="hm-facts">
                {bestRound && <li><span className="dim">{tr("лучший раунд")}</span><b>{mapName(bestRound.map)} · R{bestRound.round} · {bestRound.kills}K{bestRound.hs === bestRound.kills && bestRound.kills > 1 ? ` · ${tr("все в голову")}` : ""}</b></li>}
                {topGun && <li><span className="dim">{tr("больше всего киллов")}</span><b>{WEAPON(topGun[0])} · {topGun[1]}</b></li>}
                {sm.slice(0, SHORT).map(sessRow)}
              </ul>
              <Collapse open={sessOpen}><ul className="hm-facts hm-facts--more">{sm.slice(SHORT).map(sessRow)}</ul></Collapse>
              <MoreToggle total={sm.length} open={sessOpen} onToggle={setSessOpen} />
            </>
          ) : (
            <p className="hm-empty">{tr("Когда закроешь CS2, здесь будет итог: матчи, K/D, процент в голову, лучший раунд и любимый ствол. Он же придет уведомлением.")}</p>
          )}
        </section>

        {/* хайлайты из игры */}
        <section className="hm-card hm-hl span-2">
          <header className="hm-card__head"><h2>{tr("Хайлайты из игры")}</h2><span className="mono dim">{tr("3K, 4K, эйс, все в голову, нож и клавиша {0}", live?.mark_key || "F8")}</span></header>
          {highlights.length ? (
            <div className="hm-hl__list">
              {highlights.map(({ m, r, demo, f, v }, i) => (
                <div key={`${m.id}:${r.round}`} className="hm-hl__item" style={{ "--tint": mapTint(m.map), "--i": i }}>
                  <span className={`hm-hl__k ${r.kills >= 5 ? "is-ace" : r.kills >= 4 ? "is-4" : ""}`}>{r.kills >= 5 ? "ACE" : r.kills ? `${r.kills}K` : "★"}</span>
                  <div className="hm-hl__body">
                    <b>{mapName(m.map)} · R{r.round}</b>
                    <span>{r.tags.map((t) => tr(t)).join(" · ")}</span>
                    <span className="mono dim">{when(m.started)}</span>
                  </div>
                  {demo
                    ? <button type="button" className="hm-btn is-go" onClick={() => onOpenEdit([demo.path])}>{tr("в эдит")}</button>
                    : f ? dlBtn(f) : v?.url ? vBtn(v) : <span className="hm-hl__wait mono dim">{tr("скачай демку в «Смотреть»")}</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className="hm-empty">{tr("Играй как обычно: раунды с 3+ киллами, эйсы, ножи и все хедшоты отметятся сами, а {0} отметит любой момент. Когда демка матча скачается, эти раунды уже будут выбраны в «Эдите».", live?.mark_key || "F8")}</p>
          )}
        </section>

        {/* история игр */}
        <section className="hm-card hm-hist span-2">
          <header className="hm-card__head"><h2>{tr("История игр")}</h2><span className="hm-hist__meta">
            <span className="mono dim">{tr("{0} матчей · {1} демок", shown.length, replays.length)}{fc.length ? ` · FACEIT ${fc.length}` : ""}{vm.length ? ` · Valve ${vm.length}` : ""}
              {hidden ? <span title={tr("Бой насмерть и заходы на сервер короче 2 минут в истории не показываются: демок у них нет")}>{tr(" · скрыто {0}", hidden)}</span> : null}</span>
            <button type="button" className={`hm-btn ${vBusy ? "is-wait" : ""}`} disabled={vBusy} onClick={fetchValve}
              title={tr("Спросит у Steam последние матчи матчмейкинга и Premier со ссылками на демки. CS2 должна быть закрыта")}>
              {vBusy ? tr("спрашиваю Valve...") : valve ? tr("обновить матчи Valve") : tr("матчи Valve")}
            </button>
          </span></header>
          {fcErr && <p className="hm-note hm-err mono">{fcErr}</p>}
          {fcFixed > 0 && (
            <p className="hm-note hm-fixed" title={tr("Курица-питомец попала в первый тик демки, и CS2 падала на playdemo. Данные курицы перенесены туда, где игра их ждёт; геймплей не изменился.")}>
              {tr("🐔 Демка FACEIT была сломана (курица-питомец) — исправлено: {0}. Теперь она не крашит CS2.", fcFixed)}
              {" "}<button type="button" className="hm-link" onClick={() => setFcFixed(0)}>{tr("ок")}</button>
            </p>
          )}
          {vErr && <p className="hm-note hm-err mono">{vErr}</p>}
          {valve && !vErr && !vBusy && (
            <p className="hm-note dim">
              {vLast ? tr("Valve: {0} матчей матчмейкинга и Premier, последний {1}.", vm.length, when(vLast.started)) : tr("Valve не нашёл у тебя матчей матчмейкинга и Premier.")}
              {vFirst >= SHORT && !histOpen && <> {tr("Они ниже в списке:")} <button type="button" className="hm-link" onClick={() => setHistOpen(true)}>{tr("показать все")}</button></>}
            </p>
          )}
          {!valve && !vErr && <p className="hm-note dim">{tr("Демки матчмейкинга и Premier: нажми «матчи Valve», и clipforge спросит у Steam последние матчи. Пароль не нужен, CS2 должна быть закрыта.")}</p>}
          {key.length < 32 && <p className="hm-note dim">{tr("Чтобы скачивать демки с FACEIT отсюда, укажи ключ FACEIT Data API в «Настройках».")}</p>}
          {rows.length ? (
            <div className="hm-rows">
              {(() => { const histRow = ({ m, f, v, demo }) => {
                const s = demo && stats[`${demo.path}|${demo.size}`];
                // без записи из игры: K/D из демки, а если её не разбирали — из данных Valve
                const k = m ? m.kills : s ? s.kills : v?.kills, d = m ? m.deaths : s ? s.deaths : v?.deaths, hs = m ? m.hs : s?.hs;
                const src = m || f || v || demo;
                // новая карта, которую Valve не назвала: имя из демки
                const map = (v && !v.map && demo?.map) || src.map;
                const hl = m ? m.rounds.filter((r) => r.tags?.length).length : 0;
                return (
                  <div key={m?.id || f?.id || v?.id || demo.path} className="hm-row" style={{ "--tint": mapTint(map) }}>
                    <span className="hm-row__map"><i /><span className="hm-row__name">{mapName(map) || "demo"}{m?.server && <small className="mono dim" title={m.server}>{m.server}</small>}</span>{f && <em className="hm-fc mono">FACEIT</em>}{!f && v && <em className="hm-fc hm-valve mono">{v.mode === "wingman" ? tr("2×2") : "VALVE"}</em>}</span>
                    <span className="mono dim hm-row__when">{when(m ? m.started : f ? f.started : v ? v.started : demo.modified)}</span>
                    <span className={`hm-res is-${m?.result || f?.result || v?.result || (m && leftOf(m) ? "left" : "none")}`} title={m && leftOf(m) ? tr(LEFT_HINT) : undefined}>
                      {m ? (resultOf(m)) : f ? fcRes(f) : v ? fcRes(v) : tr("демка")}
                      {m && (m.score_ct || m.score_t) ? <b className="mono"> {m.team === "CT" ? `${m.score_ct}:${m.score_t}` : `${m.score_t}:${m.score_ct}`}</b>
                        : !m && (f || v)?.score ? <b className="mono"> {(f || v).score}</b> : null}
                    </span>
                    <span className="mono hm-row__kd">{k != null ? `${k}/${d ?? "?"}` : "—"}<em>{k && hs != null ? ` ${pct(hs, k)}% HS` : ""}</em></span>
                    <span className="hm-row__hl">{hl ? <em>★ {hl}</em> : null}{s?.taps ? <em className="is-tap">{tr("тапов {0}", s.taps)}</em> : null}</span>
                    <span className="hm-row__act">
                      {demo ? <button type="button" className="hm-btn" onClick={() => onOpenDemo(demo.path)}>{tr("открыть")}</button> : f ? dlBtn(f) : v?.url ? vBtn(v) : <span className="mono dim">{tr("нет демки")}</span>}
                      {demo && <button type="button" className="hm-btn is-go" onClick={() => onOpenEdit([demo.path])}>{tr("в эдит")}</button>}
                    </span>
                  </div>
                );
              };
              // первые три всегда видны, остальные выезжают плавно (Collapse)
              return (
                <>
                  {rows.slice(0, SHORT).map(histRow)}
                  <Collapse open={histOpen}><div className="hm-rows">{rows.slice(SHORT).map(histRow)}</div></Collapse>
                </>
              ); })()}
              <MoreToggle total={rows.length} open={histOpen} onToggle={setHistOpen} />
            </div>
          ) : (
            <p className="hm-empty">{tr("Пока пусто: сыграй матч или скачай демку в CS2 (Смотреть → Ваши матчи).")}</p>
          )}
        </section>

        {/* тренд по демкам */}
        <section className="hm-card hm-trend span-2">
          <header className="hm-card__head">
            <h2>{tr("Как стреляешь")}</h2>
            <span className="mono dim">{trend.length ? tr("по {0} демкам", trend.length) : tr("по скачанным демкам")}</span>
          </header>
          <div className="hm-trend__row">
            <div className="hm-trend__nums">
              <div><b>{tAll.k ? `${pct(tAll.hs, tAll.k)}%` : "—"}</b><span>{tr("в голову")}</span></div>
              <div><b className="accent">{tAll.k ? `${pct(tAll.tap, tAll.k)}%` : "—"}</b><span>{tr("тапы (1–2 пули)")}</span></div>
              <div><b>{tAll.k ? `${pct(tAll.spray, tAll.k)}%` : "—"}</b><span>{tr("спреи (5+ пуль)")}</span></div>
            </div>
            {trend.length > 1 ? (
              <Spark points={trend.map(({ s }) => [pct(s.hs, s.kills), pct(s.taps, s.kills)])} />
            ) : (
              <p className="hm-empty">{tr("Посчитаю по твоим демкам, сколько киллов в голову и сколько из них тапы, а сколько спреи. Это ~2 секунды на демку, один раз.")}</p>
            )}
          </div>
          {toCount.length > 0 && (
            <button type="button" className="hm-btn is-go hm-trend__go" disabled={!!busy} onClick={countDemos}>
              {busy || tr("посчитать по {0} демкам", toCount.length)}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }) {
  return (
    <div className={`hm-tile ${accent ? "is-accent" : ""}`}>
      <span className="hm-tile__label mono">{label}</span>
      <b className="hm-tile__value">{value}</b>
      <span className="hm-tile__sub dim">{sub}</span>
    </div>
  );
}

// две линии по матчам: процент в голову и доля тапов
function Spark({ points }) {
  const W = 420, H = 110, n = points.length;
  const xy = (i, v) => [8 + (i * (W - 16)) / Math.max(1, n - 1), H - 10 - (v / 100) * (H - 22)];
  const line = (j) => points.map((p, i) => xy(i, p[j]).map((x) => x.toFixed(1)).join(",")).join(" ");
  return (
    <svg className="hm-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr("в голову и тапы по матчам")}>
      {[25, 50, 75].map((g) => <line key={g} x1="0" x2={W} y1={xy(0, g)[1]} y2={xy(0, g)[1]} className="hm-spark__grid" />)}
      <polyline points={line(0)} className="hm-spark__hs" />
      <polyline points={line(1)} className="hm-spark__tap" />
      {points.map((p, i) => <circle key={i} cx={xy(i, p[1])[0]} cy={xy(i, p[1])[1]} r="3" className="hm-spark__dot" />)}
      <text x={W - 4} y="12" textAnchor="end" className="hm-spark__lbl">
        <tspan className="hm-spark__lbl--hs">{tr("в голову")}</tspan>  <tspan className="hm-spark__lbl--tap">{tr("тапы")}</tspan>
      </text>
    </svg>
  );
}
