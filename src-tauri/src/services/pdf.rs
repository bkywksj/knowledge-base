use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, NoteInput};

/// PDF 资产目录名（dev 模式加 dev- 前缀实现数据隔离）
const PDFS_DIR_PROD: &str = "pdfs";
const PDFS_DIR_DEV: &str = "dev-pdfs";

#[inline]
fn pdfs_dir_name() -> &'static str {
    if cfg!(debug_assertions) { PDFS_DIR_DEV } else { PDFS_DIR_PROD }
}

/// 单个 PDF 导入结果，供前端展示进度/错误清单
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImportResult {
    pub source_path: String,
    /// 成功：对应的笔记 id；失败：None
    pub note_id: Option<i64>,
    /// 成功：笔记标题；失败：None
    pub title: Option<String>,
    /// 失败时的错误消息
    pub error: Option<String>,
}

pub struct PdfService;

impl PdfService {
    /// 获取 PDF 根目录: {app_data_dir}/{prefix}pdfs/
    pub fn pdfs_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(pdfs_dir_name())
    }

    /// 确保 PDF 目录存在
    pub fn ensure_dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::pdfs_dir(app_data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 把一个 PDF 文件导入为笔记：抽取文本 → 创建笔记 → 拷贝原文件 → 更新 pdf_path
    pub fn import_one(
        app_data_dir: &Path,
        db: &Database,
        source_path: &str,
        folder_id: Option<i64>,
    ) -> Result<Note, AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!("PDF 文件不存在: {}", source_path)));
        }

        // 1. 抽取文本（扫描件 / 加密 PDF 会失败）
        let raw_text = pdf_extract::extract_text(source)
            .map_err(|e| AppError::Custom(format!("PDF 文本抽取失败: {}", e)))?;
        let text = normalize_text(&raw_text);

        // 2. 标题取源文件名（去后缀）
        let title = source
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "未命名 PDF".to_string());

        // 3. 创建笔记（content 先存抽出的纯文本，包在 <p> 里满足 Tiptap HTML 期望）
        let note = db.create_note(&NoteInput {
            title: title.clone(),
            content: text_to_simple_html(&text),
            folder_id,
        })?;

        // 4. 拷贝原 PDF 到 pdfs/<id>.pdf
        Self::ensure_dir(app_data_dir)?;
        let rel_path = format!("{}/{}.pdf", pdfs_dir_name(), note.id);
        let dst = app_data_dir.join(&rel_path);
        if let Err(e) = std::fs::copy(source, &dst) {
            // 拷贝失败：笔记已经建好了也算导入成功，只是不关联 PDF
            log::warn!("PDF 原文件拷贝失败（笔记已建）: {}", e);
            return Ok(note);
        }

        // 5. 更新 source_file_path 和 source_file_type
        db.set_note_source_file(note.id, Some(&rel_path), Some("pdf"))?;

        // 6. 重新取完整 note 带 source_file_path 返回
        let note = db
            .get_note(note.id)?
            .ok_or_else(|| AppError::NotFound("刚创建的笔记查询失败".into()))?;
        Ok(note)
    }

    /// 批量导入，收集每条结果（不中断整体流程）
    pub fn import_many(
        app_data_dir: &Path,
        db: &Database,
        source_paths: &[String],
        folder_id: Option<i64>,
    ) -> Vec<PdfImportResult> {
        source_paths
            .iter()
            .map(|p| match Self::import_one(app_data_dir, db, p, folder_id) {
                Ok(note) => PdfImportResult {
                    source_path: p.clone(),
                    note_id: Some(note.id),
                    title: Some(note.title),
                    error: None,
                },
                Err(e) => PdfImportResult {
                    source_path: p.clone(),
                    note_id: None,
                    title: None,
                    error: Some(e.to_string()),
                },
            })
            .collect()
    }

    /// 根据 note_id 解析出 PDF 绝对路径（不存在则返回 None）
    pub fn resolve_pdf_absolute_path(
        app_data_dir: &Path,
        pdf_path: &str,
    ) -> Option<PathBuf> {
        let abs = app_data_dir.join(pdf_path);
        if abs.exists() { Some(abs) } else { None }
    }
}

/// 把抽出的纯文本转成简单 HTML（段落分隔），兼容 Tiptap StarterKit 解析
fn text_to_simple_html(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    // 以空行切成段落；段落内保留换行
    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| {
            let escaped = html_escape(p).replace('\n', "<br/>");
            format!("<p>{}</p>", escaped)
        })
        .collect();
    paragraphs.join("\n")
}

