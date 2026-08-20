//! 笔记历史版本 IPC 入口（普通笔记）。
//!
//! 白板另有一套（`commands::whiteboard` 里的 `*_whiteboard_snapshot*`）——
//! 它的画布内容要额外做图片内联，回滚还要重建 search_text 与画布双链，
//! 与这里的纯文本路径不是一回事，所以刻意不合并。

use crate::models::{Note, NoteSnapshot, NoteSnapshotMeta, SnapshotUsage};
use crate::services::snapshot;
use crate::state::AppState;
use tauri::{Emitter, Manager};

/// 列出笔记的历史版本（不含正文，只有时间 / 体积 / 来源）。
#[tauri::command]
pub fn list_note_snapshots(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<Vec<NoteSnapshotMeta>, String> {
    state.db.list_note_snapshots(note_id).map_err(|e| e.to_string())
}

/// 取某一份历史版本的完整正文（预览 / 对比用）。
#[tauri::command]
pub fn get_note_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot_id: i64,
) -> Result<NoteSnapshot, String> {
    state
        .db
        .get_note_snapshot(snapshot_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("历史版本 {} 不存在", snapshot_id))
}

/// 手动存一个版本。返回 false = 内容与上一份存档相同，没存。
#[tauri::command]
pub fn create_note_snapshot(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<bool, String> {
    snapshot::capture_manual(&state.db, note_id).map_err(|e| e.to_string())
}

/// 把笔记正文回滚到某一份历史版本（回滚前会自动把当前版本另存一份）。
///
/// 与 `update_note` 一样广播 `note:updated`，让别的窗口跟着刷新。
/// 这里**不带** sourceLabel：发起方自己也要重新加载正文，
/// 不能像常规保存那样忽略自己发出的事件。
#[tauri::command]
pub fn restore_note_snapshot(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    note_id: i64,
    snapshot_id: i64,
) -> Result<Note, String> {
    let note =
        snapshot::restore(&state.db, note_id, snapshot_id).map_err(|e| e.to_string())?;
    let _ = window
        .app_handle()
        .emit("note:updated", serde_json::json!({ "id": note_id }));
    Ok(note)
}

// ─── 用量与清理（设置页）──────────────────────────────────

/// 全库历史版本用量（总数 / 总体积 / 占用最大的笔记）。
#[tauri::command]
pub fn get_snapshot_usage(state: tauri::State<'_, AppState>) -> Result<SnapshotUsage, String> {
    snapshot::usage(&state.db).map_err(|e| e.to_string())
}

/// 清理某条笔记的全部历史版本，返回删除条数。
#[tauri::command]
pub fn clear_note_snapshots(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<usize, String> {
    snapshot::clear_note(&state.db, note_id).map_err(|e| e.to_string())
}

/// 清理所有超过指定天数的历史版本，返回删除条数。
#[tauri::command]
pub fn clear_snapshots_older_than(
    state: tauri::State<'_, AppState>,
    days: i64,
) -> Result<usize, String> {
    snapshot::clear_older_than(&state.db, days).map_err(|e| e.to_string())
}

/// 清空全部历史版本，返回删除条数。
#[tauri::command]
pub fn clear_all_snapshots(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    snapshot::clear_all(&state.db).map_err(|e| e.to_string())
}
