// Окно не в фокусе (ты в игре) — анимации стоят: класс cf-idle на <html> ставит их на паузу (index.css),
// живая строка не печатает. Иначе открытое поверх CS2 окно перерисовывается постоянно (~5% процессора).
import { useEffect, useState } from "react";

const listeners = new Set();
let idle = typeof document !== "undefined" && !document.hasFocus();

function set(v) {
  if (idle === v) return;
  idle = v;
  document.documentElement.classList.toggle("cf-idle", v);
  listeners.forEach((f) => f(v));
}

export function installIdle() {
  document.documentElement.classList.toggle("cf-idle", idle);
  window.addEventListener("blur", () => set(true));
  window.addEventListener("focus", () => set(false));
  document.addEventListener("visibilitychange", () => set(document.hidden || !document.hasFocus()));
}

export function useIdle() {
  const [v, setV] = useState(idle);
  useEffect(() => { listeners.add(setV); return () => listeners.delete(setV); }, []);
  return v;
}
