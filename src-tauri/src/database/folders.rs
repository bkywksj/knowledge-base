use std::collections::HashMap;

use rusqlite::{params, params_from_iter, types::Value, Connection};

use crate::error::AppError;
use crate::models::{EmptyFolderInfo, Folder};

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

    /// 详细版：返回 `(子文件夹数, 未回收的普通笔记数, 未回收的日记数)`，
    /// 让 service 层给具体错误（"还有 2 个子文件夹"/"还有 3 篇笔记（含隐藏 / 加密 / 仍存在数据库的）"）。
    /// 隐藏笔记 / 加密笔记在 UI 默认看不到，但 is_deleted=0 仍算"占用"——这里完整计数避免用户困惑。
    ///
    /// 🔴 日记（`is_daily = 1`）单独计数、**不计进"笔记数"**：
    /// 「导入历史日记」会把日记留在 `2020-05-26` 这类日期文件夹下（daily_import 的设计取舍），
    /// 而 `list_notes` 一律过滤 `is_daily = 0` —— 于是用户在笔记页看到的是**空文件夹**，
    /// 删除时却被告知"还有 1 篇笔记"，确认后连当天日记一起进了回收站（真实用户反馈）。
    /// 现在两边口径对齐：笔记数 = 用户在列表里真能看到的那些；日记单独报，且删除时不动它。
    pub fn folder_children_count(&self, id: i64) -> Result<(i64, i64, i64), AppError> {
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
            "SELECT COUNT(*) FROM notes WHERE folder_id = ?1 AND is_deleted = 0 AND is_daily = 0",
            params![id],
            |row| row.get(0),
        )?;
        let dailies: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE folder_id = ?1 AND is_deleted = 0 AND is_daily = 1",
            params![id],
            |row| row.get(0),
        )?;
        Ok((sub_folders, active_notes, dailies))
    }

    /// 整棵子树统计：返回 `(子孙文件夹数（不含 root）, 子树内未回收的普通笔记数, 子树内未回收的日记数)`。
    /// 用于"级联删除"确认弹窗向用户展示将要删除的清单（含隐藏 / 加密笔记，与
    /// folder_children_count 同口径）。日记单独一项 —— 级联删除不会删它，只会让它脱离文件夹。
    pub fn folder_subtree_stats(&self, root_id: i64) -> Result<(i64, i64, i64), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let ids = bfs_descendant_ids(&conn, root_id)?;
        // 子孙文件夹数 = 总数 - root 自身
        let descendant_folders = (ids.len() as i64 - 1).max(0);
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let args: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();
        let note_sql = format!(
            "SELECT COUNT(*) FROM notes
             WHERE folder_id IN ({}) AND is_deleted = 0 AND is_daily = 0",
            placeholders
        );
        let active_notes: i64 =
            conn.query_row(&note_sql, params_from_iter(args.iter()), |row| row.get(0))?;
        let daily_sql = format!(
            "SELECT COUNT(*) FROM notes
             WHERE folder_id IN ({}) AND is_deleted = 0 AND is_daily = 1",
            placeholders
        );
        let dailies: i64 =
            conn.query_row(&daily_sql, params_from_iter(args.iter()), |row| row.get(0))?;
        Ok((descendant_folders, active_notes, dailies))
    }

    /// 级联删除文件夹子树：先把子树内所有未回收的**普通**笔记软删进回收站（可恢复），
    /// 再物理删除整棵子树的文件夹。整个操作在单个事务内，任一步失败全部回滚。
    /// 返回 `(软删笔记数, 删除文件夹数, 脱离文件夹的日记数)`。
    ///
    /// 顺序很关键：必须先按 folder_id 软删笔记，再删文件夹——否则先删文件夹会触发
    /// 外键 ON DELETE SET NULL 把笔记 folder_id 清空，后续按 folder_id 匹配就漏删了。
    /// 笔记软删后 folder_id 仍指向待删文件夹，删文件夹时被 SET NULL → 回收站恢复
    /// 时落到"未分类"，符合预期（父文件夹已不存在）。
    ///
    /// 🔴 日记（`is_daily = 1`）被显式排除在软删之外：它在笔记列表里根本不显示
    /// （`list_notes` 强制 `is_daily = 0`），用户看到的是个空文件夹，删它时不可能预期到
    /// "顺手把那天的日记也删了"。日记只会因为文件夹消失而被 ON DELETE SET NULL
    /// 置成未分类，内容与 daily_date 都还在，日记页照常能看到。
    pub fn delete_folder_cascade(&self, root_id: i64) -> Result<(usize, usize, usize), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let ids = bfs_descendant_ids(&*tx, root_id)?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let args: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();

        // 0) 先数一下会被"摘出来"的日记，删完文件夹就查不到了（folder_id 已被 SET NULL）
        let daily_sql = format!(
            "SELECT COUNT(*) FROM notes
             WHERE folder_id IN ({}) AND is_deleted = 0 AND is_daily = 1",
            placeholders
        );
        let dailies_detached: usize =
            tx.query_row(&daily_sql, params_from_iter(args.iter()), |row| {
                row.get::<_, i64>(0)
            })? as usize;

        // 1) 软删子树内未回收的普通笔记（日记不动）
        let note_sql = format!(
            "UPDATE notes SET is_deleted = 1, deleted_at = datetime('now', 'localtime') \
             WHERE folder_id IN ({}) AND is_deleted = 0 AND is_daily = 0",
            placeholders
        );
        let notes_trashed = tx.execute(&note_sql, params_from_iter(args.iter()))?;

        // 2) 物理删除整棵子树的文件夹
        let folder_sql = format!("DELETE FROM folders WHERE id IN ({})", placeholders);
        let folders_deleted = tx.execute(&folder_sql, params_from_iter(args.iter()))?;

        tx.commit()?;
        Ok((notes_trashed, folders_deleted, dailies_detached))
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

    /// 扫描全库「空文件夹」：子树内（含自身）没有任何未回收笔记。
    ///
    /// 判空口径**比列表宽**：日记 / 隐藏 / 加密笔记统统算"有内容"。清理是批量删除，
    /// 宁可少删几个也不能把还装着东西的文件夹当空壳删掉。
    ///
    /// 返回的是所有符合条件的文件夹（含嵌套的父子），调用方一次性删掉即可 ——
    /// 父文件夹只有在整棵子树都空时才会出现在结果里，所以不存在"删了父留下孤儿子"。
    pub fn list_empty_folders(&self) -> Result<Vec<EmptyFolderInfo>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT id, name, parent_id FROM folders")?;
        let rows: Vec<(i64, String, Option<i64>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        if rows.is_empty() {
            return Ok(Vec::new());
        }

        // folder_id -> 直接挂在该文件夹下的未回收笔记数
        let mut own: HashMap<i64, i64> = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT folder_id, COUNT(*) FROM notes
             WHERE is_deleted = 0 AND folder_id IS NOT NULL
             GROUP BY folder_id",
        )?;
        for r in stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))? {
            let (fid, n) = r?;
            own.insert(fid, n);
        }
        drop(stmt);

        let mut parent_of: HashMap<i64, Option<i64>> = HashMap::new();
        let mut name_of: HashMap<i64, String> = HashMap::new();
        let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
        for (id, name, parent) in &rows {
            parent_of.insert(*id, *parent);
            name_of.insert(*id, name.clone());
            if let Some(p) = parent {
                children.entry(*p).or_default().push(*id);
            }
        }

        // 自底向上累加子树笔记数。按父链深度倒序处理而不是递归 —— 树深度不可控
        // （用户可以嵌很多层），递归有爆栈风险；爬父链时带步数上限防脏数据成环。
        let mut depth: HashMap<i64, usize> = HashMap::new();
        for (id, _, _) in &rows {
            let mut d = 0usize;
            let mut cursor = parent_of.get(id).copied().flatten();
            while let Some(p) = cursor {
                d += 1;
                if d > rows.len() {
                    log::warn!("[folders] 文件夹 {} 的父链疑似成环，深度计算截断", id);
                    break;
                }
                cursor = parent_of.get(&p).copied().flatten();
            }
            depth.insert(*id, d);
        }
        let mut order: Vec<i64> = rows.iter().map(|(id, _, _)| *id).collect();
        order.sort_by_key(|id| std::cmp::Reverse(depth.get(id).copied().unwrap_or(0)));

        let mut subtree: HashMap<i64, i64> = HashMap::new();
        for id in &order {
            let mut total = own.get(id).copied().unwrap_or(0);
            if let Some(kids) = children.get(id) {
                for k in kids {
                    total += subtree.get(k).copied().unwrap_or(0);
                }
            }
            subtree.insert(*id, total);
        }

        let mut result: Vec<EmptyFolderInfo> = rows
            .iter()
            .filter(|(id, _, _)| subtree.get(id).copied().unwrap_or(0) == 0)
            .map(|(id, _, _)| EmptyFolderInfo {
                id: *id,
                path: folder_full_path(*id, &name_of, &parent_of),
            })
            .collect();
        result.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(result)
    }

    /// 批量物理删除文件夹（调用方负责确认它们是空的）。返回实际删除条数。
    ///
    /// 按 500 一批分块：清理场景动辄几千个 id，一次性拼占位符会撞 SQLite 的变量数上限。
    pub fn delete_folders_batch(&self, ids: &[i64]) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let mut deleted = 0usize;
        for chunk in ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM folders WHERE id IN ({})", placeholders);
            let args: Vec<Value> = chunk.iter().map(|id| Value::Integer(*id)).collect();
            deleted += tx.execute(&sql, params_from_iter(args.iter()))?;
        }
        tx.commit()?;
        Ok(deleted)
    }

    /// 删掉候选里"此刻确实已经空了"的文件夹（无子文件夹 + 无未回收笔记）。返回删除条数。
    ///
    /// 给导入 / 整理日记收尾用：把日记从日期文件夹里摘走后，那个日期文件夹通常就空了，
    /// 顺手清掉，别在用户笔记树里留几百个空壳。**只看候选自身、不向上追**——
    /// 候选的父级是用户自己的目录结构（如「我的日记」），不该被顺带删掉。
    pub fn prune_empty_folders(&self, candidate_ids: &[i64]) -> Result<usize, AppError> {
        if candidate_ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let mut deleted = 0usize;
        for id in candidate_ids {
            let has_child: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE parent_id = ?1)",
                params![id],
                |row| row.get::<_, i64>(0),
            )? != 0;
            if has_child {
                continue;
            }
            let has_note: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE folder_id = ?1 AND is_deleted = 0)",
                params![id],
                |row| row.get::<_, i64>(0),
            )? != 0;
            if has_note {
                continue;
            }
            deleted += tx.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(deleted)
    }

    /// 获取所有文件夹（平铺查询，含每个文件夹的笔记数），构建为树形结构
    pub fn list_folders_tree(&self) -> Result<Vec<Folder>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // note_count 与用户在笔记列表里真正看得见的口径一致：排除回收站里的和日记。
        // 否则"导入历史日记"后，日期文件夹在列表里是空的、树上却挂着 1，对不上。
        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.parent_id, f.sort_order,
                    (SELECT COUNT(*) FROM notes
                     WHERE folder_id = f.id AND is_deleted = 0 AND is_daily = 0) as note_count,
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

