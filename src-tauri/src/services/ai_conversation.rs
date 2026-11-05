//! AI 会话的整体操作：分叉 / 克隆、整段导出成 Markdown。
//!
//! 消息的增删由 services::ai 管（发送 / 重新生成 / 编辑重发），这里只放「把会话当一个整体」的操作。

use crate::database::Database;
use crate::error::AppError;
use crate::models::{AiConversation, AiMessage};

pub struct ConversationService;

impl ConversationService {
    /// 分叉 / 克隆会话。
    ///
    /// - `up_to_message_id = Some(id)`：从这条回答处分叉，新会话只带到这里，标题加「（分叉）」
    /// - `None`：整个克隆，标题加「（副本）」
    pub fn fork(
        db: &Database,
        source_id: i64,
        up_to_message_id: Option<i64>,
    ) -> Result<AiConversation, AppError> {
        let src = db.get_ai_conversation(source_id)?;
        let suffix = if up_to_message_id.is_some() { "（分叉）" } else { "（副本）" };
        db.fork_ai_conversation(source_id, up_to_message_id, &format!("{}{}", src.title, suffix))
    }

    /// 整个会话 → Markdown（「复制为 Markdown」用）：`# 标题` + 各轮问答。
    pub fn markdown(db: &Database, conversation_id: i64) -> Result<String, AppError> {
        let conv = db.get_ai_conversation(conversation_id)?;
        let messages = db.list_ai_messages(conversation_id)?;
        Ok(format!("# {}\n\n{}", conv.title, messages_markdown(&messages)).trim_end().to_string() + "\n")
    }
}

/// 各轮问答拼成 Markdown：`## 我` / `## AI` 各带正文。
/// 「存为笔记」和「复制为 Markdown」共用，两处格式保持一致。
///
/// 失败 / 空的回复卡片跳过（出现一段空白的「## AI」只会让人困惑）；
/// system / tool 消息很少见，按引用块兼容输出。
pub fn messages_markdown(messages: &[AiMessage]) -> String {
    let mut md = String::new();
    for msg in messages.iter().filter(|m| super::ai::usable_in_history(m)) {
        let label = match msg.role.as_str() {
            "user" => "## 我",
            "assistant" => "## AI",
            other => {
                md.push_str(&format!("> [{}]\n{}\n\n", other, msg.content));
                continue;
            }
        };
        md.push_str(label);
        md.push_str("\n\n");
        md.push_str(&msg.content);
        md.push_str("\n\n");
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Database, i64, Vec<i64>) {
        let db = Database::init(":memory:").unwrap();
        let model_id = {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "INSERT INTO ai_models (name, provider, api_url, model_id) VALUES ('m', 'openai', 'http://x', 'gpt')",
                [],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let conv = db.create_ai_conversation("学习 Rust", model_id, None).unwrap();
        db.set_conversation_attached_notes(conv.id, &[7, 8]).unwrap();
        let mut ids = vec![];
        for (role, text, skills) in [
            ("user", "所有权是什么", None),
            ("assistant", "回答一", Some(r#"[{"name":"search"}]"#)),
            ("user", "借用呢", None),
            ("assistant", "回答二", None),
        ] {
            let m = db
                .add_ai_message_full(conv.id, role, text, Some("[1]"), skills, None)
                .unwrap();
            ids.push(m.id);
        }
        (db, conv.id, ids)
    }

    #[test]
    fn fork_copies_up_to_message_with_details() {
        let (db, src, ids) = setup();
        let forked = ConversationService::fork(&db, src, Some(ids[1])).unwrap();
        assert_eq!(forked.title, "学习 Rust（分叉）");
        assert_eq!(forked.attached_note_ids, vec![7, 8], "附加笔记要一起带过去");

        let msgs = db.list_ai_messages(forked.id).unwrap();
        assert_eq!(msgs.len(), 2, "只带到分叉点");
        assert_eq!(msgs[0].content, "所有权是什么");
        assert_eq!(msgs[1].content, "回答一");
        assert_eq!(msgs[1].skill_calls.as_deref(), Some(r#"[{"name":"search"}]"#), "执行过程一并复制");
        assert_eq!(msgs[1].references.as_deref(), Some("[1]"));

        assert_eq!(db.list_ai_messages(src).unwrap().len(), 4, "原会话不受影响");
    }

    #[test]
    fn clone_copies_everything() {
        let (db, src, _) = setup();
        let cloned = ConversationService::fork(&db, src, None).unwrap();
        assert_eq!(cloned.title, "学习 Rust（副本）");
        let msgs = db.list_ai_messages(cloned.id).unwrap();
        assert_eq!(
            msgs.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["所有权是什么", "回答一", "借用呢", "回答二"]
        );
    }

    #[test]
    fn fork_rejects_message_from_other_conversation() {
        let (db, src, _) = setup();
        let other = ConversationService::fork(&db, src, None).unwrap();
        let foreign = db.list_ai_messages(other.id).unwrap()[0].id;
        let before = db.list_ai_conversations().unwrap().len();
        assert!(ConversationService::fork(&db, src, Some(foreign)).is_err());
        assert_eq!(db.list_ai_conversations().unwrap().len(), before, "失败不能留下半个会话");
    }

    #[test]
    fn markdown_has_title_and_turns() {
        let (db, src, _) = setup();
        let md = ConversationService::markdown(&db, src).unwrap();
        assert!(md.starts_with("# 学习 Rust\n\n## 我\n\n所有权是什么\n\n## AI\n\n回答一"));
        assert!(md.ends_with("回答二\n"));
    }
}
