// Вкладка «Хайлайты»: готовые клипы из папки вывода плитками — превью, сортировка, фильтры и плеер.
// Видео идёт через asset-протокол (list_clips открывает окну доступ только к папке клипов),
// поэтому большие файлы не грузятся в память целиком и перемотка работает.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { tr, trError, getLang, useLang } from "../../i18n";
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const SORTS = [["new", "Новые"], ["old", "Старые"], ["kills", "Больше киллов"], ["long", "Длиннее"], ["big", "Тяжелее"]];
const KILLS = [["all", "Все"], [2, "2K"], [3, "3K"], [4, "4K"], [5, "ACE"]];

const fmtSize = (b) => (b > 1e9 ? tr("{0} ГБ", (b / 1e9).toFixed(2)) : tr("{0} МБ", Math.round(b / 1e6)));
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");

// «2026-10-31 02-26-59 R15 4K.mp4» -> дата записи, раунд, киллы (имена, которые даёт рендер)
export function parseName(f) {
  const m = f.name.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-(\d\d)(?: R(\d+))?(?: (\d)K)?/);
  const date = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(f.modified);
  // склеенный ролик: «... reel 3 clips.mp4»
  const reel = f.name.match(/ reel (\d+) clips/);
  return { ...f, date, round: m?.[7] ? +m[7] : null, kills: m?.[8] ? +m[8] : 0, reel: reel ? +reel[1] : 0 };
}

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 864e5);
  if (diff === 0) return tr("Сегодня");
  if (diff === 1) return tr("Вчера");
  const year = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : "";
  return getLang() === "en" ? `${tr(MONTHS[d.getMonth()])} ${d.getDate()}${year}` : `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// превью делает ffmpeg — не больше двух одновременно, чтобы не грузить диск
const queue = [];
let busy = 0;
function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (busy < 2 && queue.length) {
    const { job, resolve, reject } = queue.shift();
    busy++;
    job().then(resolve, reject).finally(() => { busy--; pump(); });
  }
}

function KillBadge({ kills }) {
  if (!kills) return null;
  return <span className={`gl-kills gl-kills--${Math.min(kills, 5)}`}>{kills >= 5 ? "ACE" : `${kills}K`}</span>;
}

function Tile({ clip, meta, onMeta, hlae, onOpen, i }) {
  const ref = useRef(null);
  const vid = useRef(null);
  const [hover, setHover] = useState(false);
  // превью запрашиваем, только когда плитка видна
  useEffect(() => {
    if (meta) return;
    const el = ref.current;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      enqueue(() => invoke("clip_thumb", { hlae, path: clip.path })).then((m) => onMeta(clip.path, m)).catch(() => onMeta(clip.path, { thumb: null, dur: 0 }));
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [meta, clip.path, hlae]); // eslint-disable-line react-hooks/exhaustive-deps
  // при наведении — беззвучный кусок с конца клипа, где обычно фраг
  useEffect(() => {
    const v = vid.current;
    if (!hover || !v) return;
    const start = () => { v.currentTime = Math.max(0, (meta?.dur || 6) - 5); v.play().catch(() => {}); };
    if (v.readyState >= 1) start(); else v.addEventListener("loadedmetadata", start, { once: true });
    return () => v.pause();
  }, [hover, meta]);

  return (
    <button ref={ref} type="button" className="gl-tile" style={{ "--i": i }} onClick={onOpen}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className="gl-thumb">
        {meta?.thumb ? <img src={`${convertFileSrc(meta.thumb)}?v=${clip.modified}`} alt="" loading="lazy" /> : <i className="gl-skel" />}
        {hover && <video ref={vid} src={convertFileSrc(clip.path)} muted playsInline preload="metadata" />}
        <KillBadge kills={clip.kills} />
        {clip.round && <span className="gl-round mono">R{String(clip.round).padStart(2, "0")}</span>}
        {meta?.dur > 0 && <span className="gl-dur mono">{fmtDur(meta.dur)}</span>}
        <span className="gl-play" aria-hidden="true"><i /></span>
      </span>
      <span className="gl-info">
        <b>{clip.reel ? tr("Ролик · {0} клипа", clip.reel) : clip.round ? tr("Раунд {0}", clip.round) : clip.name.replace(/\.mp4$/i, "")}{clip.kills ? ` · ${clip.kills >= 5 ? tr("эйс") : tr("{0} килла", clip.kills)}` : ""}</b>
        <span className="mono dim">{hhmm(clip.date)} · {fmtSize(clip.size)}</span>
      </span>
    </button>
  );
}

function Player({ list, index, setIndex, meta, onReveal, onTrash, onClose }) {
  const clip = list[index];
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "PageDown" || (e.key === "]" && !e.ctrlKey)) setIndex((i) => Math.min(list.length - 1, i + 1));
      if (e.key === "PageUp" || (e.key === "[" && !e.ctrlKey)) setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list.length, onClose, setIndex]);
  if (!clip) return null;
  // в .app через портал: у рамок вкладки есть transform от анимации, и fixed внутри них уехал бы
  return createPortal(
    <div className="card-modal" onClick={onClose}>
      <div className="gl-player" onClick={(e) => e.stopPropagation()}>
        <div className="gl-player__head">
          <KillBadge kills={clip.kills} />
          <b>{clip.reel ? tr("Ролик · {0} клипа", clip.reel) : clip.round ? tr("Раунд {0}", clip.round) : clip.name}</b>
          <span className="mono dim">{dayLabel(clip.date)}, {hhmm(clip.date)} · {fmtSize(clip.size)}{meta?.dur ? ` · ${fmtDur(meta.dur)}` : ""}</span>
          <span className="chips__spacer" />
          <span className="mono dim">{index + 1} / {list.length}</span>
        </div>
        <div className="gl-player__stage">
          <button type="button" className="gl-nav gl-nav--prev" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label={tr("Предыдущий клип")} />
          <video key={clip.path} src={convertFileSrc(clip.path)} controls autoPlay playsInline />
          <button type="button" className="gl-nav gl-nav--next" disabled={index >= list.length - 1} onClick={() => setIndex(index + 1)} aria-label={tr("Следующий клип")} />
        </div>
        <div className="gl-player__acts">
          <span className="mono dim gl-player__name" title={clip.path}>{clip.name}</span>
          <span className="chips__spacer" />
          <button type="button" className="chip" onClick={() => onReveal(clip)}>{tr("Показать в папке")}</button>
          <button type="button" className="chip chip--del" onClick={() => onTrash(clip)}>{tr("В корзину")}</button>
          <button type="button" className="chip" onClick={onClose}>{tr("Закрыть")}</button>
        </div>
      </div>
    </div>,
    document.querySelector(".app") || document.body,
  );
}

export function Gallery({ hlae, out, refreshKey, openPath, onOpened }) {
  const lang = useLang(); // подписи дней пересчитываются при смене языка
  const [clips, setClips] = useState(null);
  const [err, setErr] = useState("");
  const [meta, setMeta] = useState({});
  const [sort, setSort] = useState(() => { try { return localStorage.getItem("cf-gl-sort") || "new"; } catch { return "new"; } });
  const [kills, setKills] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  useEffect(() => { try { localStorage.setItem("cf-gl-sort", sort); } catch {} }, [sort]);

  const load = () => {
    if (!out) return;
    invoke("list_clips", { out }).then((l) => { setClips(l.map(parseName)); setErr(""); }).catch((e) => setErr(String(e)));
  };
  useEffect(load, [out, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    if (!clips) return [];
    const words = q.trim().toLowerCase();
    const l = clips.filter((c) => (kills === "all" || (kills === 5 ? c.kills >= 5 : c.kills === kills))
      && (!words || c.name.toLowerCase().includes(words) || (c.round && tr("раунд {0}", c.round).includes(words))));
    const by = {
      new: (a, b) => b.date - a.date, old: (a, b) => a.date - b.date,
      kills: (a, b) => b.kills - a.kills || b.date - a.date,
      long: (a, b) => (meta[b.path]?.dur || 0) - (meta[a.path]?.dur || 0), big: (a, b) => b.size - a.size,
    }[sort];
    return [...l].sort(by);
  }, [clips, kills, q, sort, meta]);

  // открыть конкретный клип (кнопка «Смотреть» в уведомлении «хайлайт готов»)
  useEffect(() => {
    if (!openPath || !clips) return;
    let i = list.findIndex((c) => c.path === openPath);
    if (i < 0 && (kills !== "all" || q)) { setKills("all"); setQ(""); return; } // клип скрыт фильтром — сбрасываем
    // нет в списке — ждём, пока папка перечитается (клип только что появился)
    if (i >= 0) { setOpen(i); onOpened?.(); }
  }, [openPath, clips, list]); // eslint-disable-line react-hooks/exhaustive-deps

  // при сортировке по дате — разделители по дням
  const groups = useMemo(() => {
    if (sort !== "new" && sort !== "old") return [[null, list]];
    const g = [];
    for (const c of list) {
      const label = dayLabel(c.date);
      if (g.at(-1)?.[0] === label) g.at(-1)[1].push(c); else g.push([label, [c]]);
    }
    return g;
  }, [list, sort, lang]);

  const total = (clips || []).reduce((s, c) => s + c.size, 0);
  const counts = useMemo(() => {
    const m = { all: clips?.length || 0 };
    for (const c of clips || []) { const k = Math.min(c.kills, 5); m[k] = (m[k] || 0) + 1; }
    return m;
  }, [clips]);

  const onMeta = (path, m) => setMeta((x) => ({ ...x, [path]: m }));
  const reveal = (c) => invoke("reveal_clip", { path: c.path }).catch((e) => setErr(String(e)));
  const trash = async (c) => {
    const yes = await ask(tr("Переместить \"{0}\" в корзину?", c.name), { title: "clipforge", kind: "warning", okLabel: tr("В корзину"), cancelLabel: tr("Отмена") });
    if (!yes) return;
    try {
      await invoke("trash_clip", { path: c.path });
      const rest = list.filter((x) => x.path !== c.path);
      setClips((l) => l.filter((x) => x.path !== c.path));
      setOpen((i) => (rest.length ? Math.min(i, rest.length - 1) : null));
    } catch (e) { setErr(String(e)); }
  };

  let n = 0;
  return (
    <section className="frame span-2 gl">
      <header className="frame__head">
        <h2>{tr("Хайлайты")}</h2>
        <span className="frame__rule" />
        <span className="mono dim">{clips ? tr("{0} клипов · {1}", clips.length, fmtSize(total)) : tr("загружаю...")}</span>
      </header>

      <div className="gl-bar">
        <div className="ratios gl-kfilter" role="radiogroup" aria-label={tr("Киллы")}>
          {KILLS.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={kills === k} className={kills === k ? "is-on" : ""} onClick={() => setKills(k)}>
              {tr(l)}<span className="mono dim"> {counts[k] || 0}</span>
            </button>
          ))}
        </div>
        <input className="mono gl-search" value={q} placeholder={tr("поиск: раунд 15, 2026-10-31...")} onChange={(e) => setQ(e.target.value)} />
        <select className="mono gl-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={tr("Сортировка")}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}
        </select>
        <button type="button" className="chip" onClick={load} title={tr("Перечитать папку")}>{tr("Обновить")}</button>
        <button type="button" className="chip" onClick={() => invoke("reveal_clip", { path: out })} title={out}>{tr("Папка")}</button>
      </div>
      {err && <p className="mono err">{trError(err)}</p>}

      {clips && clips.length === 0 && (
        <div className="gl-empty">
          <b>{tr("Здесь появятся твои хайлайты")}</b>
          <span className="dim">{tr("Отрендери клип на вкладке \"Демо\" - готовые видео из папки")} {out} {tr("покажутся плитками.")}</span>
        </div>
      )}
      {clips && clips.length > 0 && list.length === 0 && <p className="empty dim">{tr("Под фильтр ничего не попало.")}</p>}

      {groups.map(([label, items]) => (
        <div key={label || "all"} className="gl-group">
          {label && <div className="gl-day"><span>{label}</span><i /><span className="mono dim">{items.length}</span></div>}
          <div className="gl-grid">
            {items.map((c) => {
              const idx = list.indexOf(c);
              return <Tile key={c.path} clip={c} meta={meta[c.path]} onMeta={onMeta} hlae={hlae} i={n++} onOpen={() => setOpen(idx)} />;
            })}
          </div>
        </div>
      ))}

      {open != null && list[open] && (
        <Player list={list} index={open} setIndex={setOpen} meta={meta[list[open].path]}
          onReveal={reveal} onTrash={trash} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}
