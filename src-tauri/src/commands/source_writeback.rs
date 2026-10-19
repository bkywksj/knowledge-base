use crate::services::source_writeback::{WriteBackResult, WriteBackService};
use crate::state::AppState;

/// 手动触发把笔记写回原 .md 文件
///
/// - 默认 `force=false`：检测到外部 mtime 变化会返回 `WriteBackResult::Conflict`，
///   前端据此弹冲突 Modal。
/// - `force=true`：强制覆盖，配合冲突 Modal 中"覆盖外部"按钮使用。
///
/// 笔记在保存时（`update_note`）会自动调用一次（force=false），所以前端通常只在
/// 冲突解决时才主动调用 `force=true`，或在设置页提供"立即同步"按钮。
#[tauri::command(async)]
pub fn write_back_source_md(
    state: tauri::State<'_, AppState>,
    note_id: i64,
    force: bool,
) -> Result<WriteBackResult, String> {
    WriteBackService::write_back(&state.db, note_id, force).map_err(|e| e.to_string())
}

/// 解除笔记与外部 .md 的双向同步关联
///
/// 触发场景：原文件已丢失（writeback 返回 Missing），或用户在 UI 上主动点"解除关联"。
/// 调用后该笔记降级为纯本地笔记，保存不再写回磁盘，也不再弹"双向同步暂时中断"提示。
#[tauri::command(async)]
pub fn clear_source_md_link(
    state: tauri::State<'_, AppState>,
    note_id: i64,
) -> Result<(), String> {
    WriteBackService::clear_link(&state.db, note_id).map_err(|e| e.to_string())
}
