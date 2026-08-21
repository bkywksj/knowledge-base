use crate::crypto;
use crate::error::AppError;
use crate::models::{AiConversation, AiMessage, AiModel, AiModelInput};

use super::Database;

/// 新建模型时 max_context 的默认值（token）。
///
/// 2026 年主流模型（DeepSeek / GPT / Claude / Qwen…）都是 128K 起步。
/// 老默认值 32000 会让 RAG 检索和挂载笔记只拿到四分之一的预算，
/// AI 常基于被截断的片段作答 —— schema v51 已把存量的 32000 一并抬上来。
const DEFAULT_MAX_CONTEXT: i64 = 128_000;

/// 把一行 ai_models 查询结果转成 AiModel
///
/// 列顺序约定（v61 起 10 列）：
///   id, name, provider, api_url, api_key, model_id, is_default, max_context, max_tokens, created_at
///
/// api_key 自 schema v59 起在库里是密文（`enc:v1:` 前缀），这里是**唯一**的读取入口，
/// 解密放在这一层，上面 16 个 `db.get_ai_model()` / `get_default_ai_model()` 调用点
/// 才能原样拿到明文去调服务商 —— 放高一层会让部分调用点把密文当 Key 发出去。
/// 解密失败不让整行查询失败，降级为"这条没配 Key"（见 `decrypt_field_or_none` 注释）。
fn row_to_ai_model(row: &rusqlite::Row) -> rusqlite::Result<AiModel> {
    let id: i64 = row.get(0)?;
    let stored_key: Option<String> = row.get(4)?;
    let api_key =
        stored_key.and_then(|s| crypto::decrypt_field_or_none(&s, &format!("AI 模型 #{}", id)));
    Ok(AiModel {
        id,
        name: row.get(1)?,
        provider: row.get(2)?,
        api_url: row.get(3)?,
        // has_api_key 在这里算：Command 层擦掉明文后，前端仍能知道"配没配"。
        // 注意用解密**后**的值判断 —— 解密失败（换机器）时等同未配置，
        // 与前端"请重新填写"的提示一致
        has_api_key: api_key.is_some(),
        api_key,
        model_id: row.get(5)?,
        is_default: row.get::<_, i32>(6)? != 0,
        max_context: row.get(7)?,
        max_tokens: row.get(8)?,
        created_at: row.get(9)?,
    })
}

/// 写库前加密 API Key。
///
/// 空串与 None 一律落 NULL：保持"空 = 未配置"的语义，
/// 免得前端 `api_key ? ... : ...` 被一串密文骗过去。
fn encrypt_api_key(raw: Option<&str>) -> Result<Option<String>, AppError> {
    match raw.map(str::trim) {
        Some(k) if !k.is_empty() => Ok(Some(crypto::encrypt_field(k)?)),
        _ => Ok(None),
    }
}

/// 标准 ai_models 查询列表达式（与 row_to_ai_model 对齐）
const AI_MODEL_COLS: &str =
    "id, name, provider, api_url, api_key, model_id, is_default, max_context, max_tokens, created_at";

