use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, PageResult, Tag};

/// 标签服务
pub struct TagService;

impl TagService {
    /// 创建标签
    pub fn create(db: &Database, name: &str, color: Option<&str>) -> Result<Tag, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("标签名称不能为空".into()));
        }
        db.create_tag(name, color)
    }

    /// 获取所有标签
    pub fn list(db: &Database) -> Result<Vec<Tag>, AppError> {
        db.list_tags()
    }

    /// 重命名标签
    pub fn rename(db: &Database, id: i64, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("标签名称不能为空".into()));
        }
        db.rename_tag(id, name)
    }

    /// 删除标签
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.delete_tag(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("标签 {} 不存在", id)));
        }
        Ok(())
    }

    /// 给笔记添加标签
    pub fn add_to_note(db: &Database, note_id: i64, tag_id: i64) -> Result<(), AppError> {
        db.add_tag_to_note(note_id, tag_id)
    }

    /// 移除笔记的标签
    pub fn remove_from_note(db: &Database, note_id: i64, tag_id: i64) -> Result<(), AppError> {
        db.remove_tag_from_note(note_id, tag_id)?;
        Ok(())
    }

    /// 获取笔记的所有标签
    pub fn get_note_tags(db: &Database, note_id: i64) -> Result<Vec<Tag>, AppError> {
        db.get_note_tags(note_id)
    }

    /// 获取标签下的笔记列表（分页）
    pub fn list_notes_by_tag(
        db: &Database,
        tag_id: i64,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PageResult<Note>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_notes_by_tag(tag_id, page, page_size)?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }
}
