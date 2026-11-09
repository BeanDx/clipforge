// Пройден ли мастер первого запуска (SetupWizard.jsx)
export const SETUP_KEY = "cf-setup-done";
// первый запуск — ещё ни разу не сохранялись пути и мастер не проходили
export const isFirstRun = () => {
  try { return !localStorage.getItem(SETUP_KEY) && !localStorage.getItem("cf-paths"); } catch { return false; }
};
export const markSetupDone = () => { try { localStorage.setItem(SETUP_KEY, "1"); } catch { /* только на сессию */ } };
