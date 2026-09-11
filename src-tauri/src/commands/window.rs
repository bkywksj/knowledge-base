//! 主窗口尺寸相关 Command（仅桌面端 —— 移动端窗口由系统管理）。

/// 窗口状态跟踪的 flags，插件注册处（`lib.rs`）与所有手动调用必须用同一份。
///
/// 刻意不含 VISIBLE：本应用支持「关闭时最小化到托盘」和 autostart `--start-minimized`，
/// 窗口隐藏着退出是正常路径，跟踪 VISIBLE 会导致下次启动直接无窗口。
#[cfg(desktop)]
pub(crate) const TRACKED_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::SIZE
        .union(tauri_plugin_window_state::StateFlags::POSITION)
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);

// ─── 跨 DPI / 显示器热插拔的几何自愈 ─────────────────────
//
// 🔴 要解决的现象（用户实测）：主屏 100% + 副屏 150%，软件全程留在主屏，但开关一次副屏
// 之后窗口就变成按 150% 渲染、内容区缩水，且重启也回不来。
//
// 三条根因（都在依赖源码里核对过）：
//   1. tao 0.34.6 在 **Windows 11** 上丢弃了自己算好的「保持逻辑尺寸」结果 ——
//      `event_loop.rs:1966-1973` 算出 `new_physical_inner_size`，但 `:2102-2105` 的
//      Win11 分支直接 `new_outer_rect = suggested_rect`，`:2107` 的 `SetWindowPos`
//      用的是 Windows 给的建议矩形，既不保逻辑尺寸守恒也不 clamp。Win10 分支反而用了它。
//   2. tao 完全不处理 `WM_DISPLAYCHANGE`（全仓搜不到），显示器增删后不重新评估窗口
//      所属屏、不刷新缓存的 scale_factor。Windows 不补发 `WM_DPICHANGED` 时，
//      `Window::scale_factor()`（读缓存）就永久停在错值。
//   3. window-state 插件存的是**物理**尺寸，于是错误几何被原样存盘、下次启动原样还原。
//
// 自愈思路：自己记住「用户意图的**逻辑**尺寸」作为唯一基准，在 DPI 事件后 / 启动还原后
// 按**实时查询**的真实缩放重算物理尺寸下发。这个做法不依赖 Windows 给的矩形是否靠谱，
// 因此上述每条路径都能纠正；而对「用户真的把窗口拖到副屏」也是正确行为（保持逻辑尺寸
// 本来就是 tao 想做的事），不会误伤。

/// 用户意图的主窗口**逻辑**尺寸 `(宽, 高)`，跨 DPI 校正的唯一基准。
///
/// 只跟踪主窗口，所以用 module static 而不是塞进 `AppState`：子窗口
/// （popout-* / push-popup-* / emergency-*）的几何各自由 builder 决定，不参与本机制。
#[cfg(desktop)]
static DESIRED_LOGICAL: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// DPI 校正的代际号。显示器热插拔时 Windows 会连发多次 `WM_DPICHANGED`，
/// 用它让只有最后一次排的校正真正执行，把一串抖动合并成一次。
#[cfg(desktop)]
static RECONCILE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 「此刻的 `Resized` 不是用户意图」的截止时刻（Unix 毫秒）。
#[cfg(desktop)]
static SUPPRESS_RECORD_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 基准写盘去抖的代际号。
#[cfg(desktop)]
static PERSIST_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 「有一次 DPI 校正因窗口当时处于最大化 / 全屏而被推迟」。
///
/// 最大化状态下窗口几何由系统管，插手只会打架，所以那一刻不能改尺寸。但用户取消最大化后，
/// tao 还原出来的那个尺寸可能已经被 DPI 事故污染（常态最大化使用的人正好撞这条路径）——
/// 把校正挂起，等窗口还原成普通窗口时补做。
#[cfg(desktop)]
static RECONCILE_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 收到 `ScaleFactorChanged` 后延迟多久才校正几何。
///
/// 🔴 必须延迟，**不能内联**：Tauri 的窗口事件是在 tao 的消息处理里**同步**派发的
/// （`tao/event_loop.rs:1980` 的 `send_event`），而 tao 自己的 `SetWindowPos`
/// （`:2107`）在派发**之后**才执行 —— 内联 `set_size` 会被它立刻覆盖，等于没改。
/// 400ms 也顺带给拓扑变化的连发 DPI 事件留出合并窗口。
#[cfg(desktop)]
const RECONCILE_DELAY_MS: u64 = 400;

