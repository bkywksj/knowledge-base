use tauri::{Manager, State};

use crate::services::pdf::{PdfImportResult, PdfService};
use crate::state::AppState;

/// 批量导入 PDF 为笔记
///
/// - 每个文件独立抽取文本、创建笔记、拷贝原文件
/// - 单个失败不影响其他，错误信息回填到 `error` 字段
#[tauri::command]
pub fn import_pdfs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    folder_id: Option<i64>,
) -> Result<Vec<PdfImportResult>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    Ok(PdfService::import_many(&data_dir, &state.db, &paths, folder_id))
}

/// 获取笔记对应 PDF 的绝对路径
///
/// 前端 `convertFileSrc()` 转成 asset: 协议可直接在 iframe 里预览
#[tauri::command]
pub fn get_pdf_absolute_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Option<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let note = state
        .db
        .get_note(note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", note_id))?;

    let Some(rel) = note.source_file_path else {
        return Ok(None);
    };

    Ok(PdfService::resolve_pdf_absolute_path(&data_dir, &rel)
        .map(|p| p.to_string_lossy().into_owned()))
}
