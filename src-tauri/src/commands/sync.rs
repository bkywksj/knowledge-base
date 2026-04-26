//! 同步 Command：ZIP 导出/导入 + WebDAV 推送/拉取

use std::path::PathBuf;

use tauri::State;

use crate::models::{
    SyncHistoryItem, SyncImportMode, SyncManifest, SyncResult, SyncScope, WebDavConfig,
};
use crate::services::sync::SyncService;
use crate::state::AppState;

// ─── 本地 ZIP 导出/导入 ──────────────────────

#[tauri::command]
pub fn sync_export_to_file(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    scope: SyncScope,
    target_path: String,
) -> Result<SyncResult, String> {
    let version = app.package_info().version.to_string();
    let history_id = state
        .db
        .sync_history_begin("export")
        .map_err(|e| e.to_string())?;

    let result = SyncService::export_to_file(
        &state.data_dir,
        &state.db,
        &scope,
        &version,
        &PathBuf::from(&target_path),
    );

    record_history(&state, history_id, &result);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_import_from_file(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    source_path: String,
    mode: SyncImportMode,
) -> Result<SyncManifest, String> {
    let db_path = resolve_db_path(&state.data_dir);
    let db_path_str = db_path.to_string_lossy().into_owned();
    let history_id = state
        .db
        .sync_history_begin("import")
        .map_err(|e| e.to_string())?;

    // 必须先释放 db 文件占用，否则 Windows 上 SQLite 的 mmap 会让
    // apply 阶段 fs::File::create(app.db) 报 ERROR_USER_MAPPED_FILE (1224)
    let _ = state.db.release();

    let result = SyncService::import_from_file(
        &state.data_dir,
        &db_path,
        &PathBuf::from(&source_path),
        mode,
    );

    // 无论 apply 成败，都必须 reopen 回真实 db；否则连接会停在 :memory: 空库，
    // 后续所有查询都打不到用户数据
    match state.db.reopen(&db_path_str) {
        Ok(_) => {
            if result.is_ok() {
                use tauri::Emitter;
                let _ = app.emit("db:reloaded", ());
            }
        }
        Err(e) => {
            log::error!(
                "[sync] reopen db 失败：{}（连接已停在 :memory:，建议立即重启应用）",
                e
            );
        }
    }

    record_manifest_history(&state, history_id, &result);
    result.map_err(|e| e.to_string())
}

// ─── WebDAV 云同步 ───────────────────────────

#[tauri::command]
pub async fn sync_webdav_test(
    url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let client = crate::services::webdav::WebDavClient::new(&url, &username, &password);
    client.test_connection().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_webdav_push(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    scope: SyncScope,
    config: WebDavConfig,
) -> Result<SyncResult, String> {
    let version = app.package_info().version.to_string();
    let password = resolve_password(&state.db, &config)?;

    let history_id = state
        .db
        .sync_history_begin("push")
        .map_err(|e| e.to_string())?;

    let result = SyncService::webdav_push(
        &state.data_dir,
        &state.db,
        &scope,
        &version,
        &config.url,
        &config.username,
        &password,
    )
    .await;

    record_history(&state, history_id, &result);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_webdav_pull(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    mode: SyncImportMode,
    config: WebDavConfig,
    filename: Option<String>,
) -> Result<SyncManifest, String> {
    let password = resolve_password(&state.db, &config)?;
    let db_path = resolve_db_path(&state.data_dir);
    let db_path_str = db_path.to_string_lossy().into_owned();

    let history_id = state
        .db
        .sync_history_begin("pull")
        .map_err(|e| e.to_string())?;

    // 同 sync_import_from_file：必须先释放 db 文件占用，否则 Windows mmap 会让
    // apply 阶段 fs::File::create(app.db) 报 ERROR_USER_MAPPED_FILE (1224)
    let _ = state.db.release();

    let result = SyncService::webdav_pull(
        &state.data_dir,
        &db_path,
        mode,
        &config.url,
        &config.username,
        &password,
        filename.as_deref(),
    )
    .await;

    // 不论成败都必须 reopen 回真实 db
    match state.db.reopen(&db_path_str) {
        Ok(_) => {
            if result.is_ok() {
                use tauri::Emitter;
                let _ = app.emit("db:reloaded", ());
            }
        }
        Err(e) => {
            log::error!(
                "[sync] reopen db 失败：{}（连接已停在 :memory:，建议立即重启应用）",
                e
            );
        }
    }

    record_manifest_history(&state, history_id, &result);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_webdav_preview(
    state: State<'_, AppState>,
    config: WebDavConfig,
    filename: Option<String>,
) -> Result<SyncManifest, String> {
    let password = resolve_password(&state.db, &config)?;
    SyncService::webdav_preview(&config.url, &config.username, &password, filename.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// 列出云端所有 `kb-sync-*.zip` 快照（多设备场景）
/// 返回 [{filename, device}, ...]
#[tauri::command]
pub async fn sync_webdav_list_snapshots(
    state: State<'_, AppState>,
    config: WebDavConfig,
) -> Result<Vec<RemoteSnapshot>, String> {
    let password = resolve_password(&state.db, &config)?;
    let items = SyncService::webdav_list_snapshots(&config.url, &config.username, &password)
        .await
        .map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .map(|(filename, device)| RemoteSnapshot { filename, device })
        .collect())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    pub filename: String,
    pub device: String,
}

// ─── 密码加密存取（AES-GCM + SQLite） ─────────────────────────────

#[tauri::command]
pub fn sync_save_webdav_password(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<(), String> {
    SyncService::save_webdav_password(&state.db, &username, &password)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_has_webdav_password(
    state: State<'_, AppState>,
    username: String,
) -> Result<bool, String> {
    SyncService::get_webdav_password(&state.db, &username)
        .map(|p| p.is_some())
        .map_err(|e| e.to_string())
}

/// 取出已加密存储的 WebDAV 密码明文。
/// 仅供"新增/编辑同步源 → 一键复用备份与恢复配置"流程使用：
/// V1 backend 把密码塞在 backend.config_json 里，需要明文以构造 JSON。
#[tauri::command]
pub fn sync_get_webdav_password(
    state: State<'_, AppState>,
    username: String,
) -> Result<Option<String>, String> {
    SyncService::get_webdav_password(&state.db, &username).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_delete_webdav_password(
    state: State<'_, AppState>,
    username: String,
) -> Result<(), String> {
    SyncService::delete_webdav_password(&state.db, &username).map_err(|e| e.to_string())
}

// ─── 同步历史 ─────────────────────────────────

#[tauri::command]
pub fn sync_list_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<SyncHistoryItem>, String> {
    state
        .db
        .list_sync_history(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

/// 唤醒自动同步调度器：配置变更后由前端调用
#[tauri::command]
pub fn sync_scheduler_reload(state: State<'_, AppState>) -> Result<(), String> {
    state.sync_scheduler_notify.notify_one();
    Ok(())
}

// ─── 辅助 ────────────────────────────────────

/// 从 WebDavConfig 读 password：优先用前端传入的，否则读 SQLite 里的加密密文
fn resolve_password(db: &crate::database::Database, config: &WebDavConfig) -> Result<String, String> {
    if let Some(p) = &config.password {
        if !p.is_empty() {
            return Ok(p.clone());
        }
    }
    match SyncService::get_webdav_password(db, &config.username).map_err(|e| e.to_string())? {
        Some(p) => Ok(p),
        None => Err("未配置密码，请先在设置中保存 WebDAV 密码".into()),
    }
}

/// 返回当前 DB 文件的实际路径（dev 模式带 dev- 前缀）
fn resolve_db_path(data_dir: &std::path::Path) -> PathBuf {
    let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
    data_dir.join(format!("{}app.db", prefix))
}

fn record_history(state: &AppState, history_id: i64, result: &Result<SyncResult, crate::error::AppError>) {
    match result {
        Ok(r) => {
            let stats_json = serde_json::to_string(&r.stats).unwrap_or_else(|_| "{}".into());
            let _ = state.db.sync_history_finish(history_id, true, None, &stats_json);
        }
        Err(e) => {
            let _ = state
                .db
                .sync_history_finish(history_id, false, Some(&e.to_string()), "{}");
        }
    }
}

fn record_manifest_history(
    state: &AppState,
    history_id: i64,
    result: &Result<SyncManifest, crate::error::AppError>,
) {
    match result {
        Ok(m) => {
            let stats_json = serde_json::to_string(&m.stats).unwrap_or_else(|_| "{}".into());
            let _ = state.db.sync_history_finish(history_id, true, None, &stats_json);
        }
        Err(e) => {
            let _ = state
                .db
                .sync_history_finish(history_id, false, Some(&e.to_string()), "{}");
        }
    }
}
