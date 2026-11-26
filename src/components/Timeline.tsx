import { useMemo, useRef, useState } from "react";
import { MeasureRecord } from "../api";
import { labelColor, labelOf } from "../utils";

const TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** 把记录分到不重叠的几行里 */
function lanes(records: MeasureRecord[], maxLanes = 3) {
  const sorted = [...records].sort((a, b) => Math.min(a.startFrame, a.endFrame) - Math.min(b.startFrame, b.endFrame));
  const ends: number[] = [];
  return sorted.map((r) => {
    const s = Math.min(r.startFrame, r.endFrame);
    const e = Math.max(r.startFrame, r.endFrame);
    let lane = ends.findIndex((x) => x < s);
    if (lane < 0) lane = ends.length < maxLanes ? ends.length : maxLanes - 1;
    ends[lane] = e;
    return { r, lane, s, e };
  });
}

export default function Timeline(props: {
  pts: number[];
  cur: number;
  start: number | null;
  end: number | null;
  records: MeasureRecord[];
  /** 高亮的已记录区间 */
  activeId?: string | null;
  onSeek: (frame: number) => void;
  onRecordClick: (r: MeasureRecord) => void;
}) {
  const { pts, cur, start, end } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null);
  const dragging = useRef(false);

  const t0 = pts[0] ?? 0;
  const last = pts[pts.length - 1] ?? 0;
  const tail = pts.length > 1 ? last - pts[pts.length - 2] : 0.033;
  const span = Math.max(1e-6, last + tail - t0);
  const pct = (i: number) => ((pts[Math.max(0, Math.min(pts.length - 1, i))] - t0) / span) * 100;

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => span / s <= 10) ?? 600;
    const out: number[] = [];
    for (let t = 0; t <= span + 1e-9; t += step) out.push(t);
    return { step, out };
  }, [span]);

  const laid = useMemo(() => lanes(props.records), [props.records]);
  const laneCount = Math.max(1, ...laid.map((l) => l.lane + 1));

  const frameFromX = (clientX: number) => {
    const el = trackRef.current!;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const t = t0 + ratio * span;
    // 找最近的帧
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return { frame: lo, x: clientX - rect.left };
  };

  const fmtTick = (t: number) => (ticks.step < 1 ? t.toFixed(ticks.step < 0.1 ? 2 : 1) + "s" : Math.round(t) + "s");

  const rs = start !== null && end !== null ? Math.min(start, end) : null;
  const re = start !== null && end !== null ? Math.max(start, end) : null;

  return (
    <div className="timeline">
      <div className="tl-records" style={{ height: laneCount * 8 + 4 }}>
        {laid.map(({ r, lane, s, e }) => (
          <button
            key={r.id}
            className={`tl-record ${props.activeId === r.id ? "active" : ""}`}
            title={`${labelOf(r.label)} · ${(r.endMs - r.startMs).toFixed(1)} ms`}
            style={{
              left: pct(s) + "%",
              width: `max(3px, ${pct(e) - pct(s)}%)`,
              top: lane * 8,
              background: labelColor(r.label),
            }}
            onClick={() => props.onRecordClick(r)}
          />
        ))}
      </div>
      <div
        ref={trackRef}
        className="tl-track"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          props.onSeek(frameFromX(e.clientX).frame);
        }}
        onPointerMove={(e) => {
          const f = frameFromX(e.clientX);
          setHover(f);
          if (dragging.current) props.onSeek(f.frame);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      >
        <div className="tl-rail" />
        {/* 已记录的区间：起点和终点在轨道上留下彩色刻度，高亮的那一段显示完整区间和旗标 */}
        {laid.map(({ r, s, e }) => {
          const color = labelColor(r.label);
          const active = props.activeId === r.id;
          return (
            <div key={r.id} className={`tl-saved ${active ? "active" : ""}`}>
              {active && <div className="tl-saved-range" style={{ left: pct(s) + "%", width: pct(e) - pct(s) + "%", background: color }} />}
              <div className="tl-tick" style={{ left: pct(s) + "%", background: color }}>
                {active && <span style={{ background: color }}>起</span>}
              </div>
              <div className="tl-tick" style={{ left: pct(e) + "%", background: color }}>
                {active && <span style={{ background: color }}>终</span>}
              </div>
            </div>
          );
        })}
        {rs !== null && re !== null && (
          <div className="tl-range" style={{ left: pct(rs) + "%", width: pct(re) - pct(rs) + "%" }} />
        )}
        <div className="tl-progress" style={{ width: pct(cur) + "%" }} />
        {start !== null && (
          <div className="tl-mark start" style={{ left: pct(start) + "%" }}>
            <span>起</span>
          </div>
        )}
        {end !== null && (
          <div className="tl-mark end" style={{ left: pct(end) + "%" }}>
            <span>终</span>
          </div>
        )}
        <div className="tl-head" style={{ left: pct(cur) + "%" }} />
        {hover && (
          <div className="tl-hover" style={{ left: hover.x }}>
            第 {hover.frame + 1} 帧 · {((pts[hover.frame] - t0) * 1000).toFixed(0)} ms
          </div>
        )}
      </div>
      <div className="tl-ticks">
        {ticks.out.map((t) => (
          <span key={t} style={{ left: (t / span) * 100 + "%" }}>
            {fmtTick(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
