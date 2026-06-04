use serde::Serialize;

use crate::models::Folder;
use crate::services::folder::FolderService;
use crate::state::AppState;

/// 文件夹子树统计（级联删除确认弹窗用）
#[derive(Debug, Serialize)]
pub struct FolderSubtreeStats {
    /// 子孙文件夹数（不含被删文件夹自身）
    pub folders: i64,
    /// 子树内未回收的笔记数（含隐藏 / 加密）
    pub notes: i64,
}

/// 级联删除结果
#[derive(Debug, Serialize)]
pub struct FolderCascadeResult {
    /// 软删进回收站的笔记数
    pub notes_trashed: usize,
    /// 物理删除的文件夹数
    pub folders_deleted: usize,
}

/// 创建文件夹
#[tauri::command]
pub fn create_folder(
    state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<i64>,
) -> Result<Folder, String> {
    FolderService::create(&state.db, &name, parent_id).map_err(|e| e.to_string())
}

/// 重命名文件夹
#[tauri::command]
pub fn rename_folder(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    FolderService::rename(&state.db, id, &name).map_err(|e| e.to_string())
}

/// 删除文件夹（安全模式：非空则拒绝，提示用户先清空）
#[tauri::command]
pub fn delete_folder(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    FolderService::delete(&state.db, id).map_err(|e| e.to_string())
}

/// 查询文件夹子树统计（级联删除前给确认弹窗展示"将删 N 个子文件夹、M 篇笔记"）
#[tauri::command]
pub fn folder_subtree_stats(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<FolderSubtreeStats, String> {
    let (folders, notes) = FolderService::subtree_stats(&state.db, id).map_err(|e| e.to_string())?;
    Ok(FolderSubtreeStats { folders, notes })
}

/// 级联删除文件夹：子树笔记移入回收站（可恢复）+ 删除子树文件夹。
/// 用户在确认弹窗明确同意后调用。
#[tauri::command]
pub fn delete_folder_cascade(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<FolderCascadeResult, String> {
    let (notes_trashed, folders_deleted) =
        FolderService::delete_cascade(&state.db, id).map_err(|e| e.to_string())?;
    Ok(FolderCascadeResult {
        notes_trashed,
        folders_deleted,
    })
}

/// 获取文件夹树
#[tauri::command]
pub fn list_folders(state: tauri::State<'_, AppState>) -> Result<Vec<Folder>, String> {
    FolderService::list_tree(&state.db).map_err(|e| e.to_string())
}

/// 移动文件夹（拖拽改变父节点）
#[tauri::command]
pub fn move_folder(
    state: tauri::State<'_, AppState>,
    id: i64,
    new_parent_id: Option<i64>,
) -> Result<(), String> {
    FolderService::move_to(&state.db, id, new_parent_id).map_err(|e| e.to_string())
}

/// 批量重排同级文件夹顺序（前端拖拽后传入排好序的 ID 列表）
#[tauri::command]
pub fn reorder_folders(
    state: tauri::State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    FolderService::reorder(&state.db, &ordered_ids).map_err(|e| e.to_string())
}

/// 设置文件夹颜色
///
/// `color` 传 `null` 或空串 = 清除（恢复默认主题色）。
#[tauri::command]
pub fn set_folder_color(
    state: tauri::State<'_, AppState>,
    id: i64,
    color: Option<String>,
) -> Result<(), String> {
    FolderService::set_color(&state.db, id, color.as_deref()).map_err(|e| e.to_string())
}

/// T-006: 按路径字符串（如 "工作/周报"）确保文件夹存在；不存在则递归创建
///
/// - 空串 / 纯空白 → 返回 null（根目录）
/// - 返回最深一级文件夹的 id
#[tauri::command]
pub fn ensure_folder_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Option<i64>, String> {
    FolderService::ensure_path(&state.db, &path).map_err(|e| e.to_string())
}
