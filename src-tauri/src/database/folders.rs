use rusqlite::{params, params_from_iter, types::Value, Connection};

use crate::error::AppError;
use crate::models::Folder;

use super::Database;

/// 内部 helper：BFS 收集 root + 所有子孙文件夹 ID（含 root 自身）。
/// 接收 `&Connection`（事务可用 `&*tx` 传入），不自己 lock，供级联删除 / 子树统计复用，
/// 避免在已持锁的事务里重复 lock 造成死锁（Mutex 不可重入）。
fn bfs_descendant_ids(conn: &Connection, root_id: i64) -> Result<Vec<i64>, AppError> {
    let mut all_ids: Vec<i64> = vec![root_id];
    let mut frontier: Vec<i64> = vec![root_id];
    while !frontier.is_empty() {
        let placeholders: String = (1..=frontier.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT id FROM folders WHERE parent_id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = frontier
            .iter()
            .map(|x| x as &dyn rusqlite::types::ToSql)
            .collect();
        let next: Vec<i64> = stmt
            .query_map(params_ref.as_slice(), |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if next.is_empty() {
            break;
        }
        all_ids.extend(&next);
        frontier = next;
        if all_ids.len() > 5000 {
            log::warn!("[folders] 子树 ID 超过 5000，root={}，截断防止失控", root_id);
            break;
        }
    }
    Ok(all_ids)
}

/// 数据库中的平铺文件夹行
struct FolderRow {
    id: i64,
    name: String,
    parent_id: Option<i64>,
    sort_order: i32,
    note_count: usize,
    color: Option<String>,
}

impl Database {
    // ─── 文件夹 DAO ───────────────────────────────

    /// 创建文件夹
    pub fn create_folder(&self, name: &str, parent_id: Option<i64>) -> Result<Folder, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
            color: None,
        })
    }

    /// 设置文件夹颜色
    ///
    /// `color` 传 `Some("#1677ff")` 设色，传 `None` 清除（恢复默认主题色）。
    /// 不在这里做格式校验 —— Service 层判断 hex 合法性。
    pub fn set_folder_color(&self, id: i64, color: Option<&str>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE folders SET color = ?1 WHERE id = ?2",
            params![color, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }

        Ok(())
    }

    /// 按 (parent_id, name) 查找文件夹：用于导入时同名合并/复用，避免重复创建。
    ///
    /// 注意：SQLite 的 NULL 比较不走普通 `=`，所以根层（parent_id IS NULL）要单独分支。
    pub fn find_folder_by_name(
        &self,
        parent_id: Option<i64>,
        name: &str,
    ) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let result = match parent_id {
            Some(pid) => conn
                .query_row(
                    "SELECT id FROM folders WHERE parent_id = ?1 AND name = ?2 LIMIT 1",
                    params![pid, name],
                    |row| row.get::<_, i64>(0),
                )
                .ok(),
            None => conn
                .query_row(
                    "SELECT id FROM folders WHERE parent_id IS NULL AND name = ?1 LIMIT 1",
                    params![name],
                    |row| row.get::<_, i64>(0),
                )
                .ok(),
        };
        Ok(result)
    }

    /// 重命名文件夹
    pub fn rename_folder(&self, id: i64, name: &str) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 检查文件夹是否含有子内容（子文件夹 或 未回收的笔记）
    /// 回收站中的笔记（is_deleted = 1）不计入阻止条件
    /// 收集 root 文件夹自身 + 所有子孙文件夹的 ID（用于"递归列出子树笔记"场景）
    ///
    /// 实现：用 BFS 一路扫 parent_id，避免递归 SQL CTE。folder 表通常 < 1000 条，
    /// 嵌套深度也很浅，BFS 一两次 SELECT 就跑完。
    /// 返回包含 root 自身的 ID 列表（顺序：BFS 层序）。
    pub fn collect_descendant_folder_ids(&self, root_id: i64) -> Result<Vec<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut all_ids: Vec<i64> = vec![root_id];
        let mut frontier: Vec<i64> = vec![root_id];

        while !frontier.is_empty() {
            // 一次拿一层的所有子文件夹（IN 子句动态拼 placeholder）
            let placeholders: String = (1..=frontier.len())
                .map(|i| format!("?{}", i))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT id FROM folders WHERE parent_id IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let params_ref: Vec<&dyn rusqlite::types::ToSql> = frontier
                .iter()
                .map(|x| x as &dyn rusqlite::types::ToSql)
                .collect();
            let next: Vec<i64> = stmt
                .query_map(params_ref.as_slice(), |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            if next.is_empty() {
                break;
            }
            all_ids.extend(&next);
            frontier = next;
            // 防御性上限：超过 5000 个文件夹的子树几乎不可能，遇到就停
            if all_ids.len() > 5000 {
                log::warn!(
                    "[folders] 子树 ID 超过 5000，root={}，截断防止失控",
                    root_id
                );
                break;
            }
        }

        Ok(all_ids)
    }

    /// 详细版：返回 `(子文件夹数, 未在回收站的笔记数)`，
    /// 让 service 层给具体错误（"还有 2 个子文件夹"/"还有 3 篇笔记（含隐藏 / 加密 / 仍存在数据库的）"）。
    /// 隐藏笔记 / 加密笔记在 UI 默认看不到，但 is_deleted=0 仍算"占用"——这里完整计数避免用户困惑。
    pub fn folder_children_count(&self, id: i64) -> Result<(i64, i64), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sub_folders: i64 = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE parent_id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let active_notes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE folder_id = ?1 AND is_deleted = 0",
            params![id],
            |row| row.get(0),
        )?;
        Ok((sub_folders, active_notes))
    }

    /// 整棵子树统计：返回 `(子孙文件夹数（不含 root）, 子树内未回收笔记数)`。
    /// 用于"级联删除"确认弹窗向用户展示将要删除的清单（含隐藏 / 加密笔记，与
    /// folder_children_count 同口径）。
    pub fn folder_subtree_stats(&self, root_id: i64) -> Result<(i64, i64), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let ids = bfs_descendant_ids(&conn, root_id)?;
        // 子孙文件夹数 = 总数 - root 自身
        let descendant_folders = (ids.len() as i64 - 1).max(0);
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT COUNT(*) FROM notes WHERE folder_id IN ({}) AND is_deleted = 0",
            placeholders
        );
        let args: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();
        let active_notes: i64 =
            conn.query_row(&sql, params_from_iter(args.iter()), |row| row.get(0))?;
        Ok((descendant_folders, active_notes))
    }

    /// 级联删除文件夹子树：先把子树内所有未回收笔记软删进回收站（可恢复），
    /// 再物理删除整棵子树的文件夹。整个操作在单个事务内，任一步失败全部回滚。
    /// 返回 `(软删笔记数, 删除文件夹数)`。
    ///
    /// 顺序很关键：必须先按 folder_id 软删笔记，再删文件夹——否则先删文件夹会触发
    /// 外键 ON DELETE SET NULL 把笔记 folder_id 清空，后续按 folder_id 匹配就漏删了。
    /// 笔记软删后 folder_id 仍指向待删文件夹，删文件夹时被 SET NULL → 回收站恢复
    /// 时落到"未分类"，符合预期（父文件夹已不存在）。
    pub fn delete_folder_cascade(&self, root_id: i64) -> Result<(usize, usize), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let ids = bfs_descendant_ids(&*tx, root_id)?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let args: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();

        // 1) 软删子树内所有未回收笔记
        let note_sql = format!(
            "UPDATE notes SET is_deleted = 1, deleted_at = datetime('now', 'localtime') \
             WHERE folder_id IN ({}) AND is_deleted = 0",
            placeholders
        );
        let notes_trashed = tx.execute(&note_sql, params_from_iter(args.iter()))?;

        // 2) 物理删除整棵子树的文件夹
        let folder_sql = format!("DELETE FROM folders WHERE id IN ({})", placeholders);
        let folders_deleted = tx.execute(&folder_sql, params_from_iter(args.iter()))?;

        tx.commit()?;
        Ok((notes_trashed, folders_deleted))
    }

    /// 批量设置文件夹 sort_order（按给定顺序赋值 0..N-1）
    pub fn set_folder_sort_orders(&self, ordered_ids: &[i64]) -> Result<(), AppError> {
        if ordered_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.parent_id, f.sort_order,
                    (SELECT COUNT(*) FROM notes WHERE folder_id = f.id) as note_count,
                    f.color
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
                    color: row.get(5)?,
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
                color: r.color.clone(),
            })
            .collect()
    }

    build_children(rows, None)
}