#[cfg(test)]
mod daily_folder_tests {
    //! 回归测试：「导入历史日记」留下的日期文件夹 vs 日记的归属关系。
    //!
    //! 真实用户反馈的链路是——日记被留在 `2020-05-26` 文件夹里，笔记列表因为
    //! `is_daily = 0` 过滤看不到它，用户以为是空文件夹；删除时被告知"还有 1 篇笔记"，
    //! 确认后当天日记进了回收站。这里盯住修复后的三条约定：
    //!   ① 统计口径：日记不算进"笔记数"，单独报
    //!   ② 级联删除：日记不进回收站，只脱钩
    //!   ③ 清理空文件夹：装着日记的文件夹**不算空**（判空口径比列表宽）

    use super::*;
    use crate::models::NoteInput;

    fn fresh_db() -> Database {
        Database::init(":memory:").expect("init :memory: 应成功（含完整迁移链）")
    }

    fn note_in(db: &Database, folder_id: Option<i64>, title: &str) -> i64 {
        db.create_note(&NoteInput {
            title: title.into(),
            content: "<p>x</p>".into(),
            folder_id,
        })
        .expect("建笔记应成功")
        .id
    }

    fn daily_in(db: &Database, folder_id: i64, title: &str, date: &str) -> i64 {
        let id = note_in(db, Some(folder_id), title);
        db.mark_note_as_daily(id, date).expect("认领日记应成功");
        id
    }

