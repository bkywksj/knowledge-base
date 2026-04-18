use crate::models::Folder;
use crate::services::folder::FolderService;
use crate::state::AppState;

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

/// 删除文件夹
#[tauri::command]
pub fn delete_folder(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    FolderService::delete(&state.db, id).map_err(|e| e.to_string())
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
