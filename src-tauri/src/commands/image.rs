use tauri::Manager;

use crate::services::image::ImageService;

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
