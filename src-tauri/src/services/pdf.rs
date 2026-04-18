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
            folder_id: None,
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

        // 5. 更新 pdf_path（存相对路径，便于搬家）
        db.set_note_pdf_path(note.id, Some(&rel_path))?;

        // 6. 重新取完整 note 带 pdf_path 返回
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
    ) -> Vec<PdfImportResult> {
        source_paths
            .iter()
            .map(|p| match Self::import_one(app_data_dir, db, p) {
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

/// 规范化文本：统一换行、去掉多余空行（pdf-extract 常有形如 \n\n\n\n 的结果）
fn normalize_text(raw: &str) -> String {
    let lf = raw.replace("\r\n", "\n").replace('\r', "\n");
    // 连续 3+ 换行压成 2 个
    let mut out = String::with_capacity(lf.len());
    let mut newline_run = 0usize;
    for ch in lf.chars() {
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

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
