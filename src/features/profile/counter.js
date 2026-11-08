// Общий счётчик готовых рендеров (клипы и эдиты) у всех копий clipforge — просто ради прикола.
// Хранится на Abacus (abacus.jasoncameron.dev): после каждого render-done один запрос /hit, без имени
// файла и вообще без данных из демки. Последнее известное число лежит в localStorage — чтобы без сети
// показать хоть что-то и не начинать анимацию с нуля каждый раз.
const URL_BASE = "https://abacus.jasoncameron.dev";
const NS = "clipforge-beandx";
const KEY = "renders";
const CACHE = "cf-global-renders";

const cached = () => { try { return Number(localStorage.getItem(CACHE)) || 0; } catch { return 0; } };
const remember = (v) => { try { localStorage.setItem(CACHE, String(v)); } catch { /* без localStorage — и ладно */ } };

async function call(op) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${URL_BASE}/${op}/${NS}/${KEY}`, { signal: ctrl.signal });
    if (r.status === 404) return 0; // ещё ни одного рендера — ключ появится на первом /hit
    if (!r.ok) throw new Error(`abacus ${r.status}`);
    const v = Number((await r.json()).value);
    if (!Number.isFinite(v)) throw new Error("abacus: нет числа");
    remember(v);
    return v;
  } finally { clearTimeout(t); }
}

export const globalRendersCached = cached;
// null — сервер не ответил
export const fetchGlobalRenders = () => call("get").catch(() => null);
// после готового рендера; ошибки сети никому не мешают
export const hitGlobalRenders = () => call("hit").catch(() => null);
