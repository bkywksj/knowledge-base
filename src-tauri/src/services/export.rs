use std::collections::HashMap;
use std::path::Path;

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ExportProgress, ExportResult};

pub struct ExportService;

impl ExportService {
    /// 导出笔记为 Markdown 文件
    ///
    /// - `output_dir`: 导出目标目录
    /// - `folder_id`: 可选，仅导出指定文件夹的笔记；None 表示导出全部
    pub fn export_notes<R: Runtime, E: Emitter<R>>(
        db: &Database,
        output_dir: &str,
        folder_id: Option<i64>,
        emitter: &E,
    ) -> Result<ExportResult, AppError> {
        let output_path = Path::new(output_dir);
        std::fs::create_dir_all(output_path)?;

        let conn = db.conn_lock()?;

        // 1. 构建文件夹 id -> name 映射 和 id -> parent_id 映射
        let mut folder_names: HashMap<i64, String> = HashMap::new();
        let mut folder_parents: HashMap<i64, Option<i64>> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT id, name, parent_id FROM folders")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })?;
            for row in rows {
                let (id, name, parent_id) = row?;
                folder_names.insert(id, name);
                folder_parents.insert(id, parent_id);
            }
        }

        // 2. 查询笔记
        let notes: Vec<(i64, String, String, Option<i64>, bool, Option<String>)> = {
            let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
                if let Some(fid) = folder_id {
                    (
                        "SELECT id, title, content, folder_id, is_daily, daily_date \
                         FROM notes WHERE is_deleted = 0 AND folder_id = ?1 \
                         ORDER BY updated_at DESC"
                            .into(),
                        vec![Box::new(fid)],
                    )
                } else {
                    (
                        "SELECT id, title, content, folder_id, is_daily, daily_date \
                         FROM notes WHERE is_deleted = 0 \
                         ORDER BY updated_at DESC"
                            .into(),
                        vec![],
                    )
                };

            let mut stmt = conn.prepare(&sql)?;
            let params_refs: Vec<&dyn rusqlite::types::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let total = notes.len();
        let mut exported = 0usize;
        let mut errors = Vec::new();

        for (i, (id, title, content, note_folder_id, is_daily, daily_date)) in
            notes.iter().enumerate()
        {
            // 构建子目录路径
            let sub_dir = if *is_daily {
                "每日笔记".to_string()
            } else if let Some(fid) = note_folder_id {
                build_folder_path(*fid, &folder_names, &folder_parents)
            } else {
                "未分类".to_string()
            };

            let dir = output_path.join(&sub_dir);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                errors.push(format!("{}: 创建目录失败 - {}", title, e));
                continue;
            }

            // 生成文件名
            let file_name = if *is_daily {
                format!("{}.md", daily_date.as_deref().unwrap_or("unknown"))
            } else {
                let safe_title = sanitize_filename(title);
                // 避免重名：加 id 后缀
                format!("{}.md", safe_title)
            };

            let file_path = dir.join(&file_name);

            // 发送进度事件
            let _ = emitter.emit(
                "export:progress",
                ExportProgress {
                    current: i + 1,
                    total,
                    file_name: file_name.clone(),
                },
            );

            // HTML → Markdown 转换
            let markdown = html_to_markdown(content);

            // 写入文件
            match std::fs::write(&file_path, &markdown) {
                Ok(_) => exported += 1,
                Err(e) => {
                    errors.push(format!("{}: 写入失败 - {}", title, e));
                }
            }

            log::debug!("导出笔记 #{}: {} -> {:?}", id, title, file_path);
        }

        let result = ExportResult {
            exported,
            errors,
            output_dir: output_dir.to_string(),
        };

        let _ = emitter.emit("export:done", &result);

        Ok(result)
    }
}

/// 构建文件夹的完整路径（递归拼接父级）
fn build_folder_path(
    folder_id: i64,
    names: &HashMap<i64, String>,
    parents: &HashMap<i64, Option<i64>>,
) -> String {
    let mut parts = Vec::new();
    let mut current = Some(folder_id);

    while let Some(id) = current {
        if let Some(name) = names.get(&id) {
            parts.push(sanitize_filename(name));
            current = parents.get(&id).copied().flatten();
        } else {
            break;
        }
    }

    parts.reverse();
    if parts.is_empty() {
        "未分类".to_string()
    } else {
        parts.join(std::path::MAIN_SEPARATOR_STR)
    }
}

/// 文件名安全化：移除不合法字符
fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = sanitized.trim().to_string();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed
    }
}

/// 将 HTML 转换为 Markdown
fn html_to_markdown(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    html2md::parse_html(html)
}
