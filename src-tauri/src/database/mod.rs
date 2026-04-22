pub mod ai;
pub mod folders;
pub mod links;
pub mod notes;
pub mod schema;
pub mod search;
pub mod sync;
pub mod tags;
pub mod tasks;
pub mod templates;

use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppError;
use crate::models::AppConfig;

/// 数据库封装，线程安全
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 初始化数据库（创建或打开 + 自动迁移）
    pub fn init(db_path: &str) -> Result<Self, AppError> {
        let conn = Connection::open(db_path)?;

        // 启用 WAL 模式提升并发性能
        conn.pragma_update(None, "journal_mode", "WAL")?;

        // 启用外键约束（SQLite 默认关闭，不开则 ON DELETE CASCADE 不生效）
        conn.pragma_update(None, "foreign_keys", "ON")?;

        // WAL 下 NORMAL 足够安全（只有断电可能丢最后一次事务），比 FULL 快 2~5 倍
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // 负数表示 KB，-64000 = 64MB 内存页缓存，减少磁盘读取（默认 2MB 远远不够）
        conn.pragma_update(None, "cache_size", -64000)?;
        // 32MB 内存映射，加速大范围顺序读（例如笔记列表、图谱）
        conn.pragma_update(None, "mmap_size", 33_554_432_i64)?;
        // 排序/临时表走内存，避免磁盘 I/O
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        // 并发锁等待 5 秒再报 SQLITE_BUSY，避免瞬时冲突立即失败
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        // 执行 Schema 迁移
        schema::migrate(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 获取数据库连接锁（供 Service 层复杂操作使用）
    pub fn conn_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, AppError> {
        self.conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))
    }

    // ─── 配置 DAO ────────────────────────────────────

    /// 获取所有配置
    pub fn get_all_config(&self) -> Result<Vec<AppConfig>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT key, value FROM app_config ORDER BY key")?;
        let configs = stmt
            .query_map([], |row| {
                Ok(AppConfig {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(configs)
    }

    /// 获取单个配置
    pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;
        let result = stmt
            .query_row([key], |row| row.get::<_, String>(0))
            .ok();
        Ok(result)
    }

    /// 设置配置（upsert）
    pub fn set_config(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO app_config (key, value, updated_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            [key, value],
        )?;
        Ok(())
    }

    // ─── 统计 DAO ─────────────────────────────────────

    /// 获取首页统计数据
    ///
    /// 合并成 2 条 SQL：一次算 notes 相关（4 项），一次算 folders/tags/links 行数。
    /// 旧实现 6 次 query_row + `updated_at LIKE '2026-04-22%'` 会走全表扫描（字符串前缀匹配
    /// 不能命中 idx_notes_updated 索引），合并后锁持有时间显著降低。
    pub fn get_dashboard_stats(&self) -> Result<crate::models::DashboardStats, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        // 对 notes 的 4 个聚合用一次扫描完成
        let (total_notes, today_updated, total_words): (usize, usize, usize) = conn.query_row(
            "SELECT
                COUNT(*) FILTER (WHERE is_deleted = 0),
                COUNT(*) FILTER (WHERE is_deleted = 0 AND substr(updated_at, 1, 10) = ?1),
                COALESCE(SUM(word_count) FILTER (WHERE is_deleted = 0), 0)
             FROM notes",
            [&today],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? as usize)),
        )?;

        let total_folders: usize = conn.query_row(
            "SELECT COUNT(*) FROM folders",
            [],
            |row| row.get(0),
        )?;
        let total_tags: usize = conn.query_row(
            "SELECT COUNT(*) FROM tags",
            [],
            |row| row.get(0),
        )?;
        let total_links: usize = conn.query_row(
            "SELECT COUNT(*) FROM note_links",
            [],
            |row| row.get(0),
        )?;

        Ok(crate::models::DashboardStats {
            total_notes,
            total_folders,
            total_tags,
            total_links,
            today_updated,
            total_words,
        })
    }

    /// 获取最近 N 天的写作趋势
    pub fn get_writing_trend(&self, days: i32) -> Result<Vec<crate::models::DailyWritingStat>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT DATE(updated_at) as d, COUNT(*) as cnt, COALESCE(SUM(word_count), 0) as wc
             FROM notes
             WHERE is_deleted = 0
               AND updated_at >= DATE('now', 'localtime', ?1)
             GROUP BY d
             ORDER BY d",
        )?;
        let offset = format!("-{} days", days);
        let stats = stmt
            .query_map([&offset], |row| {
                Ok(crate::models::DailyWritingStat {
                    date: row.get(0)?,
                    note_count: row.get(1)?,
                    word_count: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(stats)
    }

    /// 删除配置
    pub fn delete_config(&self, key: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM app_config WHERE key = ?1", [key])?;
        Ok(affected > 0)
    }

}
