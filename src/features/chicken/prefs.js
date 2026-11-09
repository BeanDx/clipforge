// Настройки курицы (показывать / звук). Хранятся на этом компьютере, меняются сразу во всём окне.
import { useSyncExternalStore } from "react";

const KEY = "cf-chicken";
const DEF = { on: true, sound: true };
const subs = new Set();

let prefs = (() => {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return DEF; }
})();

export function setChickenPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* только на эту сессию */ }
  subs.forEach((f) => f());
}

export function useChickenPrefs() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => prefs);
}
