//! 白板相关 IPC 入口。
//!
//! 白板复用了绝大部分笔记命令（重命名 / 移动文件夹 / 删除 / 打标签走既有的
//! `update_note` / `delete_note` …）。这里只放白板独有的两条：
//! 建一块空白板、保存画布。

use crate::models::{EmbeddedWhiteboardSaved, Note, NoteSnapshotMeta};
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

// ─── 历史版本 ────────────────────────────────────────────────

/// 列出白板的历史版本（不含画布正文，只有时间 / 体积 / 来源）。
#[tauri::command]
pub fn list_whiteboard_snapshots(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<Vec<NoteSnapshotMeta>, String> {
    whiteboard::list_snapshots(&state.db, note_id).map_err(|e| e.to_string())
}

/// 取某一份历史版本的画布内容（图片已内联，可直接渲染预览）。
#[tauri::command]
pub fn get_whiteboard_snapshot_scene(
    state: tauri::State<'_, AppState>,
    snapshot_id: i64,
) -> Result<String, String> {
    whiteboard::snapshot_scene(&state.db, &state.vault, &state.data_dir, snapshot_id)
        .map_err(|e| e.to_string())
}

/// 手动存一个版本。返回 false = 内容与上一份存档相同，没存。
#[tauri::command]
pub fn create_whiteboard_snapshot(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<bool, String> {
    whiteboard::create_snapshot(&state.db, note_id).map_err(|e| e.to_string())
}

/// 把白板回滚到某一份历史版本（回滚前会自动把当前版本另存一份）。
///
/// 与 `save_whiteboard_scene` 一样广播 `note:updated` —— 回滚改的是笔记内容，
/// 别的窗口（笔记列表 / 弹出窗）得跟着刷新。这里**不带** sourceLabel：
/// 发起方自己也需要重新加载画布，不能像常规保存那样忽略自己发出的事件。
#[tauri::command]
pub fn restore_whiteboard_snapshot(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    note_id: i64,
    snapshot_id: i64,
) -> Result<(), String> {
    whiteboard::restore_snapshot(
        &state.db,
        &state.vault,
        &state.data_dir,
        note_id,
        snapshot_id,
    )
    .map_err(|e| e.to_string())?;
    let _ = window
        .app_handle()
        .emit("note:updated", serde_json::json!({ "id": note_id }));
    Ok(())
}

// ─── 素材库 ──────────────────────────────────────────────────

/// 读用户的白板素材库（`.excalidrawlib` 原文）。没存过返回空串。
#[tauri::command]
pub fn get_whiteboard_library(state: tauri::State<'_, AppState>) -> Result<String, String> {
    whiteboard::load_library(&state.data_dir).map_err(|e| e.to_string())
}

/// 覆盖写素材库。前端在用户增删素材时（防抖后）调用。
#[tauri::command]
pub fn save_whiteboard_library(
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    whiteboard::save_library(&state.data_dir, &content).map_err(|e| e.to_string())
}

// ─── 笔记卡片 ────────────────────────────────────────────────

/// 批量取笔记摘要，供白板上的「笔记卡片」显示。
///
/// 每次打开白板都会调一次：卡片显示的是笔记**当前**内容，而不是插入那一刻的快照。
#[tauri::command]
pub fn get_note_excerpts(
    state: tauri::State<'_, AppState>,
    note_ids: Vec<i64>,
) -> Result<Vec<crate::models::NoteExcerpt>, String> {
    crate::services::note_excerpt::for_notes(&state.db, &note_ids).map_err(|e| e.to_string())
}
