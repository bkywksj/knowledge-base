use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;

use crate::services::converter::{self, ConverterDiagnostic, DocConverter};
use crate::services::source_file::SourceFileService;
use crate::state::AppState;

/// 探测当前系统可用的 .doc 转换器
#[tauri::command(async)]
pub fn get_converter_status() -> DocConverter {
    converter::detect_converter()
}

/// 详细诊断：列出每个 Word ProgId 的实测结果（含 PowerShell 错误细节）
///
/// 用于"导入 .doc 失败"时帮用户定位缺哪个 ProgId / 哪个版本的 WPS-Office
#[tauri::command(async)]
pub fn diagnose_doc_converter() -> ConverterDiagnostic {
    converter::diagnose()
}

/// 把任意路径的文件读成 base64（前端跑 mammoth 时用）
///
/// 路径来源是 dialog.open 返回值（用户已确认）
#[tauri::command(async)]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

/// 把 .doc 转换为 .docx，并以 base64 字符串返回 .docx 字节流
///
/// 临时 .docx 在临时目录，转换完读取后立即删除
#[tauri::command(async)]
pub fn convert_doc_to_docx_base64(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let temp_dir = std::env::temp_dir().join("kb_doc_convert");
    let docx_path = converter::convert_doc_to_docx(&src, &temp_dir).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&docx_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&docx_path);
    Ok(STANDARD.encode(bytes))
}

/// 把源文件附到笔记上：拷贝原文件 + 更新 source_file_path/type
///
/// 用于 Word 导入：前端先建笔记拿到 note_id，再调用本接口把原文件挂上
#[tauri::command(async)]
pub fn attach_source_file(
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
    file_type: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    let rel = SourceFileService::attach(&state.data_dir, note_id, &src, &file_type)
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_note_source_file(note_id, Some(&rel), Some(&file_type))
        .map_err(|e| e.to_string())?;
    Ok(rel)
}

/// 获取笔记关联源文件的绝对路径（pdf/docx/doc 通用）
///
/// 这个 Command 的返回值仅用于 PDF iframe 预览 / opener 打开（**不写入笔记 content**），
/// 所以保留输出绝对路径，前端 `convertFileSrc` 直接喂给 iframe 即可；笔记 content 里
/// 的 PDF 引用走另一套 kb-asset:// + Step 4 数据迁移。
///
/// 老的 `get_pdf_absolute_path` 仍保留作 PDF 专用别名（已迁到相对路径）
#[tauri::command(async)]
pub fn get_source_file_absolute_path(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Option<String>, String> {
    let note = state
        .db
        .get_note(note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", note_id))?;
    let Some(rel) = note.source_file_path else {
        return Ok(None);
    };
    Ok(SourceFileService::resolve_absolute(&state.data_dir, &rel)
        .map(|p| p.to_string_lossy().into_owned()))
}
