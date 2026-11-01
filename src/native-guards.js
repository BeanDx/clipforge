// Прячет браузерную природу приложения: убирает системное контекстное меню,
// выделение текста drag'ом, перетаскивание картинок и зум колесом с Ctrl.
// Поля ввода (input/textarea) не трогаем — туда можно вставлять текст (paste),
// это регулируется через CSS user-select, а не здесь.
export function installNativeGuards() {
  const block = (e) => e.preventDefault();

  document.addEventListener("contextmenu", block);
  document.addEventListener("dragstart", block);

  // Ctrl+колесо / Ctrl+ +/- — системный зум webview, выдаёт браузер с головой
  document.addEventListener(
    "wheel",
    (e) => { if (e.ctrlKey) e.preventDefault(); },
    { passive: false }
  );
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
  });

  return () => {
    document.removeEventListener("contextmenu", block);
    document.removeEventListener("dragstart", block);
  };
}