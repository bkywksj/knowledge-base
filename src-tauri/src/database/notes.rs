use rusqlite::{params, params_from_iter, OptionalExtension};

use crate::error::AppError;
use crate::models::{Note, NoteInput};

use super::Database;

impl Database {
    // ─── 笔记 DAO ─────────────────────────────────

    /// 创建笔记
    ///
    /// 同步维护：
    /// - `title_normalized`（v17）：wiki 链接查找走索引
    /// - `content_hash`（v22）：导入去重用的 SHA-256 指纹
    pub fn create_note(&self, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        conn.execute(
            "INSERT INTO notes (title, content, folder_id, title_normalized, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash
            ],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 更新笔记
    ///
    /// 同步维护 `title_normalized`（v17）与 `content_hash`（v22）。
    pub fn update_note(&self, id: i64, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        let affected = conn.execute(
            "UPDATE notes SET title = ?1, content = ?2, folder_id = ?3,
                    title_normalized = ?4,
                    content_hash = ?5,
                    updated_at = datetime('now', 'localtime')
             WHERE id = ?6",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash,
                id
            ],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }

        self.get_note_inner(&conn, id)
    }

    /// 批量移动笔记到指定文件夹（`folder_id = None` 表示移到根目录）
    ///
    /// 只改 `folder_id`，**不碰 `updated_at`**：批量整理属于"归档动作"，
    /// 不应把大量笔记的"最近更新"时间一起冒泡到最前。
    /// 一条 `WHERE id IN (...)` SQL 完成，保证原子性。
    pub fn move_notes_batch(
        &self,
        ids: &[i64],
        folder_id: Option<i64>,
    ) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE notes SET folder_id = ? WHERE id IN ({})",
            placeholders,
        );
        // 参数顺序：[folder_id, id1, id2, ...]
        let mut args: Vec<rusqlite::types::Value> = Vec::with_capacity(ids.len() + 1);
        args.push(match folder_id {
            Some(v) => rusqlite::types::Value::Integer(v),
            None => rusqlite::types::Value::Null,
        });
        for id in ids {
            args.push(rusqlite::types::Value::Integer(*id));
        }
        let affected = conn.execute(&sql, params_from_iter(args.iter()))?;
        Ok(affected)
    }

    /// 删除笔记（永久删除，预留给未来使用）
    #[allow(dead_code)]
    pub fn delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 获取单个笔记
    ///
    /// 不过滤 `is_hidden`：wiki link [[...]] 点击跳转需要能打开隐藏笔记；
    /// 主列表/搜索等入口由各自的 DAO 方法负责过滤。
    pub fn get_note(&self, id: i64) -> Result<Option<Note>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes WHERE id = ?1",
        )?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    is_hidden: row.get::<_, i32>(7)? != 0,
                    is_encrypted: row.get::<_, i32>(8)? != 0,
                    word_count: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    source_file_path: row.get(12)?,
                    source_file_type: row.get(13)?,
                    sort_order: row.get(14)?,
                })
            })
            .ok();

        Ok(result)
    }

    /// 查询笔记列表（分页 + 可选 folder_id 和 keyword 过滤）
    ///
    /// `uncategorized=true` 时只返回 folder_id IS NULL 的笔记（"未分类"虚拟文件夹）；
    /// 与 `folder_id` 互斥，同时传 `folder_id` 优先生效。
    ///
    /// `include_descendants=true` 时点父文件夹连同子孙文件夹的笔记一起返回（默认行为，
    /// 符合用户对"文件夹=容器"的直觉）。仅在传了 `folder_id` 时生效；未分类不递归。
    pub fn list_notes(
        &self,
        folder_id: Option<i64>,
        keyword: Option<&str>,
        page: usize,
        page_size: usize,
        uncategorized: bool,
        include_descendants: bool,
        sort_by: Option<&str>,
    ) -> Result<(Vec<Note>, usize), AppError> {
        // 先在锁外算好 folder_id 列表（涉及另一次 query，避免锁内嵌套）
        // include_descendants=true 时把 root 子树所有 ID 一起塞进 IN 子句
        let folder_ids: Option<Vec<i64>> = if let Some(fid) = folder_id {
            if include_descendants {
                Some(self.collect_descendant_folder_ids(fid)?)
            } else {
                Some(vec![fid])
            }
        } else {
            None
        };

        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 构建 WHERE 条件（始终过滤已删除 + 隐藏笔记）
        // T-003: is_hidden=0 在所有主列表入口强制过滤；隐藏笔记只能从 /hidden 专用页访问
        let mut conditions = vec!["is_deleted = 0".to_string(), "is_hidden = 0".to_string()];
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ids) = folder_ids {
            // 单元素时退化为 = ?；多元素拼 IN (?,?,...)
            if ids.len() == 1 {
                conditions.push(format!("folder_id = ?{}", param_values.len() + 1));
                param_values.push(Box::new(ids[0]));
            } else {
                let start = param_values.len() + 1;
                let placeholders: String = (start..start + ids.len())
                    .map(|i| format!("?{}", i))
                    .collect::<Vec<_>>()
                    .join(",");
                conditions.push(format!("folder_id IN ({})", placeholders));
                for id in ids {
                    param_values.push(Box::new(id));
                }
            }
        } else if uncategorized {
            // 未分类虚拟文件夹：folder_id 为 NULL 的笔记
            conditions.push("folder_id IS NULL".to_string());
        }

        if let Some(kw) = keyword {
            if !kw.is_empty() {
                conditions.push(format!("title LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", kw)));
            }
        }

        let where_clause = format!("WHERE {}", conditions.join(" AND "));

        // 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM notes {}", where_clause);
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let total: usize =
            conn.query_row(&count_sql, params_ref.as_slice(), |row| row.get(0))?;

        // 查询分页数据
        let offset = (page.saturating_sub(1)) * page_size;
        // 置顶笔记永远优先（is_pinned DESC），二级排序由 sort_by 决定。
        // 兜底全部带上 updated_at DESC 防止同值时顺序抖动。
        let order_clause = match sort_by.unwrap_or("default") {
            "custom" => "is_pinned DESC, sort_order ASC, updated_at DESC",
            "created" => "is_pinned DESC, created_at DESC, updated_at DESC",
            "title" => "is_pinned DESC, title COLLATE NOCASE ASC, updated_at DESC",
            // "default" 及未知值都走 updated_at DESC
            _ => "is_pinned DESC, updated_at DESC",
        };
        let data_sql = format!(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes {} ORDER BY {} LIMIT ?{} OFFSET ?{}",
            where_clause,
            order_clause,
            param_values.len() + 1,
            param_values.len() + 2,
        );

        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = param_values;
        all_params.push(Box::new(page_size as i64));
        all_params.push(Box::new(offset as i64));

        let all_params_ref: Vec<&dyn rusqlite::types::ToSql> =
            all_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&data_sql)?;
        let notes = stmt
            .query_map(all_params_ref.as_slice(), |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    is_hidden: row.get::<_, i32>(7)? != 0,
                    is_encrypted: row.get::<_, i32>(8)? != 0,
                    word_count: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    source_file_path: row.get(12)?,
                    source_file_type: row.get(13)?,
                    sort_order: row.get(14)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok((notes, total))
    }

    // ─── T-007 笔记加密 DAO ────────────────────────

    /// 启用加密：写入密文 + 占位 content + 标记 is_encrypted=1
    ///
    /// `placeholder` 是 content 列要写入的占位字符串（前端 Modal 里给用户看"🔒 已加密"）。
    /// 真实明文已在上层用 vault key 加密成 blob，这里只负责落库。
    pub fn enable_note_encryption(
        &self,
        id: i64,
        placeholder: &str,
        blob: &[u8],
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes
             SET is_encrypted = 1, encrypted_blob = ?1, content = ?2,
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?3 AND is_deleted = 0",
            params![blob, placeholder, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 取消加密：还原明文到 content + 清空 encrypted_blob + is_encrypted=0
    pub fn disable_note_encryption(
        &self,
        id: i64,
        plaintext: &str,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes
             SET is_encrypted = 0, encrypted_blob = NULL, content = ?1,
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND is_deleted = 0",
            params![plaintext, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 查询笔记是否处于加密态。笔记不存在或已软删返回 NotFound。
    /// ImageService 落盘 / 渲染前需要先反查这个，决定走加密分支还是明文分支。
    pub fn get_note_is_encrypted(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let flag: Option<i32> = conn
            .query_row(
                "SELECT is_encrypted FROM notes WHERE id = ?1 AND is_deleted = 0",
                params![id],
                |row| row.get(0),
            )
            .ok();
        flag.map(|v| v != 0)
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))
    }

    /// 读取加密笔记的 blob（未解密）。调用方拿到后用 vault 解密
    pub fn get_encrypted_blob(&self, id: i64) -> Result<Option<Vec<u8>>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT encrypted_blob FROM notes WHERE id = ?1 AND is_deleted = 0 AND is_encrypted = 1",
                params![id],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .ok()
            .flatten();
        Ok(result)
    }

    /// 更新加密笔记的密文（不改 is_encrypted / placeholder；用于"已加密态下编辑"保存）
    ///
    /// 预留给 T-007b：解锁态下直接在编辑器里编辑加密笔记，保存时重加密写回。
    /// v1 的流程是"取消加密 → 编辑 → 重新加密"，暂未调用。
    #[allow(dead_code)]
    pub fn update_encrypted_blob(
        &self,
        id: i64,
        blob: &[u8],
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET encrypted_blob = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND is_deleted = 0 AND is_encrypted = 1",
            params![blob, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或未处于加密态",
                id
            )));
        }
        Ok(())
    }

    // ─── T-003 隐藏笔记 DAO ─────────────────────────

    /// 切换笔记的"隐藏"状态
    ///
    /// 隐藏后主列表 / 搜索 / 反链 / 图谱 / RAG 全部不显示；取消隐藏立刻恢复可见。
    /// 返回切换后的新状态（true=已隐藏）。
    pub fn set_note_hidden(&self, id: i64, hidden: bool) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_hidden = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND is_deleted = 0",
            params![i32::from(hidden), id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(hidden)
    }

    /// 列出所有隐藏笔记（分页），按 updated_at DESC
    ///
    /// 与 list_notes 刚好相反——只取 is_hidden=1（仍过滤 is_deleted=0）。
    /// 可按目录过滤：
    /// - `uncategorized = true` → 只看 folder_id IS NULL
    /// - `folder_id = Some(n)` → 只看该目录（不递归子目录，与 list_notes 现有语义一致）
    /// - 两者都不传 → 全部
    pub fn list_hidden_notes(
        &self,
        page: usize,
        page_size: usize,
        folder_id: Option<i64>,
        uncategorized: bool,
    ) -> Result<(Vec<Note>, usize), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 拼 WHERE 子句：uncategorized 优先级高于 folder_id
        let (extra_where, has_folder_param) = if uncategorized {
            (" AND folder_id IS NULL", false)
        } else if folder_id.is_some() {
            (" AND folder_id = ?1", true)
        } else {
            ("", false)
        };

        let count_sql = format!(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0 AND is_hidden = 1{}",
            extra_where
        );
        let total: usize = if has_folder_param {
            conn.query_row(&count_sql, params![folder_id.unwrap()], |row| row.get(0))?
        } else {
            conn.query_row(&count_sql, [], |row| row.get(0))?
        };

        let offset = (page.saturating_sub(1)) * page_size;
        let select_sql = format!(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted,
                    word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes
             WHERE is_deleted = 0 AND is_hidden = 1{}
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?",
            extra_where
        );
        let mut stmt = conn.prepare(&select_sql)?;
        let row_mapper = |row: &rusqlite::Row<'_>| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder_id: row.get(3)?,
                is_daily: row.get::<_, i32>(4)? != 0,
                daily_date: row.get(5)?,
                is_pinned: row.get::<_, i32>(6)? != 0,
                is_hidden: row.get::<_, i32>(7)? != 0,
                is_encrypted: row.get::<_, i32>(8)? != 0,
                word_count: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                source_file_path: row.get(12)?,
                source_file_type: row.get(13)?,
                sort_order: row.get(14)?,
            })
        };
        let notes = if has_folder_param {
            stmt.query_map(
                params![folder_id.unwrap(), page_size as i64, offset as i64],
                row_mapper,
            )?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map(params![page_size as i64, offset as i64], row_mapper)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok((notes, total))
    }

    /// 返回所有"含至少一篇隐藏笔记"的 folder_id（含 None 表示有未分类的隐藏笔记）
    ///
    /// 顺序：NULL 在前（"未分类"语义上排首位），其余按 folder_id ASC。
    pub fn list_hidden_folder_ids(&self) -> Result<Vec<Option<i64>>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT folder_id FROM notes
             WHERE is_deleted = 0 AND is_hidden = 1
             ORDER BY folder_id IS NULL DESC, folder_id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, Option<i64>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ─── 置顶 & 移动 DAO ─────────────────────────

    /// 切换笔记置顶状态
    pub fn toggle_pin(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END,
                    updated_at = datetime('now', 'localtime')
             WHERE id = ?1 AND is_deleted = 0",
            params![id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }

        let is_pinned: bool = conn.query_row(
            "SELECT is_pinned FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, i32>(0).map(|v| v != 0),
        )?;

        Ok(is_pinned)
    }

    /// 批量重排笔记的 sort_order（同 folder 内一次性按给定顺序赋值 0/1000/2000…）
    ///
    /// 调用约定：`ordered_ids` 为同一 folder（或同一虚拟分组，如未分类）内**完整**的
    /// 笔记 ID 顺序列表。本函数不校验 folder_id 一致性——前端拿到该 folder 当前
    /// 的全部笔记后调用即可，间隔 1000 留给未来插队。
    ///
    /// 用事务保证原子性：要么全部更新成功要么全部回滚。
    pub fn reorder_notes(&self, ordered_ids: &[i64]) -> Result<(), AppError> {
        if ordered_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE notes SET sort_order = ?1 WHERE id = ?2 AND is_deleted = 0",
            )?;
            for (i, id) in ordered_ids.iter().enumerate() {
                stmt.execute(params![(i as i64) * 1000, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 移动笔记到文件夹
    pub fn move_note_to_folder(&self, note_id: i64, folder_id: Option<i64>) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE notes SET folder_id = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND is_deleted = 0",
            params![folder_id, note_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", note_id)));
        }

        Ok(())
    }

    // ─── 回收站 DAO ──────────────────────────────

    /// 软删除笔记（移入回收站）
    pub fn soft_delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_deleted = 1, deleted_at = datetime('now', 'localtime')
             WHERE id = ?1 AND is_deleted = 0",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 批量软删除（移入回收站）；返回实际标记删除的条数
    /// 已经在回收站的笔记会被忽略（WHERE is_deleted = 0）
    pub fn soft_delete_notes_batch(&self, ids: &[i64]) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE notes SET is_deleted = 1, deleted_at = datetime('now', 'localtime')
             WHERE id IN ({}) AND is_deleted = 0",
            placeholders,
        );
        let args: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|id| rusqlite::types::Value::Integer(*id))
            .collect();
        let affected = conn.execute(&sql, params_from_iter(args.iter()))?;
        Ok(affected)
    }

    /// 恢复笔记（从回收站恢复）
    pub fn restore_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_deleted = 0, deleted_at = NULL
             WHERE id = ?1 AND is_deleted = 1",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 永久删除笔记
    pub fn permanent_delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "DELETE FROM notes WHERE id = ?1 AND is_deleted = 1",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 查询回收站笔记列表（分页）
    pub fn list_trash(
        &self,
        page: usize,
        page_size: usize,
    ) -> Result<(Vec<Note>, usize), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 查询总数
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 1",
            [],
            |row| row.get(0),
        )?;

        // 查询分页数据
        let offset = (page.saturating_sub(1)) * page_size;
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes WHERE is_deleted = 1
             ORDER BY deleted_at DESC
             LIMIT ?1 OFFSET ?2",
        )?;

        let notes = stmt
            .query_map(params![page_size as i64, offset as i64], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    is_hidden: row.get::<_, i32>(7)? != 0,
                    is_encrypted: row.get::<_, i32>(8)? != 0,
                    word_count: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    source_file_path: row.get(12)?,
                    source_file_type: row.get(13)?,
                    sort_order: row.get(14)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok((notes, total))
    }

    /// 清空回收站
    pub fn empty_trash(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE is_deleted = 1", [])?;
        Ok(affected)
    }

    /// 查询指定笔记的 source_file_path（无论是否在回收站）
    pub fn get_note_source_path(&self, id: i64) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT source_file_path FROM notes WHERE id = ?1")?;
        let path: Option<Option<String>> = stmt
            .query_row(params![id], |row| row.get::<_, Option<String>>(0))
            .ok();
        Ok(path.flatten())
    }

    /// 轻量查询单条笔记的 folder_id（不存在或 folder_id 为 NULL 都返回 None）
    /// 用于"恢复笔记前判断是否落根目录"等场景，避免读整条 Note
    pub fn get_note_folder_id(&self, id: i64) -> Result<Option<i64>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT folder_id FROM notes WHERE id = ?1")?;
        let fid: Option<Option<i64>> = stmt
            .query_row(params![id], |row| row.get::<_, Option<i64>>(0))
            .ok();
        Ok(fid.flatten())
    }

    /// 列出所有笔记的 (id, is_encrypted, content) —— 含回收站。
    /// 加密笔记的 content 是密文占位符，孤儿扫描里调用方应跳过其 content
    /// 但保留 id 用于"该笔记目录下的素材整体放过"判定。
    pub fn list_all_contents_for_orphan_scan(
        &self,
    ) -> Result<Vec<(i64, bool, Option<String>)>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, is_encrypted, content FROM notes",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i32>(1)? != 0,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 列出所有笔记的 source_file_path（非空），用于孤儿 PDF/源文件扫描。
    /// 含回收站笔记 —— 回收站撤回时还要用。
    pub fn list_all_source_file_paths(&self) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT source_file_path FROM notes
             WHERE source_file_path IS NOT NULL AND source_file_path <> ''",
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 列出回收站内所有笔记的 (id, source_file_path) —— 用于清理时遍历
    pub fn list_trash_ids_with_sources(&self) -> Result<Vec<(i64, Option<String>)>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn
            .prepare("SELECT id, source_file_path FROM notes WHERE is_deleted = 1")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 将所有笔记批量移到回收站（软删）
    /// 只影响 is_deleted = 0 的笔记；已在回收站的保持不变。
    pub fn trash_all_notes(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes
             SET is_deleted = 1,
                 deleted_at = datetime('now', 'localtime')
             WHERE is_deleted = 0",
            [],
        )?;
        Ok(affected)
    }

    // ─── 每日笔记 DAO ────────────────────────────

    /// 查询每日笔记（不创建）
    pub fn get_daily(&self, date: &str) -> Result<Option<Note>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes WHERE is_daily = 1 AND daily_date = ?1 AND is_deleted = 0",
        )?;

        let existing = stmt
            .query_row(params![date], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    is_hidden: row.get::<_, i32>(7)? != 0,
                    is_encrypted: row.get::<_, i32>(8)? != 0,
                    word_count: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    source_file_path: row.get(12)?,
                    source_file_type: row.get(13)?,
                    sort_order: row.get(14)?,
                })
            })
            .ok();

        Ok(existing)
    }

    /// 获取或创建每日笔记
    pub fn get_or_create_daily(&self, date: &str) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 先查询是否已存在
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes WHERE is_daily = 1 AND daily_date = ?1 AND is_deleted = 0",
        )?;

        let existing = stmt
            .query_row(params![date], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    is_hidden: row.get::<_, i32>(7)? != 0,
                    is_encrypted: row.get::<_, i32>(8)? != 0,
                    word_count: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    source_file_path: row.get(12)?,
                    source_file_type: row.get(13)?,
                    sort_order: row.get(14)?,
                })
            })
            .ok();

        if let Some(note) = existing {
            return Ok(note);
        }

        // 不存在则创建
        let title = format!("{} 的日记", date);
        let normalized = crate::database::links::normalize_title(&title);
        let empty_hash = crate::services::hash::sha256_hex("");
        conn.execute(
            "INSERT INTO notes (title, content, is_daily, daily_date, title_normalized, content_hash)
             VALUES (?1, '', 1, ?2, ?3, ?4)",
            params![title, date, normalized, empty_hash],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 获取有日记的日期列表（用于日历标记）
    /// 找当前日期的相邻日记（仅返回真实存在的日记，跳过没写的日子）。
    /// 用于每日笔记顶部的 ← / → 箭头按"上一篇/下一篇真实存在的日记"跳转。
    /// `(prev, next)`：分别是 < date 的最近一条 + > date 的最近一条；不存在时返回 None。
    pub fn get_daily_neighbors(
        &self,
        date: &str,
    ) -> Result<(Option<String>, Option<String>), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let prev: Option<String> = conn
            .query_row(
                "SELECT daily_date FROM notes
                 WHERE is_daily = 1 AND is_deleted = 0 AND daily_date < ?1
                 ORDER BY daily_date DESC LIMIT 1",
                params![date],
                |row| row.get(0),
            )
            .optional()?;
        let next: Option<String> = conn
            .query_row(
                "SELECT daily_date FROM notes
                 WHERE is_daily = 1 AND is_deleted = 0 AND daily_date > ?1
                 ORDER BY daily_date ASC LIMIT 1",
                params![date],
                |row| row.get(0),
            )
            .optional()?;
        Ok((prev, next))
    }

    pub fn list_daily_dates(&self, year: i32, month: i32) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let pattern = format!("{}-{:02}-%", year, month);
        let mut stmt = conn.prepare(
            "SELECT daily_date FROM notes
             WHERE is_daily = 1 AND is_deleted = 0 AND daily_date LIKE ?1
             ORDER BY daily_date DESC",
        )?;

        let dates = stmt
            .query_map(params![pattern], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(dates)
    }

    /// 内部方法：通过已有连接获取单个笔记（避免重复锁）
    fn get_note_inner(
        &self,
        conn: &rusqlite::Connection,
        id: i64,
    ) -> Result<Note, AppError> {
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, is_hidden, is_encrypted, word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
             FROM notes WHERE id = ?1",
        )?;

        let note = stmt.query_row(params![id], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                folder_id: row.get(3)?,
                is_daily: row.get::<_, i32>(4)? != 0,
                daily_date: row.get(5)?,
                is_pinned: row.get::<_, i32>(6)? != 0,
                is_hidden: row.get::<_, i32>(7)? != 0,
                is_encrypted: row.get::<_, i32>(8)? != 0,
                word_count: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                source_file_path: row.get(12)?,
                source_file_type: row.get(13)?,
                sort_order: row.get(14)?,
            })
        })?;

        Ok(note)
    }

    /// 更新笔记的源文件路径与类型
    pub fn set_note_source_file(
        &self,
        id: i64,
        path: Option<&str>,
        file_type: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET source_file_path = ?1, source_file_type = ?2 WHERE id = ?3",
            params![path, file_type, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 标记笔记的 AI 对话归档来源（B 方向：AI 对话 → 笔记）
    ///
    /// 给"从笔记跳回原 AI 对话"的反向追溯能力用。设为 None 解除关联。
    pub fn set_note_from_ai_conversation(
        &self,
        note_id: i64,
        conversation_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET from_ai_conversation_id = ?1 WHERE id = ?2",
            params![conversation_id, note_id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", note_id)));
        }
        Ok(())
    }

    /// 读笔记的伴生 AI 对话 ID（编辑器右侧抽屉用）
    ///
    /// 返回 None 时调用方应负责创建一条新对话，再 set_note_companion_conversation 写回。
    pub fn get_note_companion_conversation(
        &self,
        note_id: i64,
    ) -> Result<Option<i64>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let result: Option<i64> = conn
            .query_row(
                "SELECT companion_conversation_id FROM notes WHERE id = ?1",
                [note_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten();
        Ok(result)
    }

    /// 关联笔记的伴生 AI 对话 ID（None 解除）
    pub fn set_note_companion_conversation(
        &self,
        note_id: i64,
        conversation_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET companion_conversation_id = ?1 WHERE id = ?2",
            params![conversation_id, note_id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", note_id)));
        }
        Ok(())
    }

    /// 按 source_file_path 查找未被删除的笔记，返回 (id, content)
    ///
    /// 用于 .md 文件重复打开去重：若已有导入过的同路径笔记，直接跳过去而不是新建。
    pub fn find_active_note_by_source_path(
        &self,
        path: &str,
    ) -> Result<Option<(i64, String)>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, content FROM notes
             WHERE source_file_path = ?1 AND is_deleted = 0
             LIMIT 1",
        )?;
        let result = stmt
            .query_row([path], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .ok();
        Ok(result)
    }

    /// 只更新笔记正文，不动 title/folder_id/source_file_path 等元数据
    ///
    /// 用于"外部编辑过 md 源文件 → 重新打开时同步回笔记"的场景。
    /// 同步更新 content_hash（v22）。
    pub fn update_note_content(&self, id: i64, content: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let content_hash = crate::services::hash::sha256_hex(content);
        let affected = conn.execute(
            "UPDATE notes SET content = ?1, content_hash = ?2,
                    updated_at = datetime('now','localtime')
             WHERE id = ?3",
            params![content, content_hash, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 按 (title, content_hash) 查活跃笔记的 id —— 导入去重的兜底
    ///
    /// 和 `find_active_note_by_source_path` 的关系：
    /// 主判用 source_file_path；若用户把源文件搬动过，path 匹配不到，再用
    /// (title, content_hash) 兜底匹配"同标题+同内容"的已存在笔记。
    /// 故意用 AND 而非仅 hash——标题被改过说明用户主动区分，不该算重复。
    pub fn find_active_note_by_title_and_hash(
        &self,
        title: &str,
        content_hash: &str,
    ) -> Result<Option<i64>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id FROM notes
             WHERE title = ?1 AND content_hash = ?2 AND is_deleted = 0
             LIMIT 1",
        )?;
        let result = stmt
            .query_row(params![title, content_hash], |row| row.get::<_, i64>(0))
            .ok();
        Ok(result)
    }
}
