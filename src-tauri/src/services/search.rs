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

        // 传原始查询给 Database 层，由它分别处理 FTS 和 LIKE
        db.search_notes(query, limit)
    }
}
