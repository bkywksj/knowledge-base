use tauri::State;

use crate::models::{DailyWritingStat, DashboardStats, SystemInfo};
use crate::services::asset_path;
use crate::services::image::ImageService;
use crate::state::AppState;

/// 把笔记里的相对资产路径（kb-asset:// 后那段）还原成绝对路径。
///
/// 用途：附件链接需要走 OS opener 打开（必须传绝对路径）；其它素材渲染走 asset 协议
/// 不需要这个 Command，前端 `convertFileSrc` 自己拼即可。
///
/// 安全：拒绝含 `..` 或绝对前缀的输入，强制限定在 data_dir 之内。
#[tauri::command]
pub fn resolve_asset_absolute_path(
    state: State<'_, AppState>,
    rel: String,
) -> Result<String, String> {
    let abs = asset_path::rel_to_abs(&rel, &state.data_dir)?;
    Ok(abs.to_string_lossy().into_owned())
}

/// 获取系统信息
///
/// data_dir / images_dir 都从 state 取，返回的是当前生效的数据根目录
/// （用户改自定义目录 / KB_DATA_DIR / 便携模式后即对应路径）。
#[tauri::command]
pub fn get_system_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SystemInfo, String> {
    let data_dir = state.data_dir.to_string_lossy().into_owned();
    let images_dir = ImageService::images_dir(&state.data_dir)
        .to_string_lossy()
        .into_owned();

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        data_dir,
        images_dir,
    })
}

/// 获取首页统计数据
#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    state.db.get_dashboard_stats().map_err(|e| e.to_string())
}

/// 获取写作趋势（最近 N 天）
#[tauri::command]
pub fn get_writing_trend(
    state: State<'_, AppState>,
    days: Option<i32>,
) -> Result<Vec<DailyWritingStat>, String> {
    state
        .db
        .get_writing_trend(days.unwrap_or(30))
        .map_err(|e| e.to_string())
}

/// 简单的 greet 命令（保留为示例）
#[tauri::command]
pub fn greet(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    Ok(format!("Hello, {}! 来自 Rust 的问候!", name))
}

/// 把任意文本写入指定路径（UTF-8）。前端"导出 SVG"等小工具用。
///
/// Tauri 2 的 WebView 默认拦截 `<a download>` 触发的下载，所以只读视图里的
/// "导出"按钮无法走纯前端方案，必须经 Rust 写盘。前端先调 `tauri-plugin-dialog`
/// 的 `save()` 获取目标路径，再把内容传到这里。
///
/// 安全：路径由用户在原生 Save 对话框中选定，不接受相对路径或拼接；调用方传啥写啥。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败 {}: {}", path, e))
}

/// 把 base64 编码的二进制数据写入指定路径。用于导出 PNG / PDF 等需要走原生 Save 对话框
/// 的二进制文件——前端先调 `tauri-plugin-dialog::save()` 拿到目标路径，再把 base64
/// 后的数据传到这里。
///
/// 为什么不直接收 `Vec<u8>`：Tauri IPC 默认 JSON 编码会把字节数组序列化成 number 数组，
/// 体积膨胀 ~10 倍且大图片可能卡住。base64 编码后是普通字符串，序列化高效。
///
/// 安全：路径由用户在原生 Save 对话框选定，调用方传啥写啥。
#[tauri::command]
pub fn write_binary_file(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败 {}: {}", path, e))
}

/// 将用户选择的图片复制为主题背景图，落到 framework_app_data_dir 根的 `theme-bg.<ext>`。
///
/// 为什么要复制：
/// - `tauri.conf.json` 的 assetProtocol scope 显式列出了 prod (`$APPDATA/**`) 和 dev
///   兄弟目录（`$DATA/com.agilefr.kb-dev/**`）两条规则，确保两套环境都能加载
/// - 复制一份还能避免用户后续移动/删除原文件导致背景丢失
///
/// 为什么用 framework_app_data_dir：
/// - dev 模式下走 `Roaming/com.agilefr.kb-dev/`，不污染 prod 数据；prod 模式走
///   `Roaming/com.agilefr.kb/`。两条 scope 规则各自匹配
///
/// 行为：
/// - 删除旧的 theme-bg.* 文件，再写入同名扩展名的新文件
/// - 返回新文件绝对路径，前端用 convertFileSrc 转 asset URL 注入到 body 背景
///
/// 安全：路径由用户在原生 Open 对话框选定（dialog plugin 已经做过授权），
/// 这里只接 src_path、不做拼接，仅做 std::fs::copy。
#[tauri::command]
pub fn copy_theme_bg(app: tauri::AppHandle, src_path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&src_path);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", src_path));
    }
    // 取扩展名（小写），未识别时回退 png
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "png".to_string());
    let allowed = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式: .{}", ext));
    }
    let app_data = crate::framework_app_data_dir(&app)
        .map_err(|e| format!("无法获取 app_data_dir: {}", e))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("创建 app_data_dir 失败: {}", e))?;
    // 清理旧的 theme-bg.* 避免不同扩展名残留
    if let Ok(entries) = std::fs::read_dir(&app_data) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("theme-bg.") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    let dst = app_data.join(format!("theme-bg.{}", ext));
    std::fs::copy(&src, &dst).map_err(|e| format!("复制图片失败: {}", e))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 删除当前主题背景图（前端"清除背景"按钮调）。
/// 静默处理 ENOENT：用户点击两次清除也不报错。
#[tauri::command]
pub fn clear_theme_bg(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = crate::framework_app_data_dir(&app)
        .map_err(|e| format!("无法获取 app_data_dir: {}", e))?;
    if let Ok(entries) = std::fs::read_dir(&app_data) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("theme-bg.") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// 检查路径是否仍然存在（前端启动时校验 store 里的 customBgImage 是否还能用）。
/// 用途：dev 数据目录被清掉、用户跨实例切换、文件被外部删除等情况下让前端及时清空旧路径。
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
