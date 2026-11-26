//! 视频列表和测量记录。数据保存在应用数据目录下的 library.json。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub version: u32,
    pub videos: Vec<VideoEntry>,
    pub records: Vec<Record>,
    /// 最近用过的标签，最新的在前
    pub labels: Vec<String>,
    /// 界面设置（主题等），原样保存
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoEntry {
    pub id: String,
    /// 原视频路径（测量使用它的时间表）
    pub path: String,
    /// 转码后用于显示的视频（只在原视频无法播放时才有）
    pub play_path: Option<String>,
    pub name: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub id: String,
    pub video_id: String,
    pub label: String,
    pub note: String,
    /// 帧序号，从 0 开始
    pub start_frame: usize,
    pub end_frame: usize,
    /// 帧的显示时间（毫秒）
    pub start_ms: f64,
    pub end_ms: f64,
    pub created_at: i64,
}

impl Record {
    pub fn duration_ms(&self) -> f64 {
        self.end_ms - self.start_ms
    }
    pub fn frames(&self) -> i64 {
        self.end_frame as i64 - self.start_frame as i64
    }
}

pub fn load(path: &Path) -> Result<Library> {
    if !path.exists() {
        return Ok(Library { version: 1, ..Default::default() });
    }
    let text = std::fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    match serde_json::from_str::<Library>(&text) {
        Ok(lib) => Ok(lib),
        Err(e) => {
            // 文件损坏时先备份，避免覆盖掉还能手工恢复的数据
            let bak = path.with_extension("broken.json");
            let _ = std::fs::copy(path, &bak);
            Err(e).with_context(|| format!("数据文件已损坏，已备份到 {}", bak.display()))
        }
    }
}

/// 先写临时文件再改名，写到一半断电也不会损坏原文件
pub fn save(path: &Path, lib: &Library) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(lib)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
