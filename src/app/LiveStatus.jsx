// Живая строка в шапке: печатает, что сейчас происходит (запись, CS2, новые скачанные матчи),
// по клику — список матчей, которые CS2 скачал в game\csgo\replays, открываются одним кликом.
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { placeOf, roundless } from "../features/home/place";
import { useIdle } from "../lib/idle";
import { mapName } from "../features/match/dossier";
import { tr } from "../i18n";

const SEEN_KEY = "cf-replays-seen";
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const TIPS = [
  "совет: во время записи можно Alt+Tab",
  "совет: перетащи .dem прямо в окно",
  "совет: несколько хайлайтов склеиваются в один ролик",
];

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return tr("только что");
  if (m < 60) return tr("{0} мин назад", m);
  const h = Math.round(m / 60);
  if (h < 24) return tr("{0} ч назад", h);
  return tr("{0} д назад", Math.round(h / 24));
}

// печатает строку по буквам, держит, стирает и берет следующую
function useTyper(lines, hold = 4500, paused = false) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const [phase, setPhase] = useState("type");
  const line = lines[i % lines.length] ?? { text: "" };
  const key = line.text;
  // строка поменялась на лету (например, растут проценты) — показываем ее целиком без перепечатки
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current !== key && line.live) setN(key.length);
    prev.current = key;
  }, [key, line.live]);
  useEffect(() => {
    // окно не в фокусе — строка замирает как есть (не тратим процессор, пока ты в игре)
    if (paused) return;
    let t;
    if (phase === "type") {
      if (n < key.length) t = setTimeout(() => setN(n + 1), 28);
      else if (lines.length > 1) t = setTimeout(() => setPhase("erase"), hold);
    } else if (n > 0) t = setTimeout(() => setN(n - 1), 12);
    else { setI((x) => (x + 1) % lines.length); setPhase("type"); }
    return () => clearTimeout(t);
  }, [n, phase, key, lines.length, hold, paused]);
  return { line, text: key.slice(0, n), done: phase === "type" && n >= key.length };
}

export function LiveStatus({ cs2, rendering, progress, archiveCount, onOpen }) {
  const [running, setRunning] = useState(false);
  const [replays, setReplays] = useState([]);
  const [seen, setSeen] = useState(readSeen);
  const [open, setOpen] = useState(false);
  const [game, setGame] = useState(null); // что сейчас в игре (gsi.rs)
  const box = useRef(null);

  useEffect(() => {
    invoke("gsi_home").then((h) => setGame(h.live)).catch(() => {});
    const un = listen("gsi-update", (e) => setGame(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.hidden) return;
      invoke("cs2_running").then((r) => alive && setRunning(r)).catch(() => {});
      if (cs2) invoke("list_replays", { cs2 }).then((r) => alive && setReplays(r)).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [cs2]);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  const fresh = replays.filter((r) => r.modified > seen);
  const markSeen = () => {
    const max = Math.max(seen, ...replays.map((r) => r.modified));
    setSeen(max);
    try { localStorage.setItem(SEEN_KEY, String(max)); } catch {}
  };

  const lines = rendering
    ? [{ text: tr("запись · {0}%", Math.floor(progress)), kind: "rec", live: true }]
    : [
        // где ты: сервер, режим, карта, счёт — обновляется на лету, без перепечатки
        ...(game?.connected && game.map ? [(() => {
          const pl = placeOf(game);
          const score = game.team === "CT" ? `${game.score_ct}:${game.score_t}` : `${game.score_t}:${game.score_ct}`;
          return { text: [pl.title, pl.kind === "community" ? pl.sub : "", pl.kind === "demo" ? "" : roundless(game.mode) ? `${game.kills}/${game.deaths}` : score].filter(Boolean).join(" · "), kind: "run", live: true };
        })()] : []),
        ...fresh.slice(0, 1).map((r) => ({ text: tr("новый матч: {0} · открыть", mapName(r.map) || "demo"), kind: "new" })),
        { text: running ? tr("CS2 запущен") : tr("CS2 готов к записи"), kind: running ? "run" : "ok" },
        replays.length
          ? { text: tr("скачанных матчей CS2: {0}", replays.length), kind: "ok" }
          : { text: tr("скачай матч в CS2 → Смотреть"), kind: "ok" },
        ...(archiveCount ? [{ text: tr("демок в архиве: {0}", archiveCount), kind: "ok" }] : []),
        { text: tr(TIPS[Math.floor(Date.now() / 600000) % TIPS.length]), kind: "tip" },
      ];
  const idle = useIdle();
  const { line, text, done } = useTyper(lines, 4500, idle);

  const toggle = () => { setOpen((o) => !o); markSeen(); };
  const pick = (path) => { setOpen(false); markSeen(); onOpen(path); };

  return (
    <div className="live" ref={box}>
      <button type="button" className={`live__chip mono live--${line.kind}`} onClick={toggle} aria-expanded={open}
        title={tr("Скачанные матчи CS2")}>
        <i className="live__dot" />
        <span className="live__text">{text}<i className={`live__caret ${done ? "is-blink" : ""}`} /></span>
        {fresh.length > 0 && <b className="live__badge">{fresh.length}</b>}
      </button>
      {open && (
        <div className="live__pop">
          <div className="live__head">
            <b>{tr("Скачанные матчи CS2")}</b>
            <span className="mono dim">{running ? tr("CS2 запущен") : "replays"}</span>
          </div>
          {replays.length === 0 ? (
            <p className="live__empty dim">{tr("Пока пусто. В CS2 открой «Смотреть» → «Ваши матчи» и скачай матч: он появится здесь сам.")}</p>
          ) : (
            <ul className="live__list">
              {replays.slice(0, 8).map((r) => (
                <li key={r.path}>
                  <button type="button" onClick={() => pick(r.path)}>
                    <b>{mapName(r.map) || "demo"}</b>
                    {r.modified > seen && <em className="mono">{tr("новый")}</em>}
                    <span className="mono dim">{ago(r.modified)} · {Math.round(r.size / 1048576)} MB</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="live__folder mono" onClick={() => invoke("open_replays", { cs2 }).catch(() => {})}>
            {tr("открыть папку replays")} ↗
          </button>
        </div>
      )}
    </div>
  );
}
