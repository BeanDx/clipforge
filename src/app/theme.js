// Оформление окна. Выбор хранится в localStorage и ставится на <html data-theme>,
// чтобы его видели и окна, открытые через портал (они живут вне .app).
export const THEMES = [
  { id: "hud", name: "Тактика", desc: "Как было: жёлтые рамки, вкладки сверху, моноширинный шрифт." },
  { id: "lumen", name: "Lumen", desc: "Меню слева с иконками, мягкие карточки, клипы собираются по шагам." },
];

const KEY = "cf-theme";

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === v) ? v : "hud";
  } catch {
    return "hud";
  }
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* приватный режим: только на сессию */ }
}
