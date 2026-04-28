use crate::error::AppError;
use crate::models::{AiConversation, AiMessage, AiModel, AiModelInput};

use super::Database;

/// 把一行 ai_models 查询结果转成 AiModel
///
/// 列顺序约定（v25 起 9 列）：
///   id, name, provider, api_url, api_key, model_id, is_default, max_context, created_at
fn row_to_ai_model(row: &rusqlite::Row) -> rusqlite::Result<AiModel> {
    Ok(AiModel {
        id: row.get(0)?,
        name: row.get(1)?,
        provider: row.get(2)?,
        api_url: row.get(3)?,
        api_key: row.get(4)?,
        model_id: row.get(5)?,
        is_default: row.get::<_, i32>(6)? != 0,
        max_context: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// 标准 ai_models 查询列表达式（与 row_to_ai_model 对齐）
const AI_MODEL_COLS: &str = "id, name, provider, api_url, api_key, model_id, is_default, max_context, created_at";

/// 把一行 ai_conversations 查询结果转成 AiConversation
///
/// 列顺序约定（v25 起 6 列）：
///   id, title, model_id, attached_note_ids, created_at, updated_at
fn row_to_ai_conversation(row: &rusqlite::Row) -> rusqlite::Result<AiConversation> {
    let attached_json: String = row.get(3)?;
    // 反序列化失败回退空数组（防御性：旧数据 / 手动改坏的情况下不让查询炸）
    let attached_note_ids: Vec<i64> =
        serde_json::from_str(&attached_json).unwrap_or_default();
    Ok(AiConversation {
        id: row.get(0)?,
        title: row.get(1)?,
        model_id: row.get(2)?,
        attached_note_ids,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const AI_CONV_COLS: &str = "id, title, model_id, attached_note_ids, created_at, updated_at";

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时文件里初始化一个空库，用来跑 DAO 单测
    ///
    /// 1. 用全局原子计数器保证不同测试拿不同 db 路径（nano 时戳并发会撞，导致 SQLite locked）
    /// 2. schema v4 会预置一条 "Ollama Llama3" 默认模型（生产场景给新用户兜底用），
    ///    测试里为了精确控制状态，先清空 ai_models 表再返回
    fn temp_db() -> Database {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kb_test_{}_{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let db = Database::init(path.to_str().unwrap()).expect("init test db");
        // 清掉 schema seed 出来的默认 Ollama 行，给测试一个干净的起点
        {
            let conn = db.conn.lock().expect("lock test db");
            conn.execute("DELETE FROM ai_models", [])
                .expect("clear ai_models");
        }
        db
    }

    fn input(name: &str) -> AiModelInput {
        AiModelInput {
            name: name.into(),
            provider: "custom".into(),
            api_url: "http://localhost".into(),
            api_key: None,
            model_id: "test-model".into(),
            max_context: None,
        }
    }

    #[test]
    fn delete_default_picks_next_as_default() {
        let db = temp_db();
        let m1 = db.create_ai_model(&input("first")).unwrap();
        let m2 = db.create_ai_model(&input("second")).unwrap();
        // 把 m1 设为默认
        db.set_default_ai_model(m1.id).unwrap();

        // 删默认 → m2 应自动成为新默认
        db.delete_ai_model(m1.id).unwrap();
        let after = db.list_ai_models().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, m2.id);
        assert!(
            after[0].is_default,
            "删除默认后剩下的那条应自动被标为 default"
        );
        // get_default 不应再返回 NotFound
        let d = db.get_default_ai_model().expect("应能拿到新默认");
        assert_eq!(d.id, m2.id);
    }

    #[test]
    fn delete_non_default_leaves_default_intact() {
        let db = temp_db();
        let m1 = db.create_ai_model(&input("first")).unwrap();
        let m2 = db.create_ai_model(&input("second")).unwrap();
        db.set_default_ai_model(m1.id).unwrap();

        // 删非默认（m2）→ m1 仍是默认
        db.delete_ai_model(m2.id).unwrap();
        let d = db.get_default_ai_model().unwrap();
        assert_eq!(d.id, m1.id);
    }

    #[test]
    fn delete_only_model_does_not_panic() {
        let db = temp_db();
        let m1 = db.create_ai_model(&input("only")).unwrap();
        db.set_default_ai_model(m1.id).unwrap();

        // 删完一条不剩；不应 panic / 不应留 is_default=0 的孤儿
        db.delete_ai_model(m1.id).unwrap();
        let after = db.list_ai_models().unwrap();
        assert_eq!(after.len(), 0);
        // get_default 这时应该是 NotFound（前端会显示"请先添加 AI 模型"）
        assert!(db.get_default_ai_model().is_err());
    }

    #[test]
    fn delete_nonexistent_id_is_idempotent() {
        let db = temp_db();
        // 库里没东西；删一个不存在的 id 不应报错
        db.delete_ai_model(999).unwrap();
    }
}

impl Database {
    // ─── AI 模型 DAO ─────────────────────────────

    /// 获取所有 AI 模型
    pub fn list_ai_models(&self) -> Result<Vec<AiModel>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM ai_models ORDER BY is_default DESC, created_at",
            AI_MODEL_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let models = stmt
            .query_map([], row_to_ai_model)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(models)
    }

    /// 获取单个 AI 模型
    pub fn get_ai_model(&self, id: i64) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!("SELECT {} FROM ai_models WHERE id = ?1", AI_MODEL_COLS);
        let model = conn.query_row(&sql, [id], row_to_ai_model)?;
        Ok(model)
    }

    /// 获取默认 AI 模型
    pub fn get_default_ai_model(&self) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        // 1) 优先查 is_default=1
        let sql_default = format!(
            "SELECT {} FROM ai_models WHERE is_default = 1 LIMIT 1",
            AI_MODEL_COLS
        );
        let primary = conn.query_row(&sql_default, [], row_to_ai_model);
        if let Ok(m) = primary {
            return Ok(m);
        }

        // 2) T-B02 兜底：库里有模型但没有任何默认（历史脏数据 / 多端同步遗留），
        //    取最早一条做默认 + 顺手 promote 它，避免下次再走兜底
        let sql_fallback = format!(
            "SELECT {} FROM ai_models ORDER BY created_at ASC, id ASC LIMIT 1",
            AI_MODEL_COLS
        );
        let fallback: AiModel = conn
            .query_row(&sql_fallback, [], row_to_ai_model)
            .map_err(|_| AppError::NotFound(
                "尚未配置任何 AI 模型，请到设置页添加".into(),
            ))?;
        let _ = conn.execute(
            "UPDATE ai_models SET is_default = 1 WHERE id = ?1",
            [fallback.id],
        );
        log::info!(
            "[ai] 库内无默认标记，自动 promote #{} 为默认（兜底 T-B02）",
            fallback.id
        );
        Ok(AiModel { is_default: true, ..fallback })
    }

    /// 创建 AI 模型
    pub fn create_ai_model(&self, input: &AiModelInput) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        // max_context 缺省时走表 DEFAULT 32000
        let max_ctx = input.max_context.unwrap_or(32000).max(1000);
        conn.execute(
            "INSERT INTO ai_models (name, provider, api_url, api_key, model_id, max_context)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                input.name,
                input.provider,
                input.api_url,
                input.api_key,
                input.model_id,
                max_ctx,
            ],
        )?;
        let id = conn.last_insert_rowid();

        // T-B02: 当前没有任何默认模型时（首次新建 / 之前默认的被删了），
        // 自动把新建的这条设为默认；避免后续 get_default_ai_model 报 NoRows。
        let has_default: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_models WHERE is_default = 1",
                [],
                |row| row.get::<_, i64>(0).map(|c| c > 0),
            )
            .unwrap_or(false);
        if !has_default {
            conn.execute(
                "UPDATE ai_models SET is_default = 1 WHERE id = ?1",
                [id],
            )?;
            log::info!(
                "[ai] 库内无默认模型，已自动把新建 #{} 设为默认（修 T-B02）",
                id
            );
        }

        drop(conn);
        self.get_ai_model(id)
    }

    /// 更新 AI 模型
    pub fn update_ai_model(&self, id: i64, input: &AiModelInput) -> Result<AiModel, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        // 用户没传 max_context 时保持原值，避免覆盖成默认 32000
        let max_ctx = input.max_context.unwrap_or(32000).max(1000);
        conn.execute(
            "UPDATE ai_models SET name = ?1, provider = ?2, api_url = ?3, api_key = ?4,
                 model_id = ?5, max_context = ?6
             WHERE id = ?7",
            rusqlite::params![
                input.name, input.provider, input.api_url, input.api_key,
                input.model_id, max_ctx, id
            ],
        )?;
        drop(conn);
        self.get_ai_model(id)
    }

    /// 删除 AI 模型
    ///
    /// T-B02 修复：删除的是默认配置时，自动把剩下的第一条标为默认；
    /// 否则用户在 /ai 页问问题会因 `get_default_ai_model` 返回 NotFound 而整个 AI 模块崩溃。
    /// 如果删完一条不剩，就什么都不做（前端会显示"请先添加 AI 模型"）。
    ///
    /// 全程在一个事务里跑：删 + 选下一个 + UPDATE 是原子的，
    /// 中途失败不会留下"全部 is_default=0"的状态。
    pub fn delete_ai_model(&self, id: i64) -> Result<(), AppError> {
        let mut conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;

        // 先看待删的是不是当前默认
        let was_default: bool = tx
            .query_row(
                "SELECT is_default FROM ai_models WHERE id = ?1",
                [id],
                |row| row.get::<_, i32>(0).map(|v| v != 0),
            )
            .unwrap_or(false);

        let affected = tx.execute("DELETE FROM ai_models WHERE id = ?1", [id])?;
        if affected == 0 {
            // 本来就不存在；幂等返回
            tx.commit()?;
            return Ok(());
        }

        if was_default {
            // 选剩下最早创建的一条作为新默认
            let next_id: Option<i64> = tx
                .query_row(
                    "SELECT id FROM ai_models ORDER BY created_at ASC, id ASC LIMIT 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .ok();
            if let Some(next) = next_id {
                tx.execute(
                    "UPDATE ai_models SET is_default = 1 WHERE id = ?1",
                    [next],
                )?;
                log::info!(
                    "[ai] 删除默认模型 #{} 后，自动把 #{} 设为新默认",
                    id, next
                );
            } else {
                log::info!("[ai] 删除最后一条 AI 模型 #{}，已无可用模型", id);
            }
        }

        tx.commit()?;
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
        let sql = format!(
            "SELECT {} FROM ai_conversations ORDER BY updated_at DESC",
            AI_CONV_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let convs = stmt
            .query_map([], row_to_ai_conversation)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(convs)
    }

    /// 单条对话查询（给"挂载笔记"等需要读取附加列表的场景）
    pub fn get_ai_conversation(&self, id: i64) -> Result<AiConversation, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM ai_conversations WHERE id = ?1",
            AI_CONV_COLS
        );
        let conv = conn.query_row(&sql, [id], row_to_ai_conversation)?;
        Ok(conv)
    }

    /// 创建对话
    pub fn create_ai_conversation(&self, title: &str, model_id: i64) -> Result<AiConversation, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_conversations (title, model_id) VALUES (?1, ?2)",
            rusqlite::params![title, model_id],
        )?;
        let id = conn.last_insert_rowid();
        let sql = format!(
            "SELECT {} FROM ai_conversations WHERE id = ?1",
            AI_CONV_COLS
        );
        let conv = conn.query_row(&sql, [id], row_to_ai_conversation)?;
        Ok(conv)
    }

    /// 更新对话的附加笔记列表（A 方向：笔记 → AI 上下文）
    ///
    /// note_ids 序列化成 JSON 字符串存 attached_note_ids 列；同时 touch updated_at
    /// 让前端会话列表重排到顶部。
    pub fn set_conversation_attached_notes(
        &self,
        conversation_id: i64,
        note_ids: &[i64],
    ) -> Result<(), AppError> {
        let json = serde_json::to_string(note_ids)
            .map_err(|e| AppError::Custom(format!("序列化 note_ids 失败: {}", e)))?;
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE ai_conversations
                 SET attached_note_ids = ?1,
                     updated_at = datetime('now', 'localtime')
             WHERE id = ?2",
            rusqlite::params![json, conversation_id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "对话 {} 不存在",
                conversation_id
            )));
        }
        Ok(())
    }

    /// 删除对话
    pub fn delete_ai_conversation(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM ai_conversations WHERE id = ?1", [id])?;
        Ok(())
    }

    /// 批量清理对话：older_than_days = None 时清空全部；
    /// = Some(N) 时删除 updated_at 早于 N 天前的对话。返回被删除的行数。
    /// Why: 让前端给一个"清理全部 / 清理 7 天前 / 清理 30 天前"快捷入口，
    ///      不用做复选框管理态。靠 SQL datetime('now', '-N days') 比较更准。
    pub fn delete_ai_conversations_before(
        &self,
        older_than_days: Option<i64>,
    ) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = match older_than_days {
            None => conn.execute("DELETE FROM ai_conversations", [])?,
            Some(days) if days >= 0 => conn.execute(
                "DELETE FROM ai_conversations
                 WHERE updated_at < datetime('now', 'localtime', ?1)",
                [format!("-{} days", days)],
            )?,
            Some(_) => 0,
        };
        Ok(affected)
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
            "SELECT id, conversation_id, role, content, references_json, skill_calls_json, created_at
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
                    skill_calls: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    }

    /// 添加消息（不带 skill_calls；普通对话走这条路径）
    pub fn add_ai_message(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
        references: Option<&str>,
    ) -> Result<AiMessage, AppError> {
        self.add_ai_message_full(conversation_id, role, content, references, None)
    }

    /// 添加消息（含 skill_calls_json）
    ///
    /// 启用 Skills 的 assistant 消息会把 SkillCall 数组 JSON 后经此持久化，
    /// 前端重绘对话历史时据此还原 "🔧 调用了 xxx" 折叠卡片。
    pub fn add_ai_message_full(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
        references: Option<&str>,
        skill_calls: Option<&str>,
    ) -> Result<AiMessage, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_messages (conversation_id, role, content, references_json, skill_calls_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![conversation_id, role, content, references, skill_calls],
        )?;
        let id = conn.last_insert_rowid();
        let msg = conn.query_row(
            "SELECT id, conversation_id, role, content, references_json, skill_calls_json, created_at
             FROM ai_messages WHERE id = ?1",
            [id],
            |row| {
                Ok(AiMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    references: row.get(4)?,
                    skill_calls: row.get(5)?,
                    created_at: row.get(6)?,
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

            // T-003: RAG 检索结果不包含隐藏笔记（否则 AI 对话会泄露隐藏内容到历史）
            let sql = format!(
                "SELECT n.id, n.title, n.content, ({hits}) AS hits
                 FROM notes n
                 WHERE n.is_deleted = 0 AND n.is_hidden = 0 AND ({where_})
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
