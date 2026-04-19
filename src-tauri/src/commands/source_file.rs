use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{Manager, State};

use crate::services::converter::{self, DocConverter};
use crate::services::source_file::SourceFileService;
use crate::state::AppState;

/// 探测当前系统可用的 .doc 转换器
#[tauri::command]
pub fn get_converter_status() -> DocConverter {
    converter::detect_converter()
}

/// 把任意路径的文件读成 base64（前端跑 mammoth 时用）
///
/// 路径来源是 dialog.open 返回值（用户已确认）
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

/// 把 .doc 转换为 .docx，并以 base64 字符串返回 .docx 字节流
///
/// 临时 .docx 在临时目录，转换完读取后立即删除
#[tauri::command]
pub fn convert_doc_to_docx_base64(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let temp_dir = std::env::temp_dir().join("kb_doc_convert");
    let docx_path = converter::convert_doc_to_docx(&src, &temp_dir)
        .map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&docx_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&docx_path);
    Ok(STANDARD.encode(bytes))
}

/// 把源文件附到笔记上：拷贝原文件 + 更新 source_file_path/type
///
/// 用于 Word 导入：前端先建笔记拿到 note_id，再调用本接口把原文件挂上
#[tauri::command]
pub fn attach_source_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
    file_type: String,
) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = PathBuf::from(&source_path);
    let rel = SourceFileService::attach(&data_dir, note_id, &src, &file_type)
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_note_source_file(note_id, Some(&rel), Some(&file_type))
        .map_err(|e| e.to_string())?;
    Ok(rel)
}

/// 获取笔记关联源文件的绝对路径（pdf/docx/doc 通用）
///
/// 老的 `get_pdf_absolute_path` 仍保留作 PDF 专用别名
#[tauri::command]
pub fn get_source_file_absolute_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let note = state
        .db
        .get_note(note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", note_id))?;
    let Some(rel) = note.source_file_path else {
        return Ok(None);
    };
    Ok(SourceFileService::resolve_absolute(&data_dir, &rel)
        .map(|p| p.to_string_lossy().into_owned()))
}
