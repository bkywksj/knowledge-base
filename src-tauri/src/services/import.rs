use std::path::Path;

use tauri::{Emitter, Runtime};
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ImportProgress, ImportResult, NoteInput};

pub struct ImportService;

impl ImportService {
    /// 从文件夹递归导入 Markdown 文件
    pub fn import_markdown_folder<R: Runtime, E: Emitter<R>>(
        db: &Database,
        folder_path: &str,
        folder_id: Option<i64>,
        emitter: &E,
    ) -> Result<ImportResult, AppError> {
        let root = Path::new(folder_path);
        if !root.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "路径不是文件夹: {}",
                folder_path
            )));
        }

        // 收集所有 .md 文件
        let md_files: Vec<_> = WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .map(|ext| ext == "md" || ext == "markdown")
                        .unwrap_or(false)
            })
            .collect();

        let total = md_files.len();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();

        for (i, entry) in md_files.iter().enumerate() {
            let file_path = entry.path();
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

            // 计算相对文件夹路径（用于在日志中记录）
            let _relative = file_path
                .strip_prefix(root)
                .unwrap_or(file_path);

            let input = NoteInput {
                title,
                content,
                folder_id,
            };

            match db.create_note(&input) {
                Ok(_) => imported += 1,
                Err(e) => {
                    errors.push(format!(
                        "{}: 导入失败 - {}",
                        input.title, e
                    ));
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
