use rusqlite::params;

use crate::error::AppError;
use crate::models::SearchResult;

use super::Database;

impl Database {
    /// 全文搜索：先用 FTS5，无结果则用 LIKE 模糊搜索兜底（支持中文）
    pub fn search_notes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 1. 尝试 FTS5 搜索（需要转换为 FTS5 语法）
        let fts_query = sanitize_fts_query(query);
        if !fts_query.is_empty() {
            let fts_results = Self::search_fts(&conn, &fts_query, limit);
            if let Ok(ref results) = fts_results {
                if !results.is_empty() {
                    return fts_results;
                }
            }
        }

        // 2. FTS5 无结果，用 LIKE 模糊搜索兜底（用原始查询）
        Self::search_like(&conn, query, limit)
    }

    fn search_fts(
        conn: &rusqlite::Connection,
        fts_query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, AppError> {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title,
                    snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
                    n.updated_at, n.folder_id
             FROM notes_fts fts
             JOIN notes n ON fts.rowid = n.id
             WHERE notes_fts MATCH ?1 AND n.is_deleted = 0
             ORDER BY rank
             LIMIT ?2",
        )?;

        let results = stmt
            .query_map(params![fts_query, limit as i64], |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    snippet: row.get(2)?,
                    updated_at: row.get(3)?,
                    folder_id: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(results)
    }

    fn search_like(
        conn: &rusqlite::Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, AppError> {
        let raw_keywords: Vec<&str> = query.split_whitespace().filter(|s| !s.is_empty()).collect();
        // 提取搜索词（按空格分隔，每个词用 LIKE 匹配）
        let keywords: Vec<String> = raw_keywords.iter().map(|s| format!("%{}%", s)).collect();

        if keywords.is_empty() {
            return Ok(Vec::new());
        }

        // 构建 WHERE 条件：每个关键词匹配 title 或 content
        let where_clauses: Vec<String> = keywords
            .iter()
            .enumerate()
            .map(|(i, _)| format!("(n.title LIKE ?{0} OR n.content LIKE ?{0})", i + 1))
            .collect();

        let sql = format!(
            "SELECT n.id, n.title, n.content, n.updated_at, n.folder_id
             FROM notes n
             WHERE n.is_deleted = 0 AND ({})
             ORDER BY n.updated_at DESC
             LIMIT ?{}",
            where_clauses.join(" AND "),
            keywords.len() + 1
        );

        let mut stmt = conn.prepare(&sql)?;

        // 绑定参数
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = keywords
            .iter()
            .map(|k| Box::new(k.clone()) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        param_values.push(Box::new(limit as i64));

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let results = stmt
            .query_map(&*params_ref, |row| {
                let content: String = row.get(2)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    content,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // 生成带高亮的 snippet
        let results = results
            .into_iter()
            .map(|(id, title, content, updated_at, folder_id)| {
                let snippet = build_highlight_snippet(&content, &raw_keywords);
                SearchResult {
                    id,
                    title,
                    snippet,
                    updated_at,
                    folder_id,
                }
            })
            .collect();

        Ok(results)
    }
}

/// 生成带 <mark> 高亮的摘要：截取第一个关键词附近的上下文
fn build_highlight_snippet(content: &str, keywords: &[&str]) -> String {
    // 去掉 HTML 标签，取纯文本
    let chars: Vec<char> = strip_tags(content).chars().collect();
    let total = chars.len();
    if total == 0 {
        return String::new();
    }

    let plain_lower: String = chars.iter().collect::<String>().to_lowercase();
    let snippet_len = 150;

    // 找第一个关键词出现的 char 位置
    let first_char_pos = keywords.iter().find_map(|kw| {
        let kw_lower = kw.to_lowercase();
        plain_lower.find(&kw_lower).map(|byte_pos| {
            plain_lower[..byte_pos].chars().count()
        })
    });

    // 截取片段：关键词前后各取一段
    let (start, end) = if let Some(char_pos) = first_char_pos {
        let s = char_pos.saturating_sub(30);
        let e = (s + snippet_len).min(total);
        (s, e)
    } else {
        (0, snippet_len.min(total))
    };

    let snippet_chars = &chars[start..end];
    let mut snippet: String = snippet_chars.iter().collect();
    if start > 0 {
        snippet = format!("...{}", snippet);
    }
    if end < total {
        snippet.push_str("...");
    }

    // 对所有关键词加 <mark> 高亮（大小写不敏感，基于 char 操作）
    for kw in keywords {
        let kw_lower = kw.to_lowercase();
        let kw_char_len = kw_lower.chars().count();
        let snippet_chars: Vec<char> = snippet.chars().collect();
        let snippet_lower: Vec<char> = snippet.to_lowercase().chars().collect();
        let mut result = String::new();
        let mut i = 0;

        while i < snippet_chars.len() {
            if i + kw_char_len <= snippet_chars.len()
                && snippet_lower[i..i + kw_char_len]
                    .iter()
                    .collect::<String>()
                    == kw_lower
            {
                result.push_str("<mark>");
                for j in i..i + kw_char_len {
                    result.push(snippet_chars[j]);
                }
                result.push_str("</mark>");
                i += kw_char_len;
            } else {
                result.push(snippet_chars[i]);
                i += 1;
            }
        }
        snippet = result;
    }

    snippet
}

/// 简单去除 HTML 标签
fn strip_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    result
}

/// 将查询转换为 FTS5 语法：每个词用双引号包裹，去除 FTS5 特殊字符
fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | ':' | '^' | '{' | '}'))
                .collect();
            if clean.is_empty() {
                String::new()
            } else {
                format!("\"{}\"", clean)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
