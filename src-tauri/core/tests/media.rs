//! 用 ffmpeg 生成的小视频验证帧时间表。`.pts` 文件是 ffprobe 读出的参考值。

use std::path::PathBuf;
use videoclip_core::library::{Library, Record, VideoEntry};
use videoclip_core::{export, media};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn reference(name: &str) -> Vec<f64> {
    std::fs::read_to_string(fixture(name)).unwrap().split(',').map(|s| s.trim().parse().unwrap()).collect()
}

fn assert_pts(file: &str, pts_file: &str) -> media::VideoInfo {
    let info = media::probe(&fixture(file)).unwrap();
    assert_eq!(info.source, "container", "{file} 应当直接解析容器");
    let want = reference(pts_file);
    assert_eq!(info.pts.len(), want.len(), "{file} 帧数");
    for (i, (a, b)) in info.pts.iter().zip(&want).enumerate() {
        assert!((a - b).abs() < 1e-5, "{file} 第 {i} 帧：{a} != {b}");
    }
    info
}

#[test]
fn h264_with_bframes_and_edit_list() {
    let v = assert_pts("cfr30_bframes.mp4", "cfr30_bframes.pts");
    assert_eq!(v.codec_name, "H.264");
    assert_eq!((v.width, v.height), (96, 160));
    assert!(!v.vfr);
    assert!((v.avg_fps - 30.0).abs() < 0.01);
    assert!((v.duration - 1.0).abs() < 1e-6);
}

#[test]
fn variable_frame_rate() {
    let v = assert_pts("vfr.mp4", "vfr.pts");
    assert!(v.vfr);
    assert_eq!(v.frame_count, 34);
}

#[test]
fn hevc_mov_timescale_600() {
    let v = assert_pts("hevc600.mov", "hevc600.pts");
    assert_eq!(v.codec, "hvc1");
    assert_eq!(v.codec_name, "HEVC");
    assert!((v.avg_fps - 60.0).abs() < 0.01);
}

#[test]
fn rotated() {
    let v = assert_pts("rot90.mp4", "rot90.pts");
    assert_eq!(v.rotation % 180, 90);
    assert_eq!((v.width, v.height), (96, 160));
}

#[test]
fn not_a_video() {
    let dir = std::env::temp_dir().join("videoclip-test-notvideo");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("a.mp4");
    std::fs::write(&p, b"hello world, definitely not a video").unwrap();
    assert!(media::probe(&p).is_err());
}

#[test]
fn library_roundtrip_and_export() {
    let dir = std::env::temp_dir().join("videoclip-test-export");
    std::fs::create_dir_all(&dir).unwrap();
    let mut lib = Library { version: 1, ..Default::default() };
    for (i, name) in ["a.mp4", "b.mp4"].iter().enumerate() {
        lib.videos.push(VideoEntry { id: format!("v{i}"), path: format!("/x/{name}"), name: name.to_string(), ..Default::default() });
    }
    let rec = |id: &str, vid: &str, label: &str, s: f64, e: f64, t: i64| Record {
        id: id.into(),
        video_id: vid.into(),
        label: label.into(),
        start_frame: (s / 16.0) as usize,
        end_frame: (e / 16.0) as usize,
        start_ms: s,
        end_ms: e,
        created_at: t,
        ..Default::default()
    };
    lib.records = vec![
        rec("r1", "v1", "冷启动", 100.0, 900.0, 3),
        rec("r2", "v0", "冷启动", 50.0, 650.0, 2),
        rec("r3", "v0", "首帧", 50.0, 250.0, 1),
        rec("r4", "orphan", "冷启动", 0.0, 1.0, 0),
    ];

    let p = dir.join("library.json");
    videoclip_core::library::save(&p, &lib).unwrap();
    assert_eq!(videoclip_core::library::load(&p).unwrap(), lib);

    let ordered = export::ordered_records(&lib, None);
    assert_eq!(ordered.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["r3", "r2", "r1"]);
    let s = export::summary_by_label(&ordered);
    assert_eq!(s[0].label, "首帧");
    assert_eq!(s[1].label, "冷启动");
    assert_eq!(s[1].count, 2);
    assert_eq!(s[1].mean, 700.0);

    let out = dir.join("out.xlsx");
    assert_eq!(export::export_xlsx(&lib, None, 480, &out).unwrap(), 3);
    assert!(std::fs::metadata(&out).unwrap().len() > 1000);
    let only = vec!["r1".to_string()];
    assert_eq!(export::export_xlsx(&lib, Some(&only), 480, &dir.join("one.xlsx")).unwrap(), 1);
}