/// 校正期间忽略 `Resized` 的时长，要盖住「延迟 + 下发 + 系统回抛 Resized」全程。
/// 否则我们自己校正出来的尺寸会被当成用户意图记进基准，自愈就退化成认命。
#[cfg(desktop)]
const SUPPRESS_RECORD_MS: u64 = 2_000;

/// 基准写盘去抖：用户拖拽窗口边框时 `Resized` 每帧都来，不能每次都写文件。
#[cfg(desktop)]
const PERSIST_DEBOUNCE_MS: u64 = 1_200;

/// 取窗口所属的 `AppHandle`。
///
/// 包一层只为把 `use tauri::Manager;` 收在一处 —— `app_handle()` 来自该 trait，
/// 本文件其余函数不需要它，不值得提到模块顶部污染命名空间。
#[cfg(desktop)]
fn handle_of(window: &tauri::WebviewWindow) -> tauri::AppHandle {
    use tauri::Manager;
    window.app_handle().clone()
}

#[cfg(desktop)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 基准存档的文件名（相对 `app_config_dir`）。
///
/// dev / prod 必须分开，理由与 `lib.rs` 的 `window_state_filename` 完全一致：
/// 插件和 Tauri 原生 `app_config_dir()` 都只认 identifier，dev 和 prod 落同一个目录，
/// 共用一份的话开着 dev 拖窗口会把正式版记住的尺寸冲掉。
#[cfg(desktop)]
fn desired_size_filename() -> &'static str {
    if cfg!(debug_assertions) {
        ".window-logical-size-dev.json"
    } else {
        ".window-logical-size.json"
    }
}

#[cfg(desktop)]
fn desired_size_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(desired_size_filename()))
}

/// 读基准存档。文件不存在 / 损坏 / 值非正一律当「没有基准」，由调用方决定退路。
#[cfg(desktop)]
fn load_desired_from_disk(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let path = desired_size_path(app)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

/// 写基准存档。失败只记 warn —— 丢了基准只是退化成「和以前一样」，不该影响任何功能。
#[cfg(desktop)]
fn save_desired_to_disk(app: &tauri::AppHandle, (w, h): (f64, f64)) {
    let Some(path) = desired_size_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "width": w, "height": h }).to_string();
    if let Err(e) = std::fs::write(&path, body) {
        log::warn!("[window] 逻辑尺寸基准写盘失败（下次启动将退回存档的物理尺寸）: {e}");
    }
}

/// 取窗口当前所在屏的**实时**缩放。
///
/// 🔴 刻意不用 `window.scale_factor()`：那读的是 tao 缓存，而缓存跑偏正是要修的病
/// （详见本节顶部根因 2 与 `services::window_size::physical_for_logical` 的注释）。
#[cfg(desktop)]
fn live_scale_factor(window: &tauri::WebviewWindow) -> Option<f64> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let s = monitor.scale_factor();
    (s.is_finite() && s > 0.0).then_some(s)
}

/// 窗口当前的实测**逻辑**尺寸。最小化（尺寸为 0）时返回 `None`。
#[cfg(desktop)]
fn current_logical_size(window: &tauri::WebviewWindow, scale: f64) -> Option<(f64, f64)> {
    let inner = window.inner_size().ok()?;
    if inner.width == 0 || inner.height == 0 {
        return None;
    }
    Some((inner.width as f64 / scale, inner.height as f64 / scale))
}

/// 读基准（内存态）。Mutex 中毒时返回 `None` 而不是 panic。
#[cfg(desktop)]
fn desired_logical_size() -> Option<(f64, f64)> {
    match DESIRED_LOGICAL.lock() {
        Ok(g) => *g,
        Err(e) => {
            log::warn!("[window] 逻辑尺寸基准锁中毒，本次跳过几何校正: {e}");
            None
        }
    }
}