    /// 直接读库：Note 模型里没有 is_deleted / folder_id 的组合视图，测试自己查
    fn row_state(db: &Database, note_id: i64) -> (Option<i64>, i64) {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT folder_id, is_deleted FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)),
        )
        .expect("笔记应still在库里")
    }

    #[test]
    fn daily_notes_are_counted_separately_not_as_notes() {
        let db = fresh_db();
        let f = db.create_folder("2020-05-26", None).unwrap().id;
        daily_in(&db, f, "工作记录", "2020-05-26");

        let (subs, notes, dailies) = db.folder_children_count(f).unwrap();
        assert_eq!(subs, 0);
        assert_eq!(notes, 0, "日记不该算进「笔记数」——列表里根本看不到它");
        assert_eq!(dailies, 1, "但要单独报出来，否则用户以为文件夹是空的");

        let (desc, notes, dailies) = db.folder_subtree_stats(f).unwrap();
        assert_eq!(desc, 0);
        assert_eq!(notes, 0);
        assert_eq!(dailies, 1);
    }

    #[test]
    fn cascade_delete_keeps_dailies_out_of_trash() {
        let db = fresh_db();
        let f = db.create_folder("2020-05-26", None).unwrap().id;
        let daily = daily_in(&db, f, "工作记录", "2020-05-26");
        let normal = note_in(&db, Some(f), "普通笔记");

        let (trashed, folders, detached) = db.delete_folder_cascade(f).unwrap();
        assert_eq!(trashed, 1, "只有普通笔记该进回收站");
        assert_eq!(folders, 1);
        assert_eq!(detached, 1, "日记数要报给用户");

        let (daily_folder, daily_deleted) = row_state(&db, daily);
        assert_eq!(daily_deleted, 0, "🔴 日记绝不能因为删文件夹而进回收站");
        assert_eq!(daily_folder, None, "文件夹没了，日记落到未分类");
        assert!(
            db.get_daily("2020-05-26").unwrap().is_some(),
            "日记页那天照样查得到"
        );

        let (_, normal_deleted) = row_state(&db, normal);
        assert_eq!(normal_deleted, 1, "普通笔记按原逻辑进回收站");
    }

    #[test]
    fn plain_delete_no_longer_blocked_by_dailies() {
        // 用户视角是空文件夹 → 删除不该被"还有 1 篇笔记"拦住
        let db = fresh_db();
        let f = db.create_folder("2020-05-26", None).unwrap().id;
        let daily = daily_in(&db, f, "工作记录", "2020-05-26");

        let (_, notes, _) = db.folder_children_count(f).unwrap();
        assert_eq!(notes, 0, "service 层据此放行普通删除");

        assert!(db.delete_folder(f).unwrap());
        let (folder_id, deleted) = row_state(&db, daily);
        assert_eq!(deleted, 0);
        assert_eq!(folder_id, None);
    }

    #[test]
    fn empty_folder_scan_treats_dailies_as_content() {
        let db = fresh_db();
        let empty = db.create_folder("空壳", None).unwrap().id;
        let with_daily = db.create_folder("2020-05-26", None).unwrap().id;
        let with_note = db.create_folder("工作", None).unwrap().id;
        daily_in(&db, with_daily, "工作记录", "2020-05-26");
        note_in(&db, Some(with_note), "周报");

        let ids: Vec<i64> = db
            .list_empty_folders()
            .unwrap()
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert!(ids.contains(&empty), "真空文件夹要被扫出来");
        assert!(
            !ids.contains(&with_daily),
            "🔴 装着日记的文件夹不算空——批量删除宁可少删也不能误删"
        );
        assert!(!ids.contains(&with_note));
    }

    #[test]
    fn parent_is_empty_only_when_whole_subtree_is() {
        let db = fresh_db();
        let parent = db.create_folder("日记", None).unwrap().id;
        let child = db.create_folder("2020", Some(parent)).unwrap().id;
        let note = note_in(&db, Some(child), "随笔");

        let ids: Vec<i64> = db
            .list_empty_folders()
            .unwrap()
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert!(ids.is_empty(), "子里有笔记，父子都不算空");

        // 笔记进回收站后整棵子树就空了，父子都该被扫出来
        db.soft_delete_note(note).unwrap();
        let ids: Vec<i64> = db
            .list_empty_folders()
            .unwrap()
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert!(ids.contains(&parent) && ids.contains(&child));
    }

    #[test]
    fn prune_only_removes_folders_that_are_actually_empty() {
        let db = fresh_db();
        let empty = db.create_folder("2020-05-26", None).unwrap().id;
        let occupied = db.create_folder("2020-05-27", None).unwrap().id;
        note_in(&db, Some(occupied), "还在的笔记");
        let parent = db.create_folder("父", None).unwrap().id;
        db.create_folder("子", Some(parent)).unwrap();

        let removed = db.prune_empty_folders(&[empty, occupied, parent]).unwrap();
        assert_eq!(removed, 1, "只有真正空的那个被删");

        let conn = db.conn_lock().unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE id IN (?1, ?2, ?3)",
                params![empty, occupied, parent],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 2, "有笔记的、有子文件夹的都要留着");
    }

    #[test]
    fn detach_returns_old_folders_and_clears_membership() {
        let db = fresh_db();
        let f1 = db.create_folder("2020-05-26", None).unwrap().id;
        let f2 = db.create_folder("2020-05-27", None).unwrap().id;
        let a = daily_in(&db, f1, "a", "2020-05-26");
        let b = daily_in(&db, f2, "b", "2020-05-27");

        let mut folders = db.detach_notes_from_folders(&[a, b]).unwrap();
        folders.sort_unstable();
        let mut expected = vec![f1, f2];
        expected.sort_unstable();
        assert_eq!(folders, expected, "要把原文件夹报回去给 prune 收尾");
        assert_eq!(row_state(&db, a).0, None);
        assert_eq!(row_state(&db, b).0, None);

        assert_eq!(db.prune_empty_folders(&folders).unwrap(), 2);
    }

    #[test]
    fn note_count_in_tree_matches_what_the_list_shows() {
        // 树上挂的数字必须和列表口径一致：回收站里的、日记都不算
        let db = fresh_db();
        let f = db.create_folder("混合", None).unwrap().id;
        daily_in(&db, f, "日记", "2020-05-26");
        let trashed = note_in(&db, Some(f), "待删");
        note_in(&db, Some(f), "可见笔记");
        db.soft_delete_note(trashed).unwrap();

        let tree = db.list_folders_tree().unwrap();
        let node = tree.iter().find(|x| x.id == f).expect("应找到该文件夹");
        assert_eq!(node.note_count, 1, "只数用户真能看到的那一篇");
    }
}

/// 沿父链拼出 `根/子/孙` 形式的完整路径。
/// 步数上限 = 已知文件夹数，脏数据成环时截断而不是死循环。
fn folder_full_path(
    id: i64,
    name_of: &HashMap<i64, String>,
    parent_of: &HashMap<i64, Option<i64>>,
) -> String {
    let mut segs: Vec<&str> = Vec::new();
    let mut cursor = Some(id);
    let limit = name_of.len() + 1;
    while let Some(cur) = cursor {
        match name_of.get(&cur) {
            Some(name) => segs.push(name.as_str()),
            None => break,
        }
        if segs.len() > limit {
            break;
        }
        cursor = parent_of.get(&cur).copied().flatten();
    }
    segs.reverse();
    segs.join("/")
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
