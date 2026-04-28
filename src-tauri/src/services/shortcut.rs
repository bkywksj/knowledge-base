//! 全局快捷键服务（global-shortcut 插件的业务编排）
//!
//! ## 职责
//! - 维护「内部 ID → accelerator」的双向状态：DB 持久化（用户改键）+ 进程内缓存（用于 unregister）
//! - 启动时根据 DB + 默认值注册全部热键；运行期支持动态改键
//! - 触发时按 ID 派发到 `dispatch_action` —— 不同热键的具体动作集中在这里
//!
//! ## 配置存储
//! - DB key：`shortcut.<id>`（如 `shortcut.global.quickCapture`）
//! - value：accelerator 字符串（`"CommandOrControl+Shift+N"`），空字符串 = 已禁用
//! - 不存在 = 走默认值
//!
//! ## 热键 ID 白名单
//! - 仅 `DEFAULT_BINDINGS` 中列出的 ID 才算合法热键
//! - 前端 registry.ts 中 `scope: 'global'` 的条目必须与本表 1:1 对齐

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::database::Database;
use crate::error::AppError;
use crate::models::ShortcutBinding;
use crate::services::quick_capture::QuickCaptureService;
use crate::state::AppState;

/// 全部全局热键的内部 ID + 默认 accelerator
/// （添加新热键时：1. 在这里加一行；2. 在 dispatch_action 加 match 分支；3. 前端 registry 同步）
const DEFAULT_BINDINGS: &[(&str, &str)] = &[
    ("global.quickCapture", "CommandOrControl+Shift+N"),
    ("global.showWindow", "CommandOrControl+Alt+K"),
    ("global.openDaily", "CommandOrControl+Alt+D"),
    ("global.openSearch", "CommandOrControl+Alt+F"),
];

/// 进程内缓存：「ID → 当前注册中的 accel」
/// 用于改键时找到旧 accel 调 unregister；以及 list_bindings 兜底校验
static BIND_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, String>> {
    BIND_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct ShortcutService;

impl ShortcutService {
    /// 默认 accel 查询（白名单 = DEFAULT_BINDINGS）
    pub fn default_accel(id: &str) -> Option<&'static str> {
        DEFAULT_BINDINGS
            .iter()
            .find(|(k, _)| *k == id)
            .map(|(_, v)| *v)
    }

    /// 取生效 accel：用户配置（可能是空 = 禁用）OR 默认。
    /// 返回 `Ok(None)` 表示「禁用」；`Ok(Some(s))` 是要绑定的 accel
    pub fn effective_accel(db: &Database, id: &str) -> Result<Option<String>, AppError> {
        match db.get_config(&config_key(id))? {
            Some(s) if s.is_empty() => Ok(None), // 显式禁用
            Some(s) => Ok(Some(s)),
            None => Ok(Self::default_accel(id).map(String::from)), // 走默认
        }
    }

    /// 列出所有热键的当前状态（给设置页 UI）
    pub fn list_bindings(db: &Database) -> Result<Vec<ShortcutBinding>, AppError> {
        let mut out = Vec::with_capacity(DEFAULT_BINDINGS.len());
        for (id, default_accel) in DEFAULT_BINDINGS {
            let user = db.get_config(&config_key(id))?;
            let (accel, is_custom, disabled) = match &user {
                Some(s) if s.is_empty() => (String::new(), true, true),
                Some(s) => (s.clone(), s != default_accel, false),
                None => (default_accel.to_string(), false, false),
            };
            out.push(ShortcutBinding {
                id: id.to_string(),
                accel,
                default_accel: default_accel.to_string(),
                is_custom,
                disabled,
            });
        }
        Ok(out)
    }

    /// 启动时注册所有有效热键（仅默认实例调用一次）。
    /// 每条独立注册：单条失败仅 log warn，不影响其他热键
    pub fn register_all(app: &AppHandle, db: &Database) {
        for (id, _) in DEFAULT_BINDINGS {
            match Self::effective_accel(db, id) {
                Ok(Some(accel)) => {
                    if let Err(e) = bind(app, id, &accel) {
                        log::warn!("[shortcut] 注册 {} ({}) 失败: {}", id, accel, e);
                    } else {
                        log::info!("[shortcut] 已注册 {} = {}", id, accel);
                    }
                }
                Ok(None) => log::info!("[shortcut] {} 已被用户禁用，跳过注册", id),
                Err(e) => log::warn!("[shortcut] 读取 {} 配置失败: {}", id, e),
            }
        }
    }

    /// 改键：DB 写入 + 解绑旧 accel + 绑新 accel
    pub fn set_accel(
        app: &AppHandle,
        db: &Database,
        id: &str,
        accel: &str,
    ) -> Result<(), AppError> {
        validate_id(id)?;
        validate_accel(accel)?;
        check_no_conflict(db, id, accel)?;

        unbind_if_any(app, id);
        bind(app, id, accel).map_err(|e| AppError::Custom(format!("注册热键失败: {}", e)))?;
        db.set_config(&config_key(id), accel)?;
        log::info!("[shortcut] 改键 {} = {}", id, accel);
        Ok(())
    }

    /// 重置：DB 删除 + 用默认重新绑定
    pub fn reset_accel(app: &AppHandle, db: &Database, id: &str) -> Result<(), AppError> {
        validate_id(id)?;
        unbind_if_any(app, id);
        // delete_config 不存在键时返回 false，这里不当错误
        let _ = db.delete_config(&config_key(id));
        let default = Self::default_accel(id).unwrap();
        bind(app, id, default)
            .map_err(|e| AppError::Custom(format!("重置后注册热键失败: {}", e)))?;
        log::info!("[shortcut] 重置 {} → {}", id, default);
        Ok(())
    }

    /// 禁用：DB 写空字符串 + 解绑（不再注册任何 accel）
    pub fn disable_accel(app: &AppHandle, db: &Database, id: &str) -> Result<(), AppError> {
        validate_id(id)?;
        unbind_if_any(app, id);
        db.set_config(&config_key(id), "")?;
        log::info!("[shortcut] 禁用 {}", id);
        Ok(())
    }
}

