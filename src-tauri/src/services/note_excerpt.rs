//! 白板「笔记卡片」的正文摘要。
//!
//! 卡片与 `[[双链]]` 角标的区别：角标只能点开跳走，卡片把笔记内容**摊在画布上**，
//! 且每次打开白板都重新取一次 —— 笔记改了卡片跟着变，这是"知识库白板"
//! 区别于普通画图工具的地方。
//!
//! 摘要在后端算而不是把整篇正文丢给前端：一篇笔记可能几万字，
//! 卡片上只放得下开头几行，多传的部分纯属浪费 IPC。

use crate::database::Database;
use crate::error::AppError;
use crate::models::NoteExcerpt;

/// 卡片正文的字符上限。
///
/// 按「一张卡片大约能舒服地放下的量」定：再多就该点进笔记看了，
/// 塞满一屏的卡片反而让画布没法用。
const MAX_CHARS: usize = 280;

/// 一次最多取多少条 —— 挡住前端传来的异常长列表（画布上不会有几百张卡片）。
const MAX_IDS: usize = 200;

/// 批量取笔记摘要。顺序与入参一致，查不到的也会返回（`missing = true`）。
///
/// 全部按 id 单条取而不是拼一个 IN 查询：条数本就不多（一块白板上的卡片），
/// 而复用 `get_note` 能自动继承它对加密笔记的处理，不必在这里重写一遍。
pub fn for_notes(db: &Database, note_ids: &[i64]) -> Result<Vec<NoteExcerpt>, AppError> {
    if note_ids.len() > MAX_IDS {
        return Err(AppError::InvalidInput(format!(
            "一次最多取 {} 条笔记摘要",
            MAX_IDS
        )));
    }

    let mut out = Vec::with_capacity(note_ids.len());
    for &id in note_ids {
        out.push(match db.get_note(id)? {
            Some(note) => {
                if note.is_encrypted {
                    // 加密笔记的内容不该出现在画布上 —— 画布会被导出成图片、
                    // 被同步、被别人看到，那等于绕过了加密
                    NoteExcerpt {
                        note_id: id,
                        title: note.title,
                        excerpt: "🔒 已加密，点击打开".into(),
                        missing: false,
                    }
                } else {
                    let plain = if note.note_type == crate::models::note_type::WHITEBOARD {
                        // 白板的 content 是 Excalidraw JSON，摊出来是一坨属性名。
                        // search_text 存的正是画布上的文字，正好拿来当摘要
                        db.get_note_search_text(id)?.unwrap_or_default()
                    } else {
                        to_plain_text(&note.content)
                    };
                    NoteExcerpt {
                        note_id: id,
                        title: note.title,
                        excerpt: truncate(&plain, MAX_CHARS),
                        missing: false,
                    }
                }
            }
            // 笔记被删了不能让卡片凭空消失 —— 那样用户会以为是自己弄丢的。
            // 保留卡片并标记失效，让他知道"这里原本引了一条现在没了的笔记"
            None => NoteExcerpt {
                note_id: id,
                title: format!("笔记 #{}", id),
                excerpt: "（笔记已删除）".into(),
                missing: true,
            },
        });
    }
    Ok(out)
}

/// 正文 → 适合摊在卡片上的纯文本。
///
/// 去掉 HTML 标签与常见 Markdown 标记：卡片是给人扫一眼的，
/// 留着 `##` `**` 这些符号只会干扰阅读。
fn to_plain_text(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_tag = false;
    for ch in content.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }

    // 逐行清掉行首的标题 / 引用 / 列表符号，行内的强调符号也去掉。
    // 刻意不做完整的 Markdown 解析：卡片只要"看着像正文"，
    // 为此引一个解析器不值得，且解析失败的边角情况反而更难处理。
    let cleaned: Vec<String> = out
        .lines()
        .map(|line| {
            let t = line.trim();
            let t = t.trim_start_matches(['#', '>', '-', '*', '+']).trim_start();
            t.replace("**", "").replace("`", "")
        })
        .filter(|l| !l.is_empty())
        .collect();
    cleaned.join("\n")
}

