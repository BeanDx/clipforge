// Достижения и бейджи своего профиля. Считаются из трёх источников:
// 1) история из игры (gsi.rs): эйсы, 4K, раунды «все в голову», ножи, матчи, победы, MVP, часы;
// 2) «подвиги» из разобранных демок (moments.js): клатчи, прострелы, no-scope, ниндзя-дефьюзы и т. п. —
//    при открытии демки записываются моменты только своих аккаунтов Steam, без повторов (файл + раунд);
// 3) счётчик готовых клипов (событие render-done).
// Почти у всех бейджей три ступени: бронза → серебро → золото. Разовые (клатч 1v5) — сразу золото.
// Хранится в localStorage — это данные одного компьютера, как и история GSI.
import { invoke } from "@tauri-apps/api/core";

const KEY = "cf-achievements";
const EMPTY = { feats: {}, renders: 0 };

function load() {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...EMPTY }; }
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* без localStorage — только на сессию */ }
  window.dispatchEvent(new Event("cf-achievements"));
}

// свои аккаунты Steam на этом компьютере (один запрос на всю сессию)
let idsP = null;
const ownIds = () => (idsP ??= invoke("steam_users").then((l) => new Set((l || []).map(String))).catch(() => new Set()));

// моменты разобранной демки → подвиги своих аккаунтов
export async function recordDemo(demo, clips) {
  const ids = await ownIds();
  if (!ids.size || !clips?.length) return;
  const file = String(demo.path || "").split(/[\\/]/).pop();
  const base = `${file}:${demo.size || 0}`;
  const s = load();
  let changed = false;
  for (const c of clips) {
    if (!ids.has(String(c.steamid))) continue;
    const k = `${base}#${c.round}`;
    if (s.feats[k]) continue;
    s.feats[k] = { t: c.tags || [], k: c.kills || 0, cl: c.clutch || 0, sc: Math.round(c.score || 0), at: Date.now() };
    changed = true;
  }
  if (changed) save(s);
}

export function noteRender() {
  const s = load();
  s.renders = (s.renders || 0) + 1;
  save(s);
}

// сколько рендеров сделано на этом компьютере
export const renderCount = () => load().renders || 0;

export const onAchievements = (f) => {
  window.addEventListener("cf-achievements", f);
  return () => window.removeEventListener("cf-achievements", f);
};

// --- правила ---

// steps — пороги ступеней; одна ступень — разовый бейдж
// name/desc — русские строки (ключи перевода), {0} — порог
export const ACHIEVEMENTS = [
  { id: "ace", icon: "★", name: "Эйс", desc: "Убей всю команду соперника за раунд — {0} раз", steps: [1, 10, 50] },
  { id: "4k", icon: "◆", name: "Четыре из пяти", desc: "4K за раунд — {0} раз", steps: [5, 25, 100] },
  { id: "allhs", icon: "⊕", name: "Только в голову", desc: "Раунд, где все киллы в голову — {0} раз", steps: [5, 25, 100] },
  { id: "knife", icon: "†", name: "Мясник", desc: "Килл ножом — {0} раз", steps: [1, 10, 50] },
  { id: "clutch", icon: "♛", name: "Клатчер", desc: "Выиграй клатч — {0} раз", steps: [1, 10, 50] },
  { id: "clutch4", icon: "♚", name: "Один против всех", desc: "Выиграй клатч 1v4 или 1v5 — {0} раз", steps: [1, 5, 20] },
  { id: "clutch5", icon: "✪", name: "Клатч 1v5", desc: "Выиграй раунд один против пятерых", steps: [1], rare: true },
  { id: "wall", icon: "▦", name: "Рентген", desc: "Килл сквозь стену — {0} раз", steps: [5, 25, 100] },
  { id: "smoke", icon: "☁", name: "Сквозь туман", desc: "Килл через смок — {0} раз", steps: [5, 25, 100] },
  { id: "noscope", icon: "◎", name: "Без прицела", desc: "No-scope со снайперки — {0} раз", steps: [1, 10, 50] },
  { id: "air", icon: "⤒", name: "Прыгун", desc: "Килл в прыжке — {0} раз", steps: [5, 25, 100] },
  { id: "blind", icon: "◐", name: "Наощупь", desc: "Килл ослеплённым — {0} раз", steps: [1, 10, 50] },
  { id: "collat", icon: "⁑", name: "Два в одном", desc: "Коллатерал — {0} раз", steps: [1, 5, 25] },
  { id: "ninja", icon: "☾", name: "Ниндзя", desc: "Разминируй бомбу, пока враги живы — {0} раз", steps: [1, 5, 20] },
  { id: "long", icon: "↗", name: "Дальнобой", desc: "Килл с 40+ метров — {0} раз", steps: [5, 25, 100] },
  { id: "eco", icon: "$", name: "Эко-герой", desc: "Мультикилл на эко — {0} раз", steps: [1, 10, 50] },
  { id: "legend", icon: "✦", name: "Легендарно", desc: "Момент уровня «Легенда» — {0} раз", steps: [1, 10, 50] },
  { id: "aceHs", icon: "☠", name: "Эйс в голову", desc: "Эйс, где все пять киллов в голову", steps: [1], rare: true },
  { id: "aceKnife", icon: "⚔", name: "Мейджор-стиль", desc: "Добей эйс или клатч ножом", steps: [1], rare: true },
  { id: "matches", icon: "▣", name: "Ветеран", desc: "Сыграй {0} матчей с открытым clipforge", steps: [10, 100, 500] },
  { id: "wins", icon: "▲", name: "Победитель", desc: "Выиграй {0} матчей", steps: [10, 100, 500] },
  { id: "mvp", icon: "✧", name: "MVP", desc: "Стань MVP раунда {0} раз", steps: [10, 100, 500] },
  { id: "hours", icon: "◷", name: "Без сна", desc: "Проведи в игре {0} ч с открытым clipforge", steps: [10, 100, 1000] },
  { id: "renders", icon: "▶", name: "Режиссёр", desc: "Заверши {0} рендеров", steps: [1, 25, 100] },
];

