//! 调试用：
//!   cargo run --example probe -- <视频>              打印视频信息
//!   cargo run --example probe -- <视频> --json       输出完整 JSON（含每帧时间）
//!   cargo run --example probe -- <视频> <转码输出>   测试转码并对比时间戳
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(input) = args.get(1) else {
        eprintln!("用法：probe <视频> [--json | 转码输出路径]");
        std::process::exit(2);
    };
    let p = std::path::Path::new(input);
    let v = videoclip_core::media::probe(p).unwrap_or_else(|e| {
        eprintln!("{e:#}");
        std::process::exit(1);
    });
    match args.get(2).map(String::as_str) {
        Some("--json") => println!("{}", serde_json::to_string(&v).unwrap()),
        Some(out) => {
            videoclip_core::media::transcode_h264(p, std::path::Path::new(out)).unwrap();
            let t = videoclip_core::media::probe(std::path::Path::new(out)).unwrap();
            let maxdiff = v.pts.iter().zip(&t.pts).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
            println!("转码后 {} 帧（原 {} 帧），最大时间偏差 {:.6}s", t.frame_count, v.frame_count, maxdiff);
        }
        None => println!(
            "{} {}x{} {} 帧 {:.3}fps 可变帧率={} 来源={} 时长={:.3}s",
            v.codec_name, v.width, v.height, v.frame_count, v.avg_fps, v.vfr, v.source, v.duration
        ),
    }
}
