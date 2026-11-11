//! 和 Tauri 窗口打交道的部分。
//!
//! 🔴 锁规则：**持锁期间绝不调用任何窗口方法** —— `set_position` / `unminimize` 会同步派发
//! WM_MOVE / WM_SIZE，事件回调重入本模块再拿锁就死锁了。所有读写都走 [`with`]，闭包里只碰数据。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{window::Monitor, AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

use super::logic::{big_enough, centered_rel, find_target, layout_key, legacy_usable, minimized_around_topology, place_in, plan, same_screen, should_record, signature, Memory, MonitorKey, Placement, Plan};

// 主窗口只有一个 webview，按 webview 窗口查找即可（以后主窗口里挂子 webview 的话，
// get_webview_window 会静默返回 None，要改成 get_window 按窗口查找）
type MainWindow = tauri::WebviewWindow;

fn lookup(app: &AppHandle, label: &str) -> Option<MainWindow> {
    app.get_webview_window(label)
}

// 开发版单独一份：开发版和正式版可能共用 identifier，也就共用目录，
// 不分开的话开着开发版拖窗口，正式版记住的位置就被冲掉了。
#[cfg(debug_assertions)]
const STORE_FILENAME: &str = "window-memory-dev.json";
#[cfg(not(debug_assertions))]
const STORE_FILENAME: &str = "window-memory.json";
// 旧版的单条记录文件，新记录为空时拿来打底。旧版同样按构建分了文件。
#[cfg(debug_assertions)]
const LEGACY_FILENAME: &str = "main-window-placement-dev.json";
#[cfg(not(debug_assertions))]
const LEGACY_FILENAME: &str = "main-window-placement.json";
/// 拓扑变化后多久内的移动不算「用户态」（系统还在搬窗口）。
const TOPOLOGY_SETTLE_MS: u64 = 1500;
/// 拓扑变化后多久内，换屏必须有真实拖动才算用户的选择。系统搬窗口可能晚于沉降期。
const SYSTEM_MOVE_QUIET_MS: u64 = 30_000;
/// 拖动结束后还算「用户在动」的宽限（松手后还有一轮 DPI 调整带来的移动）。
const DRAG_GRACE_MS: u64 = 1500;
/// 拓扑变化后两次纠偏的延迟：第二次兜住系统搬得比较晚的情况。
const CORRECT_DELAYS_MS: [u64; 2] = [TOPOLOGY_SETTLE_MS + 200, 6000];
/// 记录写盘的防抖。
const SAVE_DEBOUNCE_MS: u64 = 800;
/// 屏幕变化后那两次纠偏的 reason，同时用来区分「这次纠偏是屏幕变化引起的」。
const TOPOLOGY_REASON: &str = "显示器变化沉降后";
/// 「最小化 → 恢复」后延迟多久纠偏（等 tao / 系统把这轮还原的几何下发完）。
const EVENT_CORRECT_DELAY_MS: u64 = 120;

/// [`init`] 的选项。
pub struct Options {
    /// 主窗口的 label
    pub label: String,
    /// 旧版单条记录（`Placement` 的 JSON）。没有新记录时，用它给当前组合打底
    pub legacy: Option<String>,
    /// 额外的诊断输出（正式版日志级别高于 info 时用）
    pub diag: Option<fn(&str)>,
    /// 记录文件放哪，默认 `app_config_dir`。能多开的应用传各实例自己的数据目录，否则实例之间互相覆盖
    pub dir: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self { label: "main".into(), legacy: None, diag: None, dir: None }
    }
}

#[derive(Default)]
struct Inner {
    label: String,
    diag: Option<fn(&str)>,
    path: Option<PathBuf>,
    /// 配置里的最小尺寸（逻辑像素）
    min_size: Option<(f64, f64)>,
    memory: Memory,
    /// 上一次事件时窗口是否最小化 —— 用来识别「最小化 / 恢复」的切换
    was_minimized: bool,
    /// 最近一次变成最小化的时间，用来判断是不是屏幕变化引起的
    minimized_at: Option<Instant>,
    /// 有一次纠偏排着还没做：期间的位置都是系统还原出来的，不能记成用户态
    pending_correct: u32,
    /// 显示器拓扑签名，变了 = 插拔 / 换主屏 / 改分辨率
    monitors_sig: Option<String>,
    topology_changed_at: Option<Instant>,
    dragging: bool,
    drag_ended_at: Option<Instant>,
    save_gen: u64,
}