export const TIER_NAMES = ["бронза", "серебро", "золото"];
// цвет по рангу: закрыт, бронза, серебро, золото (разовые редкие — тоже золото)
export const TIER_COLOR = ["#55637a", "#c98a52", "#c7d0da", "#f5c518"];

// счётчики из всех источников
export function counters(history) {
  const s = load();
  const c = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, 0]));
  const has = (f, tag) => f.t.includes(tag);

  // демки
  let dAce = 0, d4k = 0, dHs = 0, dKnife = 0;
  for (const f of Object.values(s.feats)) {
    if (f.k >= 5) dAce++;
    if (f.k === 4) d4k++;
    if (has(f, "все в голову")) dHs++;
    if (has(f, "ножом")) dKnife++;
    if (f.cl) c.clutch++;
    if (f.cl >= 4) c.clutch4++;
    if (f.cl >= 5) c.clutch5++;
    if (has(f, "сквозь стену")) c.wall++;
    if (has(f, "через смок")) c.smoke++;
    if (has(f, "no-scope")) c.noscope++;
    if (has(f, "в прыжке")) c.air++;
    if (has(f, "ослепленным")) c.blind++;
    if (has(f, "коллатерал")) c.collat++;
    if (has(f, "ниндзя-дефьюз")) c.ninja++;
    if (f.t.some((t) => /^\d+ м$/.test(t))) c.long++;
    if (has(f, "эко") && f.k >= 2) c.eco++;
    if (f.sc >= 130) c.legend++;
    if (f.k >= 5 && has(f, "все в голову")) c.aceHs++;
    if ((f.k >= 5 || f.cl) && has(f, "ножом")) c.aceKnife++;
  }

  // история из игры
  const ms = history?.matches || [];
  let gAce = 0, g4k = 0, gHs = 0, gKnife = 0;
  for (const m of ms) {
    for (const r of m.rounds || []) {
      if (r.kills >= 5) gAce++;
      if (r.kills === 4) g4k++;
      if (r.kills >= 2 && r.hs === r.kills) gHs++;
      if (r.knife) gKnife++;
      if (r.kills >= 5 && r.hs === r.kills) c.aceHs = Math.max(c.aceHs, 1);
      if (r.kills >= 5 && r.knife) c.aceKnife = Math.max(c.aceKnife, 1);
    }
    if (m.finished) c.matches++;
    if (m.result === "win") c.wins++;
    c.mvp += m.mvps || 0;
  }
  c.hours = Math.floor(Object.values(history?.days || {}).reduce((a, x) => a + x, 0) / 3600);
  // одни и те же раунды могут быть и в истории, и в демке — берём больший счёт, а не сумму
  c.ace = Math.max(dAce, gAce);
  c["4k"] = Math.max(d4k, g4k);
  c.allhs = Math.max(dHs, gHs);
  c.knife = Math.max(dKnife, gKnife);
  c.renders = s.renders || 0;
  return c;
}

// состояние каждого бейджа: ступень (0 — не открыт), прогресс к следующей
export function evaluate(history) {
  const c = counters(history);
  return ACHIEVEMENTS.map((a) => {
    const v = c[a.id] || 0;
    const tier = a.steps.filter((x) => v >= x).length; // 0..steps.length
    const max = tier >= a.steps.length;
    const next = max ? a.steps[a.steps.length - 1] : a.steps[tier];
    const prev = tier ? a.steps[tier - 1] : 0;
    // ранг для «лучших» бейджей: разовые редкие и золото — выше всего
    const level = !tier ? 0 : a.steps.length === 1 ? 3 : tier;
    return {
      ...a, value: v, tier, level, max, next,
      progress: max ? 1 : Math.max(0, Math.min(1, (v - prev) / Math.max(1, next - prev))),
      rank: level * 100 + (a.rare ? 50 : 0) + Math.min(49, a.steps[Math.max(0, tier - 1)] / 10),
    };
  });
}

// лучшие открытые бейджи — для карточки игрока
export const topBadges = (list, n = 3) => list.filter((a) => a.tier).sort((a, b) => b.rank - a.rank).slice(0, n);

export const loadHistory = () => invoke("gsi_home").then((h) => h?.history).catch(() => null);
export const isOwn = (steamid) => ownIds().then((s) => s.has(String(steamid)));
