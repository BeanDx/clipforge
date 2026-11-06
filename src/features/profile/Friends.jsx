// Панель друзей Steam (src-tauri/src/friends.rs): открыть профиль друга или сравнить с ним.
// Свои друзья — с этого компьютера, чужие — со страницы Steam; скрытый список — подсказка, как открыть.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr, trError, useLang } from "../../i18n";
import { LVL_COLOR } from "./data";

// уровни FACEIT друзей: запрос на игрока, поэтому помним до перезапуска
const LEVELS = new Map();

export function Friends({ steamid, own, name, faceitKey, onOpen, onCompare, onCompareQuery, onClose }) {
  useLang();
  const key = (faceitKey || "").trim();
  const [res, setRes] = useState(null); // { source, private, friends }
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [, setTick] = useState(0); // перерисовать, когда подтянулись уровни

  useEffect(() => {
    let alive = true;
    invoke("steam_friends", { steamid }).then((r) => alive && setRes(r)).catch((e) => alive && setErr(trError(e)));
    return () => { alive = false; };
  }, [steamid]);

  // уровни FACEIT — пачками по 6 параллельно, первые 60 друзей
  useEffect(() => {
    if (key.length < 32 || !res?.friends?.length) return;
    let alive = true;
    const todo = res.friends.slice(0, 60).map((f) => f.steamid).filter((id) => !LEVELS.has(id));
    (async () => {
      for (let i = 0; i < todo.length && alive; i += 6) {
        const part = todo.slice(i, i + 6);
        const got = await Promise.all(part.map((id) => invoke("faceit_levels", { key, steamids: [id] }).catch(() => ({}))));
        part.forEach((id, j) => LEVELS.set(id, got[j]?.[id] || null));
        if (alive) setTick((t) => t + 1);
      }
    })();
    return () => { alive = false; };
  }, [res, key]);

  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const l = res?.friends || [];
    return q ? l.filter((f) => f.name.toLowerCase().includes(q)) : l;
  }, [res, filter]);
  // ввод похож на ссылку/SteamID/ник, а среди друзей никого — сравнить с ним напрямую
  const asQuery = filter.trim() && !list.length;

  return (
    <div className="fr-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="fr-panel" role="dialog" aria-modal="true" aria-label={tr("Друзья")}>
        <header className="fr-head">
          <div>
            <span className="fr-kicker mono">{own ? tr("мои друзья") : tr("друзья игрока")}</span>
            <h2>{own ? tr("Друзья") : name}</h2>
          </div>
          {res && !res.private && (
            <span className="fr-count mono">{res.friends.length}<em>{res.source === "local" ? tr("со Steam на этом ПК") : tr("из профиля Steam")}</em></span>
          )}
          <button type="button" className="fr-x" onClick={onClose} aria-label={tr("закрыть")}>×</button>
        </header>

        <form className="fr-filter" onSubmit={(e) => { e.preventDefault(); if (asQuery) onCompareQuery(filter.trim()); }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoComplete="off" autoFocus
            placeholder={tr("найти друга или вставить ссылку на любого игрока")} aria-label={tr("найти друга")} />
          {asQuery && <button type="submit" className="fr-btn is-go">{tr("сравнить")} ↵</button>}
        </form>

        <div className="fr-list">
          {!res && !err && Array.from({ length: 6 }, (_, i) => <div key={i} className="fr-skel" style={{ "--i": i }} />)}
          {err && <p className="fr-msg is-err mono">{err}</p>}
          {res?.private && (
            <div className="fr-private">
              <b>🔒 {own ? tr("Твой список друзей скрыт") : tr("{0} скрыл список друзей", name)}</b>
              {own ? (
                <p>{tr("Открой его в Steam: Профиль → Редактировать профиль → Приватность → «Список друзей» → Открытый. Потом нажми «обновить список».")}</p>
              ) : (
                <p>{tr("Попроси его открыть: Steam → Профиль → Редактировать профиль → Приватность → «Список друзей» → Открытый. А пока можно вставить ссылку на нужного игрока в поле выше.")}</p>
              )}
              <button type="button" className="fr-btn" onClick={() => { setRes(null); setErr(""); invoke("steam_friends", { steamid }).then(setRes).catch((e) => setErr(trError(e))); }}>{tr("обновить список")}</button>
            </div>
          )}
          {res && !res.private && !list.length && !asQuery && <p className="fr-msg dim">{tr("Никого не нашёл")}</p>}
          {list.map((f, i) => {
            const lv = LEVELS.get(f.steamid);
            return (
              <div key={f.steamid} className="fr-row" style={{ "--i": Math.min(i, 20) }}>
                <span className="fr-ava">{f.avatar ? <img src={f.avatar} alt="" loading="lazy" /> : <i />}</span>
                <span className="fr-name">{f.name}</span>
                {lv ? <span className="fr-lvl mono" style={{ "--c": LVL_COLOR(lv[0]) }} title={tr("FACEIT {0} · {1} эло", lv[0], lv[1])}>{lv[0]}<em>{lv[1]}</em></span>
                  : <span className="fr-lvl is-none" aria-hidden="true" />}
                <span className="fr-acts">
                  <button type="button" className="fr-btn" onClick={() => onOpen(f)}>{tr("профиль")}</button>
                  <button type="button" className="fr-btn is-go" onClick={() => onCompare(f)}>{tr("сравнить")}</button>
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
