//! 读取视频每一帧的显示时间（PTS）。
//!
//! 手机录屏几乎都是可变帧率（VFR），不能用「帧号 ÷ 帧率」换算时间，
//! 必须拿到每一帧真实的时间戳。MP4 / MOV（包括 iPhone 录屏）直接解析容器里的
//! 采样表（stts / ctts / elst），不需要解码，几百 MB 的视频也只要几十毫秒。
//! 其他格式（或分片 MP4）在本机装了 ffprobe 时交给 ffprobe。

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// 显示宽高（已按旋转角度换算）
    pub width: u32,
    pub height: u32,
    /// 容器里记录的旋转角度（0 / 90 / 180 / 270）
    pub rotation: i32,
    /// 编码标识，例如 avc1、hvc1
    pub codec: String,
    /// 便于阅读的编码名，例如 H.264、HEVC
    pub codec_name: String,
    /// 时长（秒）：首帧到最后一帧结束
    pub duration: f64,
    pub frame_count: usize,
    /// 平均帧率
    pub avg_fps: f64,
    /// 是否可变帧率
    pub vfr: bool,
    /// 每一帧的显示时间（秒），按显示顺序升序
    pub pts: Vec<f64>,
    /// 时间表来源："container" 或 "ffprobe"
    pub source: String,
}

/// 读取视频信息和帧时间表。
pub fn probe(path: &Path) -> Result<VideoInfo> {
    let meta = std::fs::metadata(path).with_context(|| format!("找不到文件：{}", path.display()))?;
    match parse_iso_bmff(path) {
        Ok(t) => Ok(finish(path, meta.len(), t, "container")),
        Err(container_err) => match probe_ffprobe(path) {
            Ok(t) => Ok(finish(path, meta.len(), t, "ffprobe")),
            Err(ff_err) => Err(anyhow!(
                "无法读取视频帧时间：{container_err}（ffprobe：{ff_err}）"
            )),
        },
    }
}

/// 解析结果（未汇总）
#[derive(Debug, Default)]
struct RawTrack {
    width: u32,
    height: u32,
    rotation: i32,
    codec: String,
    pts: Vec<f64>,
    /// 最后一帧的持续时间（秒），未知时为 None
    last_duration: Option<f64>,
    /// 按解码顺序的每个采样的显示时间（未过滤），用于 WebCodecs 解码
    decode_pts: Vec<f64>,
    /// 解码器配置：（WebCodecs codec 字符串, avcC/hvcC 内容, 编码宽, 编码高）
    decoder_config: Option<(String, Vec<u8>, u32, u32)>,
    /// 按解码顺序的采样位置：（文件偏移, 大小, 是否关键帧）
    samples: Vec<(u64, u32, bool)>,
}

fn finish(path: &Path, size: u64, mut t: RawTrack, source: &str) -> VideoInfo {
    t.pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t.pts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let n = t.pts.len();
    let deltas: Vec<f64> = t.pts.windows(2).map(|w| w[1] - w[0]).collect();
    let median = median(&deltas).unwrap_or(0.0);
    let span = if n >= 2 { t.pts[n - 1] - t.pts[0] } else { 0.0 };
    let last = t.last_duration.filter(|d| *d > 0.0).unwrap_or(median);
    let avg_fps = if span > 0.0 { (n - 1) as f64 / span } else { 0.0 };
    // 有帧间隔偏离中位数 25% 以上，就认为是可变帧率
    let vfr = median > 0.0 && deltas.iter().any(|d| (d - median).abs() > median * 0.25);
    let (width, height) = if t.rotation % 180 != 0 { (t.height, t.width) } else { (t.width, t.height) };
    VideoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        size,
        width,
        height,
        rotation: t.rotation,
        codec_name: codec_name(&t.codec),
        codec: t.codec,
        duration: if n > 0 { span + last } else { 0.0 },
        frame_count: n,
        avg_fps,
        vfr,
        pts: t.pts,
        source: source.to_string(),
    }
}

fn median(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = s.len() / 2;
    Some(if s.len().is_multiple_of(2) { (s[m - 1] + s[m]) / 2.0 } else { s[m] })
}

