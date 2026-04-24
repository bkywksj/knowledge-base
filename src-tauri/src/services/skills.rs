//! AI Skills 框架 v1 — 让 AI 在对话里调用本地只读工具
//!
//! 设计要点（详见 docs/tasks/bilibili-feedback-tasks.md T-004）：
//! - **只读**：v1 只暴露查询类接口（搜索/读笔记/列标签/查关联/看今日待办），
//!   避免 AI 误删/误改；写入类（创建/删除/移动）放 v2 + 二次确认
//! - **OpenAI function-calling 兼容**：`tool_schemas()` 返回符合 OpenAI `tools` 字段
//!   的 JSON，其他厂商（DeepSeek/智谱/Claude 代理）都能复用这套 schema
//! - **dispatch 集中执行**：`dispatch(db, name, args_json)` 按 skill name 路由到
//!   具体实现；返回的 result 字符串会经由 AI 流式通道回注到模型作为 tool role 消息
//! - **结果截断**：防 token 爆炸，笔记/列表类返回统一裁剪到 ~2000 字节
//!
//! 不在本模块做的事：
//! - 不做 tool_calls 流式解析（在 `services::ai::chat_stream_with_skills` 里）
//! - 不做持久化（在 `database::ai` 里）
//! - 不做前端渲染（在 `src/pages/ai` 里）

use serde::Deserialize;
use serde_json::{json, Value};

use crate::database::Database;
use crate::error::AppError;
use crate::models::TaskQuery;

/// 结果字符串长度上限（按字符计），超过的部分被截断并用 "…（已截断）" 标记
const SKILL_RESULT_MAX_CHARS: usize = 2000;

/// 按 OpenAI tools 格式返回所有可用 skill 的 schema
///
/// 返回的 Value 可以直接塞到 chat/completions 请求的 `tools` 字段里，
/// 形如：`{"type":"function","function":{"name":"xxx","description":"...","parameters":{...}}}`
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "搜索用户的本地笔记，返回匹配的标题和摘要。用于找与用户问题相关的笔记内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索关键词，可中英文" },
                        "limit": { "type": "integer", "description": "最多返回几条，默认 5，最大 20", "default": 5 }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_note",
                "description": "按 ID 读取一篇笔记的完整内容。在 search_notes 找到目标后，用这个取全文。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "integer", "description": "笔记 ID" }
                    },
                    "required": ["id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_tags",
                "description": "列出所有标签及每个标签关联的笔记数。用于了解知识库的主题分布。",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "find_related",
                "description": "查找与指定笔记相关的笔记（反向链接 [[wiki-link]]）。用于顺藤摸瓜。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "integer", "description": "起始笔记 ID" }
                    },
                    "required": ["note_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_today_tasks",
                "description": "获取用户今天的待办任务（未完成）。用于回答\"我今天要做什么\"。",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
    ]
}

/// 所有已知 skill 的名字集合，用于拒绝未知工具调用
pub fn known_skill_names() -> &'static [&'static str] {
    &[
        "search_notes",
        "get_note",
        "list_tags",
        "find_related",
        "get_today_tasks",
    ]
}

// ─── dispatch 入口 ─────────────────────────────

/// 按 name 路由到具体实现，返回字符串化的结果（已截断）
///
/// 返回 `Err(AppError)` 代表执行失败（DB 错误 / 参数解析失败 / 未知 skill 等），
/// 调用方（`services::ai`）把错误消息当作 tool result 回注给 AI，让 AI 有机会自我修正。
pub fn dispatch(db: &Database, name: &str, args_json: &str) -> Result<String, AppError> {
    let result = match name {
        "search_notes" => run_search_notes(db, args_json)?,
        "get_note" => run_get_note(db, args_json)?,
        "list_tags" => run_list_tags(db)?,
        "find_related" => run_find_related(db, args_json)?,
        "get_today_tasks" => run_get_today_tasks(db)?,
        other => {
            return Err(AppError::Custom(format!(
                "未知 skill: {}。可用：{}",
                other,
                known_skill_names().join(", ")
            )));
        }
    };
    Ok(truncate(&result, SKILL_RESULT_MAX_CHARS))
}

// ─── 各 skill 实现 ────────────────────────────

