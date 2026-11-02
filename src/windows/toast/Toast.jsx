// Уведомление «хайлайт готов» (окно "toast", его создаёт src-tauri/src/toast.rs).
// Кадр из клипа, название, «Смотреть» и «В папке»; закрывается само через 10 с, наведение — пауза.
import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseName } from "../../features/gallery/Gallery";
import "./toast.css";

import { tr, useLang } from "../../i18n";
const LIFE = 10000;
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");
const kills = (k) => (k >= 5 ? tr("эйс") : k ? tr("{0} килла", k) : "");

// короткий мягкий «дзынь» — два тона с затуханием
function chime() {
  try {
    const ctx = new AudioContext();
    [[880, 0], [1320, 0.09]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, ctx.currentTime + t);
      g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.65);
    });
  } catch { /* без звука */ }
}

export default function Toast() {
  useLang();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const left = useRef(LIFE);
  const rang = useRef(null);

  useEffect(() => {
    document.documentElement.classList.add("ov-root");
    invoke("toast_data").then((d) => d && setData(d));
    const un = listen("toast-data", (e) => { setData(e.payload); left.current = LIFE; setLeaving(false); });
    return () => { un.then((f) => f()); };
  }, []);

  const clip = data?.clips?.length ? parseName({ ...data.clips[data.clips.length - 1], modified: Date.now() }) : null;
  useEffect(() => {
    if (!clip) return;
    if (rang.current !== clip.path) { rang.current = clip.path; chime(); }
    invoke("clip_thumb", { hlae: data.hlae, path: clip.path }).then(setMeta).catch(() => {});
  }, [clip?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setLeaving(true); setTimeout(() => invoke("toast_close"), 280); };
  // обратный отсчёт: стоит, пока курсор над уведомлением
  useEffect(() => {
    if (!clip || paused || leaving) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const rest = left.current - (Date.now() - t0);
      if (rest <= 0) { clearInterval(id); left.current = 0; close(); }
    }, 100);
    return () => { clearInterval(id); left.current = Math.max(0, left.current - (Date.now() - t0)); };
  }, [clip?.path, paused, leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!clip) return null;
  const n = data.clips.length;
  return (
    <div className={`tst ${leaving ? "is-leaving" : ""} ${paused ? "is-paused" : ""}`}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <button type="button" className="tst-x" onClick={close} aria-label={tr("Закрыть")} />
      <div className="tst-thumb">
        {meta?.thumb ? <img src={`${convertFileSrc(meta.thumb)}?v=${Date.now()}`} alt="" /> : <i className="tst-skel" />}
        {clip.kills > 0 && <span className={`tst-kills tst-kills--${Math.min(clip.kills, 5)}`}>{clip.kills >= 5 ? "ACE" : `${clip.kills}K`}</span>}
      </div>
      <div className="tst-body">
        <span className="tst-tag">{tr("clipforge · готово")}</span>
        <b className="tst-title">{n > 1 ? tr("{0} хайлайта готовы", n) : tr("Хайлайт готов")}</b>
        <span className="tst-sub">
          {[clip.reel ? tr("Ролик · {0} клипа", clip.reel) : clip.round && tr("Раунд {0}", clip.round), kills(clip.kills), fmtDur(meta?.dur)].filter(Boolean).join(" · ") || clip.name}
        </span>
        <div className="tst-acts">
          <button type="button" className="tst-go" onClick={() => invoke("toast_open", { path: clip.path })}>
            <i className="tst-play" />{tr("Смотреть")}
          </button>
          <button type="button" className="tst-ghost" onClick={() => { invoke("reveal_clip", { path: clip.path }); close(); }}>{tr("В папке")}</button>
        </div>
      </div>
      <span className="tst-life" key={data.clips.length + clip.path} style={{ animationDuration: `${LIFE}ms` }} />
    </div>
  );
}
