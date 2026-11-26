import { useMemo, useState } from "react";
import { Crosshair, FileSpreadsheet, Search, Trash2 } from "lucide-react";
import { api, inTauri, MeasureRecord, openFile, pickSavePath } from "../api";
import { Spinner, useToast } from "../components/ui";
import { useStore } from "../store";
import { fmt1, fmtDate, fmtInt, labelColor, labelOf, splitMs, stats, UNNAMED } from "../utils";

function exportName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `启动耗时_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}

export default function RecordsPage() {
  const s = useStore();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [videoFilter, setVideoFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const videos = useMemo(() => new Map(s.lib.videos.map((v, i) => [v.id, { v, i }])), [s.lib.videos]);

  // 按视频顺序、再按记录时间排序（和导出的 Excel 一致）
  const all = useMemo(
    () =>
      s.lib.records
        .filter((r) => videos.has(r.videoId))
        .sort((a, b) => videos.get(a.videoId)!.i - videos.get(b.videoId)!.i || a.createdAt - b.createdAt),
    [s.lib.records, videos],
  );

  const labels = useMemo(() => {
    const seen: string[] = [];
    for (const r of all) {
      const l = labelOf(r.label);
      if (!seen.includes(l)) seen.push(l);
    }
    return seen;
  }, [all]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return all.filter((r) => {
      if (labelFilter !== null && labelOf(r.label) !== labelFilter) return false;
      if (videoFilter && r.videoId !== videoFilter) return false;
      if (!kw) return true;
      const v = videos.get(r.videoId)!.v;
      return (v.name + " " + r.label + " " + r.note).toLowerCase().includes(kw);
    });
  }, [all, q, labelFilter, videoFilter, videos]);

  const isFiltered = filtered.length !== all.length;

  const summary = useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const r of filtered) {
      const l = labelOf(r.label);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l)!.push(r.endMs - r.startMs);
    }
    return [...groups.entries()].map(([label, v]) => ({ label, ...stats(v)! }));
  }, [filtered]);

  const doExport = async () => {
    if (!inTauri) {
      toast("浏览器预览不能导出，请在应用里使用", { error: true });
      return;
    }
    const path = await pickSavePath(exportName());
    if (!path) return;
    setExporting(true);
    try {
      const n = await api.exportXlsx(s.lib, isFiltered ? filtered.map((r) => r.id) : null, path);
      toast(`已导出 ${n} 条记录`, { action: { label: "打开", onClick: () => openFile(path).catch((e) => toast(String(e), { error: true })) } });
    } catch (e) {
      toast(String(e), { error: true });
    } finally {
      setExporting(false);
    }
  };

  const toggleSel = (id: string) =>
    setSelected((s0) => {
      const n = new Set(s0);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const selCount = filtered.filter((r) => selected.has(r.id)).length;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">记录汇总</h1>
            <div className="page-subtitle">
              共 {all.length} 条记录，来自 {new Set(all.map((r) => r.videoId)).size} 个视频
              {isFiltered && ` · 当前筛选出 ${filtered.length} 条`}
            </div>
          </div>
          <div className="header-actions">
            {selCount > 0 && (
              <button
                className="btn btn-danger"
                onClick={() => {
                  s.deleteRecords(filtered.filter((r) => selected.has(r.id)).map((r) => r.id));
                  setSelected(new Set());
                }}
              >
                <Trash2 size={15} />
                删除所选 {selCount} 条
              </button>
            )}
            <button className="btn btn-primary" disabled={!filtered.length || exporting} onClick={doExport}>
              {exporting ? <Spinner size={15} /> : <FileSpreadsheet size={16} />}
              {isFiltered ? "导出筛选结果" : "导出 Excel"}
            </button>
          </div>
        </div>

        {all.length === 0 ? (
          <div className="panel empty-records">
            <div className="state-icon">
              <Crosshair size={24} />
            </div>
            <h2>还没有记录</h2>
            <p>在「逐帧测量」里标好起点和终点，按 Enter 就会记录到这里。</p>
            <button className="btn btn-soft" onClick={() => s.setRoute("measure")}>
              去测量
            </button>
          </div>
        ) : (
          <>
            <div className="summary-grid">
              {summary.map((g) => {
                const m = splitMs(g.mean);
                return (
                  <button
                    key={g.label}
                    className={`summary-card ${labelFilter === g.label ? "on" : ""}`}
                    onClick={() => setLabelFilter((x) => (x === g.label ? null : g.label))}
                    title="点击只看这个标签"
                  >
                    <div className="sc-head">
                      <i style={{ background: labelColor(g.label === UNNAMED ? "" : g.label) }} />
                      <span className="sc-label">{g.label}</span>
                      <span className="sc-count">{g.count} 次</span>
                    </div>
                    <div className="sc-mean">
                      {m.int}
                      <small>{m.dec}</small>
                      <span>ms 平均</span>
                    </div>
                    <div className="sc-stats">
                      <div>
                        <span>中位数</span>
                        <b>{fmtInt(g.median)}</b>
                      </div>
                      <div>
                        <span>最小</span>
                        <b>{fmtInt(g.min)}</b>
                      </div>
                      <div>
                        <span>最大</span>
                        <b>{fmtInt(g.max)}</b>
                      </div>
                      <div>
                        <span>标准差</span>
                        <b>{fmtInt(g.stddev)}</b>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="filter-bar">
              <div className="search">
                <Search size={15} />
                <input placeholder="搜索视频名、标签、备注" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <select className="select" value={videoFilter} onChange={(e) => setVideoFilter(e.target.value)}>
                <option value="">全部视频</option>
                {s.lib.videos
                  .filter((v) => all.some((r) => r.videoId === v.id))
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
              </select>
              <div className="label-chips">
                <button className={`label-chip ${labelFilter === null ? "on" : ""}`} onClick={() => setLabelFilter(null)}>
                  全部标签
                </button>
                {labels.map((l) => (
                  <button key={l} className={`label-chip ${labelFilter === l ? "on" : ""}`} onClick={() => setLabelFilter((x) => (x === l ? null : l))}>
                    <i style={{ background: labelColor(l === UNNAMED ? "" : l) }} />
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="panel table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.id)))}
                      />
                    </th>
                    <th>视频</th>
                    <th>标签</th>
                    <th className="num">耗时 (ms)</th>
                    <th className="num">帧数</th>
                    <th className="num">起点帧</th>
                    <th className="num">终点帧</th>
                    <th>备注</th>
                    <th>记录时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <Row
                      key={r.id}
                      r={r}
                      videoName={videos.get(r.videoId)!.v.name}
                      selected={selected.has(r.id)}
                      onSelect={() => toggleSel(r.id)}
                    />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={10} className="table-empty">
                        没有符合条件的记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row(props: { r: MeasureRecord; videoName: string; selected: boolean; onSelect: () => void }) {
  const s = useStore();
  const { r } = props;
  const d = r.endMs - r.startMs;
  return (
    <tr className={props.selected ? "selected" : ""}>
      <td className="col-check">
        <input type="checkbox" checked={props.selected} onChange={props.onSelect} />
      </td>
      <td className="col-video" title={props.videoName}>
        {props.videoName}
      </td>
      <td className="col-label">
        <i style={{ background: labelColor(r.label) }} />
        <input
          className="cell-input"
          value={r.label}
          placeholder={UNNAMED}
          onChange={(e) => s.updateRecord(r.id, { label: e.target.value })}
        />
      </td>
      <td className="num strong">{fmt1(d)}</td>
      <td className="num">{r.endFrame - r.startFrame}</td>
      <td className="num muted">{r.startFrame + 1}</td>
      <td className="num muted">{r.endFrame + 1}</td>
      <td className="col-note">
        <input className="cell-input" value={r.note} placeholder="—" onChange={(e) => s.updateRecord(r.id, { note: e.target.value })} />
      </td>
      <td className="muted nowrap">{fmtDate(r.createdAt)}</td>
      <td className="col-actions">
        <button className="icon-btn sm" title="在视频里定位" onClick={() => s.focusRecord(r)}>
          <Crosshair size={15} />
        </button>
        <button className="icon-btn sm danger" title="删除" onClick={() => s.deleteRecords([r.id])}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}
