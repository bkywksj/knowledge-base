//! 收件箱的 IPC 入口（P1-5）。
//!
//! 「重试」不在这里实现 —— 重试的具体动作（重导 PDF / 重新 OCR / 重新剪藏）
//! 各不相同，前端拿到 `detailJson` 后调对应的原有 Command 即可；
//! 成功后再调 [`remove_inbox_item`] 把这条移出收件箱。
//!
//! 这样做的好处是收件箱不需要认识每一种失败类型，加新类型时只改前端。

use tauri::State;

use crate::models::{InboxItem, InboxItemInput};
use crate::state::AppState;

/// 记一条失败项。同源已存在则刷新原因并累加重试次数（不会刷出重复项）。
#[tauri::command]
pub fn add_inbox_item(
    state: State<'_, AppState>,
    input: InboxItemInput,
) -> Result<InboxItem, String> {
    state.db.add_inbox_item(&input).map_err(|e| e.to_string())
}

/// 列出待处理项（最新在前）。`kind` 省略 = 不限类型。
#[tauri::command]
pub fn list_inbox_items(
    state: State<'_, AppState>,
    kind: Option<String>,
) -> Result<Vec<InboxItem>, String> {
    state
        .db
        .list_inbox_items(kind.as_deref())
        .map_err(|e| e.to_string())
}

/// 按类型统计待处理数量（侧栏红点 / 分组筛选用）。
///
/// 返回 `[[kind, count], ...]`，按数量倒序。
#[tauri::command]
pub fn inbox_counts(state: State<'_, AppState>) -> Result<Vec<(String, i64)>, String> {
    state.db.inbox_counts().map_err(|e| e.to_string())
}

/// 移除一条（重试成功 / 用户忽略）
#[tauri::command]
pub fn remove_inbox_item(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    state.db.remove_inbox_item(id).map_err(|e| e.to_string())
}

/// 清空收件箱（可按类型），返回删除条数
#[tauri::command]
pub fn clear_inbox(state: State<'_, AppState>, kind: Option<String>) -> Result<usize, String> {
    state
        .db
        .clear_inbox(kind.as_deref())
        .map_err(|e| e.to_string())
}