pub fn codec_name(fourcc: &str) -> String {
    match fourcc {
        "avc1" | "avc3" | "h264" => "H.264",
        "hvc1" | "hev1" | "hevc" => "HEVC",
        "av01" | "av1" => "AV1",
        "vp09" | "vp9" => "VP9",
        "vp08" | "vp8" => "VP8",
        "mp4v" | "mpeg4" => "MPEG-4",
        other => return other.to_uppercase(),
    }
    .to_string()
}

// ------------------------------------------------------------------ ISO BMFF（MP4 / MOV）

fn be_u16(b: &[u8], at: usize) -> Result<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).ok_or_else(|| anyhow!("数据不完整"))
}
fn be_u32(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes(s.try_into().unwrap())).ok_or_else(|| anyhow!("数据不完整"))
}
fn be_i32(b: &[u8], at: usize) -> Result<i32> {
    be_u32(b, at).map(|v| v as i32)
}
fn be_u64(b: &[u8], at: usize) -> Result<u64> {
    b.get(at..at + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap())).ok_or_else(|| anyhow!("数据不完整"))
}

/// 列出一段数据里的子 box：(类型, 内容)
fn children(buf: &[u8]) -> Result<Vec<([u8; 4], &[u8])>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= buf.len() {
        let mut size = be_u32(buf, pos)? as u64;
        let kind: [u8; 4] = buf[pos + 4..pos + 8].try_into().unwrap();
        let mut hdr = 8u64;
        if size == 1 {
            size = be_u64(buf, pos + 8)?;
            hdr = 16;
        } else if size == 0 {
            size = (buf.len() - pos) as u64;
        }
        if size < hdr || pos as u64 + size > buf.len() as u64 {
            bail!("视频文件结构损坏");
        }
        out.push((kind, &buf[pos + hdr as usize..pos + size as usize]));
        pos += size as usize;
    }
    Ok(out)
}

fn child<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Result<Option<&'a [u8]>> {
    Ok(children(buf)?.into_iter().find(|(k, _)| k == kind).map(|(_, d)| d))
}

fn need<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Result<&'a [u8]> {
    child(buf, kind)?.ok_or_else(|| anyhow!("缺少 {} 信息", String::from_utf8_lossy(kind)))
}

/// 只扫描顶层 box，把 moov 读进内存（媒体数据 mdat 不读）
fn read_moov(path: &Path) -> Result<Vec<u8>> {
    let mut f = File::open(path).with_context(|| format!("打不开文件：{}", path.display()))?;
    let len = f.metadata()?.len();
    let mut pos = 0u64;
    let mut moov = None;
    let mut fragmented = false;
    let mut first = true;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        let mut h = [0u8; 8];
        f.read_exact(&mut h)?;
        let mut size = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = h[4..8].try_into().unwrap();
        let mut hdr = 8u64;
        if first && !matches!(&kind, b"ftyp" | b"moov" | b"mdat" | b"free" | b"wide" | b"skip" | b"pnot" | b"uuid") {
            bail!("不是 MP4 / MOV 文件");
        }
        first = false;
        if size == 1 {
            let mut e = [0u8; 8];
            f.read_exact(&mut e)?;
            size = u64::from_be_bytes(e);
            hdr = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < hdr {
            bail!("视频文件结构损坏");
        }
        match &kind {
            b"moov" => {
                let body = size - hdr;
                if body > 1 << 30 {
                    bail!("moov 过大");
                }
                let mut buf = vec![0u8; body as usize];
                f.read_exact(&mut buf).context("视频文件不完整（可能还在录制或没有拷贝完）")?;
                moov = Some(buf);
            }
            b"moof" => fragmented = true,
            _ => {}
        }
        pos += size;
    }
    if fragmented {
        bail!("分片 MP4 需要用 ffprobe 读取");
    }
    moov.ok_or_else(|| anyhow!("视频文件不完整：找不到 moov（可能录制被中断）"))
}

