// 用 WebCodecs 逐帧解码并缓存，让逐帧步进不卡。
//
// 为什么不用 <video> seek：每次 seek 浏览器都要从前一个关键帧重新解码。
// 手机录屏关键帧间隔通常很长（安卓 screenrecord 默认 10 秒 = 600 帧），
// 越靠近下一个关键帧，单步越慢（实测 1080×2400 可达 800ms）。
//
// 这里的做法：
// - 解码器一直开着，向前走只需要多解一帧；
// - 解出来的帧缩放后存成 ImageBitmap，向后走直接用缓存；
// - 缓存不够时（向后走太远、随机跳转）才从关键帧重新开始，并顺带把这一段缓存下来；
// - 每个采样的 timestamp 就是它的帧序号，所以画面和帧号天然一致。

import { api, SampleTable } from "./api";

/** 缓存占用的内存上限 */
const MEMORY_BUDGET = 384 * 1024 * 1024;
/** 缓存帧的长边上限（像素） */
const MAX_SIDE = 1440;
/** 空闲时往回预取多少帧 */
const BACK_PREFETCH = 24;
/** 一次最多读多少字节 */
const MAX_READ = 24 * 1024 * 1024;

type Listener = (frame: number) => void;

export class FrameDecoder {
  readonly count: number;
  failed: string | null = null;

  private readonly t: SampleTable;
  private readonly path: string;
  private readonly n: number;
  private readonly frameToSample: Int32Array;
  private readonly keyBefore: Int32Array;
  private readonly config: VideoDecoderConfig;
  private readonly outW: number;
  private readonly outH: number;
  private readonly maxFrames: number;
  private readonly ahead: number;
  private readonly back: number;

  private cache = new Map<number, ImageBitmap>();
  private dec: VideoDecoder | null = null;
  /** 当前解码器从哪个采样开始（关键帧） */
  private genStart = 0;
  /** 下一个要送进解码器的采样 */
  private next = 0;
  private flushed = false;
  private target = 0;
  private running = false;
  private disposed = false;
  private pending = 0;
  /** 当前这一轮解码器已经输出过的帧（包括被丢弃的） */
  private emitted = new Set<number>();
  /** 正在转成位图的帧 */
  private converting = new Set<number>();
  private progressWaiters: (() => void)[] = [];
  private listeners = new Set<Listener>();

  private constructor(path: string, t: SampleTable, frameCount: number, config: VideoDecoderConfig) {
    this.path = path;
    this.t = t;
    this.n = t.offsets.length;
    this.count = frameCount;
    this.config = config;

    this.frameToSample = new Int32Array(frameCount).fill(-1);
    t.frames.forEach((f, s) => {
      if (f >= 0 && f < frameCount) this.frameToSample[f] = s;
    });
    this.keyBefore = new Int32Array(this.n);
    let k = 0;
    for (let s = 0; s < this.n; s++) {
      if (t.keys[s]) k = s;
      this.keyBefore[s] = k;
    }

    const scale = Math.min(1, MAX_SIDE / Math.max(t.codedWidth, t.codedHeight));
    this.outW = Math.max(2, Math.round(t.codedWidth * scale));
    this.outH = Math.max(2, Math.round(t.codedHeight * scale));
    this.maxFrames = Math.max(24, Math.min(600, Math.floor(MEMORY_BUDGET / (this.outW * this.outH * 4))));
    this.ahead = Math.min(30, Math.floor(this.maxFrames * 0.25));
    this.back = this.maxFrames - this.ahead - 4;
  }

  /** 不支持 WebCodecs 或这种编码时返回 null，调用方退回 <video> seek */
  static async create(path: string, t: SampleTable, frameCount: number): Promise<FrameDecoder | null> {
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;
    if (!t.offsets.length || t.frames.every((f) => f < 0)) return null;
    const config: VideoDecoderConfig = {
      codec: t.codec,
      description: new Uint8Array(t.description),
      codedWidth: t.codedWidth,
      codedHeight: t.codedHeight,
      optimizeForLatency: true,
    };
    try {
      const r = await VideoDecoder.isConfigSupported(config);
      if (!r.supported) return null;
    } catch {
      return null;
    }
    return new FrameDecoder(path, t, frameCount, config);
  }

  get(frame: number) {
    return this.cache.get(frame);
  }

  /** 订阅「某一帧解码好了」；frame 为 -1 表示解码器出错 */
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 这一帧能否很快拿到：已缓存，或者解码器顺着往后解几帧就到 */
  isCheap(frame: number) {
    if (this.cache.has(frame) || this.converting.has(frame)) return true;
    const s = this.frameToSample[frame];
    if (s < 0 || !this.dec || this.flushed || this.emitted.has(frame)) return false;
    return s >= this.genStart && s < this.next + 12;
  }

  /** 请求某一帧（最新的请求优先），并预取后面几帧 */
  request(frame: number) {
    if (this.disposed || this.failed) return;
    this.target = Math.max(0, Math.min(this.count - 1, frame));
    this.run();
  }

  dispose() {
    this.disposed = true;
    try {
      this.dec?.close();
    } catch {
      /* 忽略 */
    }
    this.dec = null;
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.listeners.clear();
    this.wake();
  }

  // ------------------------------------------------------------ 内部

  private wanted(f: number) {
    return f >= this.target - this.back && f <= this.target + this.ahead + 8;
  }

  private nextGoal(): number | null {
    if (!this.cache.has(this.target)) return this.target;
    for (let f = this.target + 1; f <= Math.min(this.count - 1, this.target + this.ahead); f++) {
      if (!this.cache.has(f)) return f;
    }
    // 前面的都有了，空闲时往回预取一段，往回走跨过关键帧时也不会顿
    for (let f = this.target - 1; f >= Math.max(0, this.target - BACK_PREFETCH); f--) {
      if (!this.cache.has(f)) return f;
    }
    return null;
  }

