use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, NoteInput, NoteQuery, PageResult};

/// 笔记服务
pub struct NoteService;

impl NoteService {
    /// 创建笔记
    pub fn create(db: &Database, input: &NoteInput) -> Result<Note, AppError> {
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("笔记标题不能为空".into()));
        }
        db.create_note(input)
    }

    /// 更新笔记
    pub fn update(db: &Database, id: i64, input: &NoteInput) -> Result<Note, AppError> {
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("笔记标题不能为空".into()));
        }
        db.update_note(id, input)
    }

    /// 删除笔记（永久删除，预留给未来使用）
    #[allow(dead_code)]
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 获取单个笔记
    pub fn get(db: &Database, id: i64) -> Result<Note, AppError> {
        db.get_note(id)?
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))
    }

    /// 切换笔记置顶状态
    pub fn toggle_pin(db: &Database, id: i64) -> Result<bool, AppError> {
        db.toggle_pin(id)
    }

    /// 移动笔记到文件夹
    pub fn move_to_folder(db: &Database, note_id: i64, folder_id: Option<i64>) -> Result<(), AppError> {
        db.move_note_to_folder(note_id, folder_id)
    }

    /// 删除所有笔记
    pub fn delete_all(db: &Database) -> Result<usize, AppError> {
        db.delete_all_notes()
    }

    /// 查询笔记列表（分页）
    pub fn list(db: &Database, query: &NoteQuery) -> Result<PageResult<Note>, AppError> {
        let page = query.page.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_notes(
            query.folder_id,
            query.keyword.as_deref(),
            page,
            page_size,
        )?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }
}
