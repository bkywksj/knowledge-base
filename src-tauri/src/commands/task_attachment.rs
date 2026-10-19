//! 任务附件 Command（薄包装 → TaskAttachmentService）
//!
//! 返回的 `TaskAttachment.rel_path` 是相对 data_dir 的 POSIX 路径，
//! 前端拼 `kb-asset://<rel_path>` 走 `resolveAssetSrc` 显示；用系统程序打开时调
//! `resolve_asset_absolute_path` 还原绝对路径。

use tauri::State;

use crate::models::{PasteImage, TaskAttachment};
use crate::services::image_download;
use crate::services::task_attachment::{self, TaskAttachmentService};
use crate::state::AppState;

#[tauri::command(async)]
pub fn list_task_attachments(
    state: State<'_, AppState>,
    task_id: i64,
) -> Result<Vec<TaskAttachment>, String> {
    TaskAttachmentService::list(&state.db, task_id).map_err(|e| e.to_string())
}

/// 保存 base64 数据为任务附件（粘贴截图 / 前端拿到的 File）
#[tauri::command(async)]
pub fn add_task_attachment(
    state: State<'_, AppState>,
    task_id: i64,
    file_name: String,
    base64_data: String,
) -> Result<TaskAttachment, String> {
    TaskAttachmentService::add_from_base64(
        &state.db,
        &state.data_dir,
        task_id,
        &file_name,
        &base64_data,
    )
    .map_err(|e| e.to_string())
}

/// 从本地路径复制为任务附件（文件选择框 / OS 拖放）
#[tauri::command(async)]
pub fn add_task_attachment_from_path(
    state: State<'_, AppState>,
    task_id: i64,
    source_path: String,
) -> Result<TaskAttachment, String> {
    TaskAttachmentService::add_from_path(&state.db, &state.data_dir, task_id, &source_path)
        .map_err(|e| e.to_string())
}

/// 下载外链图片为任务附件（从网页复制图文时，HTML 里的 `<img src="https://...">`）。
///
/// 走 Rust 侧下载而不是前端 fetch：WebView 受 CORS / 防盗链限制，
/// `fetch_image_bytes` 会按 host 注入 Referer（与笔记粘贴外链图片同一套逻辑）。
#[tauri::command]
pub async fn add_task_attachment_from_url(
    state: State<'_, AppState>,
    task_id: i64,
    url: String,
    referer: Option<String>,
) -> Result<TaskAttachment, String> {
    let (bytes, ext) = image_download::fetch_image_bytes(&url, referer.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file_name = format!("pasted-{}.{}", ts, ext);
    TaskAttachmentService::add_from_bytes(&state.db, &state.data_dir, task_id, &file_name, &bytes)
        .map_err(|e| e.to_string())
}

/// 把粘贴 HTML 里的图片（`file:///` 本地路径或 http(s) 外链）读成字节交给前端。
///
/// 新建任务还没有 id、附件无处落盘时用：前端拿到字节转成内存 File，立刻能显示缩略图 /
/// 点开预览，保存任务时再按普通 base64 附件上传。WebView 自己读不到这些图
/// （CSP 只放行 asset / data / blob，外链还有防盗链）。
#[tauri::command]
pub async fn load_paste_image(source: String) -> Result<PasteImage, String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let (bytes, ext) = image_download::fetch_image_bytes(&source, None)
            .await
            .map_err(|e| e.to_string())?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        return Ok(task_attachment::paste_image_from_bytes(
            format!("pasted-{}.{}", ts, ext),
            &ext,
            &bytes,
        ));
    }
    // 本地读盘是同步 IO，丢到阻塞线程池，别卡住 IPC
    tauri::async_runtime::spawn_blocking(move || task_attachment::load_local_paste_image(&source))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_task_attachment(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    TaskAttachmentService::delete(&state.db, &state.data_dir, id).map_err(|e| e.to_string())
}

/// 按 ids 顺序重排某任务的附件
#[tauri::command(async)]
pub fn reorder_task_attachments(
    state: State<'_, AppState>,
    task_id: i64,
    ids: Vec<i64>,
) -> Result<(), String> {
    TaskAttachmentService::reorder(&state.db, task_id, &ids).map_err(|e| e.to_string())
}
