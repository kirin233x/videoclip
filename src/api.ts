// 和 Rust 端通信。在普通浏览器里（npm run dev 调试界面）使用 mock 数据。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface VideoInfo {
  path: string;
  name: string;
  size: number;
  width: number;
  height: number;
  rotation: number;
  codec: string;
  codecName: string;
  /** 秒 */
  duration: number;
  frameCount: number;
  avgFps: number;
  vfr: boolean;
  /** 每一帧的显示时间（秒），升序 */
  pts: number[];
  source: string;
}

export interface VideoEntry {
  id: string;
  path: string;
  /** 转码后用于显示的视频 */
  playPath?: string | null;
  name: string;
  addedAt: number;
}

export interface MeasureRecord {
  id: string;
  videoId: string;
  label: string;
  note: string;
  /** 帧序号，从 0 开始（界面上显示时 +1） */
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
  createdAt: number;
}

export type Theme = "auto" | "light" | "dark";

export interface Settings {
  theme?: Theme;
  rate?: number;
}

export interface Library {
  version: number;
  videos: VideoEntry[];
  records: MeasureRecord[];
  labels: string[];
  settings: Settings | null;
}

/** WebCodecs 逐帧解码用的采样表（按解码顺序） */
export interface SampleTable {
  codec: string;
  description: number[];
  codedWidth: number;
  codedHeight: number;
  offsets: number[];
  sizes: number[];
  keys: boolean[];
  /** 对应 VideoInfo.pts 里的第几帧，-1 表示不显示 */
  frames: number[];
}

export interface Tools {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const VIDEO_EXTS = ["mp4", "mov", "m4v", "3gp", "mkv", "webm", "avi", "ts"];

export function isVideoPath(p: string) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.includes(ext);
}

export function baseName(p: string) {
  return p.split(/[\\/]/).pop() || p;
}

export function fileSrc(path: string) {
  return inTauri ? convertFileSrc(path) : path;
}

// ------------------------------------------------------------------ 浏览器调试用的 mock

const MOCK_KEY = "videoclip-mock-library";
const mock = {
  async loadLibrary(): Promise<Library> {
    try {
      const s = localStorage.getItem(MOCK_KEY);
      if (s) return JSON.parse(s);
    } catch {
      /* 忽略 */
    }
    return { version: 1, videos: [], records: [], labels: [], settings: {} };
  },
  async saveLibrary(lib: Library) {
    try {
      localStorage.setItem(MOCK_KEY, JSON.stringify(lib));
    } catch {
      /* 忽略 */
    }
  },
  async probeVideo(path: string): Promise<VideoInfo> {
    // public/mock/xxx.mp4 对应 public/mock/xxx.mp4.json（用 ffprobe 生成）
    const r = await fetch(path + ".json");
    if (!r.ok) throw new Error("找不到文件：" + path);
    return r.json();
  },
};

// ------------------------------------------------------------------ API

export const api = {
  loadLibrary: (): Promise<Library> => (inTauri ? invoke("load_library") : mock.loadLibrary()),
  saveLibrary: (library: Library): Promise<void> => (inTauri ? invoke("save_library", { library }) : mock.saveLibrary(library)),
  probeVideo: (path: string): Promise<VideoInfo> => (inTauri ? invoke("probe_video", { path }) : mock.probeVideo(path)),
  sampleTable: (path: string): Promise<SampleTable> =>
    inTauri ? invoke("sample_table", { path }) : fetch(path + ".samples.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error("no samples")))),
  /** 读取文件中的一段原始字节 */
  readSpan: async (path: string, offset: number, len: number): Promise<Uint8Array> => {
    if (inTauri) return new Uint8Array(await invoke<ArrayBuffer>("read_span", { path, offset, len }));
    const r = await fetch(path, { headers: { Range: `bytes=${offset}-${offset + len - 1}` } });
    const buf = new Uint8Array(await r.arrayBuffer());
    return r.status === 206 ? buf : buf.subarray(offset, offset + len);
  },
  toolsStatus: (): Promise<Tools> => (inTauri ? invoke("tools_status") : Promise.resolve({ ffmpeg: null, ffprobe: null })),
  transcodeVideo: (path: string): Promise<string> =>
    inTauri ? invoke("transcode_video", { path }) : Promise.reject(new Error("浏览器预览不支持转码")),
  exportXlsx: (library: Library, ids: string[] | null, path: string): Promise<number> =>
    invoke("export_xlsx", { library, ids, tzOffsetMin: -new Date().getTimezoneOffset(), path }),
};

export async function pickVideos(): Promise<string[]> {
  if (!inTauri) return ["/mock/sample.mp4"];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({
    multiple: true,
    directory: false,
    title: "选择启动录屏",
    filters: [{ name: "视频", extensions: VIDEO_EXTS }],
  });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

export async function pickVideo(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: false, directory: false, filters: [{ name: "视频", extensions: VIDEO_EXTS }] });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!inTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "导出 Excel", defaultPath: defaultName, filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }] });
}

export async function revealFile(path: string) {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function openFile(path: string) {
  if (!inTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

/** 监听拖拽文件进窗口 */
export async function onFileDrop(handlers: {
  over: (on: boolean) => void;
  drop: (paths: string[]) => void;
}): Promise<() => void> {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") handlers.over(true);
    else if (p.type === "leave") handlers.over(false);
    else if (p.type === "drop") {
      handlers.over(false);
      handlers.drop(p.paths);
    }
  });
}

export async function startWindowDrag() {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}
