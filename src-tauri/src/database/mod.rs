pub mod ai;
pub mod folders;
pub mod links;
pub mod notes;
pub mod schema;
pub mod search;
pub mod tags;
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
    pub fn get_dashboard_stats(&self) -> Result<crate::models::DashboardStats, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let total_notes: usize = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0",
            [],
            |row| row.get(0),
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

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let today_updated: usize = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0 AND updated_at LIKE ?1",
            [format!("{}%", today)],
            |row| row.get(0),
        )?;

        let total_words: usize = conn.query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM notes WHERE is_deleted = 0",
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

    /// 删除配置
    pub fn delete_config(&self, key: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM app_config WHERE key = ?1", [key])?;
        Ok(affected > 0)
    }
}
