import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Overlay from "./windows/overlay/Overlay";
import Toast from "./windows/toast/Toast";
import { installNativeGuards } from "./lib/nativeGuards";
import { installIdle } from "./lib/idle";
import "./index.css";

installNativeGuards();

// То же приложение открывается и в служебных окнах: подсказка поверх CS2 ("overlay")
// и уведомление «хайлайт готов» ("toast")
let label = "main";
try { label = getCurrentWindow().label; } catch { /* не в Tauri */ }
// главное окно без фокуса не анимируется (уведомлению и подсказке поверх игры анимации нужны)
if (label === "main") installIdle();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {label === "overlay" ? <Overlay /> : label === "toast" ? <Toast /> : <App />}
  </React.StrictMode>
);