/// 覆写基准（内存 + 落盘）。用于明确的用户意图（如「恢复默认大小」）。
#[cfg(desktop)]
fn set_desired_logical_size(app: &tauri::AppHandle, size: (f64, f64)) {
    match DESIRED_LOGICAL.lock() {
        Ok(mut g) => *g = Some(size),
        Err(e) => log::warn!("[window] 逻辑尺寸基准锁中毒，内存基准未更新: {e}"),
    }
    save_desired_to_disk(app, size);
}

/// 初始化基准。setup 里在几何全部落定（还原 / 首启默认 + `fit_into_work_area`）之后调一次。
///
/// 🔴 存档优先于实测值：`rescue_after_restore` 已经按存档校正过几何，而紧随其后的
/// `fit_into_work_area` 可能又把尺寸 clamp 小了（屏幕装不下）。若把 clamp 后的实测值
/// 记成新基准，从小屏切回大屏就再也回不到原尺寸 —— 基准必须始终是「用户想要的」，
/// 而不是「这块屏当前能给的」。
#[cfg(desktop)]
pub(crate) fn init_desired_logical_size(window: &tauri::WebviewWindow) {
    // 🔴 先撑开抑制窗口：setup 里的 restore_state / set_size / fit_into_work_area 都会
    // **异步**投递 `Resized`，那些事件在本函数返回之后才到达 `note_user_resize`。
    // 不挡住的话，fit clamp 出来的尺寸会被当成用户意图、覆盖掉下面刚载入的存档基准 ——
    // 正是本函数注释要避免的那件事。
    SUPPRESS_RECORD_UNTIL.store(
        now_ms() + SUPPRESS_RECORD_MS,
        std::sync::atomic::Ordering::SeqCst,
    );

    let app = handle_of(window);
    if let Some(saved) = load_desired_from_disk(&app) {
        match DESIRED_LOGICAL.lock() {
            Ok(mut g) => *g = Some(saved),
            Err(e) => log::warn!("[window] 逻辑尺寸基准锁中毒，未载入存档基准: {e}"),
        }
        log::info!("[window] 逻辑尺寸基准载入存档: {:.0}x{:.0}", saved.0, saved.1);
        return;
    }
    // 首次跑到带本机制的版本：拿当前实测值建档
    let Some(scale) = live_scale_factor(window) else {
        return;
    };
    let Some(cur) = current_logical_size(window, scale) else {
        return;
    };
    log::info!("[window] 逻辑尺寸基准初始化为当前实测值: {:.0}x{:.0}", cur.0, cur.1);
    set_desired_logical_size(&app, cur);
}

/// 记录用户手动调整出来的逻辑尺寸。挂在 `WindowEvent::Resized` 上。
#[cfg(desktop)]
pub(crate) fn note_user_resize(window: &tauri::WebviewWindow) {
    // 校正窗口期内的 Resized 是我们自己下发的（或 fit clamp 出来的），不是用户意图
    if now_ms() < SUPPRESS_RECORD_UNTIL.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // 最大化 / 全屏时 inner_size 是屏幕尺寸，不是用户想要的还原尺寸；
    // 这也与 window-state 插件的口径一致（它存的同样是还原尺寸）。
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    // 有挂起的校正（DPI 变化时窗口正处于最大化）→ 现在已还原成普通窗口，
    // 补做校正而不是记账：此刻的尺寸是 tao 从最大化还原出来的、可能已被 DPI 事故污染，
    // 当成用户意图就把错误尺寸固化成基准了。补做前先撑开抑制窗口，免得校正自己触发的
    // Resized 又绕回这里记账。
    if RECONCILE_PENDING.swap(false, std::sync::atomic::Ordering::SeqCst) {
        SUPPRESS_RECORD_UNTIL.store(
            now_ms() + SUPPRESS_RECORD_MS,
            std::sync::atomic::Ordering::SeqCst,
        );
        log::info!("[window] 窗口已还原成普通窗口，补做先前挂起的跨 DPI 校正");
        reconcile_geometry(window);
        return;
    }
    let Some(scale) = live_scale_factor(window) else {
        return;
    };
    // 最小化时 inner_size 为 0，会被这里挡掉
    let Some(cur) = current_logical_size(window, scale) else {
        return;
    };

    match DESIRED_LOGICAL.lock() {
        Ok(mut g) => *g = Some(cur),
        Err(e) => {
            log::warn!("[window] 逻辑尺寸基准锁中毒，本次 resize 未记账: {e}");
            return;
        }
    }

    // 写盘去抖：拖拽边框时 Resized 每帧都来，只在停手后写一次
    let gen = PERSIST_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let app = handle_of(window);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(PERSIST_DEBOUNCE_MS)).await;
        if PERSIST_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
            return;
        }
        if let Some(size) = desired_logical_size() {
            save_desired_to_disk(&app, size);
        }
    });
}

