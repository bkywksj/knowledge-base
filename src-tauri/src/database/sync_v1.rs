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

// ─── config_json 敏感字段加密（v68 起）─────────────────────────────────────────
//
// 为什么在 DAO 边界做：加密只关心"落盘时不是明文"。写入（create/update）时封存、读出（list/get）
// 时解开，DAO 以上的 parse_auth / 前端表单 / 配置分享拿到的仍是明文，无需改动。
// 此前密码以明文存在 sync_backends.config_json（2026-10 诊断报告指出），而代码注释与
// models::SyncBackend 的文档都写着"已加密" —— 实际从未实现。
//
// 算法 / 密钥复用 crate::crypto 的 `enc:v1:` 字段加密（与 AI Key、V0 WebDAV 密码同一套）：
// 密钥由本机 hostname 派生，防的是"app.db 被拷走后密码明文泄漏"。代价：换机器 / 改主机名后
// 解不开，需重填一次密码 —— 解不开时打 `_secretUnreadable` 标记，parse_auth 据此给出明确提示，
// 而不是拿密文当密码去请求、最后报一个让人摸不着头脑的 401。

/// 该 kind 的 config_json 里哪些字段是凭据（字段名与 services::sync_v1::backend::parse_auth 一致）
fn secret_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "webdav" => &["password"],
        "s3" => &["secretKey"],
        _ => &[],
    }
}

/// 解密失败时写进 config_json 的标记字段，见 [`open_config_json`]
pub const SECRET_UNREADABLE_KEY: &str = "_secretUnreadable";

/// 把 config_json 里的凭据字段加密后返回（幂等：已是密文的不再套一层）。
///
/// - 解析不了的 JSON 原样返回：这里不负责校验，坏配置会在 parse_auth 处报错
/// - 会顺手去掉 `_secretUnreadable` 标记（用户已经重新保存过了）
pub(crate) fn seal_config_json(kind: &str, json: &str) -> Result<String, AppError> {
    let fields = secret_fields(kind);
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return Ok(json.to_string());
    };
    map.remove(SECRET_UNREADABLE_KEY);
    for f in fields {
        if let Some(serde_json::Value::String(v)) = map.get(*f) {
            let sealed = crate::crypto::encrypt_field(v)?;
            map.insert((*f).to_string(), serde_json::Value::String(sealed));
        }
    }
    serde_json::to_string(&serde_json::Value::Object(map))
        .map_err(|e| AppError::Custom(format!("config_json 序列化失败: {}", e)))
}

/// 把 config_json 里的凭据字段解密后返回。
///
/// - 历史明文（无 `enc:v1:` 前缀）原样返回，兼容 v68 迁移前 / 迁移失败的行
/// - 解不开（换机器 / 改主机名）：字段置空 + 打 `_secretUnreadable: true` 标记，不让整个列表失败
///   （否则设置页打空，用户连重填的入口都找不到）
pub(crate) fn open_config_json(kind: &str, json: &str, backend_id: i64) -> String {
    let fields = secret_fields(kind);
    if fields.is_empty() {
        return json.to_string();
    }
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return json.to_string();
    };
    let mut unreadable = false;
    for f in fields {
        let Some(serde_json::Value::String(stored)) = map.get(*f) else {
            continue;
        };
        let plain = match crate::crypto::decrypt_field(stored) {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "[sync-v1] backend #{} 的 {} 解密失败（通常是换了机器 / 改了主机名），\
                     需在同步设置里重新填写: {}",
                    backend_id,
                    f,
                    e
                );
                unreadable = true;
                String::new()
            }
        };
        map.insert((*f).to_string(), serde_json::Value::String(plain));
    }
    if unreadable {
        map.insert(SECRET_UNREADABLE_KEY.into(), serde_json::Value::Bool(true));
    }
    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| json.to_string())
}

