use crate::database::Database;
use crate::error::AppError;
use crate::models::Folder;

/// 文件夹服务
pub struct FolderService;

impl FolderService {
    /// 创建文件夹
    pub fn create(
        db: &Database,
        name: &str,
        parent_id: Option<i64>,
    ) -> Result<Folder, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("文件夹名称不能为空".into()));
        }
        db.create_folder(name, parent_id)
    }

    /// 重命名文件夹
    pub fn rename(db: &Database, id: i64, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("文件夹名称不能为空".into()));
        }
        db.rename_folder(id, name)
    }

    /// 删除文件夹
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.delete_folder(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }
        Ok(())
    }

    /// 获取文件夹树
    pub fn list_tree(db: &Database) -> Result<Vec<Folder>, AppError> {
        db.list_folders_tree()
    }
}
