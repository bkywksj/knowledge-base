use rusqlite::{params, params_from_iter, OptionalExtension};

use crate::error::AppError;
use crate::models::{DailyEntry, Note, NoteInput};

use super::Database;

impl Database {
    // ─── 笔记 DAO ─────────────────────────────────

    /// 创建笔记
    ///
    /// 同步维护：
    /// - `title_normalized`（v17）：wiki 链接查找走索引
    /// - `content_hash`（v22）：导入去重用的 SHA-256 指纹
    /// - `stable_uuid`（v36）：多端同步稳定标识，UUID v4
    pub fn create_note(&self, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        let stable_uuid = uuid::Uuid::new_v4().to_string();
        // 自定义排序下新笔记排在所属 folder 末尾：MAX(sort_order)+1000
        // 避免和用户拖排到第一位的笔记(sort_order=0)撞车 → "第一名"被新建吞掉
        // folder_id 用 ?3，子查询里复用同一参数（COALESCE 用 -1 兜底 NULL 比较）
        conn.execute(
            "INSERT INTO notes (title, content, folder_id, title_normalized, content_hash, stable_uuid, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                COALESCE(
                    (SELECT MAX(sort_order) FROM notes
                     WHERE COALESCE(folder_id, -1) = COALESCE(?3, -1) AND is_deleted = 0),
                    -1000
                ) + 1000)",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash,
                stable_uuid
            ],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 用指定的 stable_uuid 创建笔记（同步 V1 pull 用：保留远端 UUID 让多端 ID 稳定）
    ///
    /// 与 `create_note` 区别：
    /// - UUID 由调用方传入而非内部生成。冲突时返回 SQLite UNIQUE 错误，
    ///   上层 pull 流程应先用 `get_note_id_by_stable_uuid` 查重决定 update / create。
    /// - `is_daily` / `daily_date`：从远端 manifest entry 透传，恢复"每日笔记"标记
    ///   （修日记跨端反复重建）。`is_daily=false` 时 `daily_date` 强制存 NULL；
    ///   旧 manifest 不带时调用方传 `false, None`，靠 `get_or_create_daily` 兜底认领自愈。
    /// - `is_hidden`：从远端 manifest entry 透传，恢复"隐藏笔记"标记（避免隐藏笔记拉到对端变可见）。
    pub fn create_note_with_uuid(
        &self,
        input: &NoteInput,
        stable_uuid: &str,
        is_daily: bool,
        daily_date: Option<&str>,
        is_hidden: bool,
    ) -> Result<Note, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        // 防御：非日记一律不带 daily_date，避免脏数据
        let daily_date_val: Option<&str> = if is_daily { daily_date } else { None };
        conn.execute(
            "INSERT INTO notes
                (title, content, folder_id, title_normalized, content_hash, stable_uuid, is_daily, daily_date, is_hidden)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash,
                stable_uuid,
                is_daily as i32,
                daily_date_val,
                is_hidden as i32,
            ],
        )?;
        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 同步 V1 pull 用：把本地某条笔记的"每日笔记"标记对齐到远端 manifest entry。
    ///
    /// - 远端说它是日记（`is_daily=true`），本地这条 `is_daily=0` → 设 `is_daily=1, daily_date=date`，
    ///   **但前提是本地没有另一条同 `daily_date` 的真日记**（否则会出现"两条当天日记"，反而更乱）；
    ///   有冲突则跳过 + 记 warn 日志，留给用户清理。
    /// - 远端说它不是日记（`is_daily=false`），本地这条 `is_daily=1` → 清掉标记（`is_daily=0, daily_date=NULL`）。
    /// - 其余情况（两边一致）→ 无操作。
    ///
    /// **不动 `updated_at`**：元数据对齐，不算内容变更，不应触发下一轮推拉。
    pub fn sync_note_daily_state(
        &self,
        id: i64,
        is_daily: bool,
        daily_date: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let cur_is_daily: bool = match conn
            .query_row(
                "SELECT is_daily FROM notes WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        {
            Some(v) => v != 0,
            None => return Ok(()), // 笔记不在了
        };

        match (is_daily, cur_is_daily) {
            (true, false) => {
                let date = match daily_date {
                    Some(d) if !d.is_empty() => d,
                    _ => return Ok(()), // 远端说是日记却没给日期 → 不动
                };
                let conflict: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM notes
                         WHERE is_daily = 1 AND daily_date = ?1 AND is_deleted = 0 AND id != ?2
                         LIMIT 1",
                        params![date, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(other) = conflict {
                    log::warn!(
                        "[sync] note#{} 远端标记为 {} 的日记，但本地 note#{} 已占着这天 → 保持 note#{} 为普通笔记，请手动合并",
                        id, date, other, id
                    );
                    return Ok(());
                }
                conn.execute(
                    "UPDATE notes SET is_daily = 1, daily_date = ?1 WHERE id = ?2",
                    params![date, id],
                )?;
                log::info!("[sync] note#{} 从远端 manifest 恢复为 {} 的每日笔记", id, date);
            }
            (false, true) => {
                conn.execute(
                    "UPDATE notes SET is_daily = 0, daily_date = NULL WHERE id = ?1",
                    params![id],
                )?;
                log::info!("[sync] note#{} 远端已不是每日笔记 → 本地清除 is_daily 标记", id);
            }
            _ => {}
        }
        Ok(())
    }

    /// 同步 V1 pull 用：把本地某条笔记的"隐藏"标记对齐到远端 manifest entry。
    ///
    /// 只做单向恢复：**远端隐藏（`is_hidden=true`）而本地这条还可见 → 设 `is_hidden=1`**
    /// （避免隐藏笔记拉到新端变可见这个隐私问题）。反方向（远端可见、本地隐藏）不动 ——
    /// 不主动取消本地隐藏，免得误把用户刚在本端隐藏的笔记又改回可见。
    /// 不动 `updated_at`（元数据对齐，不算内容变更）。
    pub fn sync_note_hidden_state(&self, id: i64, is_hidden: bool) -> Result<(), AppError> {
        if !is_hidden {
            return Ok(()); // 单向：只做"远端隐藏 → 本地也隐藏"
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // affected=0 也无所谓（本地已隐藏，或笔记不存在）
        conn.execute(
            "UPDATE notes SET is_hidden = 1 WHERE id = ?1 AND is_hidden = 0",
            params![id],
        )?;
        Ok(())
    }

    /// 按 stable_uuid 读取笔记的 (is_encrypted, encrypted_blob)（T-S014 同步加密笔记用）
    ///
    /// 返回值含义：
    /// - `Ok(Some((true, Some(blob))))` 加密笔记 + 有密文（正常情况）
    /// - `Ok(Some((true, None)))` 加密笔记但 blob 为空（数据异常）
    /// - `Ok(Some((false, _)))` 非加密笔记
    /// - `Ok(None)` 笔记不存在
    pub fn get_note_crypto_state_by_uuid(
        &self,
        uuid: &str,
    ) -> Result<Option<(bool, Option<Vec<u8>>)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                "SELECT is_encrypted, encrypted_blob FROM notes WHERE stable_uuid = ?1",
                params![uuid],
                |row| {
                    Ok((
                        row.get::<_, i32>(0)? != 0,
                        row.get::<_, Option<Vec<u8>>>(1)?,
                    ))
                },
            )
            .optional()?;
        Ok(row)
    }

    /// T-S014：用远端 UUID 创建/更新加密笔记
    ///
    /// 行为：
    /// - 本地已有该 stable_uuid → UPDATE encrypted_blob + is_encrypted=1 + content="🔒 已加密"
    /// - 本地不存在 → INSERT 一条加密笔记（is_encrypted=1，content 占位）
    ///
    /// 占位 content 用与 T-007 一致的字符串，FTS 索引到的也是占位，自然过滤；
    /// content_hash 用 encrypted_blob 的 sha256_hex（与 manifest 算法一致）。
    pub fn upsert_encrypted_note_with_uuid(
        &self,
        uuid: &str,
        title: &str,
        encrypted_blob: &[u8],
        folder_id: Option<i64>,
    ) -> Result<i64, AppError> {
        const PLACEHOLDER: &str = "🔒 已加密";
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let normalized = crate::database::links::normalize_title(title);
        let content_hash = crate::services::hash::sha256_hex(
            &encrypted_blob
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect::<String>(),
        );

        // 先查是否已存在
        let existing_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM notes WHERE stable_uuid = ?1",
                params![uuid],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE notes SET title = ?1, title_normalized = ?2,
                        content = ?3, content_hash = ?4,
                        folder_id = ?5,
                        is_encrypted = 1, encrypted_blob = ?6,
                        is_deleted = 0, deleted_at = NULL,
                        updated_at = datetime('now', 'localtime')
                 WHERE id = ?7",
                params![
                    title,
                    normalized,
                    PLACEHOLDER,
                    content_hash,
                    folder_id,
                    encrypted_blob,
                    id
                ],
            )?;
            Ok(id)
        } else {
            conn.execute(
                "INSERT INTO notes
                    (title, content, folder_id, title_normalized, content_hash, stable_uuid,
                     is_encrypted, encrypted_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
                params![
                    title,
                    PLACEHOLDER,
                    folder_id,
                    normalized,
                    content_hash,
                    uuid,
                    encrypted_blob
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }

    /// 按 stable_uuid 查笔记 id（同步 V1 多端 upsert 用）
    ///
    /// `stable_uuid` 是 v36 引入的多端稳定标识。返回值用于 sync_v1 pull 拿到远端 manifest entry 后
    /// 判断"本地是否已有该笔记"，决定 update 还是 create。
    pub fn get_note_id_by_stable_uuid(&self, uuid: &str) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let id = conn
            .query_row(
                "SELECT id FROM notes WHERE stable_uuid = ?1",
                params![uuid],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(id)
    }

    /// 更新笔记
    ///
    /// 同步维护 `title_normalized`（v17）与 `content_hash`（v22）。
    pub fn update_note(&self, id: i64, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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

    /// 同步 V1 pull 专用：更新笔记，但 `updated_at` 用**传入的值**（远端 manifest entry 的 updated_at），
    /// 而非冒泡到 `datetime('now')`。
    ///
    /// 为什么：pull 是"被动接收远端版本"，不该把本地 `updated_at` 改成现在 —— 否则下一轮本地这条笔记的
    /// `updated_at` 莫名其妙比远端新（last-write-wins 会误判它要 push），也让"本地最近改动"时间失真。
    /// 设成远端 entry 的 `updated_at` → 本地与远端一致；内容也一致时 `content_hash` 相同 → diff 跳过。
    pub fn update_note_synced(
        &self,
        id: i64,
        input: &NoteInput,
        updated_at: &str,
    ) -> Result<Note, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        let affected = conn.execute(
            "UPDATE notes SET title = ?1, content = ?2, folder_id = ?3,
                    title_normalized = ?4,
                    content_hash = ?5,
                    updated_at = ?6
             WHERE id = ?7",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash,
                updated_at,
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
    pub fn move_notes_batch(&self, ids: &[i64], folder_id: Option<i64>) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 获取单个笔记
    ///
    /// 不过滤 `is_hidden`：wiki link [[...]] 点击跳转需要能打开隐藏笔记；
    /// 主列表/搜索等入口由各自的 DAO 方法负责过滤。
    pub fn get_note(&self, id: i64) -> Result<Option<Note>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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

    /// 批量查询若干笔记的 folder_id（轻量：只取 id+folder_id，不加载正文）。
    ///
    /// 用于按文件夹范围过滤工具结果（如 find_related 的反链来源笔记）。
    /// 返回 map: note_id -> folder_id（folder_id 为 None 表示未分类）。不存在的 id 不会出现在 map 里。
    pub fn note_folder_map(
        &self,
        ids: &[i64],
    ) -> Result<std::collections::HashMap<i64, Option<i64>>, AppError> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = (1..=ids.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT id, folder_id FROM notes WHERE id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (id, fid) = r?;
            map.insert(id, fid);
        }
        Ok(map)
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

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // 构建 WHERE 条件（始终过滤已删除 + 隐藏 + 日记）
        // T-003: is_hidden=0 在所有主列表入口强制过滤；隐藏笔记只能从 /hidden 专用页访问
        // 日记 is_daily=1 也无条件过滤：所有用户视角的「笔记列表」（主列表 / 未分类 / 文件夹）
        // 都不显示日记，日记只走 📅 每日笔记专用面板。
        // 不影响 FTS 全文搜索 / MCP / AI RAG —— 那些走独立查询路径。
        let mut conditions = vec![
            "is_deleted = 0".to_string(),
            "is_hidden = 0".to_string(),
            "is_daily = 0".to_string(),
        ];
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
            // 未分类虚拟文件夹：folder_id 为 NULL
            // （is_daily=0 在外层已强制，这里只需要补 folder 条件）
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

        let total: usize = conn.query_row(&count_sql, params_ref.as_slice(), |row| row.get(0))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
    pub fn disable_note_encryption(&self, id: i64, plaintext: &str) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
    pub fn update_encrypted_blob(&self, id: i64, blob: &[u8]) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
                    word_count, created_at, updated_at, source_file_path, source_file_type, sort_order
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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

    /// 拿到当前筛选条件下「全部」笔记的 id 列表（不分页），按 sort_by 排序。
    ///
    /// 拖拽排序专用：前端只看到当前页 12 条笔记，但 reorder 必须覆盖
    /// **整个可见集合**的 ID，否则跨页 sort_order 会被踩到 0/1000/… 撞车。
    /// WHERE 条件与 list_notes 保持完全一致。
    pub fn list_note_ids_for_reorder(
        &self,
        folder_id: Option<i64>,
        keyword: Option<&str>,
        uncategorized: bool,
        include_descendants: bool,
        sort_by: Option<&str>,
    ) -> Result<Vec<i64>, AppError> {
        let folder_ids: Option<Vec<i64>> = if let Some(fid) = folder_id {
            if include_descendants {
                Some(self.collect_descendant_folder_ids(fid)?)
            } else {
                Some(vec![fid])
            }
        } else {
            None
        };

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut conditions = vec![
            "is_deleted = 0".to_string(),
            "is_hidden = 0".to_string(),
            "is_daily = 0".to_string(),
        ];
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ids) = folder_ids {
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
            conditions.push("folder_id IS NULL".to_string());
        }

        if let Some(kw) = keyword {
            if !kw.is_empty() {
                conditions.push(format!("title LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", kw)));
            }
        }

        let where_clause = format!("WHERE {}", conditions.join(" AND "));
        let order_clause = match sort_by.unwrap_or("default") {
            "custom" => "is_pinned DESC, sort_order ASC, updated_at DESC",
            "created" => "is_pinned DESC, created_at DESC, updated_at DESC",
            "title" => "is_pinned DESC, title COLLATE NOCASE ASC, updated_at DESC",
            _ => "is_pinned DESC, updated_at DESC",
        };

        let sql = format!(
            "SELECT id FROM notes {} ORDER BY {}",
            where_clause, order_clause
        );
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let ids = stmt
            .query_map(params_ref.as_slice(), |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
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
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("UPDATE notes SET sort_order = ?1 WHERE id = ?2 AND is_deleted = 0")?;
            for (i, id) in ordered_ids.iter().enumerate() {
                stmt.execute(params![(i as i64) * 1000, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 移动笔记到文件夹
    pub fn move_note_to_folder(
        &self,
        note_id: i64,
        folder_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_deleted = 0, deleted_at = NULL
             WHERE id = ?1 AND is_deleted = 1",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 永久删除笔记
    pub fn permanent_delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE is_deleted = 1", [])?;
        Ok(affected)
    }

    /// 查询指定笔记的 source_file_path（无论是否在回收站）
    pub fn get_note_source_path(&self, id: i64) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT source_file_path FROM notes WHERE id = ?1")?;
        let path: Option<Option<String>> = stmt
            .query_row(params![id], |row| row.get::<_, Option<String>>(0))
            .ok();
        Ok(path.flatten())
    }

    /// 轻量查询单条笔记的 folder_id（不存在或 folder_id 为 NULL 都返回 None）
    /// 用于"恢复笔记前判断是否落根目录"等场景，避免读整条 Note
    pub fn get_note_folder_id(&self, id: i64) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT id, is_encrypted, content FROM notes")?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt =
            conn.prepare("SELECT id, source_file_path FROM notes WHERE is_deleted = 1")?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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
        drop(stmt);

        // 兜底：认领"伪日记" —— 早期同步协议没把 is_daily 写进 manifest，从别的端拉过来的日记
        // 会落成 is_daily=0、标题仍是程序生成的 "{date} 的日记" 的普通笔记。这里把它认领为当天日记
        // （UPDATE is_daily=1, daily_date），而不是再 INSERT 一条 → 阻止日记在多端反复增殖；
        // 也覆盖"新旧客户端共存的过渡期"（旧端推上来的 entry 还没带 is_daily）。
        let claim_title = format!("{} 的日记", date);
        let claimed_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM notes
                 WHERE title = ?1 AND is_daily = 0 AND is_deleted = 0
                 ORDER BY id ASC LIMIT 1",
                params![claim_title],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(claimed) = claimed_id {
            conn.execute(
                "UPDATE notes SET is_daily = 1, daily_date = ?1 WHERE id = ?2",
                params![date, claimed],
            )?;
            log::info!(
                "[daily] 认领同步拉来的伪日记 note#{} 为 {} 的日记（不新建，避免重复）",
                claimed,
                date
            );
            return self.get_note_inner(&conn, claimed);
        }

        // 不存在则创建
        let title = format!("{} 的日记", date);
        let normalized = crate::database::links::normalize_title(&title);
        let empty_hash = crate::services::hash::sha256_hex("");
        let stable_uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO notes (title, content, is_daily, daily_date, title_normalized, content_hash, stable_uuid)
             VALUES (?1, '', 1, ?2, ?3, ?4, ?5)",
            params![title, date, normalized, empty_hash, stable_uuid],
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

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

    /// 列出全部日记，平铺返回 (id, title, daily_date)，按 daily_date 倒序。
    ///
    /// 前端拿到后按 year/month 分组渲染（GROUP BY 在 SQL 里做也行，但 SQLite 没有
    /// 嵌套 array_agg，与其多次查询/反复 join，不如一次拉回再前端 group——日记总量
    /// 通常 ~1k 级别，前端 group 开销可忽略）。
    ///
    /// 过滤：`is_daily=1 AND is_deleted=0 AND is_hidden=0`（隐藏日记走隐藏视图）。
    pub fn list_all_dailies(&self) -> Result<Vec<DailyEntry>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, daily_date, updated_at
             FROM notes
             WHERE is_daily = 1 AND is_deleted = 0 AND is_hidden = 0
                   AND daily_date IS NOT NULL
             ORDER BY daily_date DESC",
        )?;

        let entries = stmt
            .query_map([], |row| {
                Ok(DailyEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    daily_date: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(entries)
    }

    /// 内部方法：通过已有连接获取单个笔记（避免重复锁）
    fn get_note_inner(&self, conn: &rusqlite::Connection, id: i64) -> Result<Note, AppError> {
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
    pub fn get_note_companion_conversation(&self, note_id: i64) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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

#[cfg(test)]
mod stable_uuid_tests {
    //! v36 / T-S010：notes.stable_uuid 列 + UNIQUE 索引 + 自动生成行为
    //!
    //! 用 `Database::init(":memory:")` 走完整 v0 → v36 迁移链路验证：
    //! - 迁移幂等（重复初始化不报错）
    //! - 新建笔记自动填 stable_uuid
    //! - UNIQUE 索引拦截重复
    //! - get_note_id_by_stable_uuid 能查到

    use super::*;
    use crate::database::schema;

    fn fresh_db() -> Database {
        Database::init(":memory:").expect("init :memory: 应成功（含 v0→v36 完整迁移）")
    }

    #[test]
    fn migration_creates_stable_uuid_column_and_index() {
        let db = fresh_db();
        let conn = db.conn_lock().unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(notes)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(cols.contains(&"stable_uuid".to_string()), "notes 表应有 stable_uuid 列");

        let idx: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_stable_uuid'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert!(idx.is_some(), "应创建部分唯一索引 idx_notes_stable_uuid");
    }

    #[test]
    fn schema_version_is_at_least_36() {
        let db = fresh_db();
        let conn = db.conn_lock().unwrap();
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert!(version >= 36, "迁移完成后 user_version 应 ≥ 36");
        assert_eq!(version, schema::SCHEMA_VERSION);
    }

    #[test]
    fn create_note_auto_fills_stable_uuid() {
        let db = fresh_db();
        let n1 = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let n2 = db
            .create_note(&NoteInput {
                title: "B".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();

        let (u1, u2): (String, String) = {
            let conn = db.conn_lock().unwrap();
            (
                conn.query_row(
                    "SELECT stable_uuid FROM notes WHERE id = ?1",
                    params![n1.id],
                    |r| r.get(0),
                )
                .unwrap(),
                conn.query_row(
                    "SELECT stable_uuid FROM notes WHERE id = ?1",
                    params![n2.id],
                    |r| r.get(0),
                )
                .unwrap(),
            )
        };
        assert_eq!(u1.len(), 36, "UUID v4 文本长度应为 36（含 4 个连字符）");
        assert_ne!(u1, u2, "不同笔记 UUID 必须不同");
    }

    #[test]
    fn unique_index_rejects_duplicate_stable_uuid() {
        let db = fresh_db();
        db.create_note(&NoteInput {
            title: "A".into(),
            content: "x".into(),
            folder_id: None,
        })
        .unwrap();

        // 手动 INSERT 一行使用已存在的 stable_uuid → 应被 UNIQUE 索引拦截
        let dup = {
            let conn = db.conn_lock().unwrap();
            let existing: String = conn
                .query_row("SELECT stable_uuid FROM notes LIMIT 1", [], |r| r.get(0))
                .unwrap();
            conn.execute(
                "INSERT INTO notes (title, content, title_normalized, content_hash, stable_uuid)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["dup", "y", "dup", "h", existing],
            )
        };
        assert!(dup.is_err(), "UNIQUE 约束应拒绝重复 stable_uuid");
    }

    #[test]
    fn get_note_id_by_stable_uuid_works() {
        let db = fresh_db();
        let n = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let u: String = {
            let conn = db.conn_lock().unwrap();
            conn.query_row(
                "SELECT stable_uuid FROM notes WHERE id = ?1",
                params![n.id],
                |r| r.get(0),
            )
            .unwrap()
        };

        let got = db.get_note_id_by_stable_uuid(&u).unwrap();
        assert_eq!(got, Some(n.id));

        let none = db
            .get_note_id_by_stable_uuid("00000000-0000-0000-0000-000000000000")
            .unwrap();
        assert_eq!(none, None);
    }

    // ───────── 日记重复 bug 修复：is_daily 跨端同步 + 兜底认领 ─────────

    fn note_daily_state(db: &Database, id: i64) -> (bool, Option<String>) {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT is_daily, daily_date FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, Option<String>>(1)?)),
        )
        .unwrap()
    }

    /// create_note_with_uuid 透传 is_daily / daily_date；非日记时 daily_date 强制 NULL
    #[test]
    fn create_note_with_uuid_carries_daily_fields() {
        let db = fresh_db();

        let daily = db
            .create_note_with_uuid(
                &NoteInput {
                    title: "2026-05-12 的日记".into(),
                    content: "今天写了点东西".into(),
                    folder_id: None,
                },
                "11111111-1111-1111-1111-111111111111",
                true,
                Some("2026-05-12"),
                false,
            )
            .unwrap();
        assert_eq!(note_daily_state(&db, daily.id), (true, Some("2026-05-12".into())));

        // is_daily=false 时即便传了 daily_date 也要落 NULL（防脏数据）
        let plain = db
            .create_note_with_uuid(
                &NoteInput {
                    title: "普通".into(),
                    content: "x".into(),
                    folder_id: None,
                },
                "22222222-2222-2222-2222-222222222222",
                false,
                Some("2026-05-12"),
                false,
            )
            .unwrap();
        assert_eq!(note_daily_state(&db, plain.id), (false, None));
    }

    /// get_or_create_daily 遇到"同步拉来的伪日记"（is_daily=0、标题是 "{date} 的日记"）
    /// 应认领它而不是新建 → 不会出现重复日记
    #[test]
    fn get_or_create_daily_claims_pseudo_daily_instead_of_creating() {
        let db = fresh_db();

        // 模拟早期同步：从别的端拉来一条日记，落成了 is_daily=0 的普通笔记
        let pseudo = db
            .create_note_with_uuid(
                &NoteInput {
                    title: "2026-05-12 的日记".into(),
                    content: "别的端写的内容".into(),
                    folder_id: None,
                },
                "33333333-3333-3333-3333-333333333333",
                false,
                None,
                false,
            )
            .unwrap();
        assert_eq!(note_daily_state(&db, pseudo.id), (false, None));

        // 用户打开"今天的日记" → 应认领 pseudo，而不是新建
        let got = db.get_or_create_daily("2026-05-12").unwrap();
        assert_eq!(got.id, pseudo.id, "应认领已存在的伪日记，而非新建");
        assert_eq!(got.content, "别的端写的内容", "认领时内容保持不变");
        assert_eq!(note_daily_state(&db, pseudo.id), (true, Some("2026-05-12".into())));

        // 再调一次 → 还是同一条（现在是真日记了，第一步查询就命中）
        let again = db.get_or_create_daily("2026-05-12").unwrap();
        assert_eq!(again.id, pseudo.id);

        // 全程只有 1 条 "2026-05-12 的日记"
        let cnt: i64 = {
            let conn = db.conn_lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND is_deleted = 0",
                params!["2026-05-12 的日记"],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(cnt, 1, "不能因为同步又多出一条日记");
    }

    /// get_or_create_daily 没有任何同名笔记时仍然正常新建
    #[test]
    fn get_or_create_daily_creates_when_nothing_to_claim() {
        let db = fresh_db();
        let d1 = db.get_or_create_daily("2026-05-12").unwrap();
        assert_eq!(note_daily_state(&db, d1.id), (true, Some("2026-05-12".into())));
        let d2 = db.get_or_create_daily("2026-05-12").unwrap();
        assert_eq!(d1.id, d2.id, "同一天反复调应返回同一条");
    }

    /// sync_note_daily_state：恢复（远端是日记本地不是）+ 清除（远端不是日记本地是）
    #[test]
    fn sync_note_daily_state_recovers_and_clears() {
        let db = fresh_db();
        let n = db
            .create_note(&NoteInput {
                title: "2026-05-12 的日记".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        assert_eq!(note_daily_state(&db, n.id), (false, None));

        // 远端说它是 2026-05-12 的日记 → 恢复标记
        db.sync_note_daily_state(n.id, true, Some("2026-05-12")).unwrap();
        assert_eq!(note_daily_state(&db, n.id), (true, Some("2026-05-12".into())));

        // 远端说它不是日记了 → 清掉标记
        db.sync_note_daily_state(n.id, false, None).unwrap();
        assert_eq!(note_daily_state(&db, n.id), (false, None));

        // 两边一致（都不是日记）→ 无操作、不报错
        db.sync_note_daily_state(n.id, false, None).unwrap();
        assert_eq!(note_daily_state(&db, n.id), (false, None));
    }

    /// sync_note_daily_state：本地已有同日真日记时跳过（不制造"两条当天日记"）
    #[test]
    fn sync_note_daily_state_skips_on_conflict() {
        let db = fresh_db();
        // 本地已有 2026-05-12 的真日记
        let real = db.get_or_create_daily("2026-05-12").unwrap();
        // 另一条普通笔记（比如多端各自建过日记，被同步拉过来一条）
        let other = db
            .create_note(&NoteInput {
                title: "2026-05-12 的日记".into(),
                content: "另一端的".into(),
                folder_id: None,
            })
            .unwrap();

        // 远端说 other 也是 2026-05-12 的日记 → 因为 real 占着这天，应跳过
        db.sync_note_daily_state(other.id, true, Some("2026-05-12")).unwrap();
        assert_eq!(note_daily_state(&db, other.id), (false, None), "冲突时应保持 other 为普通笔记");
        assert_eq!(note_daily_state(&db, real.id), (true, Some("2026-05-12".into())), "原日记不受影响");
    }

    // ───────── 修 Bug：隐藏笔记 is_hidden 跨端同步 ─────────

    fn note_is_hidden(db: &Database, id: i64) -> bool {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT is_hidden FROM notes WHERE id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v != 0)
        .unwrap()
    }

    /// create_note_with_uuid 透传 is_hidden
    #[test]
    fn create_note_with_uuid_carries_is_hidden() {
        let db = fresh_db();
        let hidden = db
            .create_note_with_uuid(
                &NoteInput {
                    title: "密".into(),
                    content: "x".into(),
                    folder_id: None,
                },
                "11111111-1111-1111-1111-111111111111",
                false,
                None,
                true,
            )
            .unwrap();
        assert!(note_is_hidden(&db, hidden.id), "is_hidden=true 应落到 notes.is_hidden");

        let visible = db
            .create_note_with_uuid(
                &NoteInput {
                    title: "普".into(),
                    content: "y".into(),
                    folder_id: None,
                },
                "22222222-2222-2222-2222-222222222222",
                false,
                None,
                false,
            )
            .unwrap();
        assert!(!note_is_hidden(&db, visible.id));
    }

    /// sync_note_hidden_state：远端隐藏 → 本地也隐藏；远端可见 → 本地不动（不反向取消隐藏）
    #[test]
    fn sync_note_hidden_state_one_way() {
        let db = fresh_db();
        let n = db
            .create_note(&NoteInput {
                title: "a".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        assert!(!note_is_hidden(&db, n.id));

        db.sync_note_hidden_state(n.id, true).unwrap();
        assert!(note_is_hidden(&db, n.id), "远端隐藏 → 本地隐藏");

        db.sync_note_hidden_state(n.id, false).unwrap();
        assert!(note_is_hidden(&db, n.id), "远端可见时不主动取消本地隐藏");

        db.sync_note_hidden_state(n.id, true).unwrap();
        assert!(note_is_hidden(&db, n.id), "已隐藏时再'远端隐藏'幂等");
    }

    // ───────── 修 Bug：pull 不把 updated_at 冒泡到 now ─────────

    /// update_note_synced：updated_at 用传入值，而非 datetime('now')
    #[test]
    fn update_note_synced_uses_given_timestamp() {
        let db = fresh_db();
        let n = db
            .create_note(&NoteInput {
                title: "原标题".into(),
                content: "原内容".into(),
                folder_id: None,
            })
            .unwrap();

        let fixed_ts = "2026-01-15 10:30:00";
        let updated = db
            .update_note_synced(
                n.id,
                &NoteInput {
                    title: "新标题".into(),
                    content: "新内容".into(),
                    folder_id: None,
                },
                fixed_ts,
            )
            .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.content, "新内容");
        assert_eq!(
            updated.updated_at, fixed_ts,
            "updated_at 必须用传入值，不能冒泡到 now"
        );

        // 笔记不存在 → NotFound
        let err = db
            .update_note_synced(
                999_999,
                &NoteInput {
                    title: "x".into(),
                    content: "y".into(),
                    folder_id: None,
                },
                fixed_ts,
            )
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
