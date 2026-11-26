import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Flag,
  FilePlus2,
  FolderOpen,
  Keyboard,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { api, fileSrc, MeasureRecord, pickVideo, pickVideos, revealFile, VideoEntry } from "../api";
import Timeline from "../components/Timeline";
import { Kbd, Menu, MenuItem, Spinner, useToast } from "../components/ui";
import { useFramePlayer } from "../player";
import { ProbeState, useStore } from "../store";
import { fmt1, fmtClock, fmtInt, fmtSize, isMac, labelColor, labelOf, splitMs } from "../utils";

export default function MeasurePage() {
  const s = useStore();
  const video = s.lib.videos.find((v) => v.id === s.selectedId) ?? null;
  if (!video) return <Welcome />;
  const p = s.probes[video.id];
  if (!p || p.status === "loading") {
    return (
      <div className="center-state">
        <Spinner size={28} />
        <p>正在读取帧时间表…</p>
      </div>
    );
  }
  if (p.status === "error") return <ProbeError video={video} probe={p} />;
  return <Workspace key={video.id + (video.playPath ?? "")} video={video} probe={p} />;
}

// ------------------------------------------------------------------ 空状态

function Welcome() {
  const s = useStore();
  return (
    <div className="page">
      <div className="welcome">
        <div className="welcome-art">
          <div className="phone back" />
          <div className="phone front">
            <div className="phone-bar" />
            <div className="phone-flag a">起</div>
            <div className="phone-flag b">终</div>
          </div>
        </div>
        <h1>把启动录屏拖进来</h1>
        <p>
          逐帧找到起点和终点，直接得到精确到帧的毫秒耗时。
          <br />
          一个视频可以记录多段，全部记录一键导出 Excel。
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary btn-lg" onClick={async () => s.importPaths(await pickVideos())}>
            <FilePlus2 size={18} />
            选择视频
          </button>
        </div>
        <div className="steps">
          <div className="step">
            <div className="step-no">1</div>
            <b>
              找到起点，按 <Kbd>S</Kbd>
            </b>
            <span>
              <Kbd>←</Kbd> <Kbd>→</Kbd> 逐帧移动，按住 <Kbd>Shift</Kbd> 一次走 10 帧
            </span>
          </div>
          <div className="step">
            <div className="step-no">2</div>
            <b>
              找到终点，按 <Kbd>E</Kbd>
            </b>
            <span>耗时按每一帧的真实时间戳计算，可变帧率也准确</span>
          </div>
          <div className="step">
            <div className="step-no">3</div>
            <b>
              按 <Kbd>Enter</Kbd> 记录
            </b>
            <span>给这一段起个标签，在「记录汇总」里统计并导出 Excel</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProbeError({ video, probe }: { video: VideoEntry; probe: ProbeState }) {
  const s = useStore();
  return (
    <div className="center-state">
      <div className="state-icon error">
        <AlertTriangle size={26} />
      </div>
      <h2>读取不了这个视频</h2>
      <p className="state-path">{video.path}</p>
      <p className="state-msg">{probe.error}</p>
      <div className="state-actions">
        <button className="btn" onClick={() => s.reprobe(video)}>
          <RefreshCw size={15} />
          重试
        </button>
        <button
          className="btn btn-soft"
          onClick={async () => {
            const p = await pickVideo();
            if (p) s.relocateVideo(video.id, p);
          }}
        >
          <FolderOpen size={15} />
          重新选择文件
        </button>
        <button className="btn btn-ghost" onClick={() => s.removeVideo(video.id)}>
          <Trash2 size={15} />
          从列表移除
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 工作区

const RATES = [0.1, 0.25, 0.5, 1];

function Workspace({ video, probe }: { video: VideoEntry; probe: ProbeState }) {
  const s = useStore();
  const toast = useToast();
  const info = probe.info!;
  const play = probe.play ?? info;
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = fileSrc(video.playPath || video.path);

  // 转码后的帧数和原视频一致时，测量用原视频时间戳，显示用转码文件时间戳
  const sameCount = play.pts.length === info.pts.length;
  const measurePts = sameCount ? info.pts : play.pts;
  const t0 = measurePts[0] ?? 0;
  const msOf = useCallback((i: number) => (measurePts[i] - t0) * 1000, [measurePts, t0]);

  const player = useFramePlayer(videoRef, play.pts, src, s.settings.rate ?? 1);
  const { cur, count, seek, step, toggle } = player;

  const marks = s.marks[video.id] ?? { start: null, end: null };
  const { start, end } = marks;
  const records = useMemo(
    () => s.lib.records.filter((r) => r.videoId === video.id).sort((a, b) => a.createdAt - b.createdAt),
    [s.lib.records, video.id],
  );

  const [label, setLabel] = useState(() => s.lib.labels[0] ?? "");
  const [note, setNote] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [transcoding, setTranscoding] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  /** 当前高亮的已记录区间（点击记录或刚记录完） */
  const [activeRec, setActiveRec] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // 从记录页「定位」过来
  const { focus } = s;
  const focusDone = useRef(0);
  useEffect(() => {
    if (focus && focus.videoId === video.id && player.ready && focusDone.current !== focus.nonce) {
      focusDone.current = focus.nonce;
      setActiveRec(focus.recordId);
      seek(focus.frame);
    }
  }, [focus, video.id, player.ready, seek]);

  // 区间：有终点用终点，没有终点时预览「起点 → 当前帧」
  const liveEnd = end ?? (start !== null ? cur : null);
  const range =
    start !== null && liveEnd !== null
      ? { a: Math.min(start, liveEnd), b: Math.max(start, liveEnd), ms: Math.abs(msOf(liveEnd) - msOf(start)), live: end === null }
      : null;

  const setStart = useCallback(() => s.setMarks(video.id, { start: cur }), [s, video.id, cur]);
  const setEnd = useCallback(() => s.setMarks(video.id, { end: cur }), [s, video.id, cur]);
  const clearMarks = useCallback(() => s.setMarks(video.id, { start: null, end: null }), [s, video.id]);

  const record = useCallback(() => {
    if (start === null) {
      toast("先按 S 标记起点", { error: true });
      return;
    }
    const e = end ?? cur;
    if (e === start) {
      toast("起点和终点是同一帧", { error: true });
      return;
    }
    const a = Math.min(start, e);
    const b = Math.max(start, e);
    const rec = s.addRecord({
      videoId: video.id,
      label: label.trim(),
      note: note.trim(),
      startFrame: a,
      endFrame: b,
      startMs: msOf(a),
      endMs: msOf(b),
    });
    // 配对成功的一段固定成记录，待配对的标记清空，开始标下一段
    s.setMarks(video.id, { start: null, end: null });
    setActiveRec(rec.id);
    setNote("");
    toast(
      <>
        已记录 <b className="toast-em">{labelOf(rec.label)}</b> {fmt1(rec.endMs - rec.startMs)} ms
      </>,
    );
  }, [start, end, cur, s, video.id, label, note, msOf, toast]);

  const markerFrames = useMemo(() => {
    const set = new Set<number>();
    for (const r of records) {
      set.add(r.startFrame);
      set.add(r.endFrame);
    }
    if (start !== null) set.add(start);
    if (end !== null) set.add(end);
    return [...set].sort((a, b) => a - b);
  }, [records, start, end]);

  const jumpMarker = useCallback(
    (dir: -1 | 1) => {
      const f = dir < 0 ? [...markerFrames].reverse().find((x) => x < cur) : markerFrames.find((x) => x > cur);
      if (f !== undefined) seek(f);
    },
    [markerFrames, cur, seek],
  );

  const openRecord = useCallback(
    (r: MeasureRecord) => {
      setActiveRec(r.id);
      seek(r.startFrame);
    },
    [seek],
  );

  const goVideo = useCallback(
    (d: number) => {
      const vs = s.lib.videos;
      const i = vs.findIndex((v) => v.id === video.id);
      const n = vs[i + d];
      if (n) s.select(n.id);
    },
    [s, video.id],
  );

  // ------------------------------------------------------------ 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if (typing) {
        if (e.key === "Escape") t.blur();
        if (e.key === "Enter" && t.dataset.recordOnEnter !== undefined) {
          e.preventDefault();
          record();
          t.blur();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key;
      const big = e.shiftKey ? 10 : 1;
      let handled = true;
      if (k === "ArrowRight" || k === "." || k === "d" || k === "D") step(big);
      else if (k === "ArrowLeft" || k === "," || k === "a" || k === "A") step(-big);
      else if (k === " ") toggle();
      else if (k === "s" || k === "S" || k === "[") setStart();
      else if (k === "e" || k === "E" || k === "]") setEnd();
      else if (k === "Enter") record();
      else if (k === "Home") seek(0);
      else if (k === "End") seek(count - 1);
      else if (k === "ArrowUp") goVideo(-1);
      else if (k === "ArrowDown") goVideo(1);
      else if (k === "Escape") clearMarks();
      else if (k === "l" || k === "L") labelRef.current?.focus();
      else if (k === "q" || k === "Q") jumpMarker(-1);
      else if (k === "w" || k === "W") jumpMarker(1);
      else if (/^[1-9]$/.test(k) && s.lib.labels[+k - 1]) setLabel(s.lib.labels[+k - 1]);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, toggle, setStart, setEnd, record, seek, count, goVideo, clearMarks, jumpMarker, s.lib.labels]);

  // ------------------------------------------------------------ 转码
  const transcode = async () => {
    setTranscoding(true);
    try {
      const out = await api.transcodeVideo(video.path);
      s.setPlayPath(video.id, out);
      toast("已转码为 H.264，测量仍使用原视频的时间戳");
    } catch (e) {
      toast(String(e), { error: true });
    } finally {
      setTranscoding(false);
    }
  };

  const menuItems: MenuItem[] = [
    { label: isMac ? "在访达中显示" : "在资源管理器中显示", icon: <FolderOpen size={15} />, onClick: () => revealFile(video.path) },
    video.playPath
      ? { label: "改回用原视频显示", icon: <RefreshCw size={15} />, onClick: () => s.setPlayPath(video.id, null) }
      : {
          label: "画面不对？转码为 H.264 显示",
          icon: <Wand2 size={15} />,
          disabled: !s.tools?.ffmpeg || transcoding,
          onClick: transcode,
        },
    { label: "重新读取", icon: <RefreshCw size={15} />, onClick: () => s.reprobe(video) },
    "sep",
    { label: "从列表移除", icon: <Trash2 size={15} />, danger: true, onClick: () => s.removeVideo(video.id) },
  ];

  const frameDelta = cur > 0 ? (measurePts[cur] - measurePts[cur - 1]) * 1000 : null;
  const big = range ? splitMs(range.ms) : null;
  const atStart = start === cur;
  const atEnd = end === cur;
  const recHits = records.flatMap((r) =>
    [r.startFrame === cur ? { r, kind: "起点" } : null, r.endFrame === cur ? { r, kind: "终点" } : null].filter(
      (x): x is { r: MeasureRecord; kind: string } => x !== null,
    ),
  );

  return (
    <div className="measure">
      <header className="m-head">
        <div className="m-title">
          <h1 title={video.path}>{video.name}</h1>
          <div className="chips">
            <span className="chip">
              {info.width} × {info.height}
            </span>
            <span className="chip">
              {fmt1(info.avgFps)} fps
              {info.vfr && <em>可变帧率</em>}
            </span>
            <span className="chip">{fmtInt(info.frameCount)} 帧</span>
            <span className="chip">{fmtClock(info.duration)}</span>
            <span className="chip">{info.codecName}</span>
            <span className="chip faint">{fmtSize(info.size)}</span>
            {video.playPath && <span className="chip accent">转码显示</span>}
            {!sameCount && <span className="chip warn">转码后帧数不一致，按转码文件计时</span>}
          </div>
        </div>
        <div className="m-actions">
          <button className="icon-btn" title="更多" onClick={(e) => setMenu(e.currentTarget)}>
            <MoreHorizontal size={18} />
          </button>
        </div>
        {menu && <Menu anchor={menu} onClose={() => setMenu(null)} items={menuItems} />}
      </header>

      <div className="m-body">
        {/* ---------------------------------------------------- 播放器 */}
        <section className="player panel">
          <div className="stage">
            <video ref={videoRef} src={src} preload="auto" muted playsInline disablePictureInPicture />
            <div className="stage-top">
              <span className="pill">
                第 <b>{fmtInt(cur + 1)}</b> / {fmtInt(count)} 帧
              </span>
              <span className="pill">
                <b>{fmt1(msOf(cur))}</b> ms
              </span>
              {atStart && (
                <span className="pill pill-start">
                  <Flag size={12} /> 起点
                </span>
              )}
              {atEnd && (
                <span className="pill pill-end">
                  <Flag size={12} /> 终点
                </span>
              )}
              {recHits.slice(0, 3).map(({ r, kind }) => (
                <span key={r.id + kind} className="pill pill-rec">
                  <i style={{ background: labelColor(r.label) }} />
                  {labelOf(r.label)} · {kind}
                </span>
              ))}
            </div>
            {!player.ready && !player.error && (
              <div className="stage-cover">
                <Spinner size={26} />
              </div>
            )}
            {player.error && (
              <div className="stage-cover">
                <Unplayable
                  error={player.error}
                  codec={info.codecName}
                  ffmpeg={!!s.tools?.ffmpeg}
                  transcoding={transcoding}
                  onTranscode={transcode}
                />
              </div>
            )}
          </div>

          <Timeline
            pts={measurePts}
            cur={cur}
            start={start}
            end={end}
            records={records}
            activeId={activeRec}
            onSeek={seek}
            onRecordClick={openRecord}
          />

          <div className="controls">
            <div className="ctl-group">
              <button className="icon-btn" title="第一帧 (Home)" onClick={() => seek(0)}>
                <ArrowLeftToLine size={17} />
              </button>
              <button className="icon-btn" title="后退 10 帧 (Shift + ←)" onClick={() => step(-10)}>
                <ChevronsLeft size={18} />
              </button>
              <button className="icon-btn" title="上一帧 (←)" onClick={() => step(-1)}>
                <ChevronLeft size={19} />
              </button>
              <button className="play-btn" title="播放 / 暂停 (空格)" onClick={toggle}>
                {player.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <button className="icon-btn" title="下一帧 (→)" onClick={() => step(1)}>
                <ChevronRight size={19} />
              </button>
              <button className="icon-btn" title="前进 10 帧 (Shift + →)" onClick={() => step(10)}>
                <ChevronsRight size={18} />
              </button>
              <button className="icon-btn" title="最后一帧 (End)" onClick={() => seek(count - 1)}>
                <ArrowRightToLine size={17} />
              </button>
            </div>
            <div className="ctl-info">
              <span className="mono">{fmtClock(msOf(cur) / 1000)}</span>
              {frameDelta !== null && (
                <span className="ctl-delta" title="当前帧与上一帧的时间间隔">
                  帧间隔 {fmt1(frameDelta)} ms
                </span>
              )}
            </div>
            <div className="seg seg-rate" title="播放速度">
              {RATES.map((r) => (
                <button
                  key={r}
                  className={player.rate === r ? "on" : ""}
                  onClick={() => {
                    player.setRate(r);
                    s.saveSettings({ rate: r });
                  }}
                >
                  {r}×
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- 测量面板 */}
        <aside className="m-side">
          <div className="measure-card">
            <div className="mc-top">
              <span>{range ? (range.live ? "起点 → 当前帧" : "区间耗时") : "区间耗时"}</span>
              {(start !== null || end !== null) && (
                <button className="mc-clear" title="清除标记 (Esc)" onClick={clearMarks}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className={`mc-number ${range?.live ? "live" : ""}`}>
              {big ? (
                <>
                  {big.int}
                  <small>{big.dec}</small>
                  <span className="unit">ms</span>
                </>
              ) : (
                <span className="mc-empty">— ms</span>
              )}
            </div>
            <div className="mc-sub">
              {range
                ? `${fmtInt(range.b - range.a)} 帧`
                : start === null && end !== null
                  ? "已标终点，按 S 标记起点"
                  : records.length
                    ? "按 S 标记下一段的起点"
                    : "按 S 标记起点，按 E 标记终点"}
            </div>
            <div className="mc-points">
              <button className={`mc-point ${atStart ? "here" : ""}`} disabled={start === null} onClick={() => start !== null && seek(start)} title="跳到这个起点">
                <span className="mc-point-k">起点</span>
                {start !== null ? (
                  <>
                    <b>第 {fmtInt(start + 1)} 帧</b>
                    <i>{fmt1(msOf(start))} ms</i>
                  </>
                ) : (
                  <b className="dim">未标记</b>
                )}
              </button>
              <button className={`mc-point ${atEnd ? "here" : ""}`} disabled={end === null} onClick={() => end !== null && seek(end)} title="跳到这个终点">
                <span className="mc-point-k">终点</span>
                {end !== null ? (
                  <>
                    <b>第 {fmtInt(end + 1)} 帧</b>
                    <i>{fmt1(msOf(end))} ms</i>
                  </>
                ) : (
                  <b className="dim">未标记</b>
                )}
              </button>
            </div>
            <div className="mc-actions">
              <button onClick={setStart}>
                <CircleDot size={15} />
                设为起点 <Kbd>S</Kbd>
              </button>
              <button onClick={setEnd}>
                <Flag size={15} />
                设为终点 <Kbd>E</Kbd>
              </button>
            </div>
          </div>

          <div className="panel record-form">
            <label className="field-label" htmlFor="label-input">
              标签
            </label>
            <input
              id="label-input"
              ref={labelRef}
              className="input"
              placeholder="例如：冷启动-首帧"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-record-on-enter
              maxLength={40}
            />
            {s.lib.labels.length > 0 && (
              <div className="label-chips">
                {s.lib.labels.slice(0, 9).map((l, i) => (
                  <button
                    key={l}
                    className={`label-chip ${l === label.trim() ? "on" : ""}`}
                    onClick={() => setLabel(l)}
                    title={`快捷键 ${i + 1}`}
                  >
                    <i style={{ background: labelColor(l) }} />
                    {l}
                  </button>
                ))}
              </div>
            )}
            <input
              className="input input-sm"
              placeholder="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-record-on-enter
              maxLength={200}
            />
            <button className="btn btn-primary btn-block btn-record" disabled={start === null} onClick={record}>
              <Plus size={17} />
              {end === null && start !== null ? "记录 起点 → 当前帧" : "记录这一段"}
              <Kbd>Enter</Kbd>
            </button>
          </div>

          <div className="panel rec-list">
            <div className="rec-head">
              <span>本视频记录</span>
              {records.length > 0 && <span className="badge">{records.length}</span>}
            </div>
            {records.length === 0 ? (
              <div className="rec-empty">还没有记录。标好起点和终点后按 Enter。</div>
            ) : (
              records.map((r) => (
                <RecordRow
                  key={r.id}
                  r={r}
                  active={activeRec === r.id}
                  onOpen={() => openRecord(r)}
                  onDelete={() => {
                    if (activeRec === r.id) setActiveRec(null);
                    s.deleteRecords([r.id]);
                  }}
                />
              ))
            )}
          </div>

          <div className="panel keys">
            <button className="keys-toggle" onClick={() => setShowKeys((x) => !x)}>
              <Keyboard size={15} />
              快捷键
              <ChevronRight size={15} className={`chev ${showKeys ? "open" : ""}`} />
            </button>
            {showKeys && (
              <div className="keys-grid">
                <Kbd>← →</Kbd>
                <span>上一帧 / 下一帧（也可用 A D 或 , .）</span>
                <Kbd>Shift</Kbd>
                <span>配合方向键一次走 10 帧</span>
                <Kbd>空格</Kbd>
                <span>播放 / 暂停</span>
                <Kbd>S</Kbd>
                <span>当前帧设为起点</span>
                <Kbd>E</Kbd>
                <span>当前帧设为终点</span>
                <Kbd>Enter</Kbd>
                <span>记录这一对（没有终点时记录到当前帧），记录后标记清空</span>
                <Kbd>Q W</Kbd>
                <span>跳到上一个 / 下一个标记点（含已记录的）</span>
                <Kbd>1–9</Kbd>
                <span>选择最近用过的标签</span>
                <Kbd>L</Kbd>
                <span>编辑标签</span>
                <Kbd>↑ ↓</Kbd>
                <span>上一个 / 下一个视频</span>
                <Kbd>Esc</Kbd>
                <span>清除未记录的标记</span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function RecordRow(props: { r: MeasureRecord; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const { r } = props;
  const d = splitMs(r.endMs - r.startMs);
  return (
    <div className={`rec-row ${props.active ? "active" : ""}`} onClick={props.onOpen} title="点击定位到这一段">
      <i className="rec-dot" style={{ background: labelColor(r.label) }} />
      <div className="rec-main">
        <div className="rec-label">{labelOf(r.label)}</div>
        <div className="rec-sub">
          第 {r.startFrame + 1} → {r.endFrame + 1} 帧 · {r.endFrame - r.startFrame} 帧{r.note ? " · " + r.note : ""}
        </div>
      </div>
      <div className="rec-ms">
        {d.int}
        <small>{d.dec}</small>
        <span>ms</span>
      </div>
      <button
        className="rec-del"
        title="删除"
        onClick={(e) => {
          e.stopPropagation();
          props.onDelete();
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function Unplayable(props: { error: string; codec: string; ffmpeg: boolean; transcoding: boolean; onTranscode: () => void }) {
  if (props.error !== "unsupported") {
    return (
      <div className="unplayable">
        <AlertTriangle size={26} />
        <b>{props.error}</b>
      </div>
    );
  }
  return (
    <div className="unplayable">
      <AlertTriangle size={26} />
      <b>当前系统播放不了这个视频（{props.codec}）</b>
      <p>
        帧时间表已经读出来了，只是画面显示不了。可以转码成 H.264 来显示，
        <br />
        测量仍然使用原视频每一帧的时间戳，结果不受影响。
      </p>
      {props.ffmpeg ? (
        <button className="btn btn-primary" disabled={props.transcoding} onClick={props.onTranscode}>
          {props.transcoding ? <Spinner size={15} /> : <Wand2 size={16} />}
          {props.transcoding ? "正在转码…" : "转码为 H.264 显示"}
        </button>
      ) : (
        <div className="install-hint">
          需要先安装 ffmpeg，装好后重启 VideoClip：
          <code>{isMac ? "brew install ffmpeg" : "winget install Gyan.FFmpeg"}</code>
          {!isMac && <span>Windows 也可以在 Microsoft Store 安装「HEVC 视频扩展」后直接播放。</span>}
        </div>
      )}
    </div>
  );
}