fn parse_iso_bmff(path: &Path) -> Result<RawTrack> {
    let moov = read_moov(path)?;
    let mvhd = need(&moov, b"mvhd")?;
    let movie_timescale = if mvhd.first() == Some(&1) { be_u32(mvhd, 20)? } else { be_u32(mvhd, 12)? };

    for (kind, trak) in children(&moov)? {
        if &kind != b"trak" {
            continue;
        }
        let mdia = need(trak, b"mdia")?;
        let hdlr = need(mdia, b"hdlr")?;
        if hdlr.get(8..12) != Some(b"vide") {
            continue;
        }
        return parse_video_trak(trak, mdia, movie_timescale);
    }
    bail!("文件里没有视频轨道")
}

fn parse_video_trak(trak: &[u8], mdia: &[u8], movie_timescale: u32) -> Result<RawTrack> {
    let mut t = RawTrack::default();

    // tkhd：显示尺寸和旋转矩阵
    let tkhd = need(trak, b"tkhd")?;
    let base = if tkhd.first() == Some(&1) { 4 + 8 + 8 + 4 + 4 + 8 } else { 4 + 4 + 4 + 4 + 4 + 4 };
    let matrix = base + 8 + 2 + 2 + 2 + 2;
    let a = be_i32(tkhd, matrix)? as f64 / 65536.0;
    let b = be_i32(tkhd, matrix + 4)? as f64 / 65536.0;
    let deg = b.atan2(a).to_degrees().round() as i32;
    t.rotation = ((deg % 360) + 360) % 360;
    t.width = be_u32(tkhd, matrix + 36)? >> 16;
    t.height = be_u32(tkhd, matrix + 40)? >> 16;

    // mdhd：时间单位
    let mdhd = need(mdia, b"mdhd")?;
    let timescale = if mdhd.first() == Some(&1) { be_u32(mdhd, 20)? } else { be_u32(mdhd, 12)? };
    if timescale == 0 {
        bail!("视频时间单位无效");
    }

    let stbl = need(need(mdia, b"minf")?, b"stbl")?;

    // stsd：编码格式和编码尺寸
    let stsd = need(stbl, b"stsd")?;
    if let Some((kind, entry)) = children(stsd.get(8..).unwrap_or_default())?.into_iter().next() {
        t.codec = String::from_utf8_lossy(&kind).trim().to_string();
        let coded_w = be_u16(entry, 24).unwrap_or(0) as u32;
        let coded_h = be_u16(entry, 26).unwrap_or(0) as u32;
        if t.width == 0 || t.height == 0 {
            t.width = coded_w;
            t.height = coded_h;
        }
        // 视觉采样条目头部 78 字节之后是 avcC / hvcC 等子 box
        if let Some(rest) = entry.get(78..) {
            if let Ok(kids) = children(rest) {
                for (k, body) in kids {
                    let codec = match &k {
                        b"avcC" => avc_codec_string(body),
                        b"hvcC" => hevc_codec_string(&t.codec, body),
                        _ => None,
                    };
                    if let Some(c) = codec {
                        t.decoder_config = Some((c, body.to_vec(), coded_w, coded_h));
                        break;
                    }
                }
            }
        }
    }

    // stts：解码时间间隔
    let stts = need(stbl, b"stts")?;
    let n_stts = be_u32(stts, 4)? as usize;
    let mut deltas: Vec<(u32, u32)> = Vec::with_capacity(n_stts);
    for i in 0..n_stts {
        deltas.push((be_u32(stts, 8 + i * 8)?, be_u32(stts, 12 + i * 8)?));
    }
    let total: u64 = deltas.iter().map(|(c, _)| *c as u64).sum();
    if total == 0 {
        bail!("视频里没有帧");
    }
    if total > 10_000_000 {
        bail!("帧数异常");
    }

    // ctts：显示时间相对解码时间的偏移（有 B 帧时才有）
    let mut offsets: Vec<(u32, i32)> = Vec::new();
    if let Some(ctts) = child(stbl, b"ctts")? {
        let n = be_u32(ctts, 4)? as usize;
        for i in 0..n {
            offsets.push((be_u32(ctts, 8 + i * 8)?, be_i32(ctts, 12 + i * 8)?));
        }
    }

    // elst：编辑列表。开头的空编辑表示整体延后，media_time 表示从哪里开始显示
    let mut empty_delay = 0f64;
    let mut media_start = 0i64;
    if let Some(elst) = child(trak, b"edts")?.map(|e| child(e, b"elst")).transpose()?.flatten() {
        let v1 = elst.first() == Some(&1);
        let n = be_u32(elst, 4)? as usize;
        let stride = if v1 { 20 } else { 12 };
        for i in 0..n {
            let at = 8 + i * stride;
            let (dur, mt) = if v1 {
                (be_u64(elst, at)?, be_u64(elst, at + 8)? as i64)
            } else {
                (be_u32(elst, at)? as u64, be_i32(elst, at + 4)? as i64)
            };
            if mt == -1 {
                if movie_timescale > 0 {
                    empty_delay += dur as f64 / movie_timescale as f64;
                }
            } else {
                media_start = mt;
                break;
            }
        }
    }

    let mut pts = Vec::with_capacity(total as usize);
    let mut dts: i64 = 0;
    let mut off_iter = offsets.iter().flat_map(|(c, o)| std::iter::repeat_n(*o, *c as usize));
    for (count, delta) in &deltas {
        for _ in 0..*count {
            let off = off_iter.next().unwrap_or(0) as i64;
            let p = (dts + off - media_start) as f64 / timescale as f64 + empty_delay;
            pts.push(p);
            dts += *delta as i64;
        }
    }
    t.decode_pts = pts.clone();
    if t.decoder_config.is_some() {
        // 采样表只在可以用 WebCodecs 解码时才需要；解析失败不影响读取时间
        t.samples = sample_locations(stbl, total as usize).unwrap_or_default();
    }
    // 编辑列表之前的帧不会显示（解码预滚），去掉
    pts.retain(|p| *p > -1e-9);
    if pts.is_empty() {
        bail!("视频里没有可显示的帧");
    }
    t.pts = pts;
    t.last_duration = deltas.last().map(|(_, d)| *d as f64 / timescale as f64);
    Ok(t)
}

