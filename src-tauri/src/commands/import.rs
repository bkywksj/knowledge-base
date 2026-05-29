use tauri::AppHandle;

use crate::models::{ImportConflictPolicy, ImportResult, OpenMarkdownResult, ScannedFile};
use crate::services;
use crate::state::AppState;

/// 扫描文件夹中的 Markdown 文件（不导入，返回分桶后的文件列表）
///
/// 每条带 match_kind + existing_note_id，便于前端预览弹窗展示
/// "全新 / 已导入过 / 可能重复" 三桶统计。
#[tauri::command]
pub fn scan_markdown_folder(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Vec<ScannedFile>, String> {
    services::import::ImportService::scan_markdown_folder(&state.db, &path)
        .map_err(|e| e.to_string())
}

/// 按选定的文件路径列表导入 Markdown 文件
///
/// - `folder_id`: 导入到哪个文件夹下（None = 根）
/// - `root_path`: 扫描根路径；传了才能按相对目录重建文件夹树
/// - `preserve_root`: 是否在目标下多套一层"源根目录名"
/// - `policy`: 遇到已存在文件的处理策略（Skip / Duplicate），省略按 Skip
#[tauri::command]
pub async fn import_selected_files(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    file_paths: Vec<String>,
    folder_id: Option<i64>,
    root_path: Option<String>,
    preserve_root: Option<bool>,
    policy: Option<ImportConflictPolicy>,
) -> Result<ImportResult, String> {
    // ⚠️ 必须用 state.data_dir（已经过 DataDirResolver 解析），
    // 不能用 app.path().app_data_dir()（那是 OS 默认 framework 目录，不跟随用户改的数据目录）
    let app_data_dir = state.data_dir.clone();
    services::import::ImportService::import_selected_files(
        &state.db,
        &file_paths,
        folder_id,
        root_path.as_deref(),
        preserve_root.unwrap_or(false),
        policy.unwrap_or_default(),
        &app_data_dir,
        &app,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 打开单个 Markdown 文件：读取 → 创建新笔记 → 返回 note id
///
/// 用于"打开 md 文件"按钮和文件关联双击，前端拿到 id 后跳转到 /notes/:id
#[tauri::command]
pub async fn open_markdown_file(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<OpenMarkdownResult, String> {
    // ⚠️ 同 import_selected_files：必须用 state.data_dir
    let app_data_dir = state.data_dir.clone();
    services::import::ImportService::import_single_markdown(&state.db, &file_path, &app_data_dir)
        .await
        .map_err(|e| e.to_string())
}

/// 取出首次启动时由命令行带入的 .md 文件路径（幂等，取一次就清空）
///
/// 前端 App 初始化完成后调用：若返回 Some，则自动打开这个 md 文件。
#[tauri::command]
pub fn take_pending_open_md_path(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let mut guard = state
        .pending_open_md_path
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(guard.take())
}