// ─── helpers ────────────────────────────────────

fn config_key(id: &str) -> String {
    format!("shortcut.{}", id)
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if ShortcutService::default_accel(id).is_some() {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("未知的快捷键 ID: {}", id)))
    }
}

/// 至少需要一个修饰键 + 一个非修饰键（避免用户绑定单字母被吞掉所有键盘输入）
fn validate_accel(accel: &str) -> Result<(), AppError> {
    let parts: Vec<&str> = accel.split('+').map(str::trim).collect();
    if parts.len() < 2 {
        return Err(AppError::InvalidInput(
            "快捷键必须包含至少一个修饰键 + 主键".into(),
        ));
    }
    let modifiers = [
        "Command",
        "CommandOrControl",
        "Cmd",
        "CmdOrCtrl",
        "Control",
        "Ctrl",
        "Alt",
        "Option",
        "Shift",
        "Meta",
        "Super",
    ];
    let has_mod = parts.iter().any(|p| modifiers.contains(p));
    if !has_mod {
        return Err(AppError::InvalidInput("快捷键必须包含一个修饰键".into()));
    }
    Ok(())
}

/// 同一个 accel 不能绑定到两个不同的热键
fn check_no_conflict(db: &Database, self_id: &str, accel: &str) -> Result<(), AppError> {
    for (id, _) in DEFAULT_BINDINGS {
        if *id == self_id {
            continue;
        }
        let other = ShortcutService::effective_accel(db, id)?;
        if other.as_deref() == Some(accel) {
            return Err(AppError::InvalidInput(format!(
                "快捷键 {} 与「{}」冲突",
                accel, id
            )));
        }
    }
    Ok(())
}

/// 绑定 accel 到 id 对应的 handler；同步刷新缓存
fn bind(app: &AppHandle, id: &str, accel: &str) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let app_for_handler = app.clone();
    let id_for_handler = id.to_string();
    app.global_shortcut().on_shortcut(accel, move |_, _, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        let app_clone = app_for_handler.clone();
        let id_clone = id_for_handler.clone();
        tauri::async_runtime::spawn(async move {
            dispatch_action(app_clone, &id_clone);
        });
    })?;
    cache()
        .lock()
        .map(|mut g| g.insert(id.to_string(), accel.to_string()))
        .ok();
    Ok(())
}

/// 解绑当前 id 缓存的 accel；若缓存为空则当作"已经没注册"
fn unbind_if_any(app: &AppHandle, id: &str) {
    let prev = cache().lock().ok().and_then(|mut g| g.remove(id));
    if let Some(accel) = prev {
        if let Err(e) = app.global_shortcut().unregister(accel.as_str()) {
            log::warn!("[shortcut] 解绑 {} ({}) 失败: {}", id, accel, e);
        }
    }
}

// ─── action dispatch ────────────────────────────

/// 热键触发后的实际动作派发表。
/// 新增热键时在这里追加 match 分支
fn dispatch_action(app: AppHandle, id: &str) {
    match id {
        "global.quickCapture" => action_quick_capture(app),
        "global.showWindow" => focus_main(&app),
        "global.openDaily" => {
            focus_main(&app);
            let _ = app.emit("tray:open-daily", ());
        }
        "global.openSearch" => {
            focus_main(&app);
            let _ = app.emit("tray:open-search", ());
        }
        _ => log::warn!("[shortcut] 未知 action id: {}", id),
    }
}

/// 把主窗口前置 + 取消最小化 + 抢焦点
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 剪贴板 → 新笔记的具体动作（从 lib.rs 的 handle_quick_capture 迁移过来）
fn action_quick_capture(app: AppHandle) {
    let text = match app.clipboard().read_text() {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[quick_capture] 读取剪贴板失败: {}", e);
            let _ = app
                .notification()
                .builder()
                .title("剪贴板捕获失败")
                .body(&format!("无法读取剪贴板：{}", e))
                .show();
            return;
        }
    };

    let state = app.state::<AppState>();
    match QuickCaptureService::capture_from_text(&state.db, &text) {
        Ok(note) => {
            log::info!("[quick_capture] 已创建笔记 #{}: {}", note.id, note.title);
            let _ = app
                .notification()
                .builder()
                .title("已保存到知识库")
                .body(&note.title)
                .show();
            let _ = app.emit("quick_capture:note_created", note);
        }
        Err(e) => {
            log::warn!("[quick_capture] 创建笔记失败: {}", e);
            let _ = app
                .notification()
                .builder()
                .title("剪贴板捕获失败")
                .body(&e.to_string())
                .show();
        }
    }
}
