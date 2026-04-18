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
    /// 当文件夹含有子文件夹或未回收的笔记时拒绝删除
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        if db.folder_has_children(id)? {
            return Err(AppError::InvalidInput(
                "该文件夹下还有子文件夹或笔记，请先清空后再删除".into(),
            ));
        }
        let deleted = db.delete_folder(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }
        Ok(())
    }

    /// 移动文件夹（改父节点，不处理同级排序）
    pub fn move_to(
        db: &Database,
        id: i64,
        new_parent_id: Option<i64>,
    ) -> Result<(), AppError> {
        db.move_folder(id, new_parent_id)
    }

    /// 批量重排同级文件夹顺序
    /// ordered_ids 应为同一父节点下的所有子节点，按期望顺序排列
    pub fn reorder(db: &Database, ordered_ids: &[i64]) -> Result<(), AppError> {
        db.set_folder_sort_orders(ordered_ids)
    }

    /// 获取文件夹树
    pub fn list_tree(db: &Database) -> Result<Vec<Folder>, AppError> {
        db.list_folders_tree()
    }
}
