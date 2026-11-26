import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Crosshair, FilePlus2, Film, Monitor, Moon, Sun, TableProperties, X } from "lucide-react";
import { onFileDrop, pickVideos, Theme } from "./api";
import { ToastProvider } from "./components/ui";
import { StoreProvider, useStore } from "./store";
import MeasurePage from "./pages/Measure";
import RecordsPage from "./pages/Records";
import { fmtSec } from "./utils";

function useSystemDark() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setDark(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return dark;
}

function Sidebar() {
  const s = useStore();
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of s.lib.records) m[r.videoId] = (m[r.videoId] ?? 0) + 1;
    return m;
  }, [s.lib.records]);
  const theme = s.settings.theme ?? "auto";
  const themes: { v: Theme; icon: JSX.Element; title: string }[] = [
    { v: "auto", icon: <Monitor size={14} />, title: "跟随系统" },
    { v: "light", icon: <Sun size={14} />, title: "浅色" },
    { v: "dark", icon: <Moon size={14} />, title: "深色" },
  ];

  return (
    <aside className="sidebar">
      <div className="drag-region" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <div className="brand-logo">
          <img src="/logo.svg" alt="" draggable={false} />
        </div>
        <div>
          <div className="brand-name">VideoClip</div>
          <div className="brand-sub">启动录屏 · 逐帧测耗时</div>
        </div>
      </div>

      <nav className="nav">
        <button className={`nav-item ${s.route === "measure" ? "active" : ""}`} onClick={() => s.setRoute("measure")}>
          <Crosshair size={17} />
          逐帧测量
        </button>
        <button className={`nav-item ${s.route === "records" ? "active" : ""}`} onClick={() => s.setRoute("records")}>
          <TableProperties size={17} />
          记录汇总
          {s.lib.records.length > 0 && <span className="badge">{s.lib.records.length}</span>}
        </button>
      </nav>

      <div className="sidebar-section">
        <span>视频</span>
        <span className="sidebar-count">{s.lib.videos.length || ""}</span>
      </div>
      <div className="video-list">
        {s.lib.videos.length === 0 && <div className="video-list-empty">还没有视频，拖进窗口或点下面的按钮导入</div>}
        {s.lib.videos.map((v) => {
          const p = s.probes[v.id];
          const active = v.id === s.selectedId && s.route === "measure";
          return (
            <div
              key={v.id}
              className={`video-item ${active ? "active" : ""}`}
              onClick={() => {
                s.select(v.id);
                s.setRoute("measure");
              }}
              title={v.path}
            >
              <div className={`video-thumb ${p?.status === "error" ? "error" : ""}`}>
                {p?.status === "error" ? <AlertCircle size={15} /> : <Film size={15} />}
              </div>
              <div className="video-text">
                <div className="video-name">{v.name}</div>
                <div className="video-sub">
                  {p?.status === "ready" && p.info ? (
                    <>
                      {fmtSec(p.info.duration)} · {Math.round(p.info.avgFps)} fps · {p.info.codecName}
                    </>
                  ) : p?.status === "error" ? (
                    <span className="err">无法读取</span>
                  ) : (
                    "读取中…"
                  )}
                </div>
              </div>
              {counts[v.id] ? <span className="video-count">{counts[v.id]}</span> : null}
              <button
                className="video-remove"
                title="从列表移除（不会删除文件）"
                onClick={(e) => {
                  e.stopPropagation();
                  s.removeVideo(v.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button className="btn btn-soft btn-block" onClick={async () => s.importPaths(await pickVideos())}>
          <FilePlus2 size={16} />
          导入视频
        </button>
        <div className="seg" role="radiogroup" aria-label="主题">
          {themes.map((t) => (
            <button
              key={t.v}
              className={theme === t.v ? "on" : ""}
              title={t.title}
              onClick={() => s.saveSettings({ theme: t.v })}
            >
              {t.icon}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const s = useStore();
  const [dropping, setDropping] = useState(false);
  const systemDark = useSystemDark();
  const theme = s.settings.theme ?? "auto";
  const dark = theme === "dark" || (theme === "auto" && systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const { importPaths } = s;
  useEffect(() => {
    let off: (() => void) | undefined;
    onFileDrop({ over: setDropping, drop: (paths) => importPaths(paths) }).then((f) => (off = f));
    return () => off?.();
  }, [importPaths]);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="main-drag" data-tauri-drag-region />
        {s.loaded && (s.route === "measure" ? <MeasurePage /> : <RecordsPage />)}
      </main>
      {dropping && (
        <div className="drop-overlay">
          <div className="drop-card">
            <FilePlus2 size={34} />
            <b>松开导入视频</b>
            <span>支持一次拖入多个文件</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ToastProvider>
  );
}
