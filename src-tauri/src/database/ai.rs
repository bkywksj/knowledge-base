use crate::error::AppError;
use crate::models::{AiConversation, AiMessage, AiModel, AiModelInput};

use super::Database;

impl Database {
    // ─── AI 模型 DAO ─────────────────────────────

    /// 获取所有 AI 模型
    pub fn list_ai_models(&self) -> Result<Vec<AiModel>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, provider, api_url, api_key, model_id, is_default, created_at
             FROM ai_models ORDER BY is_default DESC, created_at",
        )?;
        let models = stmt
            .query_map([], |row| {
                Ok(AiModel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider: row.get(2)?,
                    api_url: row.get(3)?,
                    api_key: row.get(4)?,
                    model_id: row.get(5)?,
                    is_default: row.get::<_, i32>(6)? != 0,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(models)
    }

    /// 获取单个 AI 模型
    pub fn get_ai_model(&self, id: i64) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let model = conn.query_row(
            "SELECT id, name, provider, api_url, api_key, model_id, is_default, created_at
             FROM ai_models WHERE id = ?1",
            [id],
            |row| {
                Ok(AiModel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider: row.get(2)?,
                    api_url: row.get(3)?,
                    api_key: row.get(4)?,
                    model_id: row.get(5)?,
                    is_default: row.get::<_, i32>(6)? != 0,
                    created_at: row.get(7)?,
                })
            },
        )?;
        Ok(model)
    }

    /// 获取默认 AI 模型
    pub fn get_default_ai_model(&self) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let model = conn.query_row(
            "SELECT id, name, provider, api_url, api_key, model_id, is_default, created_at
             FROM ai_models WHERE is_default = 1 LIMIT 1",
            [],
            |row| {
                Ok(AiModel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider: row.get(2)?,
                    api_url: row.get(3)?,
                    api_key: row.get(4)?,
                    model_id: row.get(5)?,
                    is_default: row.get::<_, i32>(6)? != 0,
                    created_at: row.get(7)?,
                })
            },
        )?;
        Ok(model)
    }

    /// 创建 AI 模型
    pub fn create_ai_model(&self, input: &AiModelInput) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_models (name, provider, api_url, api_key, model_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                input.name,
                input.provider,
                input.api_url,
                input.api_key,
                input.model_id,
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_ai_model(id)
    }

    /// 更新 AI 模型
    pub fn update_ai_model(&self, id: i64, input: &AiModelInput) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE ai_models SET name = ?1, provider = ?2, api_url = ?3, api_key = ?4, model_id = ?5
             WHERE id = ?6",
            rusqlite::params![input.name, input.provider, input.api_url, input.api_key, input.model_id, id],
        )?;
        drop(conn);
        self.get_ai_model(id)
    }

    /// 删除 AI 模型
    pub fn delete_ai_model(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM ai_models WHERE id = ?1", [id])?;
        Ok(())
    }

    /// 设置默认 AI 模型
    pub fn set_default_ai_model(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("UPDATE ai_models SET is_default = 0", [])?;
        conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    // ─── AI 对话 DAO ─────────────────────────────

    /// 获取所有对话列表
    pub fn list_ai_conversations(&self) -> Result<Vec<AiConversation>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, title, model_id, created_at, updated_at
             FROM ai_conversations ORDER BY updated_at DESC",
        )?;
        let convs = stmt
            .query_map([], |row| {
                Ok(AiConversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(convs)
    }

    /// 创建对话
    pub fn create_ai_conversation(&self, title: &str, model_id: i64) -> Result<AiConversation, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_conversations (title, model_id) VALUES (?1, ?2)",
            rusqlite::params![title, model_id],
        )?;
        let id = conn.last_insert_rowid();
        let conv = conn.query_row(
            "SELECT id, title, model_id, created_at, updated_at FROM ai_conversations WHERE id = ?1",
            [id],
            |row| {
                Ok(AiConversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )?;
        Ok(conv)
    }

    /// 删除对话
    pub fn delete_ai_conversation(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM ai_conversations WHERE id = ?1", [id])?;
        Ok(())
    }

    /// 重命名对话
    pub fn rename_ai_conversation(&self, id: i64, title: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE ai_conversations SET title = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2",
            rusqlite::params![title, id],
        )?;
        Ok(())
    }

    /// 仅当对话标题仍为默认值时才重命名（首条消息后自动改标题用）
    ///
    /// 返回是否真的改了名，方便调用方决定要不要 emit 事件。
    pub fn rename_ai_conversation_if_default(
        &self,
        id: i64,
        new_title: &str,
    ) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE ai_conversations
             SET title = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND title = '新对话'",
            rusqlite::params![new_title, id],
        )?;
        Ok(affected > 0)
    }

    /// 切换对话使用的 AI 模型
    pub fn update_ai_conversation_model(&self, id: i64, model_id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE ai_conversations SET model_id = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2",
            rusqlite::params![model_id, id],
        )?;
        if affected == 0 {
            return Err(AppError::Custom(format!("对话 {} 不存在", id)));
        }
        Ok(())
    }

    /// 更新对话的 updated_at
    pub fn touch_ai_conversation(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE ai_conversations SET updated_at = datetime('now', 'localtime') WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ─── AI 消息 DAO ─────────────────────────────

    /// 获取对话的所有消息
    pub fn list_ai_messages(&self, conversation_id: i64) -> Result<Vec<AiMessage>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, references_json, created_at
             FROM ai_messages WHERE conversation_id = ?1 ORDER BY created_at",
        )?;
        let messages = stmt
            .query_map([conversation_id], |row| {
                Ok(AiMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    references: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    }

    /// 添加消息
    pub fn add_ai_message(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
        references: Option<&str>,
    ) -> Result<AiMessage, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_messages (conversation_id, role, content, references_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![conversation_id, role, content, references],
        )?;
        let id = conn.last_insert_rowid();
        let msg = conn.query_row(
            "SELECT id, conversation_id, role, content, references_json, created_at
             FROM ai_messages WHERE id = ?1",
            [id],
            |row| {
                Ok(AiMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    references: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        Ok(msg)
    }

    /// 删除单条消息（用于 API 失败时回滚）
    pub fn delete_ai_message(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM ai_messages WHERE id = ?1", [id])?;
        Ok(())
    }

    // ─── RAG 搜索 DAO ───────────────────────────

    /// 判断字符是否属于 CJK 区段（中日韩统一表意文字）
    ///
    /// Rust 的 `char::is_alphanumeric()` 对中文也返回 true，无法用来切分中英文。
    fn is_cjk(ch: char) -> bool {
        let c = ch as u32;
        (0x4E00..=0x9FFF).contains(&c)   // CJK Unified Ideographs
            || (0x3400..=0x4DBF).contains(&c) // CJK Extension A
            || (0x3040..=0x30FF).contains(&c) // Hiragana + Katakana
    }

    /// 从用户输入中提取有意义的关键词（过滤停用词和标点）
    ///
    /// 策略：
    /// - ASCII 字母数字：按空格/标点切分为整词（如 "Claude API"）
    /// - CJK 字符：按 bigram（2-gram）切分（"合同内容" → ["合同", "同内", "内容"]）
    ///   之所以不整串保留，是因为中文没有空格，整串几乎无法与笔记内容精确匹配；
    ///   bigram 对 LIKE '%xx%' 的召回足够好。
    pub(crate) fn extract_keywords(query: &str) -> Vec<String> {
        // 中文停用词（含常见疑问词、代词、虚词，避免 bigram 噪声）
        const STOP_WORDS: &[&str] = &[
            "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
            "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
            "自己", "这", "他", "她", "它", "吗", "什么", "怎么", "哪", "那", "里", "面",
            "里面", "这个", "那个", "还", "能", "可以", "被", "把", "给", "让", "用", "从",
            "写", "中", "吧", "呢", "啊", "哦", "嗯", "请", "帮", "关于", "介绍", "描述",
            "内容", "告诉", "解释", "如何", "为什么", "哪些", "什么样",
            // 高噪声 bigram（常与其他词粘连产生）
            "看看", "帮我", "一下", "有没", "没有", "里的", "里面", "那些",
        ];

        let mut keywords: Vec<String> = Vec::new();
        let mut ascii_buf = String::new();
        let mut cjk_buf: Vec<char> = Vec::new();

        fn flush_cjk(cjk: &mut Vec<char>, out: &mut Vec<String>) {
            match cjk.len() {
                0 => {}
                1 => out.push(cjk[0].to_string()),
                _ => {
                    for w in cjk.windows(2) {
                        out.push(w.iter().collect());
                    }
                }
            }
            cjk.clear();
        }

        for ch in query.chars() {
            if Self::is_cjk(ch) {
                if !ascii_buf.is_empty() {
                    keywords.push(std::mem::take(&mut ascii_buf));
                }
                cjk_buf.push(ch);
            } else if ch.is_alphanumeric() || ch == '_' {
                flush_cjk(&mut cjk_buf, &mut keywords);
                ascii_buf.push(ch);
            } else {
                flush_cjk(&mut cjk_buf, &mut keywords);
                if !ascii_buf.is_empty() {
                    keywords.push(std::mem::take(&mut ascii_buf));
                }
            }
        }
        flush_cjk(&mut cjk_buf, &mut keywords);
        if !ascii_buf.is_empty() {
            keywords.push(ascii_buf);
        }

        // 过滤停用词 + 去重，保留顺序
        let mut seen = std::collections::HashSet::new();
        keywords
            .into_iter()
            .filter(|w| !w.is_empty() && !STOP_WORDS.contains(&w.as_str()))
            .filter(|w| seen.insert(w.clone()))
            .collect()
    }

    /// 转义 FTS5 特殊字符
    fn escape_fts5(term: &str) -> String {
        // 用双引号包裹以转义特殊字符
        format!("\"{}\"", term.replace('"', "\"\""))
    }

    /// 搜索相关笔记用于 RAG 上下文
    ///
    /// 策略（中文友好 + 命中数排序）：
    /// 1. LIKE 按每条笔记 **命中不同关键词的数量** 降序排（含"合同"+"内容"的笔记高于只含"合同"的）
    /// 2. 若 query 里有 ASCII 单词，额外跑 FTS5 补充（英文 unicode61 可正确 tokenize）
    /// 3. 合并去重：LIKE 命中数高的优先，FTS5 用来填补 LIKE 漏掉的
    ///
    /// 为何不用 FTS5 为主：SQLite 默认 `unicode61` tokenizer 对中文按
    /// 连续 CJK 段切分（"合同内容" 是一个 token），bigram 关键词根本匹不上；
    /// 反而会因为"总结"/"句话"这类噪声 bigram 误召回无关笔记。
    pub fn search_notes_for_rag(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String, String)>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let keywords = Self::extract_keywords(query);

        // 收集 LIKE 检索用的模式（%xx%）
        let like_keywords: Vec<String> = if keywords.is_empty() {
            query
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| s.len() >= 2)
                .map(|s| format!("%{}%", s))
                .collect()
        } else {
            keywords.iter().map(|k| format!("%{}%", k)).collect()
        };

        let mut combined: Vec<(i64, String, String)> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // ─── 主通道：LIKE + 命中数排序 ────────────────────
        if !like_keywords.is_empty() {
            // 按命中不同关键词的个数降序（SUM(CASE WHEN ... THEN 1 ELSE 0 END) AS hits）
            let hit_exprs: Vec<String> = like_keywords
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    format!(
                        "(CASE WHEN n.title LIKE ?{0} OR n.content LIKE ?{0} \
                         THEN 1 ELSE 0 END)",
                        i + 1
                    )
                })
                .collect();
            let hits_sum = hit_exprs.join(" + ");
            let where_clauses: Vec<String> = like_keywords
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    format!("(n.title LIKE ?{0} OR n.content LIKE ?{0})", i + 1)
                })
                .collect();

            let sql = format!(
                "SELECT n.id, n.title, n.content, ({hits}) AS hits
                 FROM notes n
                 WHERE n.is_deleted = 0 AND ({where_})
                 ORDER BY hits DESC, n.updated_at DESC
                 LIMIT ?{limit_param}",
                hits = hits_sum,
                where_ = where_clauses.join(" OR "),
                limit_param = like_keywords.len() + 1,
            );

            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = like_keywords
                .iter()
                .map(|k| Box::new(k.clone()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            params.push(Box::new(limit as i64));

            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )?
                .filter_map(|r| r.ok());

            for r in rows {
                if seen.insert(r.0) {
                    combined.push(r);
                }
            }
        }

        // ─── 补充通道：有 ASCII 词才跑 FTS5 ────────────────
        let has_ascii_kw = keywords.iter().any(|k| k.is_ascii());
        if has_ascii_kw && combined.len() < limit {
            let fts_query = keywords
                .iter()
                .map(|k| Self::escape_fts5(k))
                .collect::<Vec<_>>()
                .join(" OR ");
            if let Ok(mut stmt) = conn.prepare(
                "SELECT n.id, n.title, n.content
                 FROM notes_fts fts
                 JOIN notes n ON n.id = fts.rowid
                 WHERE notes_fts MATCH ?1
                   AND n.is_deleted = 0
                 ORDER BY rank
                 LIMIT ?2",
            ) {
                let rows = stmt
                    .query_map(rusqlite::params![fts_query, limit as i64], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .ok()
                    .map(|rs| rs.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default();
                for r in rows {
                    if combined.len() >= limit {
                        break;
                    }
                    if seen.insert(r.0) {
                        combined.push(r);
                    }
                }
            }
        }

        combined.truncate(limit);
        Ok(combined)
    }
}