/// 收到 `ScaleFactorChanged` 后排一次延迟校正。挂在 `WindowEvent::ScaleFactorChanged` 上。
#[cfg(desktop)]
pub(crate) fn schedule_geometry_reconcile(window: &tauri::WebviewWindow, new_scale: f64) {
    // 先把抑制窗口撑开，盖住「延迟 + 下发 + 系统回抛 Resized」全程
    SUPPRESS_RECORD_UNTIL.store(
        now_ms() + SUPPRESS_RECORD_MS,
        std::sync::atomic::Ordering::SeqCst,
    );

    let gen = RECONCILE_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    log::info!(
        "[window] 缩放变为 {new_scale}，{RECONCILE_DELAY_MS}ms 后校正几何（第 {gen} 代）"
    );

    let app = handle_of(window);
    let label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(RECONCILE_DELAY_MS)).await;
        // 期间又来了新的 DPI 事件 → 交给最后那一代去做，本代退出
        if RECONCILE_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
            return;
        }
        let handle = app.clone();
        // 窗口几何必须在主线程下发
        let _ = app.run_on_main_thread(move || {
            use tauri::Manager;
            if let Some(w) = handle.get_webview_window(&label) {
                reconcile_geometry(&w);
            }
        });
    });
}

/// 按基准 + **实时**缩放重算并下发几何。
#[cfg(desktop)]
fn reconcile_geometry(window: &tauri::WebviewWindow) {
    // 最大化 / 全屏的几何由系统管，插手只会打架（与 fit_into_work_area 同一判断）。
    // 但不能就这么算了 —— 挂起，等还原成普通窗口时由 note_user_resize 补做。
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        RECONCILE_PENDING.store(true, std::sync::atomic::Ordering::SeqCst);
        log::info!("[window] 当前为最大化 / 全屏，跨 DPI 校正挂起，等还原成普通窗口后补做");
        return;
    }
    let Some(want) = desired_logical_size() else {
        return;
    };
    let Some(scale) = live_scale_factor(window) else {
        return;
    };

    if let Some(cur) = current_logical_size(window, scale) {
        if !crate::services::window_size::logical_size_drifted(cur, want) {
            // 尺寸没漂，但位置仍可能越界（副屏被拔掉、窗口原先在副屏坐标系里）→ 只兜位置
            fit_into_work_area(window, false);
            return;
        }
        log::info!(
            "[window] 跨 DPI 漂移校正: 逻辑 {:.0}x{:.0} → {:.0}x{:.0}（实时缩放 {scale}）",
            cur.0,
            cur.1,
            want.0,
            want.1,
        );
    }

    let (pw, ph) = crate::services::window_size::physical_for_logical(want, scale);
    // 🔴 刻意下发**物理**尺寸：set_size(LogicalSize) 会被 tao 用它自己缓存的
    // scale_factor 换算，而那个缓存正是可能跑偏的一方（根因 2）。
    if let Err(e) = window.set_size(tauri::PhysicalSize::new(pw, ph)) {
        log::warn!("[window] 跨 DPI 校正下发尺寸失败: {e}");
    }
    // 基准尺寸不一定装得进当前这块屏（从大屏切回小屏）→ 最后一道 clamp
    fit_into_work_area(window, false);
}

