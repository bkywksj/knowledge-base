//! 附件相关 Command（薄包装 → AttachmentService）
//!
//! 与 commands/image.rs 对称设计。前端拖放非图片/非文本文件时调用。
//!
//! ## 路径约定（重要）
//! `AttachmentInfo.path` 返回**相对 `state.data_dir` 的 POSIX 路径**
//! （例如 `kb_assets/attachments/1/x.pdf`）。前端拼 `kb-asset://<path>` 写入 content；
//! 需要用 OS 程序打开时调 `resolve_asset_absolute_path` 还原成绝对路径再调 opener。

use tauri::State;

use crate::error::AppError;
use crate::models::{AttachmentInfo, TextPreviewData};
// Excel 预览类型 + 解析器仅桌面端：calamine 在 Android target 编译失败（见 services/mod.rs）
#[cfg(desktop)]
use crate::models::{ExcelPreviewData, ExcelSheetData};
use crate::services::asset_path;
use crate::services::attachment::AttachmentService;
#[cfg(desktop)]
use crate::services::excel_parser;
use crate::state::AppState;

/// 文本预览最大字符数（前端 Modal 一次性渲染再多就卡）。30k ≈ 普通笔记 / 中等代码文件
const TEXT_PREVIEW_MAX_CHARS: usize = 30_000;

/// 把 Service 返回的 AttachmentInfo.path 由绝对路径改写成相对 POSIX 路径。
fn rewrite_to_relative(state: &AppState, info: AttachmentInfo) -> Result<AttachmentInfo, String> {
    let rel = asset_path::abs_to_rel(std::path::Path::new(&info.path), &state.data_dir)
        .ok_or_else(|| {
            format!(
                "内部错误：保存的附件路径 {} 不在数据目录 {} 下",
                info.path,
                state.data_dir.display()
            )
        })?;
    Ok(AttachmentInfo { path: rel, ..info })
}

/// 保存附件（base64 数据，用于前端拖放）
///
/// 返回附件信息，`path` 为相对 data_dir 的 POSIX 路径。
#[tauri::command]
pub fn save_note_attachment(
    state: State<'_, AppState>,
    note_id: i64,
    file_name: String,
    base64_data: String,
) -> Result<AttachmentInfo, String> {
    let info =
        AttachmentService::save_from_base64(&state.data_dir, note_id, &file_name, &base64_data)
            .map_err(|e| e.to_string())?;
    rewrite_to_relative(&state, info)
}

/// 从本地文件路径零拷贝保存附件（用于工具栏"插入附件"按钮）
#[tauri::command]
pub fn save_note_attachment_from_path(
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
) -> Result<AttachmentInfo, String> {
    let info = AttachmentService::save_from_path(&state.data_dir, note_id, &source_path)
        .map_err(|e| e.to_string())?;
    rewrite_to_relative(&state, info)
}