  private wake() {
    const ws = this.progressWaiters;
    this.progressWaiters = [];
    ws.forEach((w) => w());
  }

  private waitProgress(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.progressWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private fail(msg: string) {
    console.warn("[videoclip] WebCodecs 解码失败，改用 <video> seek：", msg);
    this.failed = msg;
    this.listeners.forEach((l) => l(-1));
  }

  private restart(fromSample: number) {
    try {
      this.dec?.close();
    } catch {
      /* 忽略 */
    }
    this.dec = new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: (e) => this.fail(String(e)),
    });
    this.dec.configure(this.config);
    this.genStart = fromSample;
    this.next = fromSample;
    this.flushed = false;
    this.emitted.clear();
  }

  private onOutput(frame: VideoFrame) {
    const f = frame.timestamp;
    this.emitted.add(f);
    if (this.disposed || f < 0 || this.cache.has(f) || !this.wanted(f)) {
      frame.close();
      this.wake();
      return;
    }
    this.pending++;
    this.converting.add(f);
    toBitmap(frame, this.outW, this.outH)
      .then((bmp) => {
        if (this.disposed || this.cache.has(f)) {
          bmp.close();
          return;
        }
        this.cache.set(f, bmp);
        this.evict();
        this.listeners.forEach((l) => l(f));
      })
      .catch((e) => this.fail(String(e)))
      .finally(() => {
        frame.close();
        this.pending--;
        this.converting.delete(f);
        this.wake();
      });
  }

  /** 缓存超出上限时，丢掉离当前帧最远的 */
  private evict() {
    if (this.cache.size <= this.maxFrames) return;
    const keys = [...this.cache.keys()].sort((a, b) => Math.abs(b - this.target) - Math.abs(a - this.target));
    for (const k of keys.slice(0, this.cache.size - this.maxFrames)) {
      this.cache.get(k)!.close();
      this.cache.delete(k);
    }
  }

  private async feed(upTo: number) {
    const dec = this.dec!;
    const a = this.next;
    let b = Math.min(this.n, upTo);
    if (b <= a) return;
    // 读一段连续的字节（视频采样在文件里基本是连续的）
    let lo = Infinity;
    let hi = 0;
    for (let s = a; s < b; s++) {
      const end = this.t.offsets[s] + this.t.sizes[s];
      if (s > a && Math.max(hi, end) - Math.min(lo, this.t.offsets[s]) > MAX_READ) {
        b = s;
        break;
      }
      lo = Math.min(lo, this.t.offsets[s]);
      hi = Math.max(hi, end);
    }
    const bytes = await api.readSpan(this.path, lo, hi - lo);
    if (this.disposed || dec !== this.dec) return;
    for (let s = a; s < b; s++) {
      while (dec.decodeQueueSize > 12 && dec.state === "configured") {
        await new Promise((r) => dec.addEventListener("dequeue", r, { once: true }));
      }
      if (this.disposed || dec !== this.dec || dec.state !== "configured") return;
      const off = this.t.offsets[s] - lo;
      const f = this.t.frames[s];
      dec.decode(
        new EncodedVideoChunk({
          type: this.t.keys[s] ? "key" : "delta",
          timestamp: f >= 0 ? f : -1 - s,
          data: bytes.subarray(off, off + this.t.sizes[s]),
        }),
      );
      this.next = s + 1;
    }
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    let stuck = 0;
    try {
      while (!this.disposed && !this.failed) {
        const goal = this.nextGoal();
        if (goal === null) break;
        const s = this.frameToSample[goal];
        if (s < 0) {
          // 没有对应采样的帧（理论上不会出现），跳过
          break;
        }
        if (this.converting.has(goal)) {
          await this.waitProgress(200);
          continue;
        }
        const fed = this.dec && s >= this.genStart && s < this.next;
        if (fed && !this.flushed && !this.emitted.has(goal)) {
          // 已经送进解码器但还没输出：解码器可能要多几帧输入才吐出来（B 帧重排、硬件延迟）
          const before = this.emitted.size;
          if (this.next < this.n) await this.feed(this.next + 4);
          else {
            this.flushed = true;
            await this.dec!.flush().catch(() => {});
          }
          await this.waitProgress(30);
          if (this.emitted.size === before && !this.pending && ++stuck > 40) {
            this.fail("解码器没有输出");
            break;
          }
          continue;
        }
        stuck = 0;
        // 继续往后解 vs 从关键帧重来，选代价小的
        // （已经输出过但被丢弃的帧，只能从关键帧重来）
        const needRestart =
          !this.dec || this.flushed || s < this.next || this.emitted.has(goal) || s - this.next > s - this.keyBefore[s];
        if (needRestart) this.restart(this.keyBefore[s]);
        await this.feed(Math.max(s + 1, this.next + 8));
      }
    } catch (e) {
      this.fail(String(e));
    } finally {
      this.running = false;
    }
  }
}

async function toBitmap(frame: VideoFrame, w: number, h: number): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: "low" });
  } catch {
    // 部分 WebKit 不支持带缩放参数，退回画布
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")!.drawImage(frame, 0, 0, w, h);
    return c.transferToImageBitmap();
  }
}

/** 把缓存帧画到画布上，处理容器里的旋转角度 */
export function drawFrame(canvas: HTMLCanvasElement, bmp: ImageBitmap, rotation: number) {
  const r = ((rotation % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  const w = swap ? bmp.height : bmp.width;
  const h = swap ? bmp.width : bmp.height;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (r) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((r * Math.PI) / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  } else {
    ctx.drawImage(bmp, 0, 0);
  }
}
