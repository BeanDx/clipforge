// Оформление окна. Выбор хранится в localStorage и ставится на <html data-theme>,
// чтобы его видели и окна, открытые через портал (они живут вне .app).
export const THEMES = [
  { id: "hud", name: "Тактика", desc: "Как было: жёлтые рамки, вкладки сверху, моноширинный шрифт." },
  { id: "lumen", name: "Lumen", desc: "Меню слева с иконками, мягкие карточки, клипы собираются по шагам." },
];

const KEY = "cf-theme";
// Lumen — тема по умолчанию. Раньше по умолчанию была «Тактика», и она записывалась при каждом
// запуске, поэтому всех один раз переводим на Lumen; вернуть «Тактику» можно в настройках
const LUMEN_DEFAULT = "cf-theme-lumen-default";
const DEFAULT = "lumen";

export function readTheme() {
  try {
    if (!localStorage.getItem(LUMEN_DEFAULT)) {
      localStorage.setItem(LUMEN_DEFAULT, "1");
      localStorage.setItem(KEY, DEFAULT);
    }
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* приватный режим: только на сессию */ }
}
