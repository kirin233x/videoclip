// 全局状态：视频列表、记录、每个视频的帧时间表、标记点
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, baseName, isVideoPath, Library, MeasureRecord, Settings, Tools, VideoEntry, VideoInfo } from "./api";
import { useToast } from "./components/ui";
import { uid } from "./utils";

export interface ProbeState {
  status: "loading" | "ready" | "error";
  info?: VideoInfo;
  /** 用于显示的视频（转码后）的时间表；没有转码时等于 info */
  play?: VideoInfo;
  error?: string;
}

export interface Marks {
  start: number | null;
  end: number | null;
}

export type Route = "measure" | "records";

interface Store {
  lib: Library;
  loaded: boolean;
  settings: Settings;
  saveSettings: (s: Partial<Settings>) => void;
  route: Route;
  setRoute: (r: Route) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  probes: Record<string, ProbeState>;
  reprobe: (v: VideoEntry) => void;
  tools: Tools | null;
  importPaths: (paths: string[]) => Promise<void>;
  removeVideo: (id: string) => void;
  relocateVideo: (id: string, path: string) => void;
  setPlayPath: (id: string, playPath: string | null) => void;
  addRecord: (r: Omit<MeasureRecord, "id" | "createdAt">) => MeasureRecord;
  updateRecord: (id: string, patch: Partial<MeasureRecord>) => void;
  deleteRecords: (ids: string[]) => void;
  marks: Record<string, Marks>;
  setMarks: (videoId: string, m: Partial<Marks>) => void;
  /** 定位到某条记录（跳到它的起点并高亮），不改动待配对的标记 */
  focus: { videoId: string; frame: number; recordId: string; nonce: number } | null;
  focusRecord: (r: MeasureRecord) => void;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

const EMPTY: Library = { version: 1, videos: [], records: [], labels: [], settings: {} };

export function StoreProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [lib, setLib] = useState<Library>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>("measure");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [tools, setTools] = useState<Tools | null>(null);
  const [marks, setMarksState] = useState<Record<string, Marks>>({});
  const [focus, setFocus] = useState<Store["focus"]>(null);
  const libRef = useRef(lib);
  libRef.current = lib;

  // ------------------------------------------------------------ 读取与保存
  useEffect(() => {
    api
      .loadLibrary()
      .then((l) => {
        const fixed = { ...EMPTY, ...l, settings: l.settings ?? {} };
        setLib(fixed);
        setSelectedId(fixed.videos[0]?.id ?? null);
      })
      .catch((e) => toast(String(e), { error: true }))
      .finally(() => setLoaded(true));
    api.toolsStatus().then(setTools).catch(() => {});
  }, [toast]);

