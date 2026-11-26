//! VideoClip 核心逻辑，与界面无关，可以单独测试。
//!
//! - [`media`]：读取视频每一帧的真实显示时间（PTS）
//! - [`library`]：视频列表和测量记录的存储
//! - [`export`]：统计汇总与导出 Excel

pub mod export;
pub mod library;
pub mod media;
