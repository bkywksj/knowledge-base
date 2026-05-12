//! T-024 同步 V1 — Tauri Commands
//!
//! 暴露给前端的接口：
//! - sync_v1_list_backends / get_backend / create / update / delete
//! - sync_v1_test_connection
//! - sync_v1_push / pull
//!
//! 注意：所有 Command 都需要在 lib.rs 的 generate_handler! 注册。

use tauri::{Manager, State, Window};

use crate::error::AppError;
use crate::models::{
    SyncBackend, SyncBackendInput, SyncManifestV1, SyncPullResult, SyncPushResult,
};
use crate::services::sync_v1::backend;
use crate::state::AppState;

#[tauri::command]
pub fn sync_v1_list_backends(state: State<'_, AppState>) -> Result<Vec<SyncBackend>, String> {
    state.db.list_sync_backends().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_get_backend(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<SyncBackend>, String> {
    state.db.get_sync_backend(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_create_backend(
    state: State<'_, AppState>,
    input: SyncBackendInput,
) -> Result<i64, String> {
    state
        .db
        .create_sync_backend(&input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_update_backend(
    state: State<'_, AppState>,
    id: i64,
    input: SyncBackendInput,
) -> Result<(), String> {
    state
        .db
        .update_sync_backend(id, &input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_delete_backend(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    state.db.delete_sync_backend(id).map_err(|e| e.to_string())
}

/// 测试连接
#[tauri::command]
pub fn sync_v1_test_connection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;
    backend_impl.test_connection().map_err(|e| e.to_string())
}

/// 读远端 manifest（前端调试用）
#[tauri::command]
pub fn sync_v1_read_remote_manifest(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<SyncManifestV1>, String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;
    backend_impl.read_manifest().map_err(|e| e.to_string())
}

/// 推送
#[tauri::command]
pub fn sync_v1_push(
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
    id: i64,
) -> Result<SyncPushResult, String> {
    // 同步互斥：同一 backend 同时只跑一个 pull/push，防并发互踩（见 services::sync_v1::lock）
    let _sync_guard = state
        .sync_v1_gate
        .try_acquire(id)
        .ok_or_else(|| "该同步源正在同步中，请等当前同步结束再试".to_string())?;

    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();

    crate::services::sync_v1::push::push(
        &state.db,
        id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        &state.data_dir,
        &window,
    )
    .map_err(|e| e.to_string())
}

/// 拉取
#[tauri::command]
pub fn sync_v1_pull(
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
    id: i64,
) -> Result<SyncPullResult, String> {
    // 同步互斥：同一 backend 同时只跑一个 pull/push，防并发互踩（见 services::sync_v1::lock）
    let _sync_guard = state
        .sync_v1_gate
        .try_acquire(id)
        .ok_or_else(|| "该同步源正在同步中，请等当前同步结束再试".to_string())?;

    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();

    let conflicts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sync_conflicts")
        .join(format!("backend_{}", id));

    crate::services::sync_v1::pull::pull(
        &state.db,
        id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        &conflicts_dir,
        &state.data_dir,
        &window,
    )
    .map_err(|e| e.to_string())
}

/// 后台同步：立即返回，同步（先拉后推）在后台 tokio task 里跑，完成/失败通过 `sync_v1:auto-triggered` 事件回报。
#[tauri::command]
pub fn sync_v1_trigger_background_sync(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    // 先校验 backend 存在，免得在后台静默 noop
    state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    // 已经在同步中 → 当作"已经在跑了"，不再 spawn 重复 task（用户连点按钮 / 调度器撞上来时）
    if state.sync_v1_gate.is_busy(id) {
        log::info!("[sync_v1] backend #{} 已在同步中，忽略本次后台同步触发", id);
        return Ok(());
    }
    crate::services::sync_v1_scheduler::trigger_background_sync(&app, id);
    Ok(())
}

/// 拿当前本地 manifest（调试 / UI 状态展示用）
#[tauri::command]
pub fn sync_v1_get_local_manifest(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SyncManifestV1, String> {
    let app_version = app.package_info().version.to_string();
    let device = hostname_short();
    crate::services::sync_v1::compute_local_manifest(&state.db, &app_version, &device)
        .map_err(|e: AppError| e.to_string())
}

/// T-S024: 重建附件索引
///
/// 扫描所有活跃笔记的 content，提取 markdown 图片/链接/wiki 嵌入中的本地资产引用，
/// 计算 sha256 并 upsert 到 `note_attachments` 表。
///
/// 触发场景：
/// - 用户在设置页点"重建附件索引"按钮（首次启用 V1 同步时建议跑一次）
/// - 笔记大批量导入后（外部工具导入的笔记 content 已经写好但索引表是空的）
///
/// 性能：O(笔记数 × 资产读取 IO)。1 万条笔记约几秒（取决于附件数和磁盘速度）。
#[tauri::command]
pub fn sync_v1_rebuild_attachment_index(state: State<'_, AppState>) -> Result<usize, String> {
    crate::services::sync_v1::attachment_scan::scan_all_active_notes(&state.db, &state.data_dir)
        .map_err(|e: AppError| e.to_string())
}

/// T-S025: 清理远端孤儿附件
///
/// 列出指定 backend 的远端 `attachments/` 下所有附件，与远端 manifest 引用的 hash 算差集，
/// 孤儿走"7 天宽限期标记 → 超期才删"流程。
///
/// 返回 GcResult（删除数 / 新标记数 / 移除标记数 / 远端附件总数 / 错误清单）。
///
/// 注意：
/// - Local / S3 / WebDAV 均支持（个别禁用 PROPFIND infinity 的 WebDAV 服务器会自动跳过）
/// - 远端无 manifest 时为安全起见不删任何东西
#[tauri::command]
pub fn sync_v1_gc_attachments(
    state: State<'_, AppState>,
    id: i64,
) -> Result<crate::services::sync_v1::attachment_gc::GcResult, String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;
    crate::services::sync_v1::attachment_gc::gc_attachments(&state.db, backend_impl.as_ref())
        .map_err(|e: AppError| e.to_string())
}

// ─── T-S051: 同步冲突解决 ──────────────────────────────────

/// 列出所有同步源待解决的冲突（给设置页"冲突待处理"用）
#[tauri::command]
pub fn sync_v1_list_conflicts(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::services::sync_v1::conflicts::ConflictItem>, String> {
    // 冲突文件由 sync_v1_pull 写在 `app.path().app_data_dir()/sync_conflicts/` 下，
    // 这里必须用同一个基准目录（注意：这是 framework 默认 app_data_dir，dev 模式下与 -dev 隔离目录不同；
    // 若以后改了 sync_v1_pull 的 conflicts_dir 基准，本处需同步改）。
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::services::sync_v1::conflicts::list_conflicts(&state.db, &base)
        .map_err(|e: AppError| e.to_string())
}

/// 解决一条冲突：`keep_local`（保留本地）/ `use_remote`（采用远端）/ `merged`（采用手动合并结果）
#[tauri::command]
pub fn sync_v1_resolve_conflict(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    conflict_file_path: String,
    resolution: crate::services::sync_v1::conflicts::ConflictResolution,
    merged_content: Option<String>,
) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::services::sync_v1::conflicts::resolve_conflict(
        &state.db,
        &base,
        &conflict_file_path,
        resolution,
        merged_content.as_deref(),
    )
    .map_err(|e: AppError| e.to_string())
}

/// 取本机 hostname（短名）；失败返回 "unknown-host"
fn hostname_short() -> String {
    // hostname crate 已是项目依赖（services/sync.rs 用了 hostname::get）
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}
