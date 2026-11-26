//! 统计汇总与导出 Excel。
//!
//! 导出的工作簿有三张表：
//! - 明细：每条记录一行
//! - 按标签汇总：每个标签的次数、平均、中位数、最小、最大、标准差
//! - 按视频对比：每个视频一行、每个标签一列，方便对比多次启动

use crate::library::{Library, Record};
use anyhow::{Context, Result};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook, Worksheet};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

pub const UNNAMED: &str = "未命名";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub label: String,
    pub count: usize,
    pub mean: f64,
    pub median: f64,
    pub min: f64,
    pub max: f64,
    /// 样本标准差（只有一条记录时为 0）
    pub stddev: f64,
}

pub fn summarize(values: &[f64]) -> Option<(f64, f64, f64, f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = s.len();
    let mean = s.iter().sum::<f64>() / n as f64;
    let median = if n.is_multiple_of(2) { (s[n / 2 - 1] + s[n / 2]) / 2.0 } else { s[n / 2] };
    let stddev = if n > 1 {
        (s.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1) as f64).sqrt()
    } else {
        0.0
    };
    Some((mean, median, s[0], s[n - 1], stddev))
}

fn label_of(r: &Record) -> String {
    let l = r.label.trim();
    if l.is_empty() { UNNAMED.to_string() } else { l.to_string() }
}

/// 按标签汇总，标签按第一次出现的顺序排列
pub fn summary_by_label(records: &[&Record]) -> Vec<Summary> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<f64>> = HashMap::new();
    for r in records {
        let l = label_of(r);
        if !groups.contains_key(&l) {
            order.push(l.clone());
        }
        groups.entry(l).or_default().push(r.duration_ms());
    }
    order
        .into_iter()
        .map(|label| {
            let v = &groups[&label];
            let (mean, median, min, max, stddev) = summarize(v).unwrap();
            Summary { label, count: v.len(), mean, median, min, max, stddev }
        })
        .collect()
}

/// 毫秒时间戳 → 本地时间字符串（tz_offset_min：本地时间比 UTC 快多少分钟）
pub fn format_time(ms: i64, tz_offset_min: i32) -> String {
    let secs = ms.div_euclid(1000) + tz_offset_min as i64 * 60;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// 按视频在列表中的顺序、再按记录时间排序后返回要导出的记录
pub fn ordered_records<'a>(lib: &'a Library, ids: Option<&[String]>) -> Vec<&'a Record> {
    let pos: HashMap<&str, usize> = lib.videos.iter().enumerate().map(|(i, v)| (v.id.as_str(), i)).collect();
    let mut out: Vec<&Record> = lib
        .records
        .iter()
        .filter(|r| pos.contains_key(r.video_id.as_str()))
        .filter(|r| ids.is_none_or(|ids| ids.iter().any(|i| i == &r.id)))
        .collect();
    out.sort_by_key(|r| (pos[r.video_id.as_str()], r.created_at));
    out
}

struct Styles {
    header: Format,
    ms: Format,
    int: Format,
    text: Format,
    bold: Format,
    bold_ms: Format,
    title: Format,
}

fn styles() -> Styles {
    let border = Color::RGB(0xE7E8F0);
    let base = Format::new().set_font_name("Microsoft YaHei").set_font_size(10.5).set_border(FormatBorder::Thin).set_border_color(border);
    Styles {
        header: base
            .clone()
            .set_bold()
            .set_font_color(Color::RGB(0x5444E6))
            .set_background_color(Color::RGB(0xEFEDFF))
            .set_align(FormatAlign::Center)
            .set_align(FormatAlign::VerticalCenter),
        ms: base.clone().set_num_format("#,##0.0"),
        int: base.clone().set_num_format("0"),
        text: base.clone(),
        bold: base.clone().set_bold().set_background_color(Color::RGB(0xF3F4FA)),
        bold_ms: base.clone().set_bold().set_background_color(Color::RGB(0xF3F4FA)).set_num_format("#,##0.0"),
        title: Format::new().set_font_name("Microsoft YaHei").set_bold().set_font_size(14).set_font_color(Color::RGB(0x1B1F2E)),
    }
}

