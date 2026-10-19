//! 孤儿素材统一清理 Command（薄包装 → OrphanScanService）
//!
//! 替代旧的 `scan_orphan_images` / `clean_orphan_images`：
//! - 一次扫描覆盖 5 类素材：images / videos / attachments / pdfs / sources
//! - 修复旧实现的两个 BUG：
//!   1. trash 笔记 content 没扫 → 撤回笔记后图片消失
//!   2. 加密笔记 content 是密文 → 加密笔记图片被全部判为孤儿

use tauri::State;

use crate::models::{OrphanAssetClean, OrphanAssetScan, OrphanItem};
use crate::services::orphan_scan::OrphanScanService;
use crate::state::AppState;

/// 扫描全部孤儿素材（5 类）
#[tauri::command(async)]
pub fn scan_orphan_assets(state: State<'_, AppState>) -> Result<OrphanAssetScan, String> {
    OrphanScanService::scan_all(&state.db, &state.data_dir).map_err(|e| e.to_string())
}

/// 批量清理孤儿素材（按 OrphanItem 列表删除）
///
/// 安全：每条 path 必须落在对应 kind 的 assets 子目录下，否则计入 failed。
#[tauri::command(async)]
pub fn clean_orphan_assets(
    state: State<'_, AppState>,
    items: Vec<OrphanItem>,
) -> Result<OrphanAssetClean, String> {
    OrphanScanService::clean(&state.data_dir, &items).map_err(|e| e.to_string())
}
