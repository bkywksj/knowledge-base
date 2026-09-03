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

/// 把前端传来的图片路径解析成绝对路径，并校验它确实落在 images 目录下。
///
/// 兼容传入绝对路径的旧调用：先尝试按相对路径解析，失败则当作绝对路径继续走同样的校验。
/// 校验用字符串前缀比较（统一分隔符为 `/`），能挡住 `..` 逃逸出 images 根的情况。
fn resolve_image_path(state: &AppState, path: &str) -> Result<std::path::PathBuf, String> {
    let abs = match asset_path::rel_to_abs(path, &state.data_dir) {
        Ok(p) => p,
        Err(_) => std::path::PathBuf::from(path),
    };
    let images_root = ImageService::images_dir(&state.data_dir);
    let images_root_str = images_root.to_string_lossy().to_string().replace('\\', "/");
    let abs_str = abs.to_string_lossy().to_string().replace('\\', "/");
    if !abs_str.starts_with(&images_root_str) {
        return Err(format!("非法路径（不在 images 目录下）: {}", path));
    }
    Ok(abs)
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
///
/// **返回 `tauri::ipc::Response`（二进制 IPC）而非 `Vec<u8>`**：`Vec<u8>` 会被 serde 序列化成
/// JSON 数字数组 —— 一张 300KB 的图 = 30 万个元素的 JSON 文本，光序列化 + 前端 JSON.parse
/// 就要几百毫秒到数秒。`Response` 走 raw body，前端直接拿到 `ArrayBuffer`，零编解码。
/// 这条路径慢会连带拖垮调用方：例如"复制图片"在 await 它之后再写剪贴板，
/// 用户手势（transient user activation）早已过期 → `navigator.clipboard.write()` 报 NotAllowedError。
#[tauri::command]
pub async fn get_image_blob(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let abs = resolve_image_path(&state, &path)?;
        ImageService::read_for_render(&state.vault, &abs.to_string_lossy())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("读取图片任务异常终止: {}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 把笔记里的图片直接写进系统剪贴板（接收**相对路径**，加密图自动解密）。
///
/// 为什么要有这个 Command，而不是前端 `navigator.clipboard.write()` 了事：
/// WebView 的 Async Clipboard API 要求调用时**用户手势仍在有效期内**（Chromium 约 5 秒）。
/// 前端那条路要先 IPC 取字节 → `createImageBitmap` 解码 → `canvas.toBlob` 编 PNG，
/// 大图走完手势早过期，权限检查退回 permission 询问，而 WebView2 里没人应答 → 直接
/// `NotAllowedError: The request is not allowed by the user agent...`（用户看到的是"没权限"，
/// 但跟 Capabilities 无关）。走 Rust 侧则完全不受手势/时限约束。
///
/// **实际只在桌面生效**：clipboard-manager 插件的 `write_image` 在移动端直接返回
/// Unsupported，且解码用的 image crate 也只在桌面 target 声明。Command 本身仍跨端注册
/// （`generate_handler!` 列表里放 `#[cfg]` 项不可靠），移动端调用会拿到明确的错误，
/// 前端据此回退到 Web Clipboard。
///
/// **必须 `spawn_blocking`**：插件文档明确警告 `write_image` 不可在主线程调用，
/// 否则 Linux 上底层库可能死锁、冻住整个应用。
#[tauri::command]
pub async fn copy_image_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, path);
        Err("当前平台不支持把图片写入系统剪贴板".to_string())
    }
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager;
            use tauri_plugin_clipboard_manager::ClipboardExt;

            let state = app.state::<AppState>();
            let abs = resolve_image_path(&state, &path)?;
            let bytes = ImageService::read_for_render(&state.vault, &abs.to_string_lossy())
                .map_err(|e| e.to_string())?;
            // 系统剪贴板要的是 RGBA 位图，PNG/JPEG 原字节喂进去没有平台认，必须先解码。
            // 用 image crate 直解而不是 `tauri::image::Image::from_bytes`：后者受 tauri 的
            // image-png feature 限制、只认 png/ico，而本项目允许 png/jpg/jpeg/webp/gif/bmp
            // （见 commands::system 的扩展名白名单）。
            let decoded = image::load_from_memory(&bytes)
                .map_err(|e| format!("图片解码失败（格式不支持？）: {}", e))?;
            let rgba = decoded.to_rgba8();
            let (width, height) = (rgba.width(), rgba.height());
            let image = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
            app.clipboard()
                .write_image(&image)
                .map_err(|e| format!("写入剪贴板失败: {}", e))
        })
        .await
        .map_err(|e| format!("复制图片任务异常终止: {}", e))?
    }
}
