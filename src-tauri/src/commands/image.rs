use tauri::{Manager, State};

use crate::models::{OrphanImageClean, OrphanImageScan};
use crate::services::image::ImageService;
use crate::state::AppState;

/// 保存图片（base64 数据，用于粘贴/拖放）
///
/// 返回保存后的绝对路径
#[tauri::command]
pub fn save_note_image(
    app: tauri::AppHandle,
    note_id: i64,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    ImageService::save_from_base64(&data_dir, note_id, &file_name, &base64_data)
        .map_err(|e| e.to_string())
}

/// 从本地文件路径保存图片（用于工具栏文件选择）
///
/// 返回保存后的绝对路径
#[tauri::command]
pub fn save_note_image_from_path(
    app: tauri::AppHandle,
    note_id: i64,
    source_path: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    ImageService::save_from_path(&data_dir, note_id, &source_path)
        .map_err(|e| e.to_string())
}

/// 删除笔记的所有图片
#[tauri::command]
pub fn delete_note_images(app: tauri::AppHandle, note_id: i64) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    ImageService::delete_note_images(&data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取图片存储目录路径
#[tauri::command]
pub fn get_images_dir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let images_dir = ImageService::ensure_dir(&data_dir).map_err(|e| e.to_string())?;
    Ok(images_dir.to_string_lossy().into_owned())
}

/// 扫描孤儿图片（只读，不删除）
#[tauri::command]
pub fn scan_orphan_images(
    state: State<'_, AppState>,
) -> Result<OrphanImageScan, String> {
    ImageService::scan_orphans(&state.db, &state.data_dir).map_err(|e| e.to_string())
}

/// 删除指定的孤儿图片（路径列表来自 scan 结果）
#[tauri::command]
pub fn clean_orphan_images(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<OrphanImageClean, String> {
    ImageService::clean_orphans(&state.data_dir, &paths).map_err(|e| e.to_string())
}