/// 按**字符**（不是字节）截断，中文才不会被切成乱码。
fn truncate(s: &str, max_chars: usize) -> String {
    let mut it = s.chars();
    let head: String = it.by_ref().take(max_chars).collect();
    if it.next().is_some() {
        format!("{}…", head)
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteInput;

    fn mem_db() -> Database {
        Database::init(":memory:").unwrap()
    }

    #[test]
    fn strips_html_and_markdown_markers() {
        let plain = to_plain_text("<p># 标题</p>\n<p>**加粗**正文</p>\n\n- 列表项");
        assert!(!plain.contains('<'), "不该留 HTML 标签: {}", plain);
        assert!(!plain.contains('#'), "不该留标题符号: {}", plain);
        assert!(!plain.contains("**"), "不该留强调符号: {}", plain);
        assert!(plain.contains("标题") && plain.contains("加粗") && plain.contains("列表项"));
    }

    /// 中文按字符截断，不能切出半个字（按字节截会 panic 或乱码）
    #[test]
    fn truncate_counts_chars_not_bytes() {
        let s = "中文摘要内容";
        assert_eq!(truncate(s, 3), "中文摘…");
        assert_eq!(truncate(s, 100), s, "没超长就不该加省略号");
    }

    #[test]
    fn returns_excerpt_for_plain_note() {
        let db = mem_db();
        let note = db
            .create_note(&NoteInput {
                title: "架构说明".into(),
                content: "# 架构\n三层：Command → Service → Database".into(),
                folder_id: None,
            })
            .unwrap();

        let got = for_notes(&db, &[note.id]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "架构说明");
        assert!(got[0].excerpt.contains("三层"));
        assert!(!got[0].missing);
    }

    /// 笔记删了要标记失效而不是消失 —— 卡片凭空不见会让用户以为是自己弄丢的
    #[test]
    fn missing_note_is_flagged_not_dropped() {
        let db = mem_db();
        let got = for_notes(&db, &[99999]).unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].missing);
        assert!(got[0].excerpt.contains("已删除"));
    }

    /// 加密笔记的内容绝不能摊到画布上 —— 画布会被导出、同步、给别人看，
    /// 那等于绕过了加密
    #[test]
    fn encrypted_note_content_is_not_exposed() {
        let db = mem_db();
        let note = db
            .create_note(&NoteInput {
                title: "机密".into(),
                content: "绝密内容不能出现在画布上".into(),
                folder_id: None,
            })
            .unwrap();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute("UPDATE notes SET is_encrypted = 1 WHERE id = ?1", [note.id])
                .unwrap();
        }

        let got = for_notes(&db, &[note.id]).unwrap();
        assert!(!got[0].excerpt.contains("绝密"), "加密内容泄露了: {}", got[0].excerpt);
        assert!(got[0].excerpt.contains("🔒"));
    }

    /// 白板卡片要显示画布文字，不能是 Excalidraw JSON
    #[test]
    fn whiteboard_uses_canvas_text() {
        let db = mem_db();
        let wb = db
            .create_whiteboard(
                &NoteInput {
                    title: "流程图".into(),
                    content: r#"{"type":"excalidraw","elements":[]}"#.into(),
                    folder_id: None,
                },
                "订单流程草图",
            )
            .unwrap();

        let got = for_notes(&db, &[wb.id]).unwrap();
        assert_eq!(got[0].excerpt, "订单流程草图");
        assert!(!got[0].excerpt.contains("excalidraw"), "不该泄露画布 JSON");
    }

    #[test]
    fn rejects_oversized_batch() {
        let db = mem_db();
        let ids: Vec<i64> = (0..(MAX_IDS as i64 + 1)).collect();
        assert!(for_notes(&db, &ids).is_err());
    }
}
