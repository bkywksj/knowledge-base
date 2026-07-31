use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::AppHandle;

use crate::models::{ExportResult, SingleExportResult};
use crate::services;
use crate::services::export_html::{ExportFonts, HtmlExportResult};
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
/// 入参 `parent_dir` 是用户选择的父目录。
/// - `single_file = false`/缺省：在其下建一层 `{标题}/` 子目录，放 `{标题}.md` + `assets/`。
/// - `single_file = true`：不建目录，图片/附件 base64 内嵌，直接在 `parent_dir` 下写单个 `{标题}.md`。
///
/// - `id`: 笔记 ID
/// - `parent_dir`: 用户选择的父目录路径
/// - `single_file`: 是否导出为单文件（不生成文件夹），缺省 false 保持原行为
#[tauri::command]
pub fn export_single_note(
    state: tauri::State<'_, AppState>,
    id: i64,
    parent_dir: String,
    single_file: Option<bool>,
) -> Result<SingleExportResult, String> {
    services::export::ExportService::export_single_note(
        &state.db,
        &state.data_dir,
        id,
        &parent_dir,
        single_file.unwrap_or(false),
    )
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
    // 前端编辑器实时 DOM（已内嵌资源）。给了就用它，能带上只活在渲染层的
    // 标题自动编号；不给则退回 markdown 重渲（批量导出等场景）。
    body_html: Option<String>,
    // 用户设置里的正文 / 标题字体；只在转换器路径生效（见 service 注释）
    fonts: Option<ExportFonts>,
) -> Result<WordExportResult, String> {
    let note = state
        .db
        .get_note(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", id))?;

    let assets_root = state.data_dir.clone();
    let target = PathBuf::from(&target_path);

    services::export_word::WordExportService::export_single_best_effort(
        &note.title,
        &note.content,
        &target,
        &assets_root,
        body_html.as_deref(),
        fonts.as_ref(),
    )
    .map_err(|e| e.to_string())
}

/// T-020 导出单条笔记为 HTML（单文件，图片内嵌 base64，可独立分享）
#[tauri::command]
pub fn export_single_note_to_html(
    state: tauri::State<'_, AppState>,
    id: i64,
    target_path: String,
    // 同 export_single_note_to_word：前端 DOM 优先，缺省退回 markdown 重渲
    body_html: Option<String>,
    // 用户设置里的正文 / 标题字体；缺省则用模板自带的通用中文字体链
    fonts: Option<ExportFonts>,
) -> Result<HtmlExportResult, String> {
    let note = state
        .db
        .get_note(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", id))?;

    let assets_root = state.data_dir.clone();
    let target = PathBuf::from(&target_path);

    match body_html.as_deref() {
        Some(body) => services::export_html::HtmlExportService::export_single_from_html(
            &note.title,
            body,
            &target,
            &assets_root,
            fonts.as_ref(),
        ),
        None => services::export_html::HtmlExportService::export_single(
            &note.title,
            &note.content,
            &target,
            &assets_root,
            fonts.as_ref(),
        ),
    }
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
    // 用户设置里的正文 / 标题字体；缺省则用模板自带的通用中文字体链
    fonts: Option<ExportFonts>,
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
            fonts.as_ref(),
        )
        .map_err(|e| e.to_string())?;

    Ok(html)
}

/// R-005b 「所见即所得」打印支撑：把前端传来的**编辑器实时 DOM** HTML 里的本地图片 /
/// 附件链接 inline 成 base64。
///
/// 与 `render_note_html_for_pdf` 的区别：那条从 markdown 经 pulldown-cmark **重新渲染**，
/// 套的是另一套极简 CSS 模板，导出后样式跟编辑器里看到的不一样；本条不碰结构 / 样式，
/// 直接接收编辑器**已渲染**的真实 DOM HTML，只做资源内嵌，让前端「打印 = 屏幕所见」。
/// 前端负责克隆 DOM、注入应用同一份 CSS、触发系统打印对话框。
#[tauri::command]
pub fn inline_note_html_assets(
    state: tauri::State<'_, AppState>,
    html: String,
) -> Result<String, String> {
    let assets_root = state.data_dir.clone();
    let (html, _img, _att) =
        services::export_html::HtmlExportService::inline_assets(&html, &assets_root);
    Ok(html)
}
