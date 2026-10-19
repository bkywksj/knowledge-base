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

    /// 一次性写入一条**已完成**的同步记录（begin + finish 合并）。
    ///
    /// 专给"整库导入 / WebDAV 恢复"用：这两条链路会把 `app.db` 整个替换掉，
    /// 若沿用 `begin` → 替换 → `finish` 的写法，`begin` 拿到的 rowid 属于**被替换掉的旧库**，
    /// 替换后再 `finish` 就是在新库里 UPDATE 一个不存在的 id → 影响 0 行，
    /// 这条导入历史静默消失（用户在设置页看不到刚做过的恢复记录）。
    ///
    /// 改为等替换 + reopen 完成后，用真实的开始时间一次性插进**新库**。
    pub fn sync_history_record_done(
        &self,
        direction: &str,
        started_at: &str,
        success: bool,
        error: Option<&str>,
        stats_json: &str,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_history (direction, started_at, finished_at, success, error, stats_json)
             VALUES (?1, ?2, datetime('now', 'localtime'), ?3, ?4, ?5)",
            params![direction, started_at, success as i32, error, stats_json],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// VACUUM INTO：把当前 DB 完整拷贝到新路径（合并 WAL，脱离锁冲突）
    /// 用于生成"干净的"DB 快照供同步包打包
    ///
    /// 另开一条连接执行，不拿主连接的 Mutex：库大时 VACUUM 要几秒到几十秒，
    /// 若在主锁内跑，期间列表 / 搜索 / 保存笔记全部排队，自动同步时窗口像假死。
    /// WAL 模式下这条连接只是一个读事务，看到的是开始时刻已提交数据的一致快照，
    /// 不阻塞主连接写入。内存库 / release 期间拿不到文件路径，退回在主锁内执行。
    pub fn vacuum_into(&self, target_path: &Path) -> Result<(), AppError> {
        let path_str = target_path.to_string_lossy().replace('\'', "''");
        let sql = format!("VACUUM INTO '{}'", path_str);
        if let Some(db_path) = self.file_path() {
            let conn = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            // 主连接若恰好在 checkpoint，读连接会短暂 BUSY，等一会儿而不是直接失败
            conn.busy_timeout(std::time::Duration::from_secs(10))?;
            conn.execute_batch(&sql)?;
            return Ok(());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute_batch(&sql)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn temp_db_path(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("kb-vacuum-{}-{}-{}.db", tag, std::process::id(), nanos))
    }

    fn cleanup(p: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", p.display(), suffix));
        }
    }

    /// 备份产物能打开、数据完整；并且整个过程不需要主连接的锁 ——
    /// 测试线程攥着主锁不放，VACUUM 仍要在超时内完成（回退到主锁实现会卡死而超时）
    #[test]
    fn vacuum_into_uses_separate_connection_and_keeps_data() {
        let src = temp_db_path("src");
        let dst = temp_db_path("dst");
        let db = Arc::new(Database::init(&src.to_string_lossy()).expect("init"));
        db.set_config("vacuum.test", "保留的值").expect("set");

        let guard = db.conn_lock().expect("lock");
        let (tx, rx) = mpsc::channel();
        let db2 = Arc::clone(&db);
        let dst2 = dst.clone();
        std::thread::spawn(move || {
            let _ = tx.send(db2.vacuum_into(&dst2).map_err(|e| e.to_string()));
        });
        let res = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("VACUUM INTO 不应等待主连接锁");
        drop(guard);
        res.expect("vacuum ok");

        let copy = rusqlite::Connection::open(&dst).expect("open copy");
        let v: String = copy
            .query_row(
                "SELECT value FROM app_config WHERE key = 'vacuum.test'",
                [],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(v, "保留的值");
        drop(copy);
        drop(db);
        cleanup(&src);
        cleanup(&dst);
    }
}
