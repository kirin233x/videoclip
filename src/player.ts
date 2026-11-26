// 逐帧播放控制。
//
// 关键点：
// 1. 帧时间表来自 Rust 端解析的容器时间戳（pts），而不是「帧号 ÷ 帧率」。
// 2. 跳到第 i 帧时，把 currentTime 设到第 i 帧和第 i+1 帧的中点，避免落在边界上显示成相邻帧。
// 3. 当前到底显示的是哪一帧，以 requestVideoFrameCallback 报告的 mediaTime 为准，
//    这样界面上的帧号和画面永远一致。
// 4. 浏览器的时间轴可能和容器时间戳差一个常数（编辑列表处理方式不同），
//    用第一帧显示时的 mediaTime 校准这个偏移。
// 5. 连续按方向键时 seek 会排队，只执行最新的目标，不会卡住。
// 6. 有 WebCodecs 解码器（decoder.ts）时，暂停状态下的逐帧移动完全不碰 <video>，
//    由解码缓存直接出图；只有开始播放时才把 <video> 对齐到当前帧。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FrameDecoder } from "./decoder";
import { lowerIndex } from "./utils";

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export interface FramePlayer {
  /** 当前显示的帧（从 0 开始） */
  cur: number;
  count: number;
  playing: boolean;
  ready: boolean;
  error: string | null;
  rate: number;
  setRate: (r: number) => void;
  seek: (frame: number) => void;
  step: (delta: number) => void;
  toggle: () => void;
  pause: () => void;
  /** 时间（秒，容器时间） → 帧 */
  frameAt: (t: number) => number;
  /** <video> 元素当前确定显示的帧；正在 seek 或刚暂停还没对齐时为 -1 */
  videoFrame: number;
  /** <video> 元素大概显示的帧（最后一次回调报告的，可能差一帧） */
  videoApprox: number;
}

