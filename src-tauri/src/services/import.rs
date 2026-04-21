use std::path::Path;

use tauri::{Emitter, Runtime};
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ImportProgress, ImportResult, NoteInput, ScannedFile};

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

            // 数据库 content 现在就是 Markdown，直接存；编辑器端会自行渲染
            let input = NoteInput {
                title,
                content,
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

    /// 打开单个 Markdown 文件：
    /// - 首次：创建新笔记并记录 source_file_path，返回 id
    /// - 重复打开同一文件：直接返回已有笔记 id；若文件内容已变化则同步写回笔记
    ///
    /// 用于"菜单导入单个 md 文件"和"双击 md 文件由本应用打开"两个触发场景。
    /// 与 import_selected_files 的区别：不发进度事件、不处理批量、直接返回 id 方便前端跳转。
    pub fn import_single_markdown(db: &Database, file_path: &str) -> Result<i64, AppError> {
        let path = Path::new(file_path);

        // 路径规范化（绝对路径 + 大小写/斜杠统一），保证"同文件多种写法"去重
        let canonical: String = std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| file_path.to_string());

        let file_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string();

        let content = std::fs::read_to_string(path).map_err(|e| {
            AppError::Custom(format!("读取文件失败: {} ({})", file_path, e))
        })?;

        if content.trim().is_empty() {
            return Err(AppError::InvalidInput(format!("文件内容为空: {}", file_path)));
        }

        // 去重：已有同 source_file_path 的活跃笔记 → 复用
        if let Some((existing_id, existing_content)) =
            db.find_active_note_by_source_path(&canonical)?
        {
            // 外部修改过文件 → 同步最新内容到笔记
            if existing_content != content {
                db.update_note_content(existing_id, &content)?;
                log::info!(
                    "[open-md] 检测到 {} 内容变化，已同步到笔记 #{}",
                    canonical, existing_id
                );
            }
            return Ok(existing_id);
        }

        // 首次打开：创建笔记并记录来源
        let title = extract_title(&content).unwrap_or(file_name);
        let input = NoteInput {
            title,
            content,
            folder_id: None,
        };
        let note = db.create_note(&input)?;
        let _ = db.set_note_source_file(note.id, Some(&canonical), Some("md"));
        Ok(note.id)
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
