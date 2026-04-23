use crate::database::Database;
use crate::error::AppError;
use crate::models::{NoteTemplate, NoteTemplateInput};

/// 模板服务
pub struct TemplateService;

impl TemplateService {
    /// 获取所有模板
    pub fn list(db: &Database) -> Result<Vec<NoteTemplate>, AppError> {
        db.list_templates()
    }

    /// 获取单个模板
    pub fn get(db: &Database, id: i64) -> Result<NoteTemplate, AppError> {
        db.get_template(id)
    }

    /// 创建模板
    pub fn create(db: &Database, input: &NoteTemplateInput) -> Result<NoteTemplate, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("模板名称不能为空".into()));
        }
        db.create_template(input)
    }

    /// 更新模板
    pub fn update(db: &Database, id: i64, input: &NoteTemplateInput) -> Result<NoteTemplate, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("模板名称不能为空".into()));
        }
        db.update_template(id, input)
    }

    /// 删除模板
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        db.delete_template(id)
    }
}