impl Inner {
    fn settling(&self) -> bool {
        self.topology_changed_at.is_some_and(|t| t.elapsed() < Duration::from_millis(TOPOLOGY_SETTLE_MS))
    }

    /// 窗口换了屏时，算不算用户动的：正在拖、刚拖完，或者离上次显示器变化已经很久（系统不会无故搬窗口，
    /// 这时多半是 Win+Shift+方向键）。macOS / Linux 没有拖动信号，只靠后一条。
    fn user_moved(&self) -> bool {
        self.dragging_now() || self.topology_changed_at.is_none_or(|t| t.elapsed() >= Duration::from_millis(SYSTEM_MOVE_QUIET_MS))
    }

    fn minimized_by_topology(&self) -> bool {
        minimized_around_topology(self.minimized_at.map(|t| t.elapsed()), self.topology_changed_at.map(|t| t.elapsed()))
    }

    /// 用户正在拖或刚拖完。
    fn dragging_now(&self) -> bool {
        self.dragging || self.drag_ended_at.is_some_and(|t| t.elapsed() < Duration::from_millis(DRAG_GRACE_MS))
    }
}

#[derive(Default)]
struct WindowMemory {
    inner: Mutex<Inner>,
}

/// 唯一的取锁入口；闭包里只许碰数据，不许调窗口方法（见文件头锁规则）。
fn with<T>(app: &AppHandle, f: impl FnOnce(&mut Inner) -> T) -> Option<T> {
    let st = app.try_state::<WindowMemory>()?;
    let mut g = st.inner.lock().unwrap_or_else(|e| e.into_inner());
    Some(f(&mut g))
}

fn note(app: &AppHandle, msg: String) {
    log::info!("{msg}");
    if let Some(f) = with(app, |s| s.diag).flatten() {
        f(&msg);
    }
}

fn main_window(app: &AppHandle) -> Option<MainWindow> {
    let label = with(app, |s| s.label.clone())?;
    lookup(app, &label)
}

fn key_of(m: &Monitor) -> MonitorKey {
    let (p, s) = (m.position(), m.size());
    MonitorKey { name: m.name().cloned(), x: p.x, y: p.y, w: s.width, h: s.height }
}

fn monitor_keys(win: &MainWindow) -> Vec<MonitorKey> {
    win.available_monitors().map(|v| v.iter().map(key_of).collect()).unwrap_or_default()
}

fn primary_key(win: &MainWindow) -> Option<MonitorKey> {
    win.primary_monitor().ok().flatten().map(|m| key_of(&m))
}

fn current_key(win: &MainWindow) -> Option<MonitorKey> {
    win.current_monitor().ok().flatten().map(|m| key_of(&m))
}

fn describe_mon(m: &MonitorKey) -> String {
    format!("{}@({},{}) {}x{}", m.name.as_deref().unwrap_or("?"), m.x, m.y, m.w, m.h)
}

