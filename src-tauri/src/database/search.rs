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
        // 提取搜索词（按空格分隔，每个词用 LIKE 匹配）
        let keywords: Vec<String> = query
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", s))
            .collect();

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
            "SELECT n.id, n.title,
                    substr(n.content, 1, 200) as snippet,
                    n.updated_at, n.folder_id
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
