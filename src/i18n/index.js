// Язык интерфейса. Ключ перевода — сама русская строка: tr("Сохранить") по-русски вернёт её же,
// по-английски — перевод из ./i18n.en.js. {0}, {1}… в строке заменяются аргументами.
// При первом запуске язык берётся из системы: русский — русский, любой другой — английский.
// Выбор в «Настройках» запоминается и применяется сразу, без перезапуска.
import { useSyncExternalStore } from "react";
import EN from "./en";

const KEY = "cf-lang";
const listeners = new Set();

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "ru" || saved === "en") return saved;
  } catch { /* без localStorage — по системе */ }
  const sys = (navigator.languages?.[0] || navigator.language || "en").toLowerCase();
  return sys.startsWith("ru") ? "ru" : "en";
}

let lang = detect();
document.documentElement.lang = lang;

export const getLang = () => lang;

export function setLang(next) {
  if (next !== "ru" && next !== "en") return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* только на эту сессию */ }
  document.documentElement.lang = next;
  listeners.forEach((f) => f());
}

// служебные окна (подсказка поверх игры, уведомление) узнают о смене языка через localStorage
window.addEventListener("storage", (e) => {
  if (e.key === KEY && (e.newValue === "ru" || e.newValue === "en") && e.newValue !== lang) {
    lang = e.newValue;
    document.documentElement.lang = lang;
    listeners.forEach((f) => f());
  }
});

const subscribe = (f) => { listeners.add(f); return () => listeners.delete(f); };
// компонент с этим хуком перерисовывается при смене языка (вместе со всеми вложенными)
export const useLang = () => useSyncExternalStore(subscribe, getLang);

export function tr(key, ...args) {
  let s = lang === "en" ? EN[key] ?? key : key;
  if (args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? m));
  return s;
}

// Перевод сообщения целиком, в том числе с подставленными значениями: «не удалось прочитать трек: <ошибка>»
// узнаётся по шаблону «не удалось прочитать трек: {0}». Нужно для ошибок из Rust и сообщений с путями.
let patterns = null;
export function trError(msg) {
  const s = String(msg ?? "");
  if (lang !== "en" || !s) return s;
  if (EN[s]) return EN[s];
  patterns ??= Object.keys(EN).filter((k) => k.includes("{0}")).map((k) => [
    new RegExp("^" + k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\d+)\\?\}/g, "(.*?)") + "$", "s"), k,
  ]);
  for (const [re, k] of patterns) {
    const m = re.exec(s);
    if (m) return tr(k, ...m.slice(1));
  }
  return s;
}