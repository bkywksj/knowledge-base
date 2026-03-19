use rusqlite::params;

use crate::error::AppError;
use crate::models::SearchResult;

use super::Database;

impl Database {
    /// FTS5 全文搜索
    pub fn search_notes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

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
            .query_map(params![query, limit as i64], |row| {
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