/// 启动还原之后，按基准校正「跨 DPI 存取」造成的偏差。
///
/// window-state 插件存/还原的都是**物理**尺寸：上次退出时若窗口正处在错误缩放下
/// （或用户换了显示器 / 改了缩放），还原出来的物理尺寸按当前真实缩放解释就是错的，
/// 且插件不做任何校正。这里用基准把它拉回来。
///
/// 调用方紧接着会跑 `fit_into_work_area`，所以本函数只管尺寸、不管位置与 clamp。
#[cfg(desktop)]
pub(crate) fn rescue_after_restore(window: &tauri::WebviewWindow) {
    let app = handle_of(window);
    // 没有基准存档（首次升级到本版本）→ 认账还原出来的物理尺寸，不瞎猜
    let Some(want) = load_desired_from_disk(&app) else {
        return;
    };
    let Some(scale) = live_scale_factor(window) else {
        return;
    };
    let Some(cur) = current_logical_size(window, scale) else {
        return;
    };
    if !crate::services::window_size::logical_size_drifted(cur, want) {
        return;
    }
    let (pw, ph) = crate::services::window_size::physical_for_logical(want, scale);
    log::info!(
        "[window] 存档物理尺寸与逻辑尺寸基准不符（上次退出时的缩放与现在不同）: \
         逻辑 {:.0}x{:.0} → {:.0}x{:.0}，按实时缩放 {scale} 下发物理 {pw}x{ph}",
        cur.0,
        cur.1,
        want.0,
        want.1,
    );
    if let Err(e) = window.set_size(tauri::PhysicalSize::new(pw, ph)) {
        log::warn!("[window] 启动期跨 DPI 校正下发尺寸失败: {e}");
    }
}

/// 把窗口塞进它当前所在那块屏的**工作区**（扣掉任务栏），返回是否真的动过窗口。
///
/// 🔴 存在的理由：`tauri-plugin-window-state` 存/还原的都是**物理**像素，且完全不 clamp
/// （详见 `services::window_size::fit_into_work_area` 的注释）。显示器拓扑一变
/// —— 拔掉外接屏、改分辨率、改缩放 —— 还原出来的几何就可能比屏幕还大、或整个跑到屏幕外。
/// 每次还原 / 改尺寸之后都过一遍本函数，保证窗口一定是完整可见、可拖动的。
///
/// `center = true` 时忽略当前位置、直接在工作区内居中（首次启动 / 「恢复默认大小」）。
///
/// 🔴 下发顺序固定为 `set_position` → `set_size`：跨 DPI 屏移动时 Windows 会在
/// `set_position` 内部同步抛 `WM_DPICHANGED` 并按新 DPI 重算窗口 rect，反过来的话
/// 刚设好的尺寸会被再乘一次两屏缩放比（tauri-cc 项目在混合 DPI 双屏上实测过这个坑）。
#[cfg(desktop)]
pub(crate) fn fit_into_work_area(window: &tauri::WebviewWindow, center: bool) -> bool {
    use crate::services::window_size::Rect;

    // 最大化 / 全屏的几何由系统管理，插手只会打架
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return false;
    }

    // current_monitor 才是「窗口实际在哪块屏」；取不到（窗口还没落位）才退主屏
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return false;
    };

    // 工作区被报成 0 的显示器（虚拟屏 / 远程桌面）退回整屏几何
    let wa = monitor.work_area();
    let work = if wa.size.width > 0 && wa.size.height > 0 {
        Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height }
    } else {
        Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        }
    };

    let (Ok(outer), Ok(inner), Ok(pos)) = (
        window.outer_size(),
        window.inner_size(),
        window.outer_position(),
    ) else {
        return false;
    };

    // 「占多大地方」算的是外框，但 set_size 设的是内容区。本应用 decorations:false
    // 时两者相等，但别把这个前提焊死 —— 留出边框差，将来开边框也不会算错。
    let border_w = outer.width.saturating_sub(inner.width);
    let border_h = outer.height.saturating_sub(inner.height);

    let want_pos = if center { None } else { Some((pos.x, pos.y)) };
    let fitted = crate::services::window_size::fit_into_work_area(
        work,
        want_pos,
        outer.width,
        outer.height,
    );

    let mut changed = false;
    if (fitted.x, fitted.y) != (pos.x, pos.y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(fitted.x, fitted.y));
        changed = true;
    }
    if (fitted.width, fitted.height) != (outer.width, outer.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(
            fitted.width.saturating_sub(border_w).max(1),
            fitted.height.saturating_sub(border_h).max(1),
        ));
        changed = true;
    }

    if changed {
        log::info!(
            "[window] 几何已按工作区校正: {}x{}@({},{}) → {}x{}@({},{})，屏 {}",
            outer.width,
            outer.height,
            pos.x,
            pos.y,
            fitted.width,
            fitted.height,
            fitted.x,
            fitted.y,
            monitor.name().map(String::as_str).unwrap_or("<未命名>"),
        );
    }
    changed
}

