import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Overlay from "./overlay";
import Toast from "./toast";
import { installNativeGuards } from "./native-guards";
import "./index.css";

installNativeGuards();

// То же приложение открывается и в служебных окнах: подсказка поверх CS2 ("overlay")
// и уведомление «хайлайт готов» ("toast")
let label = "main";
try { label = getCurrentWindow().label; } catch { /* не в Tauri */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {label === "overlay" ? <Overlay /> : label === "toast" ? <Toast /> : <App />}
  </React.StrictMode>
);