  const saveTimer = useRef<number>();
  const dirty = useRef(false);
  const update = useCallback((fn: (l: Library) => Library) => {
    setLib((l) => fn(l));
    dirty.current = true;
  }, []);
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      dirty.current = false;
      api.saveLibrary(libRef.current).catch((e) => toast("保存失败：" + e, { error: true }));
    }, 250);
  }, [lib, loaded, toast]);
  // 关闭窗口前把没保存的写进去
  useEffect(() => {
    const flush = () => {
      if (dirty.current) api.saveLibrary(libRef.current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  const settings = lib.settings ?? {};
  const saveSettings = useCallback(
    (s: Partial<Settings>) => update((l) => ({ ...l, settings: { ...(l.settings ?? {}), ...s } })),
    [update],
  );

  // ------------------------------------------------------------ 读取帧时间表
  const probing = useRef(new Set<string>());
  const probe = useCallback(async (v: VideoEntry) => {
    const key = v.id + "|" + v.path + "|" + (v.playPath ?? "");
    if (probing.current.has(key)) return;
    probing.current.add(key);
    setProbes((p) => ({ ...p, [v.id]: { ...p[v.id], status: "loading", error: undefined } }));
    try {
      const info = await api.probeVideo(v.path);
      let play = info;
      if (v.playPath) {
        try {
          play = await api.probeVideo(v.playPath);
        } catch {
          play = info; // 转码文件被清理了，退回原视频
        }
      }
      setProbes((p) => ({ ...p, [v.id]: { status: "ready", info, play } }));
    } catch (e) {
      setProbes((p) => ({ ...p, [v.id]: { status: "error", error: String(e) } }));
    } finally {
      probing.current.delete(key);
    }
  }, []);

  // 所有视频都在后台读一遍（只读容器，很快），侧栏能显示时长
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      for (const v of lib.videos) {
        if (!probes[v.id]) await probe(v);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, lib.videos]);

  // ------------------------------------------------------------ 视频
  const importPaths = useCallback(
    async (paths: string[]) => {
      const vids = paths.filter(isVideoPath);
      if (!vids.length) {
        if (paths.length) toast("没有可以导入的视频（支持 MP4 / MOV / MKV 等）", { error: true });
        return;
      }
      const existing = new Map(libRef.current.videos.map((v) => [v.path, v.id]));
      const now = Date.now();
      const added: VideoEntry[] = [];
      let firstId: string | null = null;
      vids.forEach((p, i) => {
        const id = existing.get(p);
        if (id) {
          firstId ??= id;
          return;
        }
        const v = { id: uid(), path: p, name: baseName(p), playPath: null, addedAt: now + i };
        added.push(v);
        firstId ??= v.id;
      });
      if (added.length) {
        update((l) => ({ ...l, videos: [...l.videos, ...added] }));
        toast(`已导入 ${added.length} 个视频` + (vids.length > added.length ? `（${vids.length - added.length} 个已在列表中）` : ""));
      } else {
        toast("这些视频已经在列表里了");
      }
      if (firstId) {
        setSelectedId(firstId);
        setRoute("measure");
      }
    },
    [toast, update],
  );

  const removeVideo = useCallback(
    (id: string) => {
      const before = libRef.current;
      const v = before.videos.find((x) => x.id === id);
      if (!v) return;
      const idx = before.videos.findIndex((x) => x.id === id);
      const recs = before.records.filter((r) => r.videoId === id);
      const n = recs.length;
      update((l) => ({ ...l, videos: l.videos.filter((x) => x.id !== id), records: l.records.filter((r) => r.videoId !== id) }));
      setSelectedId((s) => {
        if (s !== id) return s;
        const rest = before.videos.filter((x) => x.id !== id);
        return rest[Math.min(idx, rest.length - 1)]?.id ?? null;
      });
      toast(`已移除「${v.name}」` + (n ? `及 ${n} 条记录` : ""), {
        action: {
          label: "撤销",
          onClick: () => {
            update((l) => {
              const videos = [...l.videos];
              videos.splice(Math.min(idx, videos.length), 0, v);
              return { ...l, videos, records: [...l.records, ...recs] };
            });
            setSelectedId(id);
          },
        },
      });
    },
    [toast, update],
  );

  const relocateVideo = useCallback(
    (id: string, path: string) => {
      update((l) => ({ ...l, videos: l.videos.map((v) => (v.id === id ? { ...v, path, playPath: null } : v)) }));
      setProbes((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    },
    [update],
  );

  const setPlayPath = useCallback(
    (id: string, playPath: string | null) => {
      update((l) => ({ ...l, videos: l.videos.map((v) => (v.id === id ? { ...v, playPath } : v)) }));
      setProbes((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    },
    [update],
  );

  // ------------------------------------------------------------ 记录
  const addRecord = useCallback(
    (r: Omit<MeasureRecord, "id" | "createdAt">) => {
      const rec: MeasureRecord = { ...r, id: uid(), createdAt: Date.now() };
      const label = r.label.trim();
      update((l) => ({
        ...l,
        records: [...l.records, rec],
        labels: label ? [label, ...l.labels.filter((x) => x !== label)].slice(0, 12) : l.labels,
      }));
      return rec;
    },
    [update],
  );

  const updateRecord = useCallback(
    (id: string, patch: Partial<MeasureRecord>) =>
      update((l) => ({ ...l, records: l.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    [update],
  );

  const deleteRecords = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      const removed = libRef.current.records.filter((r) => set.has(r.id));
      if (!removed.length) return;
      update((l) => ({ ...l, records: l.records.filter((r) => !set.has(r.id)) }));
      toast(removed.length > 1 ? `已删除 ${removed.length} 条记录` : "已删除记录", {
        action: { label: "撤销", onClick: () => update((l) => ({ ...l, records: [...l.records, ...removed] })) },
      });
    },
    [toast, update],
  );

  // ------------------------------------------------------------ 标记
  const setMarks = useCallback((videoId: string, m: Partial<Marks>) => {
    setMarksState((s) => ({ ...s, [videoId]: { ...(s[videoId] ?? { start: null, end: null }), ...m } }));
  }, []);

  const focusRecord = useCallback(
    (r: MeasureRecord) => {
      setSelectedId(r.videoId);
      setRoute("measure");
      setFocus({ videoId: r.videoId, frame: r.startFrame, recordId: r.id, nonce: Date.now() });
    },
    [],
  );

  const value = useMemo<Store>(
    () => ({
      lib,
      loaded,
      settings,
      saveSettings,
      route,
      setRoute,
      selectedId,
      select: setSelectedId,
      probes,
      reprobe: probe,
      tools,
      importPaths,
      removeVideo,
      relocateVideo,
      setPlayPath,
      addRecord,
      updateRecord,
      deleteRecords,
      marks,
      setMarks,
      focus,
      focusRecord,
    }),
    [lib, loaded, settings, saveSettings, route, selectedId, probes, probe, tools, importPaths, removeVideo, relocateVideo, setPlayPath, addRecord, updateRecord, deleteRecords, marks, setMarks, focus, focusRecord],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