fn describe_list(list: &[MonitorKey], primary: Option<&MonitorKey>) -> String {
    list.iter()
        .map(|m| format!("{}{}", if Some(m) == primary { "[主]" } else { "" }, describe_mon(m)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_placement(p: &Placement) -> String {
    format!("屏 {} 偏移({},{}) {}x{}{}", describe_mon(&p.monitor), p.rel_x, p.rel_y, p.w, p.h, if p.maximized { " 最大化" } else { "" })
}

fn describe_window(win: &MainWindow) -> String {
    let pos = win.outer_position().map(|p| format!("({},{})", p.x, p.y)).unwrap_or_else(|_| "?".into());
    let size = win.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|_| "?".into());
    let mon = current_key(win).map(|m| describe_mon(&m)).unwrap_or_else(|| "无".into());
    format!("pos={pos} size={size} 屏={mon} visible={} min={} max={}", win.is_visible().unwrap_or(false), win.is_minimized().unwrap_or(false), win.is_maximized().unwrap_or(false))
}

/// 把窗口摆到 (x, y)。`outer = true` 时 w×h 是含隐形边框的外框（记录里存的就是它），否则是内容区。
///
/// 🔴 先挪屏再定尺寸：尺寸是目标屏上的物理像素。先定尺寸再挪到缩放比不同的屏，系统会按 DPI 再放大一次。
/// 🔴 `set_size` 设的是内容区：把外框尺寸直接传进去，每次启动都会多出一圈边框。
/// 跨屏的 DPI 调整可能带动位置，定完尺寸再摆一次。
fn place_window(win: &MainWindow, x: i32, y: i32, w: u32, h: u32, outer: bool) {
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // 边框宽度要在挪到目标屏之后量，它随 DPI 变
    let (dw, dh) = match (outer, win.outer_size(), win.inner_size()) {
        (true, Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    let _ = win.set_size(PhysicalSize::new(w.saturating_sub(dw), h.saturating_sub(dh)));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 压进目标屏的工作区（扣掉任务栏）：记录是脏的也不能让窗口比这还大。
fn fit_work_area(win: &MainWindow, target: &MonitorKey, w: u32, h: u32) -> (u32, u32) {
    let area = win.available_monitors().ok().and_then(|v| v.iter().find(|m| key_of(m) == *target).map(|m| (m.work_area().size.width, m.work_area().size.height)));
    let (aw, ah) = area.unwrap_or((target.w, target.h));
    (w.min(aw), h.min(ah))
}

// ───────────────────────── 记录 ─────────────────────────

/// 记下当前位置。`force` = 用户明确操作（还原默认大小），不用再判断是不是系统挪的。
fn capture(win: &MainWindow, reason: &str, force: bool) {
    if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return;
    }
    let keys = monitor_keys(win);
    let Some(mk) = current_key(win) else { return };
    if keys.is_empty() {
        return;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    let maximized = win.is_maximized().unwrap_or(false);
    let layout = layout_key(&keys);
    let app = win.app_handle();
    if !force && !maximized {
        if let (Some(min), Ok(inner), Ok(scale)) = (with(app, |s| s.min_size).flatten(), win.inner_size(), win.scale_factor()) {
            let logical = inner.to_logical::<f64>(scale);
            if !big_enough((logical.width, logical.height), min) {
                return;
            }
        }
    }

    let updated = with(app, |s| {
        // 恢复事件还没处理（Moved 先于 Resized 到达）/ 纠偏排着没做 / 系统还在搬窗口 → 都不是用户态。
        // 但用户真的在拖就要记：屏幕变化后要等约 6 秒才纠偏完，这期间拖的位置不记就会被纠偏撤销
        if !force && (s.was_minimized || ((s.pending_correct > 0 || s.settling()) && !s.dragging_now())) {
            return None;
        }
        let prev = s.memory.get(&layout).cloned();
        let new = if maximized {
            // 最大化时外框是整屏，不能当「正常位置」：同屏就保留上次的正常矩形，只翻标志
            match &prev {
                Some(p) if same_screen(&p.monitor, &mk) => Placement { monitor: mk.clone(), maximized: true, ..p.clone() },
                other => {
                    let (w, h) = other.as_ref().map(|p| (p.w.min(mk.w), p.h.min(mk.h))).unwrap_or((mk.w * 3 / 4, mk.h * 3 / 4));
                    let (rel_x, rel_y) = centered_rel(&mk, w, h);
                    Placement { monitor: mk.clone(), rel_x, rel_y, w, h, maximized: true }
                }
            }
        } else {
            Placement { monitor: mk.clone(), rel_x: pos.x - mk.x, rel_y: pos.y - mk.y, w: size.width, h: size.height, maximized: false }
        };
        if prev.as_ref() == Some(&new) || (!force && !should_record(prev.as_ref(), &new, s.user_moved())) {
            return None;
        }
        let screen_changed = prev.as_ref().is_none_or(|p| !same_screen(&p.monitor, &new.monitor));
        s.memory.put(layout.clone(), new.clone());
        s.save_gen += 1;
        Some((new, s.save_gen, screen_changed))
    })
    .flatten();

    if let Some((p, gen, screen_changed)) = updated {
        if screen_changed {
            note(app, format!("[winpos] 记录位置（{reason}，组合 {layout}）：{}", describe_placement(&p)));
        }
        schedule_save(app, gen);
    }
}

fn schedule_save(app: &AppHandle, gen: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS)).await;
        let Some((memory, Some(path))) = with(&app, |s| (s.save_gen == gen).then(|| (s.memory.clone(), s.path.clone()))).flatten() else {
            return; // 期间又有新记录，交给最后那次写
        };
        let Ok(json) = serde_json::to_string(&memory) else { return };
        if let Err(e) = write_atomic(&path, &json) {
            log::warn!("[winpos] 保存窗口位置失败：{e}");
        }
    });
}

fn write_atomic(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

// ───────────────────────── 纠偏 ─────────────────────────

/// 按当前显示器组合的记录把窗口放回去。返回是否挪动。
fn correct(win: &MainWindow, reason: &str) -> bool {
    let app = win.app_handle();
    let keys = monitor_keys(win);
    if keys.is_empty() || with(app, |s| s.dragging).unwrap_or(false) {
        return false;
    }
    let layout = layout_key(&keys);
    let rec = with(app, |s| s.memory.get(&layout).cloned()).flatten();
    let current = current_key(win);
    let Ok(size) = win.outer_size() else { return false };
    // 没有记录时沿用当前的逻辑尺寸：物理像素按两块屏的缩放比换算，跨 DPI 才不会变大变小
    let ratio = win.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor()) / win.scale_factor().unwrap_or(1.0);
    let on_primary = ((size.width as f64 * ratio).round() as u32, (size.height as f64 * ratio).round() as u32);
    let actual = if win.is_maximized().unwrap_or(false) { None } else { win.outer_position().ok().map(|p| (p.x, p.y, size.width, size.height)) };
    let Plan::Move { target, rel_x, rel_y, size: (w, h), maximized } = plan(rec.as_ref(), &keys, primary_key(win).as_ref(), current.as_ref(), actual, on_primary) else {
        log::debug!("[winpos] 纠偏跳过（{reason}）：已在该在的屏上");
        return false;
    };

    let before = describe_window(win);
    let was_max = win.is_maximized().unwrap_or(false);
    if was_max {
        let _ = win.unmaximize();
    }
    let (w, h) = fit_work_area(win, &target, w, h);
    let (x, y) = place_in(&target, rel_x, rel_y, w, h);
    place_window(win, x, y, w, h, true);
    // 这个组合有记录就按记录来，没有记录时保持原来的最大化状态
    if if rec.is_some() { maximized } else { was_max } {
        let _ = win.maximize();
    }
    note(app, format!("[winpos] 纠偏（{reason}，组合 {layout}）：{} {} ({x},{y})；纠偏前 {before}", if rec.is_some() { "放回记录的屏" } else { "没有记录，放主屏" }, describe_mon(&target)));
    true
}

/// 延迟后回主线程纠偏（事件路径用）。
///
/// 🔴 事件回调里不内联改几何：窗口事件在 tao 的消息处理里同步派发，tao 在派发之后还可能再 `SetWindowPos`，
/// 内联挪动可能被覆盖。排队期间挡住系统还原出来的位置被 [`capture`] 记下。
fn schedule_correct(app: &AppHandle, delay_ms: u64, reason: &'static str) {
    with(app, |s| s.pending_correct += 1);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            with(&handle, |s| s.pending_correct = s.pending_correct.saturating_sub(1));
            let Some(win) = main_window(&handle) else { return };
            // 显示器断开时系统可能把窗口最小化，这不是用户的操作，恢复回来（不抢焦点）
            if reason == TOPOLOGY_REASON && win.is_minimized().unwrap_or(false) && with(&handle, |s| s.minimized_by_topology()).unwrap_or(false) {
                note(&handle, format!("[winpos] 屏幕变化时窗口被最小化，恢复：{}", describe_window(&win)));
                restore_without_focus(&win);
            }
            if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) {
                // 挪了的话随后的 Moved 会记下新位置；没挪就把当前位置补记一次
                if !correct(&win, reason) {
                    capture(&win, reason, false);
                }
                #[cfg(windows)]
                resync_webview_scale(&win);
            } else {
                note(&handle, format!("[winpos] {reason}：窗口未显示，{}（等唤回时再纠偏）", describe_window(&win)));
            }
        });
    });
}