export function useFramePlayer(
  ref: React.RefObject<HTMLVideoElement>,
  pts: number[] | null,
  src: string | null,
  initialRate = 1,
  decoder: FrameDecoder | null = null,
): FramePlayer {
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(initialRate);
  const [videoApprox, setVideoApprox] = useState(-1);
  const [videoExact, setVideoExact] = useState(false);
  /** seek() 里自己调用的 pause，不要当成用户暂停处理 */
  const pauseBySeekRef = useRef(false);
  const decRef = useRef(decoder);
  decRef.current = decoder;
  /** 逐帧走的时候没有 seek <video>，播放前需要先对齐 */
  const videoStaleRef = useRef(false);
  const useDecoder = () => {
    const d = decRef.current;
    return !!d && !d.failed && !!ref.current?.paused;
  };

  const curRef = useRef(0);
  const offsetRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const ptsRef = useRef<number[]>([]);
  ptsRef.current = pts ?? [];

  const count = pts?.length ?? 0;

  const lastDur = useMemo(() => {
    if (!pts || pts.length < 2) return 1 / 30;
    return pts[pts.length - 1] - pts[pts.length - 2];
  }, [pts]);

  const offset = () => offsetRef.current ?? 0;

  const frameAt = useCallback((t: number) => lowerIndex(ptsRef.current, t + 0.0005), []);

  const targetOf = useCallback(
    (i: number) => {
      const p = ptsRef.current;
      const t = i < p.length - 1 ? (p[i] + p[i + 1]) / 2 : p[i] + lastDur / 2;
      return Math.max(0, t + offset());
    },
    [lastDur],
  );

  const setFrame = (i: number) => {
    if (curRef.current !== i) {
      curRef.current = i;
      setCur(i);
    }
  };

  const seek = useCallback(
    (frame: number) => {
      const v = ref.current;
      const n = ptsRef.current.length;
      if (!v || !n) return;
      const i = Math.max(0, Math.min(n - 1, Math.round(frame)));
      if (!v.paused) {
        pauseBySeekRef.current = true;
        v.pause();
      }
      setFrame(i);
      if (useDecoder()) {
        const d = decRef.current!;
        const cheap = d.isCheap(i);
        d.request(i);
        if (cheap) {
          videoStaleRef.current = true;
          return;
        }
        // 缓存里没有、要从关键帧重新解：<video> 也同时 seek，谁先好就先显示谁
        videoStaleRef.current = false;
      }
      setVideoExact(false);
      if (v.seeking) {
        pendingRef.current = i;
      } else {
        pendingRef.current = null;
        v.currentTime = targetOf(i);
      }
    },
    [ref, targetOf],
  );

  const step = useCallback((d: number) => seek(curRef.current + d), [seek]);

  const pause = useCallback(() => ref.current?.pause(), [ref]);

  const toggle = useCallback(() => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      // 在最后一帧时从头播放；逐帧走过之后先把 <video> 对齐到当前帧
      if (curRef.current >= ptsRef.current.length - 1) v.currentTime = targetOf(0);
      else if (videoStaleRef.current) v.currentTime = targetOf(curRef.current);
      videoStaleRef.current = false;
      pendingRef.current = null;
      v.play().catch(() => {});
    } else v.pause();
  }, [ref, targetOf]);

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      if (ref.current) ref.current.playbackRate = r;
    },
    [ref],
  );

  // 换视频时重置
  useEffect(() => {
    curRef.current = 0;
    setCur(0);
    setPlaying(false);
    setReady(false);
    setError(null);
    setVideoApprox(-1);
    setVideoExact(false);
    pauseBySeekRef.current = false;
    offsetRef.current = null;
    pendingRef.current = null;
    videoStaleRef.current = false;
  }, [src]);

  // 解码器就绪后先把当前帧解出来
  useEffect(() => {
    decoder?.request(curRef.current);
  }, [decoder]);

  useEffect(() => {
    const v = ref.current as VideoWithRVFC | null;
    if (!v || !src || !pts?.length) return;
    let alive = true;
    let handle: number | null = null;
    let raf = 0;

    const onMediaTime = (t: number) => {
      if (offsetRef.current === null) {
        // 第一帧显示出来时校准偏移；差得太离谱就不信它
        const off = t - ptsRef.current[0];
        offsetRef.current = Math.abs(off) < 2 ? off : 0;
        if (Math.abs(off) > 1e-4) console.info("[videoclip] 时间偏移校准", off);
        return;
      }
      const f = lowerIndex(ptsRef.current, t - offset() + 0.0005);
      setVideoApprox(f);
      if (pendingRef.current !== null || v.seeking) return;
      setVideoExact(true);
      // 解码器模式下暂停时，帧号由逐帧操作决定，忽略 <video> 迟到的回调
      if (v.paused && decRef.current && !decRef.current.failed && videoStaleRef.current) return;
      setFrame(f);
    };

    const hasRVFC = typeof v.requestVideoFrameCallback === "function";
    if (hasRVFC) {
      const loop = (_: number, meta: { mediaTime: number }) => {
        if (!alive) return;
        onMediaTime(meta.mediaTime);
        handle = v.requestVideoFrameCallback!(loop);
      };
      handle = v.requestVideoFrameCallback!(loop);
    }

    // 没有 rVFC（旧版 WebKit）时退回 currentTime
    const syncFromCurrentTime = () => {
      if (offsetRef.current === null) offsetRef.current = 0;
      if (pendingRef.current !== null || v.seeking) return;
      setFrame(lowerIndex(ptsRef.current, v.currentTime - offset() + 0.0005));
    };
    const rafLoop = () => {
      syncFromCurrentTime();
      if (!v.paused) raf = requestAnimationFrame(rafLoop);
    };

    const calibrateTimer = window.setTimeout(() => {
      if (offsetRef.current === null) offsetRef.current = 0;
    }, 1500);

    const onLoaded = () => {
      setReady(true);
      v.playbackRate = rate;
    };
    const onSeeked = () => {
      const p = pendingRef.current;
      if (p !== null) {
        pendingRef.current = null;
        v.currentTime = targetOf(p);
      } else {
        // 我们总是 seek 到帧的中点，所以这里的 currentTime 能准确对应到帧
        setVideoApprox(lowerIndex(ptsRef.current, v.currentTime - offset() + 0.0005));
        setVideoExact(true);
        if (!hasRVFC) syncFromCurrentTime();
      }
    };
    const onPlay = () => {
      setPlaying(true);
      if (!hasRVFC) raf = requestAnimationFrame(rafLoop);
    };
    const onPause = () => {
      setPlaying(false);
      if (pauseBySeekRef.current) {
        pauseBySeekRef.current = false;
        return;
      }
      // 用户暂停：暂停瞬间 <video> 可能又换了一帧却没有回调，
      // 按 currentTime 定下当前帧，并把 <video> 对齐到这一帧的中点
      if (v.ended) return;
      const f = lowerIndex(ptsRef.current, v.currentTime - offset() + 0.0005);
      setFrame(f);
      setVideoExact(false);
      videoStaleRef.current = false;
      pendingRef.current = null;
      v.currentTime = targetOf(f);
      decRef.current?.request(f);
    };
    const onError = () => {
      const code = v.error?.code;
      setError(
        code === 4 || code === 3
          ? "unsupported"
          : code === 2
            ? "网络错误：无法读取视频文件"
            : "视频无法播放" + (v.error?.message ? "：" + v.error.message : ""),
      );
    };

    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    v.addEventListener("error", onError);
    if (v.readyState >= 2) onLoaded();

    return () => {
      alive = false;
      clearTimeout(calibrateTimer);
      cancelAnimationFrame(raf);
      if (handle !== null) v.cancelVideoFrameCallback?.(handle);
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      v.removeEventListener("error", onError);
    };
    // rate 只在加载时应用一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, src, pts, targetOf]);

  const videoFrame = videoExact ? videoApprox : -1;
  return { cur, count, playing, ready, error, rate, setRate, seek, step, toggle, pause, frameAt, videoFrame, videoApprox };
}
