//! 视频 Command（薄包装 → VideoService）
//!
//! 设计要点：
//! - `save_video` 接收 `Vec<u8>` 而非 base64 字符串：前端用 `Uint8Array` 调 invoke，
//!   Tauri 2.x 走 binary IPC 通道，比 base64 省 33% 体积 + 零编解码
//! - `save_video_from_path` 走 `std::fs::copy` 零拷贝，给"工具栏插入视频"
//!   或前端"大文件超限退化为文件选择器"的兜底场景
//! - v1 不支持加密笔记的视频 —— 加密笔记调用直接返回错误，由前端引导用户取消加密

use tauri::State;

use crate::services::asset_path;
use crate::services::video::VideoService;
use crate::state::AppState;

/// 后端硬性上限：单文件 500MB。前端会按更小阈值（粘贴 50MB / 拖入 100MB）提前拦截，
/// 这里只兜底防止异常调用 OOM。
const MAX_BYTES: usize = 500 * 1024 * 1024;

fn to_relative(state: &AppState, abs: &str) -> Result<String, String> {
    asset_path::abs_to_rel(std::path::Path::new(abs), &state.data_dir).ok_or_else(|| {
        format!(
            "内部错误：保存的视频路径 {} 不在数据目录 {} 下",
            abs,
            state.data_dir.display()
        )
    })
}

/// 保存视频（前端 Uint8Array 直传，Tauri 2.x 走 binary IPC）
///
/// 返回**相对 data_dir 的 POSIX 路径**（如 `kb_assets/videos/1/x.mp4`）。
/// 前端拼 `kb-asset://<rel>` 写入 content。
#[tauri::command(async)]
pub fn save_video(
    state: State<'_, AppState>,
    note_id: i64,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() {
        return Err("视频内容为空".into());
    }
    if data.len() > MAX_BYTES {
        return Err(format!(
            "视频体积 {} MB 超过上限 {} MB；请用工具栏的「插入视频」按钮选择文件",
            data.len() / 1024 / 1024,
            MAX_BYTES / 1024 / 1024
        ));
    }
    // v1 不支持加密笔记的视频
    if state
        .db
        .get_note_is_encrypted(note_id)
        .map_err(|e| e.to_string())?
    {
        return Err("加密笔记暂不支持插入视频，请先取消加密".into());
    }

    let abs = VideoService::save_bytes(&state.data_dir, note_id, &file_name, &data)
        .map_err(|e| e.to_string())?;
    to_relative(&state, &abs)
}

/// 从本地文件路径保存视频（用于工具栏文件选择 / 大文件回退路径）
///
/// 后端走 `std::fs::copy` 零拷贝，避免大视频走 IPC
#[tauri::command(async)]
pub fn save_video_from_path(
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
) -> Result<String, String> {
    if state
        .db
        .get_note_is_encrypted(note_id)
        .map_err(|e| e.to_string())?
    {
        return Err("加密笔记暂不支持插入视频，请先取消加密".into());
    }

    let abs = VideoService::save_from_path(&state.data_dir, note_id, &source_path)
        .map_err(|e| e.to_string())?;
    to_relative(&state, &abs)
}

/// 删除笔记的所有视频
#[tauri::command(async)]
pub fn delete_note_videos(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    VideoService::delete_note_videos(&state.data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取视频存储目录（设置页"打开目录"入口用）
#[tauri::command(async)]
pub fn get_videos_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = VideoService::ensure_dir(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