/// 比对显示器签名；变了就记时间、打日志，并安排沉降后的检查。
fn check_topology(win: &MainWindow) {
    let keys = monitor_keys(win);
    if keys.is_empty() {
        return;
    }
    let sig = signature(&keys);
    let app = win.app_handle();
    let changed = with(app, |s| match &s.monitors_sig {
        Some(old) if *old == sig => false,
        None => {
            s.monitors_sig = Some(sig);
            false
        }
        Some(_) => {
            s.monitors_sig = Some(sig);
            s.topology_changed_at = Some(Instant::now());
            true
        }
    })
    .unwrap_or(false);
    if changed {
        note(app, format!("[winpos] 显示器拓扑变化：[{}]；窗口此刻 {}", describe_list(&keys, primary_key(win).as_ref()), describe_window(win)));
        // 窗口若可见且不在这个组合该在的屏上，搬回去（最小化 / 隐藏的等唤回时再纠）
        for delay in CORRECT_DELAYS_MS {
            schedule_correct(app, delay, TOPOLOGY_REASON);
        }
    }
}

// ───────────────────────── Windows 消息 ─────────────────────────

#[cfg(windows)]
fn restore_without_focus(win: &MainWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = win.hwnd() {
        unsafe { ShowWindow(hwnd.0 as HWND, SW_SHOWNOACTIVATE) };
    }
}

