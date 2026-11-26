export function uid() {
  try {
    return crypto.randomUUID();
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 1234.56 → "1,235" */
export const fmtInt = (n: number) => nf0.format(Math.round(n));
/** 1234.56 → "1,234.6" */
export const fmt1 = (n: number) => nf1.format(n);

/** 毫秒拆成整数和小数两部分，用于大号数字：「1,234」「.6」 */
export function splitMs(ms: number) {
  const s = fmt1(Math.abs(ms));
  const [i, d] = s.split(".");
  return { sign: ms < 0 ? "−" : "", int: i, dec: "." + d };
}

/** 秒 → "00:12.345" */
export function fmtClock(sec: number) {
  if (!isFinite(sec)) return "--:--";
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return (neg ? "-" : "") + String(m).padStart(2, "0") + ":" + s.toFixed(3).padStart(6, "0");
}

/** 秒 → "6.00 s" / "1:05.3" */
export function fmtSec(sec: number) {
  if (sec < 60) return sec.toFixed(2) + " s";
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function fmtSize(bytes: number) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function fmtDate(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 找到最后一个 <= t 的位置（数组升序）。t 比第一个还小时返回 0 */
export function lowerIndex(arr: number[], t: number) {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0 || t <= arr[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Stat {
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  stddev: number;
}

export function stats(values: number[]): Stat | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const stddev = n > 1 ? Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { count: n, mean, median, min: s[0], max: s[n - 1], stddev };
}

export const UNNAMED = "未命名";
export const labelOf = (l: string) => l.trim() || UNNAMED;

/** 标签的颜色（同一个标签在全 App 里颜色固定） */
const PALETTE = ["#6d5bff", "#ec4899", "#0ea5e9", "#f97316", "#10b981", "#8b5cf6", "#eab308", "#14b8a6", "#ef4444", "#64748b"];
export function labelColor(label: string) {
  let h = 0;
  for (const c of labelOf(label)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);
export const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
