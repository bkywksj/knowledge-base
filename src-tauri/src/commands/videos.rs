//! 视频 Command（薄包装 → VideoService）
//!
//! 设计要点：
//! - `save_video` 接收 `Vec<u8>` 而非 base64 字符串：前端用 `Uint8Array` 调 invoke，
//!   Tauri 2.x 走 binary IPC 通道，比 base64 省 33% 体积 + 零编解码
//! - `save_video_from_path` 走 `std::fs::copy` 零拷贝，给"工具栏插入视频"
//!   或前端"大文件超限退化为文件选择器"的兜底场景
//! - v1 不支持加密笔记的视频 —— 加密笔记调用直接返回错误，由前端引导用户取消加密

use tauri::State;

use crate::services::video::VideoService;
use crate::state::AppState;

/// 后端硬性上限：单文件 500MB。前端会按更小阈值（粘贴 50MB / 拖入 100MB）提前拦截，
/// 这里只兜底防止异常调用 OOM。
const MAX_BYTES: usize = 500 * 1024 * 1024;

/// 保存视频（前端 Uint8Array 直传，Tauri 2.x 走 binary IPC）
///
/// 返回保存后的绝对路径，前端拼 `convertFileSrc` 喂给 `<video src=...>`
#[tauri::command]
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

    VideoService::save_bytes(&state.data_dir, note_id, &file_name, &data)
        .map_err(|e| e.to_string())
}

/// 从本地文件路径保存视频（用于工具栏文件选择 / 大文件回退路径）
///
/// 后端走 `std::fs::copy` 零拷贝，避免大视频走 IPC
#[tauri::command]
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

    VideoService::save_from_path(&state.data_dir, note_id, &source_path)
        .map_err(|e| e.to_string())
}

/// 删除笔记的所有视频
#[tauri::command]
pub fn delete_note_videos(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    VideoService::delete_note_videos(&state.data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取视频存储目录（设置页"打开目录"入口用）
#[tauri::command]
pub fn get_videos_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = VideoService::ensure_dir(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
