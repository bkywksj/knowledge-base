//! 白板相关 IPC 入口。
//!
//! 白板复用了绝大部分笔记命令（重命名 / 移动文件夹 / 删除 / 打标签走既有的
//! `update_note` / `delete_note` …）。这里只放白板独有的两条：
//! 建一块空白板、保存画布。

use crate::models::{EmbeddedWhiteboardSaved, Note};
use crate::services::whiteboard;
use crate::state::AppState;
use tauri::{Emitter, Manager};

/// 新建白板。`title` 传空则用「白板 年-月-日 时:分」作默认名。
#[tauri::command]
pub fn create_whiteboard(
    state: tauri::State<'_, AppState>,
    title: Option<String>,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    whiteboard::create(&state.db, title.as_deref().unwrap_or(""), folder_id)
        .map_err(|e| e.to_string())
}

/// 读取白板画布，图片已从附件内联回 base64（Excalidraw 可直接吃）。
///
/// 前端**不要**直接拿 `note.content` 当场景用 —— 那里面的图片是
/// `kb-asset://` 引用，画布拿到会显示成裂图。
#[tauri::command]
pub fn get_whiteboard_scene(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<String, String> {
    whiteboard::load_scene(&state.db, &state.vault, &state.data_dir, id)
        .map_err(|e| e.to_string())
}

/// 保存**笔记内嵌**的白板画布，返回相对 data_dir 的路径。
///
/// `relPath` 传已有路径 = 覆盖原文件（继续编辑同一块白板）；传 null = 新建。
/// 前端拿返回值拼成 `kb-asset://` 写进 Tiptap 节点属性。
#[tauri::command]
pub fn save_embedded_whiteboard(
    state: tauri::State<'_, AppState>,
    note_id: i64,
    rel_path: Option<String>,
    scene: String,
    preview: String,
) -> Result<EmbeddedWhiteboardSaved, String> {
    whiteboard::save_embedded_scene(
        &state.db,
        &state.vault,
        &state.data_dir,
        note_id,
        rel_path.as_deref(),
        &scene,
        &preview,
    )
    .map_err(|e| e.to_string())
}

/// 读取笔记内嵌白板的画布（图片已内联回 base64）。
#[tauri::command]
pub fn load_embedded_whiteboard(
    state: tauri::State<'_, AppState>,
    rel_path: String,
) -> Result<String, String> {
    whiteboard::load_embedded_scene(&state.vault, &state.data_dir, &rel_path)
        .map_err(|e| e.to_string())
}

/// 保存白板画布。
///
/// 与 `update_note` 一样广播 `note:updated`，让别的窗口（弹出窗 / 笔记列表）跟着刷新；
/// `sourceLabel` 让发起方忽略自己刚发出的这条，避免把用户正在画的画布覆盖回去。
#[tauri::command]
pub fn save_whiteboard_scene(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    id: i64,
    scene: String,
) -> Result<(), String> {
    whiteboard::save_scene(&state.db, &state.vault, &state.data_dir, id, &scene)
        .map_err(|e| e.to_string())?;
    let _ = window.app_handle().emit(
        "note:updated",
        serde_json::json!({
            "id": id,
            "sourceLabel": window.label(),
        }),
    );
    Ok(())
}
