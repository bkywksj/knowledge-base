//! 同步相关 DAO：同步历史记录读写 + 导出辅助（VACUUM/COUNT）

use std::path::Path;

use rusqlite::params;

use crate::error::AppError;
use crate::models::SyncHistoryItem;

use super::Database;

impl Database {
    /// 记录一次同步（开始，返回 id）
    pub fn sync_history_begin(&self, direction: &str) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_history (direction, started_at, success, stats_json)
             VALUES (?1, datetime('now', 'localtime'), 0, '{}')",
            params![direction],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 完成一次同步
    pub fn sync_history_finish(
        &self,
        id: i64,
        success: bool,
        error: Option<&str>,
        stats_json: &str,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_history
             SET finished_at = datetime('now', 'localtime'),
                 success = ?2,
                 error = ?3,
                 stats_json = ?4
             WHERE id = ?1",
            params![id, success as i32, error, stats_json],
        )?;
        Ok(())
    }

    /// VACUUM INTO：把当前 DB 完整拷贝到新路径（合并 WAL，脱离锁冲突）
    /// 用于生成"干净的"DB 快照供同步包打包
    pub fn vacuum_into(&self, target_path: &Path) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let path_str = target_path.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{}'", path_str))?;
        Ok(())
    }

    /// 未回收笔记数量
    pub fn count_notes_active(&self) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0",
            [],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }

    /// 文件夹数量
    pub fn count_folders(&self) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))?;
        Ok(n as usize)
    }

    /// 标签数量
    pub fn count_tags(&self) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))?;
        Ok(n as usize)
    }

    /// 列出最近的同步历史
    pub fn list_sync_history(&self, limit: usize) -> Result<Vec<SyncHistoryItem>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, direction, started_at, finished_at, success, error, stats_json
             FROM sync_history
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(SyncHistoryItem {
                    id: row.get(0)?,
                    direction: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    success: row.get::<_, i32>(4)? != 0,
                    error: row.get(5)?,
                    stats_json: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
