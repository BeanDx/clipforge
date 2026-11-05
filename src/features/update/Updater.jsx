// Автообновление: при запуске и раз в 6 часов спрашиваем latest.json последнего релиза на GitHub
// (tauri-plugin-updater, адрес и открытый ключ — в tauri.conf.json). Есть новая версия — плашка
// в углу, по ней окно со списком изменений (описание релиза, markdown) и кнопка «Обновить»:
// скачивание с прогрессом, проверка подписи, установщик в тихом режиме, перезапуск.
// После обновления один раз показываем «Что нового» в установленной версии.
import { useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { tr, trError, useLang } from "../../i18n";
import { version as APP_VERSION } from "../../../package.json";
import "./updater.css";

const EVERY = 6 * 3_600_000;
const SKIP_KEY = "cf-update-skip"; // версия, которую попросили пропустить
const NOTES_KEY = "cf-update-notes"; // { version, body, date } — чтобы показать после установки
const SEEN_KEY = "cf-seen-version"; // последняя версия, чьё «Что нового» уже показано
// событие для кнопки «Проверить обновления» в «Настройках»
export const CHECK_EVENT = "cf-check-update";

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const newer = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const fmtMb = (b) => (b / 1048576).toFixed(1);

export function Updater() {
  useLang();
  const [update, setUpdate] = useState(null); // объект Update из плагина
  const [open, setOpen] = useState(false); // окно со списком изменений
  const [hidden, setHidden] = useState(false); // плашку закрыли до следующей проверки
  const [stage, setStage] = useState("idle"); // idle | download | install | error
  const [got, setGot] = useState(0);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState(""); // «у вас последняя версия» после ручной проверки
  const [whatsNew, setWhatsNew] = useState(null); // { version, body } после установки
  const busy = useRef(false);

  const run = async (manual) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const u = await check();
      if (u && (manual || ls.get(SKIP_KEY) !== u.version)) {
        setUpdate(u); setHidden(false);
        ls.set(NOTES_KEY, JSON.stringify({ version: u.version, body: u.body || "", date: u.date || "" }));
        if (manual) setOpen(true);
      } else if (manual) {
        setToast(u ? tr("версия {0} пропущена — открываю", u.version) : tr("У тебя последняя версия {0}", APP_VERSION));
        if (u) { setUpdate(u); setOpen(true); }
        setTimeout(() => setToast(""), 3500);
      }
    } catch (e) {
      // нет сети, релиз ещё без latest.json, запуск не из Tauri — молча; при ручной проверке говорим
      if (manual) { setToast(tr("Не получилось проверить обновления: {0}", trError(e))); setTimeout(() => setToast(""), 5000); }
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    // «Что нового» после установки: версия выросла, а заметки к ней сохранены перед обновлением
    const seen = ls.get(SEEN_KEY);
    try {
      const n = JSON.parse(ls.get(NOTES_KEY) || "null");
      if (seen && newer(APP_VERSION, seen) && n?.version === APP_VERSION) setTimeout(() => setWhatsNew(n), 0);
    } catch { /* битые заметки — пропускаем */ }
    ls.set(SEEN_KEY, APP_VERSION);

    const first = setTimeout(() => run(false), 4000); // не мешаем запуску
    const every = setInterval(() => run(false), EVERY);
    const manual = () => run(true);
    window.addEventListener(CHECK_EVENT, manual);
    return () => { clearTimeout(first); clearInterval(every); window.removeEventListener(CHECK_EVENT, manual); };
  }, []);

  const install = async () => {
    if (!update) return;
    setStage("download"); setErr(""); setGot(0); setTotal(0);
    try {
      let sum = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") setTotal(ev.data.contentLength || 0);
        else if (ev.event === "Progress") { sum += ev.data.chunkLength; setGot(sum); }
        else if (ev.event === "Finished") setStage("install");
      });
      // на Windows установщик сам закрывает программу; сюда доходим на других системах
      await relaunch();
    } catch (e) {
      setStage("error"); setErr(trError(e));
    }
  };
  const skip = () => { ls.set(SKIP_KEY, update.version); setOpen(false); setHidden(true); };
  const later = () => { setOpen(false); setHidden(true); };

  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
  const working = stage === "download" || stage === "install";

  return (
    <>
      {update && !hidden && !open && (
        <button type="button" className="up-pill" onClick={() => setOpen(true)}>
          <i className="up-pill__dot" aria-hidden="true" />
          <span>{tr("Доступна версия {0}", update.version)}</span>
          <b>{tr("что нового")} →</b>
        </button>
      )}

      {toast && <div className="up-toast mono" role="status">{toast}</div>}

      {update && open && (
        <Modal onClose={working ? null : later} labelledBy="up-title">
          <header className="up-head">
            <span className="up-kicker mono">{tr("обновление")}</span>
            <h2 id="up-title">clipforge {update.version}</h2>
            <span className="up-ver mono">
              <s>{update.currentVersion || APP_VERSION}</s> → <b>{update.version}</b>
              {update.date ? ` · ${fmtDate(update.date)}` : ""}
            </span>
          </header>
          <div className="up-notes"><Markdown text={update.body} /></div>
          <footer className="up-foot">
            {working || stage === "error" ? (
              <div className="up-progress">
                <div className="up-bar"><i style={{ width: stage === "install" ? "100%" : total ? `${pct}%` : "30%" }} className={!total && stage === "download" ? "is-indet" : ""} /></div>
                <span className="mono">
                  {stage === "install" ? tr("устанавливаю — программа перезапустится сама")
                    : stage === "error" ? <span className="up-err">{err}</span>
                    : total ? tr("скачиваю: {0} из {1} МБ · {2}%", fmtMb(got), fmtMb(total), pct) : tr("скачиваю...")}
                </span>
                {stage === "error" && <button type="button" className="up-btn is-go" onClick={install}>{tr("Повторить")}</button>}
              </div>
            ) : (
              <>
                <button type="button" className="up-btn is-ghost" onClick={skip}>{tr("пропустить эту версию")}</button>
                <span className="up-foot__gap" />
                <button type="button" className="up-btn" onClick={later}>{tr("позже")}</button>
                <button type="button" className="up-btn is-go" onClick={install}>{tr("обновить")}</button>
              </>
            )}
          </footer>
        </Modal>
      )}

      {whatsNew && (
        <Modal onClose={() => setWhatsNew(null)} labelledBy="up-new-title">
          <header className="up-head">
            <span className="up-kicker mono">{tr("обновление установлено")}</span>
            <h2 id="up-new-title">{tr("Что нового в {0}", whatsNew.version)}</h2>
          </header>
          <div className="up-notes"><Markdown text={whatsNew.body} /></div>
          <footer className="up-foot">
            <span className="up-foot__gap" />
            <button type="button" className="up-btn is-go" onClick={() => setWhatsNew(null)}>{tr("отлично")}</button>
          </footer>
        </Modal>
      )}
    </>
  );
}

