//! 任务附件服务：图片 / 文件挂在任务（含子任务）上。
//!
//! 目录：`{app_data_dir}/{prefix}kb_assets/task_files/<task_id>/`
//!   · 放在 kb_assets 下 → 整包 ZIP 备份 / WebDAV 自动带上，备份代码零改动
//!   · 🔴 不放 `images/<id>/`：那里的孤儿扫描按「笔记 id」判定，会把任务目录整个误删
//!
//! 表 `task_attachments` 存相对 data_dir 的 POSIX 路径，前端拼 `kb-asset://<rel>` 显示。
//! 任务软删时文件保留（复活还能用）；真正无主的文件交给孤儿扫描。

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::database::Database;
use crate::error::AppError;
use crate::models::TaskAttachment;
use crate::services::attachment::{mime_for_ext, BLOCKED_EXTS};
use crate::services::{asset_path, safe_filename};

const ASSETS_DIR_PROD: &str = "kb_assets";
const ASSETS_DIR_DEV: &str = "dev-kb_assets";
pub const TASK_FILES_DIR: &str = "task_files";

#[inline]
fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        ASSETS_DIR_DEV
    } else {
        ASSETS_DIR_PROD
    }
}

/// 图片 MIME 单独映射：附件服务的表不含图片（笔记图片走 ImageService）
fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "txt" | "md" | "log" => "text/plain",
        other => mime_for_ext(other),
    }
}

/// 拆 stem / ext 并做扩展名黑名单校验
fn split_name(file_name: &str) -> Result<(String, String), AppError> {
    let p = Path::new(file_name);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if BLOCKED_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Custom(format!(
            "出于安全考虑，禁止保存 .{} 文件为附件",
            ext
        )));
    }
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok((stem, if ext.is_empty() { "bin".into() } else { ext }))
}

pub struct TaskAttachmentService;

impl TaskAttachmentService {
    /// 任务附件根目录
    pub fn root_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(assets_dir_name()).join(TASK_FILES_DIR)
    }

    fn task_dir(app_data_dir: &Path, task_id: i64) -> PathBuf {
        Self::root_dir(app_data_dir).join(task_id.to_string())
    }

    fn ensure_task_exists(db: &Database, task_id: i64) -> Result<(), AppError> {
        db.get_task(task_id)?
            .map(|_| ())
            .ok_or_else(|| AppError::NotFound(format!("任务 {} 不存在", task_id)))
    }

    pub fn list(db: &Database, task_id: i64) -> Result<Vec<TaskAttachment>, AppError> {
        db.list_task_attachments(task_id)
    }

    /// 保存 base64 数据（粘贴截图 / 拖入浏览器 File）
    pub fn add_from_base64(
        db: &Database,
        app_data_dir: &Path,
        task_id: i64,
        file_name: &str,
        base64_data: &str,
    ) -> Result<TaskAttachment, AppError> {
        Self::ensure_task_exists(db, task_id)?;
        let (stem, ext) = split_name(file_name)?;
        let data = STANDARD
            .decode(base64_data)
            .map_err(|e| AppError::Custom(format!("base64 解码失败: {}", e)))?;
        let abs =
            safe_filename::save_unique(&Self::task_dir(app_data_dir, task_id), &stem, &ext, &data)?;
        Self::record(
            db,
            app_data_dir,
            task_id,
            file_name,
            &ext,
            &abs,
            data.len() as i64,
        )
    }

    /// 从本地路径复制（文件选择框 / OS 拖放），不经 IPC 传字节
    pub fn add_from_path(
        db: &Database,
        app_data_dir: &Path,
        task_id: i64,
        source_path: &str,
    ) -> Result<TaskAttachment, AppError> {
        Self::ensure_task_exists(db, task_id)?;
        let source = Path::new(source_path);
        if !source.is_file() {
            return Err(AppError::NotFound(format!("文件不存在: {}", source_path)));
        }
        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment.bin")
            .to_string();
        let (stem, ext) = split_name(&file_name)?;
        let abs = safe_filename::save_unique_from_path(
            &Self::task_dir(app_data_dir, task_id),
            &stem,
            &ext,
            source,
        )?;
        let size = std::fs::metadata(&abs).map(|m| m.len() as i64).unwrap_or(0);
        Self::record(db, app_data_dir, task_id, &file_name, &ext, &abs, size)
    }

    fn record(
        db: &Database,
        app_data_dir: &Path,
        task_id: i64,
        file_name: &str,
        ext: &str,
        abs: &Path,
        size: i64,
    ) -> Result<TaskAttachment, AppError> {
        let rel = asset_path::abs_to_rel(abs, app_data_dir).ok_or_else(|| {
            AppError::Custom(format!(
                "内部错误：附件路径 {} 不在数据目录下",
                abs.display()
            ))
        })?;
        let row = db.insert_task_attachment(task_id, &rel, file_name, mime_of(ext), size)?;
        log::info!("任务 {} 新增附件 {} ({} bytes)", task_id, rel, size);
        Ok(row)
    }

    /// 删除一条附件；文件没有其它行引用时一并删掉
    pub fn delete(db: &Database, app_data_dir: &Path, id: i64) -> Result<bool, AppError> {
        let Some(att) = db.get_task_attachment(id)? else {
            return Ok(false);
        };
        db.delete_task_attachment(id)?;
        if db.count_task_attachment_refs(&att.rel_path)? == 0 {
            match asset_path::rel_to_abs(&att.rel_path, app_data_dir) {
                Ok(abs) if abs.exists() => {
                    // 删文件失败不回滚行：行已删，残留文件交给孤儿扫描兜底
                    if let Err(e) = std::fs::remove_file(&abs) {
                        log::warn!("删除任务附件文件失败 {}: {}", abs.display(), e);
                    }
                }
                Ok(_) => {}
                Err(e) => log::warn!("任务附件路径非法 {}: {}", att.rel_path, e),
            }
        }
        Ok(true)
    }

    pub fn reorder(db: &Database, task_id: i64, ids: &[i64]) -> Result<(), AppError> {
        db.reorder_task_attachments(task_id, ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_ext_rejected() {
        assert!(split_name("evil.EXE").is_err());
        assert_eq!(
            split_name("截图.PNG").unwrap(),
            ("截图".into(), "png".into())
        );
        assert_eq!(split_name("noext").unwrap().1, "bin");
    }

    #[test]
    fn delete_keeps_file_while_still_referenced() {
        let dir = std::env::temp_dir().join(format!("kb-task-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::init(":memory:").unwrap();
        let input: crate::models::CreateTaskInput =
            serde_json::from_value(serde_json::json!({ "title": "t" })).unwrap();
        let tid = db.create_task(input).unwrap();

        // 同名同内容 → save_unique 复用同一文件，两行指向同一路径
        let a =
            TaskAttachmentService::add_from_base64(&db, &dir, tid, "a.png", "aGVsbG8=").unwrap();
        let b =
            TaskAttachmentService::add_from_base64(&db, &dir, tid, "a.png", "aGVsbG8=").unwrap();
        assert_eq!(a.rel_path, b.rel_path);
        let abs = asset_path::rel_to_abs(&a.rel_path, &dir).unwrap();

        TaskAttachmentService::delete(&db, &dir, a.id).unwrap();
        assert!(abs.exists(), "还有引用时不能删文件");
        TaskAttachmentService::delete(&db, &dir, b.id).unwrap();
        assert!(!abs.exists(), "最后一个引用删掉后文件应被清理");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
