use std::path::Path;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, PageResult};
use crate::services::attachment::AttachmentService;
use crate::services::image::ImageService;
use crate::services::pdf::PdfService;

/// 回收站服务
pub struct TrashService;

impl TrashService {
    /// 清理某笔记的所有关联文件（图片目录 + 附件目录 + 源文件副本）
    /// 文件层失败仅 warn，不阻塞数据库删除流程
    fn cleanup_note_assets(data_dir: &Path, note_id: i64, source_file_path: &Option<String>) {
        // 1. 删图片目录 kb_assets/images/<id>/
        if let Err(e) = ImageService::delete_note_images(data_dir, note_id) {
            log::warn!("删除笔记 {} 图片目录失败: {}", note_id, e);
        }

        // 2. 删附件目录 kb_assets/attachments/<id>/
        if let Err(e) = AttachmentService::delete_note_attachments(data_dir, note_id) {
            log::warn!("删除笔记 {} 附件目录失败: {}", note_id, e);
        }

        // 3. 删源文件（可能是 sources/<id>.docx、pdfs/<id>.pdf 等）
        //    旧格式 pdfs/<id>.pdf 走这里；新格式 pdfs/<id>/<原名>.pdf 也能被
        //    单文件 remove_file 删掉，但会留下空 pdfs/<id>/ 目录，由下面第 4 步兜底
        if let Some(rel) = source_file_path {
            let abs = data_dir.join(rel);
            if abs.exists() {
                if let Err(e) = std::fs::remove_file(&abs) {
                    log::warn!("删除源文件 {:?} 失败: {}", abs, e);
                } else {
                    log::info!("已删除笔记 {} 源文件: {}", note_id, rel);
                }
            }
        }

        // 4. 删 PDF 子目录 pdfs/<id>/（新方案 C 格式：每个笔记独占目录）
        //    旧格式 pdfs/<id>.pdf 是单文件，这里 is_dir 检查会跳过，互不冲突
        if let Err(e) = PdfService::delete_note_pdfs(data_dir, note_id) {
            log::warn!("删除笔记 {} PDF 子目录失败: {}", note_id, e);
        }
    }
    /// 软删除笔记（移入回收站）
    pub fn soft_delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.soft_delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("笔记 {} 不存在或已在回收站", id)));
        }
        Ok(())
    }

    /// 恢复笔记（从回收站恢复）
    pub fn restore(db: &Database, id: i64) -> Result<(), AppError> {
        let restored = db.restore_note(id)?;
        if !restored {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或不在回收站",
                id
            )));
        }
        Ok(())
    }

    /// 永久删除笔记（连带清理图片 + 源文件）
    pub fn permanent_delete(
        db: &Database,
        data_dir: &Path,
        id: i64,
    ) -> Result<(), AppError> {
        // 先查 source_file_path（DB 行删掉后就拿不到了）
        let source = db.get_note_source_path(id)?;

        // 删 DB 行（外键 ON DELETE CASCADE 会自动清 note_tags/note_links，
        // FTS 触发器会清 notes_fts）
        let deleted = db.permanent_delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或不在回收站",
                id
            )));
        }

        // DB 成功后再清理文件（失败仅 warn）
        Self::cleanup_note_assets(data_dir, id, &source);
        Ok(())
    }

    /// 查询回收站（分页）
    pub fn list(
        db: &Database,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PageResult<Note>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_trash(page, page_size)?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 清空回收站（连带清理所有关联图片 + 源文件）
    pub fn empty(db: &Database, data_dir: &Path) -> Result<usize, AppError> {
        // 先拿到所有待删笔记的 (id, source_path)
        let items = db.list_trash_ids_with_sources()?;

        // 删 DB 行（一次性批量）
        let affected = db.empty_trash()?;

        // DB 成功后逐个清文件
        for (id, source) in &items {
            Self::cleanup_note_assets(data_dir, *id, source);
        }

        log::info!("清空回收站: DB 删除 {} 条，清理 {} 个笔记的资产", affected, items.len());
        Ok(affected)
    }
}