/// 行映射（list / get 共用）。列顺序须与 [`BACKEND_COLUMNS`] 一致。
fn row_to_backend(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncBackend> {
    let kind_str: String = row.get(1)?;
    let id: i64 = row.get(0)?;
    let raw_config: String = row.get(3)?;
    Ok(SyncBackend {
        id,
        kind: parse_kind(&kind_str),
        name: row.get(2)?,
        config_json: open_config_json(&kind_str, &raw_config, id),
        enabled: row.get::<_, i32>(4)? != 0,
        auto_sync: row.get::<_, i32>(5)? != 0,
        sync_interval_min: row.get(6)?,
        last_push_ts: row.get(7)?,
        last_pull_ts: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_error: row.get(11)?,
        last_error_at: row.get(12)?,
    })
}

const BACKEND_COLUMNS: &str = "id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
     last_push_ts, last_pull_ts, created_at, updated_at, last_error, last_error_at";

impl Database {
    // ─── sync_backends ─────────────────────────

    pub fn list_sync_backends(&self) -> Result<Vec<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM sync_backends ORDER BY id ASC",
            BACKEND_COLUMNS
        ))?;
        let rows = stmt
            .query_map([], row_to_backend)?
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
                &format!("SELECT {} FROM sync_backends WHERE id = ?1", BACKEND_COLUMNS),
                [id],
                row_to_backend,
            )
            .ok();
        Ok(row)
    }

    pub fn create_sync_backend(&self, input: &SyncBackendInput) -> Result<i64, AppError> {
        // 加密放在拿锁之前：纯 CPU 计算，没必要占着主连接
        let sealed = seal_config_json(kind_to_str(input.kind), &input.config_json)?;
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
                sealed,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_sync_backend(&self, id: i64, input: &SyncBackendInput) -> Result<(), AppError> {
        let sealed = seal_config_json(kind_to_str(input.kind), &input.config_json)?;
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
                sealed,
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

    /// 记录 / 清除 backend 最近一次同步错误（v68）。`Some` 写入并打时间戳，`None` 清空。
    ///
    /// 为什么需要：V1 同步失败此前只弹一个 toast、写一行日志，不落任何持久化状态
    /// （`sync_history` 是 V0 ZIP 快照的表，V1 从未写入）—— toast 一消失，用户在设置页就看不到
    /// 任何失败痕迹（2026-10 诊断报告：25 次连续失败全无记录）。只记"最近一次"而非流水：
    /// 自动同步频率高，流水会把历史表刷爆，而用户真正要的是"现在好没好、为什么不好"。
    ///
    /// 不碰 `updated_at`：那是配置的修改时间，同步结果不算改配置。
    pub fn set_sync_backend_error(&self, id: i64, error: Option<&str>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        match error {
            Some(msg) => conn.execute(
                "UPDATE sync_backends
                 SET last_error = ?2, last_error_at = datetime('now', 'localtime')
                 WHERE id = ?1",
                params![id, msg],
            )?,
            None => conn.execute(
                "UPDATE sync_backends SET last_error = NULL, last_error_at = NULL
                 WHERE id = ?1 AND last_error IS NOT NULL",
                [id],
            )?,
        };
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

    fn webdav_input(password: &str) -> SyncBackendInput {
        SyncBackendInput {
            kind: SyncBackendKind::Webdav,
            name: "nas".into(),
            config_json: serde_json::json!({
                "url": "http://192.168.1.2:5005/dav",
                "username": "u",
                "password": password,
            })
            .to_string(),
            enabled: Some(true),
            auto_sync: Some(true),
            sync_interval_min: Some(30),
        }
    }

    fn raw_config(db: &Database, id: i64) -> String {
        db.conn_lock()
            .unwrap()
            .query_row("SELECT config_json FROM sync_backends WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
    }

    fn config_field(json: &str, key: &str) -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(json).unwrap()[key].clone()
    }

    /// v68：落盘是密文，读出是明文；update 后仍是密文且不会套两层
    #[test]
    fn webdav_password_encrypted_at_rest() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input("s3cret-pw")).unwrap();

        let raw = raw_config(&db, id);
        assert!(!raw.contains("s3cret-pw"), "落盘不应含明文密码: {}", raw);
        assert!(crate::crypto::is_encrypted_field(
            config_field(&raw, "password").as_str().unwrap()
        ));

        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert_eq!(config_field(&b.config_json, "password"), "s3cret-pw");
        assert_eq!(config_field(&b.config_json, "url"), "http://192.168.1.2:5005/dav");

        // 前端把读出的（明文）配置原样保存回来 → 仍是单层密文、能解回原值
        db.update_sync_backend(id, &webdav_input("s3cret-pw")).unwrap();
        let listed = db.list_sync_backends().unwrap();
        assert_eq!(config_field(&listed[0].config_json, "password"), "s3cret-pw");
    }

    /// 历史明文（v68 前写入、迁移失败的行）读取时原样兼容
    #[test]
    fn legacy_plaintext_still_readable() {
        let opened = open_config_json("webdav", r#"{"url":"x","username":"u","password":"plain"}"#, 1);
        assert_eq!(config_field(&opened, "password"), "plain");
        assert!(config_field(&opened, SECRET_UNREADABLE_KEY).is_null());
    }

    /// 解不开（换机器 / 改主机名）→ 凭据置空 + 标记，parse_auth 给出明确提示而非 401
    #[test]
    fn undecryptable_secret_is_flagged() {
        let opened = open_config_json(
            "webdav",
            r#"{"url":"x","username":"u","password":"enc:v1:bm90LXJlYWwtY2lwaGVydGV4dA=="}"#,
            1,
        );
        assert_eq!(config_field(&opened, "password"), "");
        assert_eq!(config_field(&opened, SECRET_UNREADABLE_KEY), true);

        let err = crate::services::sync_v1::backend::parse_auth(SyncBackendKind::Webdav, &opened)
            .err()
            .expect("应拒绝解不开的凭据");
        assert!(err.to_string().contains("重新填写密码"), "{}", err);

        // 用户重新保存后标记被去掉
        let resealed = seal_config_json("webdav", &opened).unwrap();
        assert!(config_field(&resealed, SECRET_UNREADABLE_KEY).is_null());
    }

    #[test]
    fn s3_secret_key_encrypted_local_untouched() {
        let s3 = seal_config_json("s3", r#"{"endpoint":"e","bucket":"b","accessKey":"AK","secretKey":"SK"}"#).unwrap();
        assert!(crate::crypto::is_encrypted_field(config_field(&s3, "secretKey").as_str().unwrap()));
        assert_eq!(config_field(&s3, "accessKey"), "AK", "accessKey 不是机密，不加密");

        let local = r#"{"path":"/data/kb"}"#;
        assert_eq!(seal_config_json("local", local).unwrap(), local);
    }

    /// last_error：失败写入带时间，成功清空
    #[test]
    fn last_error_set_and_cleared() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input("pw")).unwrap();
        assert!(db.get_sync_backend(id).unwrap().unwrap().last_error.is_none());

        db.set_sync_backend_error(id, Some("pull 失败: boom")).unwrap();
        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert_eq!(b.last_error.as_deref(), Some("pull 失败: boom"));
        assert!(b.last_error_at.is_some());

        db.set_sync_backend_error(id, None).unwrap();
        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert!(b.last_error.is_none() && b.last_error_at.is_none());
    }

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
