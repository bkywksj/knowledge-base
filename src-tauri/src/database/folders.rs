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

    /// 检查文件夹是否含有子内容（子文件夹 或 未回收的笔记）
    /// 回收站中的笔记（is_deleted = 1）不计入阻止条件
    pub fn folder_has_children(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let sub_folders: i64 = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE parent_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        if sub_folders > 0 {
            return Ok(true);
        }

        let active_notes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE folder_id = ?1 AND is_deleted = 0",
            params![id],
            |row| row.get(0),
        )?;
        Ok(active_notes > 0)
    }

    /// 批量设置文件夹 sort_order（按给定顺序赋值 0..N-1）
    pub fn set_folder_sort_orders(&self, ordered_ids: &[i64]) -> Result<(), AppError> {
        if ordered_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        for (idx, id) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE folders SET sort_order = ?1 WHERE id = ?2",
                params![idx as i64, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 修改文件夹父节点（拖拽移动）
    /// new_parent_id == None 表示移到根节点
    pub fn move_folder(&self, id: i64, new_parent_id: Option<i64>) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 防循环：new_parent_id 不能是自己，也不能是自己的后代
        if let Some(pid) = new_parent_id {
            if pid == id {
                return Err(AppError::InvalidInput("不能把文件夹移到自身".into()));
            }
            // 沿父链向上走，若遇到 id 则说明目标是当前文件夹的后代
            let mut cursor: Option<i64> = Some(pid);
            while let Some(current) = cursor {
                if current == id {
                    return Err(AppError::InvalidInput(
                        "不能把文件夹移到自己的子孙中".into(),
                    ));
                }
                cursor = conn
                    .query_row(
                        "SELECT parent_id FROM folders WHERE id = ?1",
                        params![current],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .ok()
                    .flatten();
            }
        }

        let affected = conn.execute(
            "UPDATE folders SET parent_id = ?1 WHERE id = ?2",
            params![new_parent_id, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }

        Ok(())
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