/// 规范化文本：清洗 pdf-extract 抽出的常见垃圾字符并修整结构
///
/// 处理顺序：
/// 1. 换行规范化（CRLF → LF）
/// 2. 逐行清洗：去零宽字符、行首 PUA/豆腐字符还原为 "• "、行内 PUA/替换字符删除
/// 3. 多余空行压成最多 2 个
fn normalize_text(raw: &str) -> String {
    let lf = raw.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned: String = lf
        .split('\n')
        .map(clean_line)
        .collect::<Vec<_>>()
        .join("\n");
    collapse_blank_lines(&cleaned)
}

/// 单行清洗：处理零宽字符、行首项目符号字形、行内不可打印字符
fn clean_line(line: &str) -> String {
    // 1. 去零宽字符
    let no_zw: String = line.chars().filter(|c| !is_zero_width(*c)).collect();

    // 2. 行首处理：跳过前导空白，若开头是疑似项目符号字形（PUA / FFFD 等），还原成 "•"
    let leading_ws: String = no_zw.chars().take_while(|c| c.is_whitespace()).collect();
    let body = &no_zw[leading_ws.len()..];

    if let Some(first) = body.chars().next() {
        if is_likely_bullet_glyph(first) {
            // 吃掉连续多个 bullet 字形（PDF 有时一个 bullet 占多个字符）
            let bullet_end = body
                .char_indices()
                .find(|(_, c)| !is_likely_bullet_glyph(*c))
                .map(|(i, _)| i)
                .unwrap_or(body.len());
            let rest = &body[bullet_end..];
            return format!(
                "{}• {}",
                leading_ws,
                strip_unprintable(rest).trim_start()
            );
        }
    }

    // 3. 非项目符号行：仅做行内不可打印清洗
    format!("{}{}", leading_ws, strip_unprintable(body))
}

/// 删除行内的 PUA 区段字符与替换字符（这些是 pdf-extract 没解出的字形残留）
fn strip_unprintable(s: &str) -> String {
    s.chars()
        .filter(|&c| !is_pua(c) && c != '\u{FFFD}')
        .collect()
}

/// 0-宽字符（不可见但污染搜索/光标）
fn is_zero_width(c: char) -> bool {
    matches!(
        c,
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{2060}'
    )
}

/// Unicode Private Use Area（PDF 嵌入子集字体常用区段，无字形定义）
fn is_pua(c: char) -> bool {
    matches!(c as u32, 0xE000..=0xF8FF)
}

/// 判断是否疑似"被错抽的项目符号字形"
///
/// PDF 里项目符号 `•` 在很多字体（如 Wingdings、Symbol、自制嵌入字体）
/// 走的是 PUA 字形，pdf-extract 输出 \uF0B7 / \uFFFD / 各种 PUA 码点。
fn is_likely_bullet_glyph(c: char) -> bool {
    is_pua(c) || c == '\u{FFFD}'
}

/// 把连续 3+ 个换行压成 2 个，整体 trim
fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut newline_run = 0usize;
    for ch in s.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push('\n');
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pua_at_line_start_becomes_bullet() {
        let raw = "\u{E020} 将本软件作为独立产品销售\n普通段落";
        let out = normalize_text(raw);
        assert!(out.starts_with("• 将本软件作为独立产品销售"));
        assert!(out.contains("普通段落"));
    }

    #[test]
    fn fffd_at_line_start_becomes_bullet() {
        let raw = "\u{FFFD} 第一项\n\u{FFFD} 第二项";
        let out = normalize_text(raw);
        assert_eq!(out, "• 第一项\n• 第二项");
    }

    #[test]
    fn zero_width_chars_removed() {
        let raw = "正\u{200B}文\u{FEFF}内\u{200C}容";
        assert_eq!(normalize_text(raw), "正文内容");
    }

    #[test]
    fn inline_pua_stripped_normal_line_kept() {
        let raw = "正文里夹\u{E100}个 PUA";
        assert_eq!(normalize_text(raw), "正文里夹个 PUA");
    }

    #[test]
    fn excessive_blank_lines_collapsed() {
        let raw = "A\n\n\n\nB\n\n\n\n\nC";
        assert_eq!(normalize_text(raw), "A\n\nB\n\nC");
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
