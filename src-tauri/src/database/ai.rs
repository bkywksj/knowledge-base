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

    // ─── RAG 搜索 DAO ───────────────────────────

    /// 搜索相关笔记用于 RAG 上下文（基于 FTS5）
    pub fn search_notes_for_rag(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String, String)>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.content
             FROM notes_fts fts
             JOIN notes n ON n.id = fts.rowid
             WHERE notes_fts MATCH ?1
               AND n.is_deleted = 0
             ORDER BY rank
             LIMIT ?2",
        )?;
        let results = stmt
            .query_map(rusqlite::params![query, limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    }
}
