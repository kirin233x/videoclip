use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use videoclip_core::library::{self, Library};
use videoclip_core::{export, media};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e}")
}

struct AppState {
    library_path: PathBuf,
    /// 保存时串行写文件
    save_lock: Mutex<()>,
}

/// 允许 WebView 通过 asset 协议读取这个文件（用于播放视频）
fn allow(app: &AppHandle, path: &Path) {
    let _ = app.asset_protocol_scope().allow_file(path);
}

#[tauri::command]
fn load_library(app: AppHandle, state: State<AppState>) -> CmdResult<Library> {
    let lib = library::load(&state.library_path).map_err(err)?;
    for v in &lib.videos {
        allow(&app, Path::new(&v.path));
        if let Some(p) = &v.play_path {
            allow(&app, Path::new(p));
        }
    }
    Ok(lib)
}

#[tauri::command]
fn save_library(state: State<AppState>, library: Library) -> CmdResult<()> {
    let _g = state.save_lock.lock().map_err(|_| "保存被占用，请重试".to_string())?;
    library::save(&state.library_path, &library).map_err(err)
}

#[tauri::command]
async fn probe_video(app: AppHandle, path: String) -> CmdResult<media::VideoInfo> {
    let p = PathBuf::from(&path);
    allow(&app, &p);
    tauri::async_runtime::spawn_blocking(move || media::probe(&p)).await.map_err(err)?.map_err(err)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Tools {
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
}

#[tauri::command]
fn tools_status() -> Tools {
    let s = |n: &str| media::find_tool(n).map(|p| p.to_string_lossy().into_owned());
    Tools { ffmpeg: s("ffmpeg"), ffprobe: s("ffprobe") }
}

/// 转码为 H.264 用于显示，结果放在缓存目录，同一个文件只转一次
#[tauri::command]
async fn transcode_video(app: AppHandle, path: String) -> CmdResult<String> {
    let input = PathBuf::from(&path);
    let meta = std::fs::metadata(&input).map_err(err)?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    meta.len().hash(&mut h);
    if let Ok(m) = meta.modified() {
        m.hash(&mut h);
    }
    let dir = app.path().app_cache_dir().map_err(err)?.join("transcoded");
    let out = dir.join(format!("{:016x}.mp4", h.finish()));
    if !out.exists() {
        let o = out.clone();
        tauri::async_runtime::spawn_blocking(move || media::transcode_h264(&input, &o)).await.map_err(err)?.map_err(err)?;
    }
    allow(&app, &out);
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
async fn export_xlsx(library: Library, ids: Option<Vec<String>>, tz_offset_min: i32, path: String) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || export::export_xlsx(&library, ids.as_deref(), tz_offset_min, Path::new(&path)))
        .await
        .map_err(err)?
        .map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(AppState { library_path: dir.join("library.json"), save_lock: Mutex::new(()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            probe_video,
            tools_status,
            transcode_video,
            export_xlsx
        ])
        .run(tauri::generate_context!())
        .expect("启动 VideoClip 失败");
}