function fmtDate(d) {
  const t = new Date(String(d).replace(" ", "T").replace(/ \+.*$/, ""));
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString();
}

function Modal({ children, onClose, labelledBy }) {
  useEffect(() => {
    if (!onClose) return;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="up-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="up-modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</div>
    </div>
  );
}

// Небольшой markdown для описания релиза: заголовки, списки, абзацы, **жирный**, `код`, ссылки
// (показываем текстом). Без innerHTML — описание приходит из сети.
function Markdown({ text }) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  if (!lines.some((l) => l.trim())) return <p className="dim">{tr("Описание изменений не приложено.")}</p>;
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(<p key={out.length}>{inline(para.join(" "))}</p>); para = []; } };
  const flushList = () => {
    if (list) { out.push(<ul key={out.length}>{list.map((li, i) => <li key={i} className={li.sub ? "is-sub" : ""}>{inline(li.text)}</li>)}</ul>); list = null; }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    const li = /^(\s*)[-*]\s+(.*)$/.exec(l);
    const quote = /^>\s?(.*)$/.exec(l);
    if (h) { flushPara(); flushList(); out.push(h[1].length <= 2 ? <h3 key={out.length}>{inline(h[2])}</h3> : <h4 key={out.length}>{inline(h[2])}</h4>); }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { flushPara(); flushList(); out.push(<hr key={out.length} />); }
    else if (quote) { flushPara(); flushList(); out.push(<blockquote key={out.length}>{inline(quote[1])}</blockquote>); }
    else if (li) { flushPara(); (list ||= []).push({ text: li[2], sub: li[1].length >= 2 }); }
    else if (!l.trim()) { flushPara(); flushList(); }
    else if (list && /^\s{2,}/.test(raw)) list[list.length - 1].text += " " + l.trim(); // продолжение пункта
    else { flushList(); para.push(l.trim()); }
  }
  flushPara(); flushList();
  return <>{out}</>;
}

function inline(s) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) parts.push(<b key={parts.length}>{inline(t.slice(2, -2))}</b>); // внутри жирного бывает `код`
    else if (t.startsWith("`")) parts.push(<code key={parts.length}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) parts.push(<u key={parts.length}>{t.slice(1, t.indexOf("]"))}</u>);
    else parts.push(<i key={parts.length}>{inline(t.slice(1, -1))}</i>);
    last = m.index + t.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