#[cfg(not(windows))]
fn restore_without_focus(win: &MainWindow) {
    let _ = win.unminimize();
}

/// 把 WebView 的渲染比例同步成窗口当前的真实缩放。
///
/// 显示器切换时窗口可能在缩放不同的屏之间被系统搬来搬去，WebView2 的比例会停在旧值
/// （实测窗口在 200% 的屏上，内容还按 150% 渲染，界面元素小了四分之一），重启才恢复。
#[cfg(windows)]
fn resync_webview_scale(win: &MainWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    let Ok(hwnd) = win.hwnd() else { return };
    // 用系统的实时值：tao 缓存的 scale_factor 在这种时候也可能是旧的
    let dpi = unsafe { GetDpiForWindow(hwnd.0 as HWND) };
    if dpi == 0 {
        return;
    }
    let scale = dpi as f64 / 96.0;
    let app = win.app_handle().clone();
    for_each_webview(win, move |webview| apply_webview_scale(&app, webview, scale));
}

/// 🔴 这里按 COM 虚表直接调用，不依赖 webview2-com：它的版本跟着 wry 走，
/// 这里再固定一个版本的话类型对不上，编译不过。COM 接口的 ID 和方法顺序是固定不变的 ABI。
/// 槽位按 ICoreWebView2Controller3 数：IUnknown 0..=2，Controller 3..=25，Controller2 26..=27，
/// Controller3 从 28 开始（get_RasterizationScale 28、put 29、put_ShouldDetectMonitorScaleChanges 31）。
#[cfg(windows)]
fn apply_webview_scale(app: &AppHandle, webview: tauri::webview::PlatformWebview, scale: f64) {
    use std::ffi::c_void;
    use std::mem::{size_of, size_of_val, transmute, transmute_copy};
    use windows_sys::core::{GUID, HRESULT};

    const IID_CONTROLLER3: GUID = GUID::from_u128(0xf9614724_5d2b_41dc_aef7_73d62b51543b);
    type QueryInterface = unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT;
    type Release = unsafe extern "system" fn(*mut c_void) -> u32;
    type GetScale = unsafe extern "system" fn(*mut c_void, *mut f64) -> HRESULT;
    type PutScale = unsafe extern "system" fn(*mut c_void, f64) -> HRESULT;
    type PutDetect = unsafe extern "system" fn(*mut c_void, i32) -> HRESULT;

    let controller = webview.controller();
    if size_of_val(&controller) != size_of::<*mut c_void>() {
        return;
    }
    unsafe {
        // 只借用指针，引用计数仍归 controller 管；QueryInterface 拿到的 c3 要自己 Release
        let raw: *mut c_void = transmute_copy(&controller);
        let vtbl = |p: *mut c_void| *(p as *const *const *const c_void);
        let query: QueryInterface = transmute(*vtbl(raw).add(0));
        let mut c3: *mut c_void = std::ptr::null_mut();
        if query(raw, &IID_CONTROLLER3, &mut c3) < 0 || c3.is_null() {
            return;
        }
        let get: GetScale = transmute(*vtbl(c3).add(28));
        let mut current = 0f64;
        if get(c3, &mut current) >= 0 && (current - scale).abs() >= 0.001 {
            note(app, format!("[winpos] WebView 缩放停在 {current}，同步成窗口实际的 {scale}"));
            let put: PutScale = transmute(*vtbl(c3).add(29));
            put(c3, scale);
            // 设比例会关掉自动检测，要重新打开，否则之后拖到别的屏就不跟了
            let detect: PutDetect = transmute(*vtbl(c3).add(31));
            detect(c3, 1);
        }
        let release: Release = transmute(*vtbl(c3).add(2));
        release(c3);
    }
}

