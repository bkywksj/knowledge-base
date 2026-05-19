//! T-024 同步 V1：sync_backends + sync_remote_state DAO
//!
//! 不和老 `database/sync.rs`（V0 ZIP 模式的 vacuum_into 等辅助）混在一起，
//! 单独成模块。老代码保留兼容 V0 流程。

use rusqlite::params;

use crate::error::AppError;
use crate::models::{SyncBackend, SyncBackendInput, SyncBackendKind, SyncRemoteState};

use super::Database;

fn parse_kind(s: &str) -> SyncBackendKind {
    match s {
        "local" => SyncBackendKind::Local,
        "webdav" => SyncBackendKind::Webdav,
        "s3" => SyncBackendKind::S3,
        // git 已下线（曾在原型阶段保留）；老数据兜底为 Local，让用户在 UI 上重选
        _ => SyncBackendKind::Local,
    }
}

fn kind_to_str(k: SyncBackendKind) -> &'static str {
    match k {
        SyncBackendKind::Local => "local",
        SyncBackendKind::Webdav => "webdav",
        SyncBackendKind::S3 => "s3",
    }
}

impl Database {
    // ─── sync_backends ─────────────────────────

    pub fn list_sync_backends(&self) -> Result<Vec<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
                    last_push_ts, last_pull_ts, created_at, updated_at
             FROM sync_backends
             ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let kind_str: String = row.get(1)?;
                Ok(SyncBackend {
                    id: row.get(0)?,
                    kind: parse_kind(&kind_str),
                    name: row.get(2)?,
                    config_json: row.get(3)?,
                    enabled: row.get::<_, i32>(4)? != 0,
                    auto_sync: row.get::<_, i32>(5)? != 0,
                    sync_interval_min: row.get(6)?,
                    last_push_ts: row.get(7)?,
                    last_pull_ts: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_sync_backend(&self, id: i64) -> Result<Option<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                "SELECT id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
                        last_push_ts, last_pull_ts, created_at, updated_at
                 FROM sync_backends WHERE id = ?1",
                [id],
                |row| {
                    let kind_str: String = row.get(1)?;
                    Ok(SyncBackend {
                        id: row.get(0)?,
                        kind: parse_kind(&kind_str),
                        name: row.get(2)?,
                        config_json: row.get(3)?,
                        enabled: row.get::<_, i32>(4)? != 0,
                        auto_sync: row.get::<_, i32>(5)? != 0,
                        sync_interval_min: row.get(6)?,
                        last_push_ts: row.get(7)?,
                        last_pull_ts: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    pub fn create_sync_backend(&self, input: &SyncBackendInput) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_backends
             (kind, name, config_json, enabled, auto_sync, sync_interval_min)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                kind_to_str(input.kind),
                input.name,
                input.config_json,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_sync_backend(&self, id: i64, input: &SyncBackendInput) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE sync_backends SET
                kind = ?1, name = ?2, config_json = ?3,
                enabled = ?4, auto_sync = ?5, sync_interval_min = ?6,
                updated_at = datetime('now', 'localtime')
             WHERE id = ?7",
            params![
                kind_to_str(input.kind),
                input.name,
                input.config_json,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("sync_backend {} 不存在", id)));
        }
        Ok(())
    }

    pub fn delete_sync_backend(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM sync_backends WHERE id = ?1", [id])?;
        Ok(affected > 0)
    }

    pub fn touch_sync_backend_push(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_push_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn touch_sync_backend_pull(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_pull_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ─── sync_remote_state ─────────────────────

    /// 拿某 backend 下所有笔记的同步状态，hash map 返回（按 note_id 索引）
    pub fn list_remote_state(
        &self,
        backend_id: i64,
    ) -> Result<std::collections::HashMap<i64, SyncRemoteState>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone
             FROM sync_remote_state WHERE backend_id = ?1",
        )?;
        let rows = stmt
            .query_map([backend_id], |row| {
                Ok(SyncRemoteState {
                    backend_id: row.get(0)?,
                    note_id: row.get(1)?,
                    remote_path: row.get(2)?,
                    last_synced_hash: row.get(3)?,
                    last_synced_ts: row.get(4)?,
                    tombstone: row.get::<_, i32>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(|s| (s.note_id, s)).collect())
    }

    /// upsert 一条同步状态（推送/拉取成功后调）
    pub fn upsert_remote_state(
        &self,
        backend_id: i64,
        note_id: i64,
        remote_path: &str,
        content_hash: &str,
        updated_ts: &str,
        tombstone: bool,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_remote_state
                (backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(backend_id, note_id) DO UPDATE SET
                remote_path      = excluded.remote_path,
                last_synced_hash = excluded.last_synced_hash,
                last_synced_ts   = excluded.last_synced_ts,
                tombstone        = excluded.tombstone",
            params![
                backend_id,
                note_id,
                remote_path,
                content_hash,
                updated_ts,
                tombstone as i32,
            ],
        )?;
        Ok(())
    }

    /// 清空某 backend 下所有 sync_remote_state 行
    ///
    /// 用于 hash 算法升级（v1 → v2）：远端 manifest 是旧算法时调本方法，
    /// 本机失去与该远端的同步状态映射 → 下次 push 会把本地全部笔记当作新增上传，
    /// 下次 pull 跳过（避免按旧 hash 误 diff）。
    pub fn clear_remote_state_for_backend(&self, backend_id: i64) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected =
            conn.execute("DELETE FROM sync_remote_state WHERE backend_id = ?1", [backend_id])?;
        Ok(affected)
    }

    /// 物理删除已确认 tombstone 推送完成的状态行
    ///
    /// 预留给 T-024 后续阶段：tombstone 同步成功后清理 sync_remote_state
    #[allow(dead_code)]
    pub fn purge_remote_state(&self, backend_id: i64, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "DELETE FROM sync_remote_state WHERE backend_id = ?1 AND note_id = ?2",
            [backend_id, note_id],
        )?;
        Ok(())
    }

    /// P2-c：清理 `sync_remote_state` 里的死数据行。
    ///
    /// 删除条件：state 行的 `note_id` 已不在 `compute_local_manifest` 的范围内 ——
    /// 即笔记被硬删（不在 `notes` 表）、或软删且 `deleted_at` 早于 `tombstone_cutoff`
    /// （超 tombstone 保留期）。这类笔记永不再进 manifest、diff 不会处理它们，
    /// 对应的 state 行是纯死数据。
    ///
    /// `tombstone_cutoff` 由调用方传 `compute_local_manifest` 同款的 30 天前阈值。
    /// 笔记若被 restore（`is_deleted` 1→0）会重回 manifest 范围 → 不被本方法删。
    /// 一条 SQL 清所有 backend（某笔记超期 → 所有 backend 的 manifest 都不带它）。
    ///
    /// 返回删除的行数。
    pub fn gc_sync_remote_state(&self, tombstone_cutoff: &str) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "DELETE FROM sync_remote_state
             WHERE note_id NOT IN (
                 SELECT id FROM notes
                 WHERE is_deleted = 0
                    OR (is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at >= ?1)
             )",
            params![tombstone_cutoff],
        )?;
        Ok(affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NoteInput, SyncBackendInput, SyncBackendKind};

    /// P2-c：gc_sync_remote_state 删孤儿行 + 超期 tombstone 行，
    /// 保留活笔记 / 30 天内软删的 state 行
    #[test]
    fn gc_sync_remote_state_removes_dead_rows() {
        let db = Database::init(":memory:").unwrap();

        let backend_id = db
            .create_sync_backend(&SyncBackendInput {
                kind: SyncBackendKind::Local,
                name: "t".into(),
                config_json: "{}".into(),
                enabled: Some(true),
                auto_sync: Some(false),
                sync_interval_min: Some(30),
            })
            .unwrap();

        let n_alive = db
            .create_note(&NoteInput {
                title: "活".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let n_recent = db
            .create_note(&NoteInput {
                title: "近删".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();
        let n_old = db
            .create_note(&NoteInput {
                title: "久删".into(),
                content: "z".into(),
                folder_id: None,
            })
            .unwrap();

        // 三条真笔记 + 一条孤儿（note_id 不存在，模拟硬删）都登记 sync_remote_state
        for nid in [n_alive.id, n_recent.id, n_old.id, 999_999] {
            db.upsert_remote_state(backend_id, nid, "notes/x.md", "h", "2026-01-01", false)
                .unwrap();
        }

        // n_recent 最近软删（deleted_at = now）
        db.soft_delete_note(n_recent.id).unwrap();
        // n_old 改成 60 天前删（超 30 天阈值）
        let old_ts = (chrono::Local::now() - chrono::Duration::days(60))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
                params![old_ts, n_old.id],
            )
            .unwrap();
        }

        let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let removed = db.gc_sync_remote_state(&cutoff).unwrap();
        assert_eq!(removed, 2, "应删：n_old（超 30 天软删）+ 999999（孤儿）");

        let states = db.list_remote_state(backend_id).unwrap();
        assert!(states.contains_key(&n_alive.id), "活笔记 state 必须保留");
        assert!(states.contains_key(&n_recent.id), "30 天内软删 state 必须保留");
        assert!(!states.contains_key(&n_old.id), "超 30 天软删 state 应删除");
        assert!(!states.contains_key(&999_999), "孤儿 state 应删除");
    }

    /// 笔记被 restore（is_deleted 1→0）→ 重回 manifest 范围 → GC 不应删它的 state
    #[test]
    fn gc_keeps_state_of_restored_note() {
        let db = Database::init(":memory:").unwrap();
        let backend_id = db
            .create_sync_backend(&SyncBackendInput {
                kind: SyncBackendKind::Local,
                name: "t".into(),
                config_json: "{}".into(),
                enabled: Some(true),
                auto_sync: Some(false),
                sync_interval_min: Some(30),
            })
            .unwrap();
        let n = db
            .create_note(&NoteInput {
                title: "复活".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        db.upsert_remote_state(backend_id, n.id, "notes/x.md", "h", "2026-01-01", false)
            .unwrap();

        // 软删到 60 天前 → 再 restore
        let old_ts = (chrono::Local::now() - chrono::Duration::days(60))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
                params![old_ts, n.id],
            )
            .unwrap();
        }
        db.restore_note(n.id).unwrap();

        let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let removed = db.gc_sync_remote_state(&cutoff).unwrap();
        assert_eq!(removed, 0, "已 restore 的笔记重回 manifest 范围 → 不删 state");
        assert!(db.list_remote_state(backend_id).unwrap().contains_key(&n.id));
    }
}
