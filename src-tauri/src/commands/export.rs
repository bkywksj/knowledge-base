use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::AppHandle;

use crate::models::{ExportResult, SingleExportResult};
use crate::services;
use crate::services::export_html::HtmlExportResult;
// Word 导出仅桌面端（docx_rs 移动端编译失败）
#[cfg(desktop)]
use crate::services::export_word::WordExportResult;
use crate::state::AppState;

/// 批量导出笔记为 Markdown 文件
///
/// 入参 `output_dir` 是用户选择的父目录；服务会在其下自动创建一层
/// `知识库导出_YYYYMMDD_HHmmss/` 作为实际导出根（结果中的 `root_dir`）。
#[tauri::command]
pub fn export_notes(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    output_dir: String,
    folder_id: Option<i64>,
) -> Result<ExportResult, String> {
    services::export::ExportService::export_notes(
        &state.db,
        &state.data_dir,
        &output_dir,
        folder_id,
        &app,
    )
    .map_err(|e| e.to_string())
}

/// 导出单篇笔记为 Markdown 文件
///
/// 入参 `parent_dir` 是用户选择的父目录；服务会在其下创建一层
/// `{标题}/` 子目录，里面放 `{标题}.md` 与 `assets/`。
///
/// - `id`: 笔记 ID
/// - `parent_dir`: 用户选择的父目录路径
#[tauri::command]
pub fn export_single_note(
    state: tauri::State<'_, AppState>,
    id: i64,
    parent_dir: String,
) -> Result<SingleExportResult, String> {
    services::export::ExportService::export_single_note(&state.db, &state.data_dir, id, &parent_dir)
        .map_err(|e| e.to_string())
}

/// T-020 导出单条笔记为 Word（.docx）
///
/// `target_path` 是用户在 save dialog 选定的最终 .docx 路径
/// 仅桌面端：docx_rs 移动端编译失败
#[cfg(desktop)]
#[tauri::command]
pub fn export_single_note_to_word(
    state: tauri::State<'_, AppState>,
    id: i64,
    target_path: String,
) -> Result<WordExportResult, String> {
    let note = state
        .db
        .get_note(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", id))?;

    let assets_root = state.data_dir.clone();
    let target = PathBuf::from(&target_path);

    services::export_word::WordExportService::export_single(
        &note.title,
        &note.content,
        &target,
        &assets_root,
    )
    .map_err(|e| e.to_string())
}

/// T-020 导出单条笔记为 HTML（单文件，图片内嵌 base64，可独立分享）
#[tauri::command]
pub fn export_single_note_to_html(
    state: tauri::State<'_, AppState>,
    id: i64,
    target_path: String,
) -> Result<HtmlExportResult, String> {
    let note = state
        .db
        .get_note(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", id))?;

    let assets_root = state.data_dir.clone();
    let target = PathBuf::from(&target_path);

    services::export_html::HtmlExportService::export_single(
        &note.title,
        &note.content,
        &target,
        &assets_root,
    )
    .map_err(|e| e.to_string())
}

/// 将前端生成的 base64 PNG 数据写入用户在 save dialog 选定的路径。
///
/// 用于"导出表格为图片"等"前端渲染→落盘到任意路径"的场景：前端
/// 用 html-to-image / canvas 生成 data URL，把 base64 部分通过本命令
/// 写到用户挑的位置，避开 WebView 默认下载行为不可控的问题。
///
/// `base64_data` 可以是带前缀的 data URL（`data:image/png;base64,...`），
/// 也可以是纯 base64 字符串。
#[tauri::command]
pub fn export_png_to_file(target_path: String, base64_data: String) -> Result<(), String> {
    let b64 = base64_data
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(&base64_data);
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    std::fs::write(&target_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// R-005 渲染笔记为 HTML 字符串供前端 iframe 打印为 PDF。
///
/// 不写文件，前端拿到字符串后塞 hidden iframe → contentWindow.print() →
/// 用户在原生打印对话框选 "Microsoft Print to PDF" / "另存为 PDF"。
///
/// 返回的 HTML 与 export_single_note_to_html 一致：图片内嵌 base64，
/// 自包含可独立打印，无需额外资源加载。
#[tauri::command]
pub fn render_note_html_for_pdf(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<String, String> {
    let note = state
        .db
        .get_note(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", id))?;

    let assets_root = state.data_dir.clone();

    let (html, _inlined, _missing) =
        services::export_html::HtmlExportService::render_html(
            &note.title,
            &note.content,
            &assets_root,
        )
        .map_err(|e| e.to_string())?;

    Ok(html)
}
