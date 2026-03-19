use rusqlite::params;

use crate::error::AppError;
use crate::models::Folder;

use super::Database;

/// 数据库中的平铺文件夹行
struct FolderRow {
    id: i64,
    name: String,
    parent_id: Option<i64>,
    sort_order: i32,
    note_count: usize,
}

impl Database {
    // ─── 文件夹 DAO ───────────────────────────────

    /// 创建文件夹
    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<i64>,
    ) -> Result<Folder, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        conn.execute(
            "INSERT INTO folders (name, parent_id) VALUES (?1, ?2)",
            params![name, parent_id],
        )?;

        let id = conn.last_insert_rowid();

        Ok(Folder {
            id,
            name: name.to_string(),
            parent_id,
            sort_order: 0,
            children: vec![],
            note_count: 0,
        })
    }

    /// 重命名文件夹
    pub fn rename_folder(&self, id: i64, name: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE folders SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }

        Ok(())
    }

    /// 删除文件夹（笔记的 folder_id 由 ON DELETE SET NULL 自动置空）
    pub fn delete_folder(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 获取所有文件夹（平铺查询，含每个文件夹的笔记数），构建为树形结构
    pub fn list_folders_tree(&self) -> Result<Vec<Folder>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.parent_id, f.sort_order,
                    (SELECT COUNT(*) FROM notes WHERE folder_id = f.id) as note_count
             FROM folders f ORDER BY f.sort_order, f.name",
        )?;

        let rows: Vec<FolderRow> = stmt
            .query_map([], |row| {
                Ok(FolderRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    note_count: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(build_folder_tree(&rows))
    }
}

/// 将平铺的文件夹列表构建为树形结构
fn build_folder_tree(rows: &[FolderRow]) -> Vec<Folder> {
    // 递归构建：找到所有 parent_id == target 的节点
    fn build_children(rows: &[FolderRow], parent_id: Option<i64>) -> Vec<Folder> {
        rows.iter()
            .filter(|r| r.parent_id == parent_id)
            .map(|r| Folder {
                id: r.id,
                name: r.name.clone(),
                parent_id: r.parent_id,
                sort_order: r.sort_order,
                children: build_children(rows, Some(r.id)),
                note_count: r.note_count,
            })
            .collect()
    }

    build_children(rows, None)
}
