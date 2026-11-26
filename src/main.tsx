import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { isMac, isWindows } from "./utils";

// macOS 用透明标题栏（红绿灯浮在侧栏上），Windows 用系统原生标题栏
if (isWindows) document.documentElement.classList.add("windows");
if (isMac) document.documentElement.classList.add("mac");

// 防止拖文件进来时 WebView 直接打开它
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
