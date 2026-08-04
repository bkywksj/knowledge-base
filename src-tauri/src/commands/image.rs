use tauri::State;

use crate::services::asset_path;
use crate::services::image::ImageService;
use crate::services::image_download;
use crate::state::AppState;

/// 把 Service 返回的绝对路径转成相对 `state.data_dir` 的 POSIX 路径。
/// 不能转出来的视为内部 BUG（图片应当永远落在 data_dir 下）。
fn to_relative(state: &AppState, abs: &str) -> Result<String, String> {
    asset_path::abs_to_rel(std::path::Path::new(abs), &state.data_dir).ok_or_else(|| {
        format!(
            "内部错误：保存的图片路径 {} 不在数据目录 {} 下",
            abs,
            state.data_dir.display()
        )
    })
}

/// 保存图片（base64 数据，用于粘贴/拖放）。按笔记 is_encrypted 自动加密。
///
/// 返回**相对 data_dir 的 POSIX 路径**（例如 `kb_assets/images/1/x.png` 或加密版 `*.png.enc`）。
/// 前端拼成 `kb-asset://<rel>` 写入笔记 content；渲染层再解析为可显示 URL。
#[tauri::command]
pub fn save_note_image(
    state: State<'_, AppState>,
    note_id: i64,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    let abs = ImageService::save_from_base64(
        &state.db,
        &state.vault,
        &state.data_dir,
        note_id,
        &file_name,
        &base64_data,
    )
    .map_err(|e| e.to_string())?;
    to_relative(&state, &abs)
}

/// 从本地文件路径保存图片（用于工具栏文件选择）。按笔记 is_encrypted 自动加密。
#[tauri::command]
pub fn save_note_image_from_path(
    state: State<'_, AppState>,
    note_id: i64,
    source_path: String,
) -> Result<String, String> {
    let abs = ImageService::save_from_path(
        &state.db,
        &state.vault,
        &state.data_dir,
        note_id,
        &source_path,
    )
    .map_err(|e| e.to_string())?;
    to_relative(&state, &abs)
}

/// 从远程 URL 下载图片到 kb_assets（粘贴外链图片本地化）。
///
/// Why 不在前端 `fetch`：WebView 受 Origin/Referer/CORS 限制，钉钉/微信图床/知乎/CSDN
/// 等图床防盗链直接 403。Rust 侧 reqwest 不受 WebView 同源策略约束，可按 host 智能注入
/// Referer 绕过常见防盗链。详见 services/image_download.rs。
#[tauri::command]
pub async fn download_image_to_assets(
    state: State<'_, AppState>,
    note_id: i64,
    url: String,
    referer: Option<String>,
) -> Result<String, String> {
    let (bytes, ext) = image_download::fetch_image_bytes(&url, referer.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // 文件名复用现有 `pasted-{ts}.{ext}` 风格；safe_filename 会处理重名（同字节复用 / 加后缀）
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file_name = format!("pasted-{}.{}", ts, ext);

    let abs = ImageService::save_bytes_routed(
        &state.db,
        &state.vault,
        &state.data_dir,
        note_id,
        &file_name,
        &bytes,
    )
    .map_err(|e| e.to_string())?;
    to_relative(&state, &abs)
}

/// 删除笔记的所有图片
#[tauri::command]
pub fn delete_note_images(state: State<'_, AppState>, note_id: i64) -> Result<(), String> {
    ImageService::delete_note_images(&state.data_dir, note_id).map_err(|e| e.to_string())
}

/// 获取图片存储目录路径
#[tauri::command]
pub fn get_images_dir(state: State<'_, AppState>) -> Result<String, String> {
    let images_dir = ImageService::ensure_dir(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(images_dir.to_string_lossy().into_owned())
}

/// 读取图片字节流（接收**相对路径**）。路径以 `.enc` 结尾时用 vault key 解密。
/// 前端用 `new Blob([bytes])` + `URL.createObjectURL` 喂给 `<img>`。
///
/// 安全：rel 必须不含 `..`、不能是绝对路径，且解析后必须落在 images 目录下。
///
/// **必须是 `async` + `spawn_blocking`**：Tauri 把非 async Command 放在**主线程**执行，
/// 而这里要读整个图片文件、加密图还要走一次 AES 解密。一篇笔记里有几十张图时，
/// 这些调用会串行霸占主线程 → 整个窗口冻结、笔记"一直加载中"。
/// 同款教训见 `commands::sync_v1::sync_v1_push` 的注释。
#[tauri::command]
pub async fn get_image_blob(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        // 兼容传入绝对路径的旧调用：尝试转相对，失败则当作绝对路径继续走老校验
        let abs = match asset_path::rel_to_abs(&path, &state.data_dir) {
            Ok(p) => p,
            Err(_) => std::path::PathBuf::from(&path),
        };
        let images_root = ImageService::images_dir(&state.data_dir);
        let images_root_str = images_root.to_string_lossy().to_string().replace('\\', "/");
        let abs_str = abs.to_string_lossy().to_string().replace('\\', "/");
        if !abs_str.starts_with(&images_root_str) {
            return Err(format!("非法路径（不在 images 目录下）: {}", path));
        }
        ImageService::read_for_render(&state.vault, &abs.to_string_lossy())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("读取图片任务异常终止: {}", e))?
}