#[cfg(windows)]
fn for_each_webview(win: &MainWindow, f: impl Fn(tauri::webview::PlatformWebview) + Clone + Send + 'static) {
    let _ = win.with_webview(f);
}

/// 收到 WM_DISPLAYCHANGE：窗口没动时不会有窗口事件，靠这个才知道屏幕变了。
#[cfg(windows)]
fn display_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(win) = main_window(&handle) {
                check_topology(&win);
            }
        });
    });
}

#[cfg(windows)]
fn set_dragging(app: &AppHandle, dragging: bool) {
    with(app, |s| {
        s.dragging = dragging;
        if !dragging {
            s.drag_ended_at = Some(Instant::now());
        }
    });
}

#[cfg(windows)]
mod hook {
    use std::sync::OnceLock;

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_DISPLAYCHANGE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE};

    /// 子类按「proc 指针 + id」区分，和应用自己的子类（键盘守卫等）互不影响。
    const SUBCLASS_ID: usize = 0x574D_454D;
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// 🔴 必须在窗口所属线程（主线程）调用：`SetWindowSubclass` 不支持跨线程。
    pub fn install(app: &AppHandle, win: &super::MainWindow) {
        let _ = APP.set(app.clone());
        match win.hwnd() {
            Ok(hwnd) => unsafe {
                if SetWindowSubclass(hwnd.0 as HWND, Some(proc), SUBCLASS_ID, 0) == 0 {
                    log::warn!("[winpos] 挂窗口消息钩子失败，退回按时间判断");
                }
            },
            Err(e) => log::warn!("[winpos] 取窗口句柄失败：{e}"),
        }
    }

    /// 只记状态、不调窗口方法：这里跑在窗口过程里，见 glue 文件头的锁规则。
    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if let Some(app) = APP.get() {
            match msg {
                WM_ENTERSIZEMOVE => super::set_dragging(app, true),
                WM_EXITSIZEMOVE => super::set_dragging(app, false),
                WM_DISPLAYCHANGE => super::display_changed(app),
                _ => {}
            }
        }
        DefSubclassProc(hwnd, msg, w, l)
    }
}

// ───────────────────────── 对外入口 ─────────────────────────

