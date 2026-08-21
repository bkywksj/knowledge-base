use tauri::State;

use crate::services::asset_path;
use crate::services::pdf::{PdfImportResult, PdfService};
use crate::state::AppState;

/// 批量导入 PDF 为笔记
///
/// - 每个文件独立抽取文本、创建笔记、拷贝原文件
/// - 单个失败不影响其他，错误信息回填到 `error` 字段
/// - `enable_ocr`（缺省 false）：扫描件（无文字层）时用本地 OCR 逐页识别兜底。
///   OCR 较慢（逐页渲染 + 子进程推理）；async command 在 worker 线程执行，不冻结主线程 UI。
/// - 每开始处理一个文件会发一条 `pdf:import-progress`，前端右下角悬浮条据此显示 x/N
#[tauri::command]
pub async fn import_pdfs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    folder_id: Option<i64>,
    enable_ocr: Option<bool>,
) -> Result<Vec<PdfImportResult>, String> {
    Ok(PdfService::import_many(
        &state.data_dir,
        &state.db,
        &paths,
        folder_id,
        enable_ocr.unwrap_or(false),
        &app,
    ))
}

/// 获取笔记对应 PDF 的**相对 data_dir 的 POSIX 路径**（迁移前叫 get_pdf_absolute_path）。
///
/// 返回值前端拼 `kb-asset://<rel>` 喂给 iframe / 渲染层。
/// 历史命名保留 `absolute` 字样仅为兼容 IPC 调用方，含义已变。
#[tauri::command]
pub fn get_pdf_absolute_path(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Option<String>, String> {
    let note = state
        .db
        .get_note(note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", note_id))?;

    let Some(rel_legacy) = note.source_file_path else {
        return Ok(None);
    };

    // DB 里 source_file_path 已经是相对路径（可能 Windows 风格反斜杠）。
    // 先 join 还原绝对路径再 abs_to_rel 一次，确保最终输出 POSIX 风格。
    let abs = match PdfService::resolve_pdf_absolute_path(&state.data_dir, &rel_legacy) {
        Some(p) => p,
        None => return Ok(None),
    };
    Ok(asset_path::abs_to_rel(&abs, &state.data_dir))
}