/// 把主窗口恢复成"默认大小并居中"。
///
/// 为什么需要它：接了 tauri-plugin-window-state 之后，窗口的大小 / 位置 /
/// 最大化状态会被记住并在下次启动还原。好处是用户调过一次就一直保持，代价是
/// 一旦把窗口拖成很别扭的尺寸（或从多屏环境挪到单屏、外接屏拔掉），就再没有
/// 一键回到合理尺寸的路 —— 这个 Command 就是那条路。
///
/// 做三件事，缺一不可：
///   1. 先退出最大化 —— 最大化状态下 set_size 不生效（或还原后才生效，观感是"点了没反应"）
///   2. 按**窗口当前所在**那块屏重算默认尺寸，再按该屏工作区居中
///   3. **立刻落盘**，否则用户点完不重启直接关窗口，插件会把"关闭那一刻的尺寸"
///      写回去，看起来像恢复失败
///
/// 🔴 第 2 步认的是 `current_monitor` 而非 `primary_monitor`：双屏下用户很可能是在副屏
/// 点的这个按钮，按主屏分辨率算出来的尺寸放到副屏上并不合适（4K 副屏上会偏小、
/// 小副屏上会装不下）。居中也不再用 `center()` —— 它按整屏居中、不管任务栏，
/// 改走 [`fit_into_work_area`] 按工作区居中并兜底。
#[tauri::command]
pub fn reset_window_size(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_window_state::AppHandleExt;

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;

        // 1. 退出最大化（本来就不是最大化时这是空操作）
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }

        // 2. 按窗口所在屏重算 —— 用户可能换了屏、挪了窗口或改了缩放，不能用启动时的值
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten())
            .ok_or_else(|| "取不到显示器信息".to_string())?;
        let scale = monitor.scale_factor().max(0.1);
        let phys = monitor.size();
        let (w, h) = crate::services::window_size::default_window_size(
            phys.width as f64 / scale,
            phys.height as f64 / scale,
        );

        // 「恢复默认大小」是一次明确的用户意图 → 它就是新的跨 DPI 校正基准。
        // 不更新的话，下一次缩放变化会按旧基准把窗口又拉回去。
        set_desired_logical_size(&app, (w, h));
        // 并撑开抑制窗口：下面 set_size + fit 投递的 Resized 不能反过来把 clamp 后的
        // 尺寸记成新基准（屏幕装不下时 fit 会把默认尺寸压小，那是屏幕限制、不是用户意图）。
        SUPPRESS_RECORD_UNTIL.store(
            now_ms() + SUPPRESS_RECORD_MS,
            std::sync::atomic::Ordering::SeqCst,
        );

        // 🔴 下发**物理**而非逻辑尺寸：`set_size(LogicalSize)` 会被 tao 用它缓存的
        // scale_factor 换算，而显示器热插拔后那个缓存可能已经跑偏（见本文件顶部根因 2）。
        // 这里的 `scale` 取自 MonitorHandle，是实时查询的真值。
        let (pw, ph) = crate::services::window_size::physical_for_logical((w, h), scale);
        window
            .set_size(tauri::PhysicalSize::new(pw, ph))
            .map_err(|e| e.to_string())?;
        // 按工作区居中 + clamp：默认尺寸不一定装得进这块屏（小笔记本 / 投影仪 1280×720）
        fit_into_work_area(&window, true);

        // 3. 立刻落盘。flags 与插件注册处同源，避免两处漂移 ——
        //    传 all() 会顺带把 VISIBLE 写进去，而我们刻意不跟踪它（见 TRACKED_STATE_FLAGS）。
        app.save_window_state(TRACKED_STATE_FLAGS)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("移动端窗口由系统管理，不支持调整".to_string())
    }
}
