//! 定时推送 DAO
//!
//! 表结构见 `schema.rs` 中的 v46 -> v47 迁移（push_jobs / push_run_logs）。
//! 业务层约定：
//! - 列表按 `created_at DESC, id DESC` 展示（最近建的在前）
//! - 调度专用查询：`peek_next_run_at` / `list_due_push_jobs` / `update_push_job_run`
//!   只看 `enabled = 1` 的推送；禁用的推送对调度器不可见
//! - 写操作（create/update/delete/set_enabled）后由命令层 notify 调度器重算，不在 DAO 里耦合

use rusqlite::params;

use super::Database;
use crate::error::AppError;
use crate::models::{
    CreatePushJobInput, PushJob, PushPopupData, PushRunLog, UpdatePushJobInput,
};

/// push_jobs 全列，SELECT 与 row 映射共用，避免索引错位
const PUSH_JOB_COLS: &str = "id, name, prompt, model_id, source_kind, source_config, \
    schedule_time, repeat_kind, repeat_weekdays, channels, enabled, last_run_at, next_run_at, \
    created_at, updated_at";

fn row_to_push_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<PushJob> {
    Ok(PushJob {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        model_id: row.get(3)?,
        source_kind: row.get(4)?,
        source_config: row.get(5)?,
        schedule_time: row.get(6)?,
        repeat_kind: row.get(7)?,
        repeat_weekdays: row.get(8)?,
        channels: row.get(9)?,
        enabled: row.get::<_, i32>(10)? != 0,
        last_run_at: row.get(11)?,
        next_run_at: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

impl Database {
    // ─── CRUD ─────────────────────────────────

    pub fn list_push_jobs(&self) -> Result<Vec<PushJob>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM push_jobs ORDER BY created_at DESC, id DESC",
            PUSH_JOB_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_push_job)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_push_job(&self, id: i64) -> Result<PushJob, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!("SELECT {} FROM push_jobs WHERE id = ?1", PUSH_JOB_COLS);
        conn.query_row(&sql, params![id], row_to_push_job)
            .map_err(|_| AppError::NotFound(format!("推送 #{} 不存在", id)))
    }

    /// 创建推送。`next_run_at` 由调用方（Service 层）算好后传入，DAO 只负责落库。
    pub fn create_push_job(
        &self,
        input: &CreatePushJobInput,
        next_run_at: Option<&str>,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let source_kind = input.source_kind.as_deref().unwrap_or("none");
        let source_config = input.source_config.as_deref().unwrap_or("{}");
        let repeat_kind = input.repeat_kind.as_deref().unwrap_or("daily");
        let channels = input.channels.as_deref().unwrap_or("[\"notification\"]");
        let enabled = input.enabled.unwrap_or(true) as i32;
        conn.execute(
            "INSERT INTO push_jobs
                (name, prompt, model_id, source_kind, source_config, schedule_time,
                 repeat_kind, repeat_weekdays, channels, enabled, next_run_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                input.name,
                input.prompt,
                input.model_id,
                source_kind,
                source_config,
                input.schedule_time,
                repeat_kind,
                input.repeat_weekdays,
                channels,
                enabled,
                next_run_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 更新推送业务字段（不含调度字段 last_run_at）。`next_run_at` 由 Service 层重算后传入。
    pub fn update_push_job(
        &self,
        id: i64,
        input: &UpdatePushJobInput,
        next_run_at: Option<&str>,
    ) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let source_kind = input.source_kind.as_deref().unwrap_or("none");
        let source_config = input.source_config.as_deref().unwrap_or("{}");
        let repeat_kind = input.repeat_kind.as_deref().unwrap_or("daily");
        let channels = input.channels.as_deref().unwrap_or("[\"notification\"]");
        let enabled = input.enabled.unwrap_or(true) as i32;
        let affected = conn.execute(
            "UPDATE push_jobs SET
                name = ?2, prompt = ?3, model_id = ?4, source_kind = ?5, source_config = ?6,
                schedule_time = ?7, repeat_kind = ?8, repeat_weekdays = ?9, channels = ?10,
                enabled = ?11, next_run_at = ?12, updated_at = datetime('now','localtime')
             WHERE id = ?1",
            params![
                id,
                input.name,
                input.prompt,
                input.model_id,
                source_kind,
                source_config,
                input.schedule_time,
                repeat_kind,
                input.repeat_weekdays,
                channels,
                enabled,
                next_run_at,
            ],
        )?;
        Ok(affected > 0)
    }

    pub fn delete_push_job(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM push_jobs WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 开关启用。`next_run_at` 在启用时由 Service 层重算传入；禁用时传 None 清空。
    pub fn set_push_job_enabled(
        &self,
        id: i64,
        enabled: bool,
        next_run_at: Option<&str>,
    ) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE push_jobs SET enabled = ?2, next_run_at = ?3,
                updated_at = datetime('now','localtime') WHERE id = ?1",
            params![id, enabled as i32, next_run_at],
        )?;
        Ok(affected > 0)
    }

    // ─── 调度专用 ─────────────────────────────

    /// 最近一个待运行时刻：所有启用且有 next_run_at 的推送里取最小值。
    /// 调度器据此 sleep_until。无启用推送时返回 None。
    pub fn peek_next_push_run_at(&self) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let v: Option<String> = conn
            .query_row(
                "SELECT MIN(next_run_at) FROM push_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        Ok(v)
    }

    /// 捞出所有"到点该跑"的启用推送：next_run_at <= now。
    pub fn list_due_push_jobs(&self) -> Result<Vec<PushJob>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM push_jobs
             WHERE enabled = 1
               AND next_run_at IS NOT NULL
               AND datetime(next_run_at) <= datetime('now','localtime')",
            PUSH_JOB_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_push_job)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 推进调度字段：记下本次运行时刻 + 下次预计时刻（防调度器重入重复推送）。
    pub fn update_push_job_run(
        &self,
        id: i64,
        last_run_at: &str,
        next_run_at: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE push_jobs SET last_run_at = ?2, next_run_at = ?3 WHERE id = ?1",
            params![id, last_run_at, next_run_at],
        )?;
        Ok(())
    }

    // ─── 运行历史 ─────────────────────────────

    /// 写一条运行记录，返回新行 id（弹窗投递据此打开 `#/push-popup/<id>`）。
    pub fn insert_push_run_log(
        &self,
        job_id: i64,
        run_at: &str,
        status: &str,
        item_count: i32,
        payload: Option<&str>,
        error: Option<&str>,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO push_run_logs (job_id, run_at, status, item_count, payload, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![job_id, run_at, status, item_count, payload, error],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 按 run_log id 取弹窗展示数据（JOIN 推送名）。成功取 payload，失败取 error。
    pub fn get_push_popup_data(&self, log_id: i64) -> Result<PushPopupData, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.query_row(
            "SELECT j.name, l.status, l.run_at, l.payload, l.error
             FROM push_run_logs l JOIN push_jobs j ON j.id = l.job_id
             WHERE l.id = ?1",
            params![log_id],
            |row| {
                let name: String = row.get(0)?;
                let status: String = row.get(1)?;
                let run_at: String = row.get(2)?;
                let payload: Option<String> = row.get(3)?;
                let error: Option<String> = row.get(4)?;
                let content = payload
                    .or(error)
                    .unwrap_or_else(|| "（无内容）".to_string());
                Ok(PushPopupData {
                    name,
                    content,
                    status,
                    run_at,
                })
            },
        )
        .map_err(|_| AppError::NotFound(format!("推送记录 #{} 不存在", log_id)))
    }

    /// 取某条推送的最近 N 条运行历史（前端"查看上次推了什么"用）
    pub fn list_push_run_logs(&self, job_id: i64, limit: i64) -> Result<Vec<PushRunLog>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, job_id, run_at, status, item_count, payload, error
             FROM push_run_logs WHERE job_id = ?1 ORDER BY run_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![job_id, limit], |row| {
                Ok(PushRunLog {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    run_at: row.get(2)?,
                    status: row.get(3)?,
                    item_count: row.get(4)?,
                    payload: row.get(5)?,
                    error: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