#[derive(Debug, Deserialize)]
struct SearchNotesArgs {
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

fn run_search_notes(db: &Database, args: &str) -> Result<String, AppError> {
    let a: SearchNotesArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("search_notes 参数非法: {}", e)))?;
    let limit = a.limit.unwrap_or(5).clamp(1, 20) as usize;
    let notes = db.search_notes_for_rag(&a.query, limit)?;
    if notes.is_empty() {
        return Ok("未找到相关笔记".to_string());
    }
    let hits: Vec<Value> = notes
        .into_iter()
        .map(|(id, title, content)| {
            // 给 AI 一个 250 字摘要足够判断是否相关，再决定要不要 get_note 读全文
            let snippet = summarize_content(&content, 250);
            json!({ "id": id, "title": title, "snippet": snippet })
        })
        .collect();
    Ok(serde_json::to_string(&json!({ "hits": hits }))
        .unwrap_or_else(|_| "[]".to_string()))
}

#[derive(Debug, Deserialize)]
struct GetNoteArgs {
    id: i64,
}

fn run_get_note(db: &Database, args: &str) -> Result<String, AppError> {
    let a: GetNoteArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("get_note 参数非法: {}", e)))?;
    let note = db
        .get_note(a.id)?
        .ok_or_else(|| AppError::Custom(format!("笔记 #{} 不存在", a.id)))?;
    // content 是 markdown，直接回给 AI；截断在 dispatch 尾部统一做
    Ok(serde_json::to_string(&json!({
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "folder_id": note.folder_id,
        "updated_at": note.updated_at,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

fn run_list_tags(db: &Database) -> Result<String, AppError> {
    let tags = db.list_tags()?;
    let arr: Vec<Value> = tags
        .into_iter()
        .map(|t| json!({ "id": t.id, "name": t.name, "note_count": t.note_count }))
        .collect();
    Ok(serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string()))
}

#[derive(Debug, Deserialize)]
struct FindRelatedArgs {
    note_id: i64,
}

fn run_find_related(db: &Database, args: &str) -> Result<String, AppError> {
    let a: FindRelatedArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("find_related 参数非法: {}", e)))?;
    let links = db.get_backlinks(a.note_id)?;
    if links.is_empty() {
        return Ok(r#"{"backlinks":[]}"#.to_string());
    }
    let arr: Vec<Value> = links
        .into_iter()
        .map(|l| {
            json!({
                "source_id": l.source_id,
                "source_title": l.source_title,
                "context": l.context,
            })
        })
        .collect();
    Ok(serde_json::to_string(&json!({ "backlinks": arr }))
        .unwrap_or_else(|_| "{}".to_string()))
}

fn run_get_today_tasks(db: &Database) -> Result<String, AppError> {
    // TaskQuery.status = Some(0) 表示只看未完成
    let query = TaskQuery {
        status: Some(0),
        keyword: None,
        priority: None,
    };
    let tasks = db.list_tasks(query)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    // 过滤：due_date 是今天 或 过期的（视为今天要处理）；没截止也算今日需关注
    let filtered: Vec<Value> = tasks
        .into_iter()
        .filter(|t| match &t.due_date {
            Some(d) => d.starts_with(&today) || d.as_str() < today.as_str(),
            None => true,
        })
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "priority": t.priority,
                "due_date": t.due_date,
                "important": t.important,
            })
        })
        .collect();
    Ok(serde_json::to_string(&json!({
        "date": today,
        "tasks": filtered,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

// ─── 工具函数 ─────────────────────────────────

/// 按字符截断，超长时追加省略提示（避免 AI 以为得到了完整内容）
fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let head: String = chars.iter().take(max_chars).collect();
    format!("{}…（已截断，共 {} 字符）", head, chars.len())
}

/// 去 HTML/多余空白后取前 N 字符，给 AI 当"摘要"看
fn summarize_content(content: &str, max_chars: usize) -> String {
    let mut s = String::with_capacity(content.len());
    let mut in_tag = false;
    for ch in content.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => s.push(ch),
            _ => {}
        }
    }
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preserves_short_strings() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_adds_suffix_when_over_limit() {
        let out = truncate("abcdefghij", 3);
        assert!(out.starts_with("abc…"));
        assert!(out.contains("共 10"));
    }

    #[test]
    fn summarize_strips_html_and_whitespace() {
        let raw = "<p>hello   <b>world</b></p>  foo";
        assert_eq!(summarize_content(raw, 100), "hello world foo");
    }

    #[test]
    fn tool_schemas_contain_all_known_skills() {
        let schemas = tool_schemas();
        let names: Vec<String> = schemas
            .iter()
            .filter_map(|v| v["function"]["name"].as_str().map(String::from))
            .collect();
        for &k in known_skill_names() {
            assert!(names.contains(&k.to_string()), "missing schema for {}", k);
        }
    }
}