/// 在 `setup` 里、主窗口首次 show 之前调用：载入记录并摆回当前组合的位置。
///
/// `will_show = false`（自启收托盘）时只摆位置不最大化，等托盘唤回。
///
/// 返回是否按记录摆了窗口；`false`（这个组合第一次见到）时调用方可以走自己的默认几何，比如默认最大化。
pub fn init(app: &AppHandle, will_show: bool, options: Options) -> bool {
    app.manage(WindowMemory::default());
    let dir = options.dir.clone().or_else(|| app.path().app_config_dir().ok());
    let path = dir.as_ref().map(|d| d.join(STORE_FILENAME));
    let mut memory: Memory = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let label = options.label.clone();
    let min_size = app.config().app.windows.iter().find(|c| c.label == label).and_then(|c| Some((c.min_width?, c.min_height?)));
    with(app, |s| {
        s.label = label.clone();
        s.diag = options.diag;
        s.path = path;
        s.min_size = min_size;
    });
    let Some(win) = lookup(app, &label) else { return false };

    let keys = monitor_keys(&win);
    let layout = layout_key(&keys);
    let primary = primary_key(&win);
    let mut seeded = false;
    if memory.is_empty() {
        let legacy = options.legacy.or_else(|| dir.and_then(|d| std::fs::read_to_string(d.join(LEGACY_FILENAME)).ok()));
        if let Some(old) = legacy.and_then(|j| serde_json::from_str::<Placement>(&j).ok()) {
            if legacy_usable(&old, &keys, primary.as_ref()) {
                memory.put(layout.clone(), old);
                seeded = true;
            }
        }
    }
    let saved = memory.get(&layout).cloned();
    let minimized = win.is_minimized().unwrap_or(false);
    let gen = with(app, |s| {
        s.monitors_sig = Some(signature(&keys));
        s.was_minimized = minimized;
        s.memory = memory;
        s.save_gen += 1;
        s.save_gen
    });
    // 打底的记录马上落盘：否则先合盖写下别的组合后，文件不再为空，这份就再也补不回来了
    if let (true, Some(gen)) = (seeded, gen) {
        schedule_save(app, gen);
    }
    #[cfg(windows)]
    hook::install(app, &win);
    note(app, format!("[winpos] 启动：显示器 [{}]；组合 {layout} 的记录：{}；窗口初始 {}", describe_list(&keys, primary.as_ref()), saved.as_ref().map(describe_placement).unwrap_or_else(|| "无".into()), describe_window(&win)));

    // 没有记录：沿用配置的 center，窗口在主屏居中
    let Some(saved) = saved else { return false };
    let Some(target) = find_target(&saved.monitor, &keys).cloned() else { return false };
    let (w, h) = fit_work_area(&win, &target, saved.w, saved.h);
    let (x, y) = place_in(&target, saved.rel_x, saved.rel_y, w, h);
    place_window(&win, x, y, w, h, true);
    if saved.maximized && will_show {
        let _ = win.maximize();
    }
    note(app, format!("[winpos] 启动：放回 {} ({x},{y}) {w}x{h}{}", describe_mon(&target), if saved.maximized && will_show { " 最大化" } else { "" }));
    true
}

/// 主窗口首次显示后补记一次（这个组合没有记录时，这就是第一条）。
pub fn capture_now(app: &AppHandle, reason: &str) {
    if let Some(win) = main_window(app) {
        capture(&win, reason, false);
    }
}

/// 唤回前只纠偏、不显示，给需要自己决定怎么抢前台的调用方。
pub fn correct_before_show(app: &AppHandle, source: &str) {
    let Some(win) = main_window(app) else { return };
    note(app, format!("[winpos] 唤回主窗口（{source}）：{}", describe_window(&win)));
    if !win.is_minimized().unwrap_or(false) {
        // 隐藏（收托盘）或本就可见：先摆好位置再 show，无跳动。
        // 最小化的窗口此刻坐标是 (-32000,-32000)，判不出在哪块屏 —— 交给 unminimize 触发的「最小化 → 恢复」事件分支去纠。
        correct(&win, source);
        #[cfg(windows)]
        resync_webview_scale(&win);
    }
}

/// 唤回主窗口的统一入口（托盘 / 双开唤回 / Dock 图标）：纠偏 + 还原 + 显示 + 抢焦点。
pub fn show_main(app: &AppHandle, source: &str) {
    correct_before_show(app, source);
    let Some(win) = main_window(app) else { return };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 主窗口的窗口事件（`on_window_event` 里、按 label 过滤之后调用）。
pub fn on_window_event(app: &AppHandle, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
        return;
    }
    let Some(win) = main_window(app) else { return };
    check_topology(&win);

    let minimized = win.is_minimized().unwrap_or(false);
    let visible = win.is_visible().unwrap_or(false);
    let was_minimized = with(app, |s| {
        if minimized && !s.was_minimized {
            s.minimized_at = Some(Instant::now());
        }
        std::mem::replace(&mut s.was_minimized, minimized)
    })
    .unwrap_or(minimized);
    if was_minimized && !minimized {
        note(app, format!("[winpos] 从最小化恢复：{}", describe_window(&win)));
        schedule_correct(app, EVENT_CORRECT_DELAY_MS, "最小化恢复");
        return;
    }
    if visible && !minimized {
        capture(&win, "窗口移动/缩放", false);
    }
}
