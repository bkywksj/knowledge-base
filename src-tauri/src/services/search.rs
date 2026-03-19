use crate::database::Database;
use crate::error::AppError;
use crate::models::SearchResult;

/// 搜索服务
pub struct SearchService;

impl SearchService {
    /// 搜索笔记（处理空查询、限制默认值）
    pub fn search(
        db: &Database,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<SearchResult>, AppError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let limit = limit.unwrap_or(50).min(200);
        let sanitized = sanitize_fts_query(query);

        if sanitized.is_empty() {
            return Ok(Vec::new());
        }

        db.search_notes(&sanitized, limit)
    }
}

/// 将查询分词，每个词用双引号包裹，去除 FTS5 特殊字符
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