/// 把一行 ai_conversations 查询结果转成 AiConversation
///
/// 列顺序约定（v50 起 8 列）：
///   id, title, model_id, attached_note_ids, scope_folder_id, preset_id, created_at, updated_at
fn row_to_ai_conversation(row: &rusqlite::Row) -> rusqlite::Result<AiConversation> {
    let attached_json: String = row.get(3)?;
    // 反序列化失败回退空数组（防御性：旧数据 / 手动改坏的情况下不让查询炸）
    let attached_note_ids: Vec<i64> = serde_json::from_str(&attached_json).unwrap_or_default();
    Ok(AiConversation {
        id: row.get(0)?,
        title: row.get(1)?,
        model_id: row.get(2)?,
        attached_note_ids,
        scope_folder_id: row.get(4)?,
        preset_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const AI_CONV_COLS: &str =
    "id, title, model_id, attached_note_ids, scope_folder_id, preset_id, created_at, updated_at";

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
        let dir = std::env::temp_dir().join(format!("kb_test_{}_{}", std::process::id(), n));
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
            max_tokens: None,
        }
    }

    /// 建一条笔记并按需打上 hidden / scratch 标记，用于 RAG 可见性测试
    fn note_with_flags(db: &Database, title: &str, content: &str, hidden: bool, scratch: bool) -> i64 {
        let id = db
            .create_note(&crate::models::NoteInput {
                title: title.into(),
                content: content.into(),
                folder_id: None,
            })
            .expect("create note")
            .id;
        if hidden || scratch {
            let conn = db.conn.lock().expect("lock");
            conn.execute(
                "UPDATE notes SET is_hidden = ?1, is_scratch = ?2 WHERE id = ?3",
                rusqlite::params![hidden as i32, scratch as i32, id],
            )
            .expect("set flags");
        }
        id
    }

    /// 🔴 回归测试：FTS 补充通道曾经漏掉 is_hidden / is_scratch 过滤
    /// （只写了 is_deleted = 0），导致 query 里**只要带一个英文词**就会走 FTS 通道，
    /// 把隐藏笔记捞进 RAG 上下文 —— 内容会被发给模型服务商并写进对话历史，
    /// 正是 T-003 明令要防的泄露。这条用例钉住两条通道的可见性口径必须一致。
    #[test]
    fn rag_never_returns_hidden_or_scratch_notes() {
        let db = temp_db();
        let visible = note_with_flags(&db, "Kubernetes 部署笔记", "kubernetes 集群部署步骤", false, false);
        let hidden = note_with_flags(&db, "Kubernetes 私密凭据", "kubernetes 生产环境密码", true, false);
        let scratch = note_with_flags(&db, "Kubernetes 临时草稿", "kubernetes 临时记录", false, true);

        // 带 ASCII 词 → 必定触发 FTS 补充通道（正是出问题的那条分支）
        let hits = db.search_notes_for_rag("kubernetes 部署", 20, None).unwrap();
        let ids: Vec<i64> = hits.iter().map(|(id, _, _)| *id).collect();

        assert!(ids.contains(&visible), "正常笔记应能被检索到，实际: {:?}", ids);
        assert!(!ids.contains(&hidden), "隐藏笔记绝不能进入 RAG 上下文，实际: {:?}", ids);
        assert!(!ids.contains(&scratch), "临时笔记不属于知识库，实际: {:?}", ids);
    }

    /// 回收站里的笔记同样不该参与问答
    #[test]
    fn rag_never_returns_deleted_notes() {
        let db = temp_db();
        let kept = note_with_flags(&db, "Docker 构建", "docker build 说明", false, false);
        let gone = note_with_flags(&db, "Docker 旧稿", "docker 废弃内容", false, false);
        db.delete_note(gone).expect("soft delete");

        let hits = db.search_notes_for_rag("docker", 20, None).unwrap();
        let ids: Vec<i64> = hits.iter().map(|(id, _, _)| *id).collect();
        assert!(ids.contains(&kept));
        assert!(!ids.contains(&gone), "回收站笔记不该被召回，实际: {:?}", ids);
    }

    /// 直接读库里 api_key 那一列的原始内容（绕过 row_to_ai_model 的解密）
    fn raw_api_key(db: &Database, id: i64) -> Option<String> {
        let conn = db.conn.lock().expect("lock");
        conn.query_row("SELECT api_key FROM ai_models WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .expect("query raw key")
    }

    #[test]
    fn api_key_encrypted_at_rest_but_plain_on_read() {
        let db = temp_db();
        let mut inp = input("with-key");
        inp.api_key = Some("sk-secret-12345".into());
        let created = db.create_ai_model(&inp).unwrap();

        // 上层拿到的是明文（services/ai.rs 要拿它去调服务商）
        assert_eq!(created.api_key.as_deref(), Some("sk-secret-12345"));

        // 但库里落的是密文 —— 这正是 v59 想解决的：app.db 被复制走也读不出 Key
        let raw = raw_api_key(&db, created.id).expect("库里应有值");
        assert!(crypto::is_encrypted_field(&raw), "库里应是 enc:v1: 密文");
        assert!(!raw.contains("sk-secret-12345"), "库里不能出现明文");

        // 走 get / list 两条读取路径都应解密
        assert_eq!(
            db.get_ai_model(created.id).unwrap().api_key.as_deref(),
            Some("sk-secret-12345")
        );
        let listed = db.list_ai_models().unwrap();
        assert_eq!(listed[0].api_key.as_deref(), Some("sk-secret-12345"));
    }

    #[test]
    fn api_key_update_stays_encrypted() {
        let db = temp_db();
        let mut inp = input("m");
        inp.api_key = Some("sk-first".into());
        let created = db.create_ai_model(&inp).unwrap();

        inp.api_key = Some("sk-second".into());
        let updated = db.update_ai_model(created.id, &inp).unwrap();
        assert_eq!(updated.api_key.as_deref(), Some("sk-second"));

        let raw = raw_api_key(&db, created.id).expect("库里应有值");
        assert!(crypto::is_encrypted_field(&raw));
        assert!(!raw.contains("sk-second"));
    }

    #[test]
    fn empty_api_key_stored_as_null() {
        let db = temp_db();
        // 空串和纯空白都应落 NULL，保持"空 = 未配置"语义
        let mut inp = input("blank");
        inp.api_key = Some("   ".into());
        let created = db.create_ai_model(&inp).unwrap();
        assert_eq!(created.api_key, None);
        assert_eq!(raw_api_key(&db, created.id), None);
    }

    // ─── P0-1b：Key 三态更新 ───────────────────

    /// 🔴 最关键的一条：Key 对前端不回显，用户只改模型名时表单里的 Key 是空的。
    /// 若把"不传"当清除，**改个名字就会静默弄丢 Key**，下次对话才报鉴权失败。
    #[test]
    fn update_without_key_keeps_existing() {
        let db = temp_db();
        let mut inp = input("m");
        inp.api_key = Some("sk-keep-me".into());
        let created = db.create_ai_model(&inp).unwrap();

        // 模拟"只改名字"：api_key 字段不传
        inp.name = "改过名字".into();
        inp.api_key = None;
        let updated = db.update_ai_model(created.id, &inp).unwrap();

        assert_eq!(updated.name, "改过名字");
        assert_eq!(
            updated.api_key.as_deref(),
            Some("sk-keep-me"),
            "不传 api_key 时必须保持原值，否则改名就丢 Key"
        );
        assert!(updated.has_api_key);
    }

    /// 显式传空串 = 用户主动清除
    #[test]
    fn update_with_empty_key_clears_it() {
        let db = temp_db();
        let mut inp = input("m");
        inp.api_key = Some("sk-old".into());
        let created = db.create_ai_model(&inp).unwrap();

        inp.api_key = Some("".into());
        let updated = db.update_ai_model(created.id, &inp).unwrap();
        assert_eq!(updated.api_key, None, "空串应清除 Key");
        assert!(!updated.has_api_key);
        assert_eq!(raw_api_key(&db, created.id), None, "库里也应是 NULL");
    }

    #[test]
    fn update_with_new_key_replaces_it() {
        let db = temp_db();
        let mut inp = input("m");
        inp.api_key = Some("sk-old".into());
        let created = db.create_ai_model(&inp).unwrap();

        inp.api_key = Some("sk-new".into());
        let updated = db.update_ai_model(created.id, &inp).unwrap();
        assert_eq!(updated.api_key.as_deref(), Some("sk-new"));
        // 换新值同样要加密入库
        let raw = raw_api_key(&db, created.id).unwrap();
        assert!(crypto::is_encrypted_field(&raw));
        assert!(!raw.contains("sk-new"));
    }

    /// has_api_key 必须跟着实际状态走 —— 前端全靠它显示"已保存 / 未配置"
    #[test]
    fn has_api_key_reflects_actual_state() {
        let db = temp_db();
        let without = db.create_ai_model(&input("no-key")).unwrap();
        assert!(!without.has_api_key);

        let mut inp = input("with-key");
        inp.api_key = Some("sk-x".into());
        let with = db.create_ai_model(&inp).unwrap();
        assert!(with.has_api_key);

        // 列表路径同样要带上
        let listed = db.list_ai_models().unwrap();
        let m = listed.iter().find(|m| m.id == with.id).unwrap();
        assert!(m.has_api_key);
    }

    #[test]
    fn legacy_plaintext_key_still_readable() {
        // v59 迁移若因故跳过某条（加密失败保持明文），读取侧必须仍能拿到它
        let db = temp_db();
        let created = db.create_ai_model(&input("legacy")).unwrap();
        {
            let conn = db.conn.lock().expect("lock");
            conn.execute(
                "UPDATE ai_models SET api_key = 'sk-plain-legacy' WHERE id = ?1",
                [created.id],
            )
            .expect("inject legacy plaintext");
        }
        let got = db.get_ai_model(created.id).unwrap();
        assert_eq!(got.api_key.as_deref(), Some("sk-plain-legacy"));
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

    // ─── RAG 检索的正文口径（白板不能把 Excalidraw JSON 喂给模型）──────────

    /// 建一条白板笔记：`content` 是画布 JSON，`search_text` 是画布上的纯文字。
    fn make_whiteboard(db: &Database, title: &str, canvas_text: &str) -> i64 {
        // 用 r##"…"## 而不是 r#"…"#：JSON 里的颜色值 "#ffffff" 含 `"#`，
        // 正好撞上单井号原始字符串的终止符，会把字符串提前截断
        let scene = format!(
            r##"{{"type":"excalidraw","appState":{{"viewBackgroundColor":"#ffffff","gridModeEnabled":false}},"elements":[{{"type":"text","backgroundColor":"transparent","text":"{}"}}]}}"##,
            canvas_text
        );
        db.create_whiteboard(
            &crate::models::NoteInput {
                title: title.into(),
                content: scene,
                folder_id: None,
            },
            canvas_text,
        )
        .unwrap()
        .id
    }

    /// 命中白板时，回传给模型的必须是画布文字，绝不能是那坨 Excalidraw JSON ——
    /// 后者模型看不懂，还白白挤占上下文。
    #[test]
    fn rag_returns_canvas_text_for_whiteboard() {
        let db = temp_db();
        make_whiteboard(&db, "架构图", "订单服务拆分方案");

        let hits = db.search_notes_for_rag("订单服务拆分方案", 5, None).unwrap();
        assert_eq!(hits.len(), 1, "画布文字应能被检索到");
        assert!(hits[0].2.contains("订单服务拆分方案"));
        assert!(
            !hits[0].2.contains("appState") && !hits[0].2.contains("excalidraw"),
            "回传的正文不该是 Excalidraw JSON，实际: {}",
            hits[0].2
        );
    }

    /// 反向契约：JSON 里的属性名不该把白板召回来。
    /// 修复前搜 "backgroundColor" 会命中每一块白板，纯粹是噪声。
    #[test]
    fn rag_ignores_json_property_names() {
        let db = temp_db();
        make_whiteboard(&db, "架构图", "订单服务拆分方案");

        let hits = db.search_notes_for_rag("backgroundColor", 5, None).unwrap();
        assert!(
            hits.is_empty(),
            "画布 JSON 的属性名不该造成召回，实际命中 {} 条",
            hits.len()
        );
    }

    /// 普通笔记的 search_text 恒为 NULL（见 schema v52），检索必须照常回退到正文。
    #[test]
    fn rag_still_matches_plain_notes() {
        let db = temp_db();
        db.create_note(&crate::models::NoteInput {
            title: "会议记录".into(),
            content: "讨论了订单服务拆分方案".into(),
            folder_id: None,
        })
        .unwrap();

        let hits = db.search_notes_for_rag("订单服务拆分方案", 5, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].2.contains("讨论了订单服务拆分方案"));
    }
}

impl Database {
    // ─── AI 模型 DAO ─────────────────────────────

    /// 获取所有 AI 模型
    pub fn list_ai_models(&self) -> Result<Vec<AiModel>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!("SELECT {} FROM ai_models WHERE id = ?1", AI_MODEL_COLS);
        let model = conn.query_row(&sql, [id], row_to_ai_model)?;
        Ok(model)
    }

    /// 获取默认 AI 模型
    pub fn get_default_ai_model(&self) -> Result<AiModel, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
            .map_err(|_| AppError::NotFound("尚未配置任何 AI 模型，请到设置页添加".into()))?;
        let _ = conn.execute(
            "UPDATE ai_models SET is_default = 1 WHERE id = ?1",
            [fallback.id],
        );
        log::info!(
            "[ai] 库内无默认标记，自动 promote #{} 为默认（兜底 T-B02）",
            fallback.id
        );
        Ok(AiModel {
            is_default: true,
            ..fallback
        })
    }

    /// 创建 AI 模型
    pub fn create_ai_model(&self, input: &AiModelInput) -> Result<AiModel, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // max_context 缺省时给 128000：2026 年主流模型都是 128K 起步，
        // 老的 32000 会让 RAG / 挂载笔记白白少拿三四倍预算（见 schema v51 迁移）
        let max_ctx = input.max_context.unwrap_or(DEFAULT_MAX_CONTEXT).max(1000);
        // v59 起 API Key 加密入库，防 app.db 被复制走后明文泄漏
        let api_key_enc = encrypt_api_key(input.api_key.as_deref())?;
        conn.execute(
            "INSERT INTO ai_models
                (name, provider, api_url, api_key, model_id, max_context, max_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                input.name,
                input.provider,
                input.api_url,
                api_key_enc,
                input.model_id,
                max_ctx,
                // 新建时外层 None（没提供）与 Some(None)（显式清空）等价，都落 NULL
                input.max_tokens.flatten(),
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
            conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [id])?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // 用户没传 max_context 时保持原值，避免覆盖成默认值
        let max_ctx = input.max_context.unwrap_or(DEFAULT_MAX_CONTEXT).max(1000);

        // 两个字段都是三态（api_key 见其注释，max_tokens 同理），
        // 各自独立决定"要不要出现在 SET 里"。
        //
        // 🔴 为什么必须区分「没提供」和「设为空」：Key 对前端不回显，
        // 用户只改模型名时表单里的 Key 是空的。若把"空"当清除，
        // **改个名字就会把 Key 弄丢** —— 而且是静默弄丢，下次对话才报鉴权失败。
        //
        // 早先这里按 api_key 分了两条完整 SQL；再叠一个三态字段就是 4 条，
        // 每加一个字段翻一倍。改成动态拼 SET 子句，字段数与分支数解耦。
        let mut sets: Vec<&str> = vec![
            "name = :name",
            "provider = :provider",
            "api_url = :api_url",
            "model_id = :model_id",
            "max_context = :max_context",
        ];
        let mut params: Vec<(&str, &dyn rusqlite::ToSql)> = vec![
            (":name", &input.name),
            (":provider", &input.provider),
            (":api_url", &input.api_url),
            (":model_id", &input.model_id),
            (":max_context", &max_ctx),
            (":id", &id),
        ];

        // v59 起 API Key 加密入库；encrypt_api_key 对空串返回 None → 落 NULL，即"清除"
        let api_key_enc = match &input.api_key {
            Some(_) => Some(encrypt_api_key(input.api_key.as_deref())?),
            None => None,
        };
        if let Some(enc) = &api_key_enc {
            sets.push("api_key = :api_key");
            params.push((":api_key", enc));
        }

        let max_tokens_val = input.max_tokens.flatten();
        if input.max_tokens.is_some() {
            sets.push("max_tokens = :max_tokens");
            params.push((":max_tokens", &max_tokens_val));
        }

        let sql = format!(
            "UPDATE ai_models SET {} WHERE id = :id",
            sets.join(", ")
        );
        conn.execute(&sql, params.as_slice())?;

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
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
                tx.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [next])?;
                log::info!("[ai] 删除默认模型 #{} 后，自动把 #{} 设为新默认", id, next);
            } else {
                log::info!("[ai] 删除最后一条 AI 模型 #{}，已无可用模型", id);
            }
        }

        tx.commit()?;
        Ok(())
    }

    /// 设置默认 AI 模型
    pub fn set_default_ai_model(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("UPDATE ai_models SET is_default = 0", [])?;
        conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    // ─── AI 对话 DAO ─────────────────────────────

    /// 获取所有对话列表
    pub fn list_ai_conversations(&self) -> Result<Vec<AiConversation>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM ai_conversations WHERE id = ?1",
            AI_CONV_COLS
        );
        let conv = conn.query_row(&sql, [id], row_to_ai_conversation)?;
        Ok(conv)
    }

    /// 创建对话
    pub fn create_ai_conversation(
        &self,
        title: &str,
        model_id: i64,
        scope_folder_id: Option<i64>,
    ) -> Result<AiConversation, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO ai_conversations (title, model_id, scope_folder_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![title, model_id, scope_folder_id],
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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

    /// 设置对话的角色预设（v50）。preset_id = None 表示取消角色，恢复默认助手身份。
    ///
    /// 不校验 preset_id 是否存在：提示词可能在设置后被删掉，读取时走 JOIN 查不到就当没设，
    /// 不会让对话打不开。
    pub fn set_conversation_preset(
        &self,
        conversation_id: i64,
        preset_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE ai_conversations
                 SET preset_id = ?1,
                     updated_at = datetime('now', 'localtime')
             WHERE id = ?2",
            rusqlite::params![preset_id, conversation_id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "对话 {} 不存在",
                conversation_id
            )));
        }
        Ok(())
    }

    /// 取对话当前角色预设的提示词正文（供拼 system prompt 用）。
    ///
    /// 没设预设、预设被删、或提示词已停用 → 返回 None，调用方按"无角色"处理。
    pub fn get_conversation_preset_prompt(
        &self,
        conversation_id: i64,
    ) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT p.prompt
               FROM ai_conversations c
               JOIN prompt_templates p ON p.id = c.preset_id
              WHERE c.id = ?1 AND p.enabled = 1",
        )?;
        let found = stmt
            .query_row(rusqlite::params![conversation_id], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .filter(|s| !s.trim().is_empty());
        Ok(found)
    }

    /// 设置对话的 RAG 文件夹范围（"对此文件夹问 AI"在对话里随时改）。
    ///
    /// scope_folder_id = None 表示清除范围（恢复全库检索）。
    pub fn set_conversation_scope_folder(
        &self,
        conversation_id: i64,
        scope_folder_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE ai_conversations
                 SET scope_folder_id = ?1,
                     updated_at = datetime('now', 'localtime')
             WHERE id = ?2",
            rusqlite::params![scope_folder_id, conversation_id],
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE ai_conversations SET updated_at = datetime('now', 'localtime') WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ─── AI 消息 DAO ─────────────────────────────

    /// 获取对话的所有消息
    pub fn list_ai_messages(&self, conversation_id: i64) -> Result<Vec<AiMessage>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
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
            "的",
            "了",
            "在",
            "是",
            "我",
            "有",
            "和",
            "就",
            "不",
            "人",
            "都",
            "一",
            "一个",
            "上",
            "也",
            "很",
            "到",
            "说",
            "要",
            "去",
            "你",
            "会",
            "着",
            "没有",
            "看",
            "好",
            "自己",
            "这",
            "他",
            "她",
            "它",
            "吗",
            "什么",
            "怎么",
            "哪",
            "那",
            "里",
            "面",
            "里面",
            "这个",
            "那个",
            "还",
            "能",
            "可以",
            "被",
            "把",
            "给",
            "让",
            "用",
            "从",
            "写",
            "中",
            "吧",
            "呢",
            "啊",
            "哦",
            "嗯",
            "请",
            "帮",
            "关于",
            "介绍",
            "描述",
            "内容",
            "告诉",
            "解释",
            "如何",
            "为什么",
            "哪些",
            "什么样",
            // 高噪声 bigram（常与其他词粘连产生）
            "看看",
            "帮我",
            "一下",
            "有没",
            "没有",
            "里的",
            "里面",
            "那些",
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

    /// RAG 检索的「正文口径」。
    ///
    /// 白板笔记的 `content` 是一整坨 Excalidraw JSON（颜色值、元素 id、坐标、属性名），
    /// 直接拿它检索有两层害处：JSON 里的属性名会造成误召回；一旦被召回，
    /// 塞进上下文的是模型看不懂的 JSON —— 白烧 token 还挤掉了真正有用的笔记。
    ///
    /// `search_text` 存的正是画布上的纯文字（schema v52 为此而加，普通笔记恒为 NULL）。
    /// 这里的 `COALESCE` 与 v52 那三个 FTS 触发器**逐字同一口径**，
    /// 保证 LIKE 通道和 FTS 通道检索的是同一份文本。
    /// 刻意不加 `NULLIF(...,'')`：画布没有任何文字时 search_text 是空串，
    /// 那就该匹配不到，而不是退回去拿 JSON 碰运气。
    const RAG_TEXT: &'static str = "COALESCE(n.search_text, n.content)";

    /// RAG 召回的**可见性过滤**，所有召回通道必须逐字复用同一份。
    ///
    /// 🔴 收敛成常量是有代价换来的教训：此前 LIKE 通道写了三个条件、
    /// FTS 补充通道只写了 `is_deleted = 0` —— 于是**只要 query 里带一个英文词**
    /// 就会走 FTS 通道，把隐藏笔记 / 临时笔记捞进 RAG 上下文，
    /// 连同内容一起发给模型服务商并落进对话历史。这正是 T-003 明令要防的事。
    ///
    /// 同一功能有两条召回路径时，过滤条件必须只有一处来源；
    /// 各写各的迟早会漂移，而漏掉的那条恰恰是最不容易被测到的分支。
    ///
    /// - `is_deleted`：回收站里的笔记不该参与问答
    /// - `is_hidden`：T-003 隐藏笔记（AI 对话会把内容写进历史，等于泄露）
    /// - `is_scratch`：临时编辑的外部 md，不属于知识库
    const RAG_VISIBILITY: &'static str = "n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_scratch = 0";

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
        folder_ids: Option<&[i64]>,
    ) -> Result<Vec<(i64, String, String)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let keywords = Self::extract_keywords(query);

        // 文件夹范围限定（"对此文件夹问 AI"）：folder_ids 已是该文件夹 + 所有子孙文件夹的 id。
        // i64 直接内联进 SQL（整数无注入风险），免去与 LIKE 占位符的编号冲突。
        // None / 空 → 不加约束（全库检索，旧行为）。
        let folder_clause = match folder_ids {
            Some(ids) if !ids.is_empty() => {
                let list = ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                format!(" AND n.folder_id IN ({})", list)
            }
            _ => String::new(),
        };

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

        // 两路召回各自产出一个**名次序列**，最后用 RRF 融合。
        // 不能直接比两边的分数：LIKE 是加权命中计数（正整数），FTS5 的 rank 是 bm25
        // 负值（越小越相关），量纲根本不可比。RRF 只用名次，天然回避这个问题。
        let mut docs: std::collections::HashMap<i64, (String, String)> =
            std::collections::HashMap::new();
        let mut like_ranking: Vec<i64> = Vec::new();
        let mut fts_ranking: Vec<i64> = Vec::new();

        // ─── 通道一：LIKE + 标题加权命中数排序 ────────────────────
        if !like_keywords.is_empty() {
            // 加权打分：title 命中 ×5，content 命中 ×1
            //
            // 历史教训（2026-04-30 用户反馈）：
            // 平权打分（title 与 content 等权）会让"语义噪声"压过"主题命中"。
            // 例：用户问华为，bigram 拆出 20+ 关键词（华为/政府/关系/发展/历程/...）。
            // 政治学论文（《中县干部》《做官》）内容含一堆"政府/关系/发展/历程"
            // 但完全没提华为 → hits ≈ 10；《小聊华为》title 含华为 + content 含
            // 政府/关系 → hits ≈ 5 → 反而被挤出 top 5。
            //
            // 加权后《小聊华为》: title.华为(5) + content.政府(1) + content.关系(1) = 7
            // 《中县干部》: content.政府(1) + content.关系(1) + ... = 10 但每项只 1 分
            // 真正命中主题词的笔记（专有名词进 title）会显著上升。
            //
            // 业界做法：BM25 / TF-IDF 中 title 字段一般给 boost 系数 3-5。
            let title_exprs: Vec<String> = like_keywords
                .iter()
                .enumerate()
                .map(|(i, _)| format!("(CASE WHEN n.title LIKE ?{0} THEN 5 ELSE 0 END)", i + 1))
                .collect();
            let content_exprs: Vec<String> = like_keywords
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    format!(
                        "(CASE WHEN {text} LIKE ?{0} THEN 1 ELSE 0 END)",
                        i + 1,
                        text = Self::RAG_TEXT
                    )
                })
                .collect();
            let score_sum = format!(
                "({}) + ({})",
                title_exprs.join(" + "),
                content_exprs.join(" + "),
            );
            let where_clauses: Vec<String> = like_keywords
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    format!(
                        "(n.title LIKE ?{0} OR {text} LIKE ?{0})",
                        i + 1,
                        text = Self::RAG_TEXT
                    )
                })
                .collect();

            // 可见性过滤走共享常量（见 RAG_VISIBILITY 注释：两条通道曾经写法不一致）
            let sql = format!(
                "SELECT n.id, n.title, {text}, ({score}) AS score
                 FROM notes n
                 WHERE {visibility} AND ({where_}){folder_clause}
                 ORDER BY score DESC, n.updated_at DESC
                 LIMIT ?{limit_param}",
                text = Self::RAG_TEXT,
                score = score_sum,
                visibility = Self::RAG_VISIBILITY,
                where_ = where_clauses.join(" OR "),
                folder_clause = folder_clause,
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

            for (id, title, text) in rows {
                docs.entry(id).or_insert((title, text));
                like_ranking.push(id);
            }
        }

        // ─── 通道二：有 ASCII 词才跑 FTS5 ────────────────
        //
        // 仍然保留 `has_ascii_kw` 这个门槛：SQLite 的 unicode61 tokenizer 对中文
        // 按连续 CJK 段切分（"合同内容" 是一个 token），纯中文 query 跑 FTS 基本白跑
        // 一次全表 —— 这是有意为之的性能取舍，不是遗漏。
        //
        // 但**不再**要求"LIKE 没查够才跑"：那样 FTS 只是填空，两路同时命中的笔记
        // 得不到任何加权。现在两路都跑满 limit，再交给 RRF 按名次融合。
        let has_ascii_kw = keywords.iter().any(|k| k.is_ascii());
        if has_ascii_kw {
            let fts_query = keywords
                .iter()
                .map(|k| Self::escape_fts5(k))
                .collect::<Vec<_>>()
                .join(" OR ");
            let fts_sql = format!(
                // MATCH 那一侧本来就查的是 search_text（v52 起 FTS 索引的就是
                // COALESCE(search_text, content)），这里只需把回传的正文口径对齐。
                //
                // 🔴 可见性过滤必须与 LIKE 通道**逐字一致**：此处原先只有
                // `is_deleted = 0`，漏了 is_hidden / is_scratch —— 导致 query 只要
                // 含一个英文词就会把隐藏笔记喂给模型。改用共享常量杜绝再次漂移。
                "SELECT n.id, n.title, {text}
                 FROM notes_fts fts
                 JOIN notes n ON n.id = fts.rowid
                 WHERE notes_fts MATCH ?1
                   AND {visibility}{folder_clause}
                 ORDER BY rank
                 LIMIT ?2",
                text = Self::RAG_TEXT,
                visibility = Self::RAG_VISIBILITY,
                folder_clause = folder_clause,
            );
            if let Ok(mut stmt) = conn.prepare(&fts_sql) {
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
                for (id, title, text) in rows {
                    docs.entry(id).or_insert((title, text));
                    fts_ranking.push(id);
                }
            }
        }

        // ─── 融合：RRF 按名次合并两路 ────────────────
        //
        // 单路时 RRF 退化为原顺序（见 fusion::tests::single_ranking_preserves_order），
        // 所以纯中文 query（没有 FTS 通道）的行为与改造前一致。
        let rankings: Vec<Vec<i64>> = [like_ranking, fts_ranking]
            .into_iter()
            .filter(|r| !r.is_empty())
            .collect();
        let fused = crate::database::fusion::rrf_fuse(&rankings, crate::database::fusion::RRF_K);

        let combined: Vec<(i64, String, String)> = fused
            .into_iter()
            .take(limit)
            .filter_map(|id| docs.remove(&id).map(|(title, text)| (id, title, text)))
            .collect();
        Ok(combined)
    }
}