/// 每个采样在文件里的位置（stsz + stco/co64 + stsc）和是否关键帧（stss）
fn sample_locations(stbl: &[u8], total: usize) -> Result<Vec<(u64, u32, bool)>> {
    let stsz = need(stbl, b"stsz")?;
    let fixed = be_u32(stsz, 4)?;
    let count = be_u32(stsz, 8)? as usize;
    if count != total {
        bail!("采样数不一致");
    }
    let size_of = |i: usize| -> Result<u32> { if fixed != 0 { Ok(fixed) } else { be_u32(stsz, 12 + i * 4) } };

    let chunk_offsets: Vec<u64> = if let Some(stco) = child(stbl, b"stco")? {
        (0..be_u32(stco, 4)? as usize).map(|i| be_u32(stco, 8 + i * 4).map(|v| v as u64)).collect::<Result<_>>()?
    } else {
        let co64 = need(stbl, b"co64")?;
        (0..be_u32(co64, 4)? as usize).map(|i| be_u64(co64, 8 + i * 8)).collect::<Result<_>>()?
    };

    let stsc = need(stbl, b"stsc")?;
    let n = be_u32(stsc, 4)? as usize;
    let mut runs: Vec<(u32, u32)> = Vec::with_capacity(n); // (first_chunk, samples_per_chunk)
    for i in 0..n {
        runs.push((be_u32(stsc, 8 + i * 12)?, be_u32(stsc, 12 + i * 12)?));
    }

    let sync: Option<Vec<u32>> = match child(stbl, b"stss")? {
        Some(stss) => Some((0..be_u32(stss, 4)? as usize).map(|i| be_u32(stss, 8 + i * 4)).collect::<Result<_>>()?),
        None => None, // 没有 stss 表示每一帧都是关键帧
    };

    let mut out = Vec::with_capacity(total);
    let mut sample = 0usize;
    for (ci, base) in chunk_offsets.iter().enumerate() {
        let chunk_no = ci as u32 + 1;
        let per = runs.iter().rev().find(|(first, _)| *first <= chunk_no).map(|(_, n)| *n).unwrap_or(0);
        let mut off = *base;
        for _ in 0..per {
            if sample >= total {
                break;
            }
            let size = size_of(sample)?;
            let key = sync.as_ref().is_none_or(|s| s.binary_search(&(sample as u32 + 1)).is_ok());
            out.push((off, size, key));
            off += size as u64;
            sample += 1;
        }
    }
    if out.len() != total {
        bail!("采样表不完整");
    }
    Ok(out)
}

