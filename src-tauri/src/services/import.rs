use std::path::Path;

use tauri::{Emitter, Runtime};
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ImportProgress, ImportResult, NoteInput, ScannedFile};
use crate::services::markdown::markdown_to_html;

pub struct ImportService;

impl ImportService {
    /// 扫描文件夹，返回所有 Markdown 文件列表（不导入）
    pub fn scan_markdown_folder(folder_path: &str) -> Result<Vec<ScannedFile>, AppError> {
        let root = Path::new(folder_path);
        if !root.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "路径不是文件夹: {}",
                folder_path
            )));
        }

        let files: Vec<ScannedFile> = WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .map(|ext| ext == "md" || ext == "markdown")
                        .unwrap_or(false)
            })
            .filter_map(|entry| {
                let path = entry.path();
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("未命名")
                    .to_string();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                Some(ScannedFile {
                    path: path.to_string_lossy().to_string(),
                    name,
                    size,
                })
            })
            .collect();

        Ok(files)
    }

    /// 按指定文件路径列表导入 Markdown 文件
    pub fn import_selected_files<R: Runtime, E: Emitter<R>>(
        db: &Database,
        file_paths: &[String],
        folder_id: Option<i64>,
        emitter: &E,
    ) -> Result<ImportResult, AppError> {
        let total = file_paths.len();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();

        for (i, file_path_str) in file_paths.iter().enumerate() {
            let file_path = Path::new(file_path_str);
            let file_name = file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("未命名")
                .to_string();

            // 发送进度事件
            let _ = emitter.emit(
                "import:progress",
                ImportProgress {
                    current: i + 1,
                    total,
                    file_name: file_name.clone(),
                },
            );

            // 读取文件内容
            let content = match std::fs::read_to_string(file_path) {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("{}: 读取失败 - {}", file_name, e));
                    continue;
                }
            };

            // 跳过空文件
            if content.trim().is_empty() {
                skipped += 1;
                continue;
            }

            // 提取标题：优先用第一个 # 标题行，否则用文件名
            let title = extract_title(&content).unwrap_or(file_name);

            // 将 Markdown 转换为 HTML
            let html_content = markdown_to_html(&content);

            let input = NoteInput {
                title,
                content: html_content,
                folder_id,
            };

            match db.create_note(&input) {
                Ok(note) => {
                    // 标记为 markdown 导入，让前端 Tab 栏图标能区分
                    let _ = db.set_note_source_file(note.id, None, Some("md"));
                    imported += 1;
                }
                Err(e) => {
                    errors.push(format!("{}: 导入失败 - {}", input.title, e));
                }
            }
        }

        // 发送完成事件
        let result = ImportResult {
            imported,
            skipped,
            errors,
        };

        let _ = emitter.emit("import:done", &result);

        Ok(result)
    }
}

/// 从 Markdown 内容提取标题（第一个 # 开头的行）
fn extract_title(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            let title = trimmed.trim_start_matches('#').trim().to_string();
            if !title.is_empty() {
                return Some(title);
            }
        }
        // 跳过空行和 frontmatter
        if trimmed.is_empty() || trimmed == "---" {
            continue;
        }
        // 非标题非空行，停止查找
        if !trimmed.starts_with('#') && !trimmed.starts_with("---") {
            break;
        }
    }
    None
}