fn header(ws: &mut Worksheet, row: u32, cols: &[(&str, f64)], st: &Styles) -> Result<()> {
    for (i, (name, width)) in cols.iter().enumerate() {
        ws.write_string_with_format(row, i as u16, *name, &st.header)?;
        ws.set_column_width(i as u16, *width)?;
    }
    ws.set_row_height(row, 22)?;
    Ok(())
}

/// 导出 Excel。`ids` 为 None 时导出全部记录。返回导出的记录条数。
pub fn export_xlsx(lib: &Library, ids: Option<&[String]>, tz_offset_min: i32, out: &Path) -> Result<usize> {
    let records = ordered_records(lib, ids);
    let videos: HashMap<&str, &crate::library::VideoEntry> = lib.videos.iter().map(|v| (v.id.as_str(), v)).collect();
    let st = styles();
    let mut wb = Workbook::new();

    // ---------------------------------------------------------- 明细
    {
        let ws = wb.add_worksheet().set_name("明细")?;
        let cols = [
            ("序号", 6.0),
            ("视频", 30.0),
            ("标签", 18.0),
            ("耗时 (ms)", 12.0),
            ("帧数", 8.0),
            ("起点帧", 9.0),
            ("起点时间 (ms)", 14.0),
            ("终点帧", 9.0),
            ("终点时间 (ms)", 14.0),
            ("备注", 24.0),
            ("记录时间", 20.0),
            ("视频路径", 50.0),
        ];
        header(ws, 0, &cols, &st)?;
        for (i, r) in records.iter().enumerate() {
            let row = i as u32 + 1;
            let v = videos[r.video_id.as_str()];
            ws.write_number_with_format(row, 0, (i + 1) as f64, &st.int)?;
            ws.write_string_with_format(row, 1, &v.name, &st.text)?;
            ws.write_string_with_format(row, 2, label_of(r), &st.text)?;
            ws.write_number_with_format(row, 3, r.duration_ms(), &st.ms)?;
            ws.write_number_with_format(row, 4, r.frames() as f64, &st.int)?;
            // 表格里的帧号从 1 开始，和界面一致
            ws.write_number_with_format(row, 5, (r.start_frame + 1) as f64, &st.int)?;
            ws.write_number_with_format(row, 6, r.start_ms, &st.ms)?;
            ws.write_number_with_format(row, 7, (r.end_frame + 1) as f64, &st.int)?;
            ws.write_number_with_format(row, 8, r.end_ms, &st.ms)?;
            ws.write_string_with_format(row, 9, &r.note, &st.text)?;
            ws.write_string_with_format(row, 10, format_time(r.created_at, tz_offset_min), &st.text)?;
            ws.write_string_with_format(row, 11, &v.path, &st.text)?;
        }
        ws.set_freeze_panes(1, 0)?;
        if !records.is_empty() {
            ws.autofilter(0, 0, records.len() as u32, (cols.len() - 1) as u16)?;
        }
    }

    // ---------------------------------------------------------- 按标签汇总
    let summary = summary_by_label(&records);
    {
        let ws = wb.add_worksheet().set_name("按标签汇总")?;
        let cols = [
            ("标签", 20.0),
            ("次数", 8.0),
            ("平均 (ms)", 12.0),
            ("中位数 (ms)", 12.0),
            ("最小 (ms)", 12.0),
            ("最大 (ms)", 12.0),
            ("标准差 (ms)", 12.0),
        ];
        header(ws, 0, &cols, &st)?;
        for (i, s) in summary.iter().enumerate() {
            let row = i as u32 + 1;
            ws.write_string_with_format(row, 0, &s.label, &st.text)?;
            ws.write_number_with_format(row, 1, s.count as f64, &st.int)?;
            ws.write_number_with_format(row, 2, s.mean, &st.ms)?;
            ws.write_number_with_format(row, 3, s.median, &st.ms)?;
            ws.write_number_with_format(row, 4, s.min, &st.ms)?;
            ws.write_number_with_format(row, 5, s.max, &st.ms)?;
            ws.write_number_with_format(row, 6, s.stddev, &st.ms)?;
        }
        ws.set_freeze_panes(1, 1)?;
    }

    // ---------------------------------------------------------- 按视频对比
    {
        let ws = wb.add_worksheet().set_name("按视频对比")?;
        let labels: Vec<&str> = summary.iter().map(|s| s.label.as_str()).collect();
        ws.write_string_with_format(0, 0, "每个视频同一标签有多条记录时取平均值（ms）", &st.title)?;
        let mut cols: Vec<(&str, f64)> = vec![("视频", 30.0)];
        cols.extend(labels.iter().map(|l| (*l, 14.0_f64.max(l.chars().count() as f64 * 2.2))));
        header(ws, 1, &cols, &st)?;

        let mut video_order: Vec<&str> = Vec::new();
        let mut cells: HashMap<(&str, String), Vec<f64>> = HashMap::new();
        for r in &records {
            if !video_order.contains(&r.video_id.as_str()) {
                video_order.push(&r.video_id);
            }
            cells.entry((r.video_id.as_str(), label_of(r))).or_default().push(r.duration_ms());
        }
        let mut columns: Vec<Vec<f64>> = vec![Vec::new(); labels.len()];
        for (i, vid) in video_order.iter().enumerate() {
            let row = i as u32 + 2;
            ws.write_string_with_format(row, 0, &videos[vid].name, &st.text)?;
            for (j, l) in labels.iter().enumerate() {
                match cells.get(&(*vid, l.to_string())) {
                    Some(v) => {
                        let mean = v.iter().sum::<f64>() / v.len() as f64;
                        columns[j].push(mean);
                        ws.write_number_with_format(row, j as u16 + 1, mean, &st.ms)?;
                    }
                    None => {
                        ws.write_blank(row, j as u16 + 1, &st.text)?;
                    }
                }
            }
        }
        let base = video_order.len() as u32 + 2;
        for (k, name) in ["平均", "中位数", "最小", "最大", "标准差"].iter().enumerate() {
            let row = base + k as u32;
            ws.write_string_with_format(row, 0, *name, &st.bold)?;
            for (j, col) in columns.iter().enumerate() {
                match summarize(col) {
                    Some(s) => {
                        let v = [s.0, s.1, s.2, s.3, s.4][k];
                        ws.write_number_with_format(row, j as u16 + 1, v, &st.bold_ms)?;
                    }
                    None => {
                        ws.write_blank(row, j as u16 + 1, &st.bold)?;
                    }
                }
            }
        }
        ws.set_freeze_panes(2, 1)?;
    }

    wb.save(out).with_context(|| format!("保存失败（文件是否正在 Excel 里打开？）：{}", out.display()))?;
    Ok(records.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats() {
        let (mean, median, min, max, sd) = summarize(&[100.0, 300.0, 200.0, 400.0]).unwrap();
        assert_eq!((mean, median, min, max), (250.0, 250.0, 100.0, 400.0));
        assert!((sd - 129.0994).abs() < 1e-3);
        assert_eq!(summarize(&[5.0]).unwrap(), (5.0, 5.0, 5.0, 5.0, 0.0));
        assert!(summarize(&[]).is_none());
    }

    #[test]
    fn time_format() {
        assert_eq!(format_time(0, 0), "1970-01-01 00:00:00");
        // 2026-11-26 08:00:00 UTC = 16:00 北京时间
        assert_eq!(format_time(1_795_680_000_000, 480), "2026-11-26 16:00:00");
    }
}