fn hex2(v: u8) -> String {
    format!("{v:02x}")
}

/// avcC → "avc1.64002a"
fn avc_codec_string(avcc: &[u8]) -> Option<String> {
    let b = avcc.get(1..4)?;
    Some(format!("avc1.{}{}{}", hex2(b[0]), hex2(b[1]), hex2(b[2])))
}

/// hvcC → "hvc1.1.6.L153.B0"（ISO/IEC 14496-15 附录 E）
fn hevc_codec_string(fourcc: &str, h: &[u8]) -> Option<String> {
    if h.len() < 13 {
        return None;
    }
    let space = ["", "A", "B", "C"][(h[1] >> 6) as usize];
    let tier = if h[1] & 0x20 != 0 { "H" } else { "L" };
    let profile = h[1] & 0x1f;
    let compat = u32::from_be_bytes([h[2], h[3], h[4], h[5]]).reverse_bits();
    let level = h[12];
    let mut cons: Vec<u8> = h[6..12].to_vec();
    while cons.last() == Some(&0) {
        cons.pop();
    }
    let mut s = format!("{}.{space}{profile}.{compat:x}.{tier}{level}", if fourcc == "hev1" { "hev1" } else { "hvc1" });
    for c in cons {
        s.push('.');
        s.push_str(&format!("{c:x}"));
    }
    Some(s)
}

// ------------------------------------------------------------------ WebCodecs 解码用的采样表

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SampleTable {
    /// WebCodecs 的 codec 字符串，例如 avc1.64002a
    pub codec: String,
    /// avcC / hvcC 的内容，作为 VideoDecoder 的 description
    pub description: Vec<u8>,
    pub coded_width: u32,
    pub coded_height: u32,
    /// 按解码顺序：文件偏移
    pub offsets: Vec<u64>,
    /// 按解码顺序：大小
    pub sizes: Vec<u32>,
    /// 按解码顺序：是否关键帧
    pub keys: Vec<bool>,
    /// 按解码顺序：对应 VideoInfo.pts 里的第几帧；-1 表示这个采样不显示（编辑列表之前的预滚）
    pub frames: Vec<i64>,
}

/// 读取 WebCodecs 逐帧解码需要的采样表。帧序号和 [`probe`] 返回的 pts 一一对应。
pub fn sample_table(path: &Path) -> Result<SampleTable> {
    let t = parse_iso_bmff(path)?;
    let (codec, description, coded_width, coded_height) =
        t.decoder_config.clone().ok_or_else(|| anyhow!("不支持用 WebCodecs 解码 {}", t.codec))?;
    if t.samples.len() != t.decode_pts.len() {
        bail!("采样表不完整");
    }
    // 和 probe 一样得到显示顺序的帧时间表，再把每个采样映射到帧序号
    let info = finish(path, 0, RawTrack { pts: t.pts.clone(), ..Default::default() }, "container");
    let frames = t
        .decode_pts
        .iter()
        .map(|p| {
            if *p <= -1e-9 {
                return -1;
            }
            let i = info.pts.partition_point(|x| *x < p - 1e-9);
            if i < info.pts.len() && (info.pts[i] - p).abs() < 1e-6 { i as i64 } else { -1 }
        })
        .collect();
    Ok(SampleTable {
        codec,
        description,
        coded_width,
        coded_height,
        offsets: t.samples.iter().map(|s| s.0).collect(),
        sizes: t.samples.iter().map(|s| s.1).collect(),
        keys: t.samples.iter().map(|s| s.2).collect(),
        frames,
    })
}

