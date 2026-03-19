use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, PageResult};

/// 回收站服务
pub struct TrashService;

impl TrashService {
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

    /// 永久删除笔记
    pub fn permanent_delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.permanent_delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或不在回收站",
                id
            )));
        }
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

    /// 清空回收站
    pub fn empty(db: &Database) -> Result<usize, AppError> {
        db.empty_trash()
    }
}
