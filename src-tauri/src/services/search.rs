use crate::database::Database;
use crate::error::AppError;
use crate::models::{SearchFilters, SearchResult};

/// 搜索服务
pub struct SearchService;

impl SearchService {
    /// 搜索笔记（处理空查询、限制默认值、应用筛选）
    ///
    /// `filters = None` 与全部维度都没勾等价，走原有行为。
    pub fn search_filtered(
        db: &Database,
        query: &str,
        limit: Option<usize>,
        filters: Option<SearchFilters>,
    ) -> Result<Vec<SearchResult>, AppError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let limit = limit.unwrap_or(50).min(200);
        let filters = filters.unwrap_or_default();

        // 传原始查询给 Database 层，由它分别处理 FTS 和 LIKE
        db.search_notes_filtered(query, limit, &filters)
    }
}