/// 删除笔记的所有附件
#[tauri::command]
pub fn delete_note_attachments(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    AttachmentService::delete_note_attachments(&state.data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取附件存储目录路径（设置页"打开目录"入口用）
#[tauri::command]
pub fn get_attachments_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = AttachmentService::ensure_dir(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 把 kb-asset:// 里的相对路径还原成绝对路径（共用安全检查 + 存在性校验）
fn resolve_attachment_path(state: &AppState, rel: &str) -> Result<std::path::PathBuf, AppError> {
    let abs = asset_path::rel_to_abs(rel, &state.data_dir)
        .map_err(|e| AppError::Custom(format!("路径解析失败: {}", e)))?;
    if !abs.exists() {
        return Err(AppError::Custom(format!(
            "附件不存在或已被移动: {}",
            abs.display()
        )));
    }
    Ok(abs)
}

/// 把 Excel/ODS 附件解析为前端可直接渲染的结构化数据。
///
/// 内部复用 `excel_parser::read_workbook`，只把 markdown 字段丢掉、保留结构。
/// 输入是**相对 data_dir 的 POSIX 路径**（笔记 content 里 kb-asset:// 后那段）。
///
/// 仅桌面端：依赖 calamine（Android target 编译失败）。移动端不注册此 command。
#[cfg(desktop)]
#[tauri::command]
pub fn preview_excel_attachment(
    state: State<'_, AppState>,
    rel: String,
) -> Result<ExcelPreviewData, String> {
    let abs = resolve_attachment_path(&state, &rel).map_err(|e| e.to_string())?;
    let summary = excel_parser::read_workbook(&abs.to_string_lossy()).map_err(|e| e.to_string())?;
    let sheets = summary
        .sheets
        .into_iter()
        .map(|s| ExcelSheetData {
            name: s.name,
            headers: s.headers,
            rows: s.rows,
            total_rows: s.total_rows,
            truncated_rows: s.truncated_rows,
        })
        .collect();
    Ok(ExcelPreviewData {
        sheets,
        total_rows: summary.total_rows,
    })
}

/// 读取文本文件做预览（md/txt/json/csv/代码等）。
///
/// 超过 TEXT_PREVIEW_MAX_CHARS 时尾部截断并标记 truncated=true，避免 Modal 内一次渲染巨型字符串卡死。
#[tauri::command]
pub fn preview_text_attachment(
    state: State<'_, AppState>,
    rel: String,
) -> Result<TextPreviewData, String> {
    let abs = resolve_attachment_path(&state, &rel).map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(&abs).map_err(|e| friendly_read_error(&abs, &e))?;
    let total_lines = raw.lines().count();
    let char_count = raw.chars().count();
    if char_count <= TEXT_PREVIEW_MAX_CHARS {
        return Ok(TextPreviewData {
            content: raw,
            total_lines,
            truncated: false,
        });
    }
    // 字符级截断（按 char 不按 byte，避免劈到 UTF-8 字符中间）
    let mut truncated_content: String = raw.chars().take(TEXT_PREVIEW_MAX_CHARS).collect();
    truncated_content.push_str("\n\n... [文件过大，已截断显示] ...");
    Ok(TextPreviewData {
        content: truncated_content,
        total_lines,
        truncated: true,
    })
}

/// 把 `read_to_string` 的底层错误翻译成用户能看懂的话。
///
/// 二进制文件（PDF / 图片 / 压缩包…）走到这里时，std 只会甩一句
/// "stream did not contain valid UTF-8" —— 用户完全不知道发生了什么。
/// 前端已按扩展名白名单拦了一道（见 attachmentPreview.ts 的 TEXT_ATTACHMENT_EXTS），
/// 这里是最后兜底。
fn friendly_read_error(abs: &std::path::Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::InvalidData {
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| abs.display().to_string());
        return format!(
            "「{name}」不是纯文本文件（可能是 PDF / 图片 / 压缩包等二进制格式），无法按文本预览。请用系统应用打开。"
        );
    }
    format!("读取文件失败 {}: {}", abs.display(), e)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户实际踩到的场景：改过名的 PDF 落到文本预览分支，
    /// 报一句 "stream did not contain valid UTF-8"，没人看得懂。
    #[test]
    fn binary_file_gets_human_readable_message() {
        let err = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        );
        let msg = friendly_read_error(std::path::Path::new("C:/kb/关于某某的通知.pdf"), &err);

        assert!(msg.contains("关于某某的通知.pdf"), "要点名是哪个文件: {msg}");
        assert!(msg.contains("不是纯文本文件"), "要说人话: {msg}");
        assert!(msg.contains("系统应用"), "要给出下一步动作: {msg}");
        assert!(
            !msg.contains("UTF-8"),
            "不该把底层编码错误甩给用户: {msg}"
        );
    }

    /// 其它 IO 错误（文件不存在 / 没权限）保持原样 —— 那些信息对排查有用
    #[test]
    fn other_io_errors_keep_original_detail() {
        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let msg = friendly_read_error(std::path::Path::new("C:/kb/a.txt"), &err);
        assert!(msg.contains("读取文件失败"), "{msg}");
        assert!(msg.contains("file not found"), "应保留底层原因: {msg}");
    }

    /// 真·二进制文件端到端：写一个非 UTF-8 的 PDF 头，确认 read_to_string
    /// 确实返回 InvalidData，且我们的翻译能接住
    #[test]
    fn real_binary_pdf_triggers_invalid_data() {
        let dir = std::env::temp_dir().join("kb_attachment_preview_test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("probe.pdf");
        // 0xFF 0xFE 不是合法 UTF-8 起始字节
        std::fs::write(&path, b"%PDF-1.4\n\xff\xfe\x80\x81 binary\n%%EOF").unwrap();

        let err = std::fs::read_to_string(&path).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);

        let msg = friendly_read_error(&path, &err);
        assert!(msg.contains("probe.pdf"), "{msg}");
        assert!(msg.contains("不是纯文本文件"), "{msg}");

        let _ = std::fs::remove_file(&path);
    }
}