/// 读取文件中的一段字节（给 WebCodecs 解码用）
pub fn read_span(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>> {
    if len > 256 << 20 {
        bail!("一次读取太多");
    }
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

// ------------------------------------------------------------------ ffprobe

/// 在 PATH 和常见安装位置里找 ffmpeg / ffprobe
pub fn find_tool(name: &str) -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // 从 Finder 启动的 macOS 应用拿不到终端里的 PATH，补上 Homebrew 的目录
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(d.into());
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn probe_ffprobe(path: &Path) -> Result<RawTrack> {
    let ffprobe = find_tool("ffprobe").ok_or_else(|| anyhow!("没有安装 ffprobe"))?;
    let out = command(&ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
        .arg("stream=codec_name,width,height:stream_side_data=rotation:packet=pts_time,duration_time")
        .args(["-show_packets", "-of", "json"])
        .arg(path)
        .output()
        .context("运行 ffprobe 失败")?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    parse_ffprobe_json(&out.stdout)
}

fn parse_ffprobe_json(json: &[u8]) -> Result<RawTrack> {
    #[derive(Deserialize)]
    struct Out {
        #[serde(default)]
        packets: Vec<Packet>,
        #[serde(default)]
        streams: Vec<Stream>,
    }
    #[derive(Deserialize)]
    struct Packet {
        pts_time: Option<String>,
        duration_time: Option<String>,
    }
    #[derive(Deserialize)]
    struct Stream {
        codec_name: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        #[serde(default)]
        side_data_list: Vec<serde_json::Value>,
    }
    let o: Out = serde_json::from_slice(json).context("ffprobe 输出无法解析")?;
    let s = o.streams.first().ok_or_else(|| anyhow!("文件里没有视频轨道"))?;
    let rotation = s
        .side_data_list
        .iter()
        .find_map(|v| v.get("rotation").and_then(|r| r.as_f64()))
        .map(|r| (((-r).round() as i32 % 360) + 360) % 360)
        .unwrap_or(0);
    let mut last = None;
    let mut pts = Vec::new();
    for p in &o.packets {
        if let Some(t) = p.pts_time.as_deref().and_then(|t| t.parse::<f64>().ok()) {
            pts.push(t);
            last = p.duration_time.as_deref().and_then(|d| d.parse::<f64>().ok());
        }
    }
    if pts.is_empty() {
        bail!("视频里没有帧");
    }
    Ok(RawTrack {
        width: s.width.unwrap_or(0),
        height: s.height.unwrap_or(0),
        rotation,
        codec: s.codec_name.clone().unwrap_or_default(),
        pts,
        last_duration: last,
        ..Default::default()
    })
}

// ------------------------------------------------------------------ 转码

/// 把视频转成 H.264，只用于在 WebView 里显示（例如 Windows 上播放不了 HEVC）。
/// 保留原始时间戳，不丢帧不补帧；测量仍然使用原视频的时间表。
pub fn transcode_h264(input: &Path, output: &Path) -> Result<()> {
    let ffmpeg = find_tool("ffmpeg").ok_or_else(|| anyhow!("没有找到 ffmpeg，请先安装 ffmpeg 并加入 PATH"))?;
    if let Some(dir) = output.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = output.with_extension("part.mp4");
    let run = |sync: &[&str]| -> Result<std::process::Output> {
        command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(input)
            .args(["-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16"])
            .args(["-pix_fmt", "yuv420p", "-bf", "0", "-video_track_timescale", "90000"])
            .args(sync)
            .args(["-movflags", "+faststart"])
            .arg(&tmp)
            .output()
            .context("运行 ffmpeg 失败")
    };
    let mut out = run(&["-fps_mode", "passthrough"])?;
    if !out.status.success() {
        // 老版本 ffmpeg 不认识 -fps_mode
        out = run(&["-vsync", "passthrough"])?;
    }
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        bail!("转码失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    std::fs::rename(&tmp, output)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobe_json() {
        let j = br#"{"packets":[{"pts_time":"0.033"},{"pts_time":"0.000","duration_time":"0.0166"}],
            "streams":[{"codec_name":"hevc","width":1080,"height":2400,"side_data_list":[{"rotation":-90}]}]}"#;
        let t = parse_ffprobe_json(j).unwrap();
        assert_eq!(t.rotation, 90);
        assert_eq!(t.codec, "hevc");
        let v = finish(Path::new("a.mkv"), 1, t, "ffprobe");
        assert_eq!(v.pts, vec![0.0, 0.033]);
        assert_eq!((v.width, v.height), (2400, 1080));
        assert_eq!(v.codec_name, "HEVC");
    }
}
