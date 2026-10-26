//! 主窗口「所在显示器」记忆与纠偏（仅桌面端）—— 解决「本来在主屏，插拔副屏 / 收起后再唤回却跑到了副屏」。
//!
//! ## 问题
//!
//! 唤回主窗口（托盘 / 任务栏 / 双开 / 快捷键 / 提醒）原先只做 `unminimize + show + set_focus`，
//! 窗口回到哪块屏完全交给 Windows。Windows 记的是虚拟桌面的**绝对坐标**，显示器拓扑一变（插拔副屏、
//! 换主屏、Win+P 切模式、Win11「根据显示器连接记住窗口位置」）就可能在用户不知情时把窗口挪走 ——
//! 尤其窗口最小化 / 收在托盘时用户看不到这次搬家，下次唤回才发现「怎么跑到副屏了」。
//! window-state 插件同样存绝对坐标，换了主屏后冷启动也会落到别的屏。
//!
//! ## 做法
//!
//! 1. **只记用户态位置**：窗口可见、非最小化、不在「拓扑刚变化」的沉降期、也没有待做的纠偏时，记下
//!    「所在显示器 + 相对该显示器左上角的偏移 + 是否最大化」。系统趁窗口收起时挪它、拓扑变化瞬间的
//!    搬家，都不会被记进来。
//! 2. **按显示器记，不按绝对坐标**：换主屏后虚拟桌面原点会变，记「相对哪块屏的偏移」才能放回同一块
//!    物理屏的同一位置。认屏顺序：名字 + 尺寸 → 位置 + 尺寸 → 仅名字（Windows 的 `\\.\DISPLAYn`
//!    重新插拔后可能换号，所以不能只认名字）。
//! 3. **唤回时纠偏**：当前所在屏 ≠ 记录的屏 → 记录的屏还在就放回去；已经拔掉了 → 主屏居中。
//!    - 走 [`show_main`] 的入口（托盘 / 双开 / 快捷键 / 提醒 / 推送弹窗…）：窗口若是隐藏态，在 `show()`
//!      之前摆好位置，无跳动。
//!    - 任务栏还原不经过我们的代码，只能在「最小化 → 恢复」事件后纠（可能闪一下）。
//!    - 窗口可见时遇到拓扑变化：沉降期过后检查一次，被系统搬走就搬回来。
//!    - 冷启动：window-state 插件还原之后、`fit_into_work_area` 之前纠一次（见 [`init`]）。
//! 4. **只管位置，不碰尺寸**：尺寸由 `commands/window.rs` 的逻辑尺寸基准负责（跨 DPI 自愈）。
//!    挪到不同缩放的屏时系统会发 `ScaleFactorChanged`，由那套机制按基准重算尺寸并 clamp 进工作区。
//! 5. **持久化**到 `app_config_dir` 下的独立 json（dev / prod 分开，理由同 `window_state_filename`）。
//!
//! 诊断日志统一带 `[winpos]` 前缀：关键节点 info 级；拖动中的普通 Moved / 记录更新是 debug 级。
//!
//! 🔴 锁规则：**持锁期间绝不调用任何窗口方法** —— `set_position` / `unminimize` 会同步派发
//! WM_MOVE / WM_SIZE，事件回调重入本模块再拿锁就死锁了。所有读写都走 [`with`]，闭包里只碰数据。
//!
//! 🔴 事件回调里**不内联**改几何：Tauri 的窗口事件在 tao 的消息处理里同步派发，tao 在派发之后
//! 还可能再 `SetWindowPos`（详见 `commands/window.rs` 的 `RECONCILE_DELAY_MS` 注释），内联挪动
//! 可能被覆盖。事件路径的纠偏一律延迟后回主线程做（[`schedule_correct`]）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{window::Monitor, AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

const MAIN_LABEL: &str = "main";
/// 拓扑变化后多久内的移动不算「用户态」（系统还在搬窗口）。
const TOPOLOGY_SETTLE_MS: u64 = 1500;
/// 记录写盘的防抖。
const SAVE_DEBOUNCE_MS: u64 = 800;
/// 「最小化 → 恢复」后延迟多久纠偏（等 tao / 系统把这轮还原的几何下发完）。
const EVENT_CORRECT_DELAY_MS: u64 = 120;
/// 本模块自己 set_position 之后多久内的 Moved 视为「自己挪的」（只影响日志措辞）。
const OWN_MOVE_MS: u64 = 500;
/// Windows 10/11 窗口外框有约 7px 的隐形边框，贴边 / 吸附时 outer_position 会略微为负，钳制时留点余量。
const EDGE_SLACK: i32 = 16;

/// 一块显示器的身份（名字 + 物理像素矩形）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonitorKey {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl MonitorKey {
    fn of(m: &Monitor) -> Self {
        let p = m.position();
        let s = m.size();
        Self { name: m.name().cloned(), x: p.x, y: p.y, w: s.width, h: s.height }
    }
}

/// 用户态窗口位置：所在屏 + 相对该屏左上角的偏移（物理像素）。尺寸只用于日志 / 居中计算。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Placement {
    pub monitor: MonitorKey,
    pub rel_x: i32,
    pub rel_y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

#[derive(Default)]
struct Inner {
    /// 最后一次用户态位置。
    last: Option<Placement>,
    /// 上一次事件时窗口是否最小化 —— 用来识别「最小化 / 恢复」的切换。
    was_minimized: bool,
    /// 有一次纠偏排着还没做：期间的位置都是系统还原出来的，不能记成用户态。
    pending_correct: bool,
    /// 显示器拓扑签名，变了 = 插拔 / 换主屏 / 改分辨率。
    monitors_sig: Option<String>,
    topology_changed_at: Option<Instant>,
    own_move_until: Option<Instant>,
    save_gen: u64,
}

impl Inner {
    fn settling(&self) -> bool {
        self.topology_changed_at
            .is_some_and(|t| t.elapsed() < Duration::from_millis(TOPOLOGY_SETTLE_MS))
    }
}

/// 托管状态，在 [`init`] 里 `manage`。
#[derive(Default)]
pub struct MainWindowPlacement {
    inner: Mutex<Inner>,
}

/// 唯一的取锁入口；闭包里只许碰数据，不许调窗口方法（见文件头锁规则）。
fn with<T>(app: &AppHandle, f: impl FnOnce(&mut Inner) -> T) -> Option<T> {
    let st = app.try_state::<MainWindowPlacement>()?;
    let mut g = st.inner.lock().unwrap_or_else(|e| e.into_inner());
    Some(f(&mut g))
}

// ───────────────────────── 纯函数（可测） ─────────────────────────

/// 在当前显示器列表里找回记录的那块屏。
fn find_target<'a>(saved: &MonitorKey, list: &'a [MonitorKey]) -> Option<&'a MonitorKey> {
    let named = |m: &&MonitorKey| m.name.is_some() && m.name == saved.name;
    list.iter()
        .find(|m| named(m) && m.w == saved.w && m.h == saved.h)
        .or_else(|| list.iter().find(|m| m.x == saved.x && m.y == saved.y && m.w == saved.w && m.h == saved.h))
        .or_else(|| list.iter().find(named))
}

/// 把「相对偏移 + 尺寸」放进某块屏，钳制在屏内（窗口比屏大就贴左上）。
fn place_in(mon: &MonitorKey, rel_x: i32, rel_y: i32, w: u32, h: u32) -> (i32, i32) {
    let clamp = |rel: i32, win: i32, scr: i32| {
        if win >= scr {
            0
        } else {
            rel.clamp(-EDGE_SLACK, scr - win + EDGE_SLACK)
        }
    };
    (
        mon.x + clamp(rel_x, w as i32, mon.w as i32),
        mon.y + clamp(rel_y, h as i32, mon.h as i32),
    )
}

/// 屏内居中的相对偏移。
fn centered_rel(mon: &MonitorKey, w: u32, h: u32) -> (i32, i32) {
    ((mon.w as i32 - w as i32).max(0) / 2, (mon.h as i32 - h as i32).max(0) / 2)
}

fn signature(list: &[MonitorKey]) -> String {
    let mut v: Vec<String> = list
        .iter()
        .map(|m| format!("{}@{},{},{}x{}", m.name.as_deref().unwrap_or("?"), m.x, m.y, m.w, m.h))
        .collect();
    v.sort();
    v.join("|")
}

fn describe_mon(m: &MonitorKey) -> String {
    format!("{}@({},{}) {}x{}", m.name.as_deref().unwrap_or("?"), m.x, m.y, m.w, m.h)
}

fn describe_list(list: &[MonitorKey], primary: Option<&MonitorKey>) -> String {
    list.iter()
        .map(|m| {
            let tag = if Some(m) == primary { "[主]" } else { "" };
            format!("{tag}{}", describe_mon(m))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_placement(p: &Placement) -> String {
    format!(
        "屏 {} 偏移({},{}) {}x{}{}",
        describe_mon(&p.monitor),
        p.rel_x,
        p.rel_y,
        p.w,
        p.h,
        if p.maximized { " 最大化" } else { "" }
    )
}

// ───────────────────────── 读窗口 ─────────────────────────

fn monitor_keys(win: &WebviewWindow) -> Vec<MonitorKey> {
    win.available_monitors().map(|v| v.iter().map(MonitorKey::of).collect()).unwrap_or_default()
}

fn primary_key(win: &WebviewWindow) -> Option<MonitorKey> {
    win.primary_monitor().ok().flatten().map(|m| MonitorKey::of(&m))
}

fn current_key(win: &WebviewWindow) -> Option<MonitorKey> {
    win.current_monitor().ok().flatten().map(|m| MonitorKey::of(&m))
}

fn describe_window(win: &WebviewWindow) -> String {
    let pos = win.outer_position().map(|p| format!("({},{})", p.x, p.y)).unwrap_or_else(|_| "?".into());
    let size = win.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|_| "?".into());
    let mon = current_key(win).map(|m| describe_mon(&m)).unwrap_or_else(|| "无".into());
    format!(
        "pos={pos} size={size} 屏={mon} visible={} min={} max={}",
        win.is_visible().unwrap_or(false),
        win.is_minimized().unwrap_or(false),
        win.is_maximized().unwrap_or(false)
    )
}

// ───────────────────────── 持久化 ─────────────────────────

/// 存档文件名（相对 `app_config_dir`）。dev / prod 分开，理由同 `lib.rs` 的 `window_state_filename`：
/// 两者落同一个目录，共用一份的话开着 dev 拖窗口会把正式版记住的屏冲掉。
fn store_filename() -> &'static str {
    if cfg!(debug_assertions) {
        ".window-monitor-dev.json"
    } else {
        ".window-monitor.json"
    }
}

fn store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(store_filename()))
}

/// 读存档。不存在 / 损坏一律当「没有记录」—— 退化成和以前一样，不影响任何功能。
fn load_from_disk(app: &AppHandle) -> Option<Placement> {
    let raw = std::fs::read_to_string(store_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn schedule_save(app: &AppHandle, gen: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS)).await;
        let Some(p) = with(&app, |s| if s.save_gen == gen { s.last.clone() } else { None }).flatten() else {
            return; // 期间又有新记录，交给最后那次写
        };
        let Some(path) = store_path(&app) else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string(&p) {
            Ok(body) => {
                if let Err(e) = std::fs::write(&path, body) {
                    log::warn!("[winpos] 保存窗口所在屏失败（下次启动沿用插件还原的位置）: {e}");
                }
            }
            Err(e) => log::warn!("[winpos] 序列化窗口所在屏失败: {e}"),
        }
    });
}

// ───────────────────────── 记录 ─────────────────────────

/// 记下当前位置（仅当它是用户态位置时）。
fn capture(win: &WebviewWindow, reason: &str) {
    if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return;
    }
    let Some(mk) = current_key(win) else { return };
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    let maximized = win.is_maximized().unwrap_or(false);
    let app = win.app_handle();

    let updated = with(app, |s| {
        // 恢复事件还没处理（Moved 先于 Resized 到达）/ 纠偏排着没做 / 系统还在搬窗口 → 都不是用户态
        if s.was_minimized || s.pending_correct || s.settling() {
            return None;
        }
        let new = if maximized {
            // 最大化时外框是整屏，不能当「正常位置」：同屏就保留上次的正常偏移，只翻标志
            match &s.last {
                Some(p) if p.monitor == mk => Placement { maximized: true, ..p.clone() },
                prev => {
                    let (w, h) = prev
                        .as_ref()
                        .map(|p| (p.w.min(mk.w), p.h.min(mk.h)))
                        .unwrap_or((mk.w * 3 / 4, mk.h * 3 / 4));
                    let (rel_x, rel_y) = centered_rel(&mk, w, h);
                    Placement { monitor: mk.clone(), rel_x, rel_y, w, h, maximized: true }
                }
            }
        } else {
            Placement {
                monitor: mk.clone(),
                rel_x: pos.x - mk.x,
                rel_y: pos.y - mk.y,
                w: size.width,
                h: size.height,
                maximized: false,
            }
        };
        if s.last.as_ref() == Some(&new) {
            return None;
        }
        let monitor_changed = s.last.as_ref().is_none_or(|p| p.monitor != new.monitor);
        s.last = Some(new.clone());
        s.save_gen += 1;
        Some((new, s.save_gen, monitor_changed))
    })
    .flatten();

    if let Some((p, gen, monitor_changed)) = updated {
        if monitor_changed {
            log::info!("[winpos] 记录用户态位置（{reason}，换了屏）：{}", describe_placement(&p));
        } else {
            log::debug!("[winpos] 记录用户态位置（{reason}）：{}", describe_placement(&p));
        }
        schedule_save(app, gen);
    }
}

// ───────────────────────── 纠偏 ─────────────────────────

/// 窗口不在记录的屏上就挪回去；记录的屏没了就放主屏居中。返回是否挪动。只动位置，不动尺寸。
fn correct(win: &WebviewWindow, reason: &str) -> bool {
    let app = win.app_handle();
    let Some(saved) = with(app, |s| s.last.clone()).flatten() else {
        log::debug!("[winpos] 纠偏跳过（{reason}）：还没有用户态位置记录");
        return false;
    };
    let keys = monitor_keys(win);
    if keys.is_empty() {
        return false;
    }
    let (target, fallback) = match find_target(&saved.monitor, &keys) {
        Some(t) => (t.clone(), false),
        None => match primary_key(win) {
            Some(p) => (p, true),
            None => return false,
        },
    };
    if current_key(win).as_ref() == Some(&target) {
        log::debug!("[winpos] 纠偏跳过（{reason}）：已在目标屏 {}", describe_mon(&target));
        return false;
    }

    let before = describe_window(win);
    let was_max = win.is_maximized().unwrap_or(false);
    if was_max {
        let _ = win.unmaximize();
    }
    let Ok(size) = win.outer_size() else { return false };
    let (rel_x, rel_y) = if fallback {
        centered_rel(&target, size.width, size.height)
    } else {
        (saved.rel_x, saved.rel_y)
    };
    let (x, y) = place_in(&target, rel_x, rel_y, size.width, size.height);
    with(app, |s| s.own_move_until = Some(Instant::now() + Duration::from_millis(OWN_MOVE_MS)));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    if was_max {
        let _ = win.maximize();
    }
    log::info!(
        "[winpos] 纠偏（{reason}）：{} → {} ({x},{y})；纠偏前 {before}",
        if fallback { "记录的屏已不在，退回主屏居中" } else { "放回记录的屏" },
        describe_mon(&target),
    );
    true
}

/// 延迟后回主线程纠偏（事件路径用，见文件头「不内联改几何」）。
/// 排队期间置 `pending_correct`，挡住系统还原出来的位置被 [`capture`] 记成用户态。
fn schedule_correct(app: &AppHandle, delay_ms: u64, reason: &'static str) {
    with(app, |s| s.pending_correct = true);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            with(&handle, |s| s.pending_correct = false);
            let Some(win) = handle.get_webview_window(MAIN_LABEL) else { return };
            if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) {
                // 挪了的话随后的 Moved 会记下新位置；没挪就把当前位置补记一次
                if !correct(&win, reason) {
                    capture(&win, reason);
                }
            } else {
                log::info!("[winpos] {reason}：窗口未显示，{}（等唤回时再纠偏）", describe_window(&win));
            }
        });
    });
}

// ───────────────────────── 拓扑变化 ─────────────────────────

/// 比对显示器签名；变了就记时间、打日志，并安排沉降后的检查。
fn check_topology(win: &WebviewWindow) {
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
        log::info!(
            "[winpos] 显示器拓扑变化：[{}]；窗口此刻 {}",
            describe_list(&keys, primary_key(win).as_ref()),
            describe_window(win)
        );
        // 沉降后：窗口若可见且被系统搬离了记录的屏，搬回去（最小化 / 隐藏的等唤回时再纠）
        schedule_correct(app, TOPOLOGY_SETTLE_MS + 200, "显示器变化沉降后");
    }
}

// ───────────────────────── 对外入口 ─────────────────────────

/// 在 `setup` 里、window-state 插件还原之后、`fit_into_work_area` 与首次 `show()` 之前调用：
/// 托管状态 + 载入上次所在屏，窗口不在那块屏上就挪过去（插件存的是绝对坐标，换了主屏会错位）。
pub fn init(win: &WebviewWindow) {
    let app = win.app_handle();
    app.manage(MainWindowPlacement::default());

    let keys = monitor_keys(win);
    let saved = load_from_disk(app);
    let minimized = win.is_minimized().unwrap_or(false);
    with(app, |s| {
        s.monitors_sig = Some(signature(&keys));
        s.was_minimized = minimized;
        s.last = saved.clone();
    });
    log::info!(
        "[winpos] 启动：显示器 [{}]；上次所在屏：{}；插件还原后 {}",
        describe_list(&keys, primary_key(win).as_ref()),
        saved.as_ref().map(describe_placement).unwrap_or_else(|| "无记录".into()),
        describe_window(win)
    );
    if saved.is_some() {
        correct(win, "启动");
    }
}

/// 主窗口首次显示后补记一次（没有历史记录时，这就是第一条用户态位置）。
pub fn capture_now(app: &AppHandle, reason: &str) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        capture(&win, reason);
    }
}

/// 唤回主窗口的统一入口：纠偏 + 还原 + 显示 + 抢焦点。
///
/// 可以在任意线程调（窗口方法由 Tauri 转发到主线程），`source` 只用于日志。
pub fn show_main(app: &AppHandle, source: &str) {
    let Some(win) = app.get_webview_window(MAIN_LABEL) else { return };
    let minimized = win.is_minimized().unwrap_or(false);
    log::info!("[winpos] 唤回主窗口（{source}）：{}", describe_window(&win));
    if !minimized {
        // 隐藏（收托盘）或本就可见：先摆好位置再 show，无跳动。
        // 最小化的窗口此刻坐标是 (-32000,-32000)，判不出在哪块屏 —— 交给 unminimize 触发的
        // 「最小化 → 恢复」事件分支去纠（见 on_main_window_event）。
        correct(&win, source);
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 主窗口的窗口事件（lib.rs `on_window_event` 里、label 过滤之后调用）。
pub fn on_main_window_event(app: &AppHandle, event: &WindowEvent) {
    if !matches!(
        event,
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
    ) {
        return;
    }
    let Some(win) = app.get_webview_window(MAIN_LABEL) else { return };
    check_topology(&win);

    let minimized = win.is_minimized().unwrap_or(false);
    let visible = win.is_visible().unwrap_or(false);
    let was_minimized = with(app, |s| std::mem::replace(&mut s.was_minimized, minimized)).unwrap_or(minimized);

    match (was_minimized, minimized) {
        (false, true) => {
            let last = with(app, |s| s.last.clone()).flatten();
            log::info!(
                "[winpos] 最小化；最后用户态位置：{}",
                last.as_ref().map(describe_placement).unwrap_or_else(|| "无记录".into())
            );
        }
        (true, false) => {
            log::info!("[winpos] 从最小化恢复（任务栏 / 托盘 / 系统还原）：{}", describe_window(&win));
            schedule_correct(app, EVENT_CORRECT_DELAY_MS, "最小化恢复");
            return;
        }
        _ => {}
    }

    if let WindowEvent::Moved(p) = event {
        if minimized || !visible {
            // 最小化瞬间的 (-32000,-32000) 是系统占位坐标，不是搬家
            if p.x > -30000 && p.y > -30000 {
                let own = with(app, |s| s.own_move_until.is_some_and(|t| Instant::now() < t)).unwrap_or(false);
                log::info!(
                    "[winpos] 窗口在{}期间被移动到 ({},{})（{}）；屏={}",
                    if minimized { "最小化" } else { "隐藏" },
                    p.x,
                    p.y,
                    if own { "本模块摆位" } else { "非用户操作，多半是系统在搬" },
                    current_key(&win).map(|m| describe_mon(&m)).unwrap_or_else(|| "无".into())
                );
            }
            return;
        }
        log::debug!("[winpos] Moved ({},{})", p.x, p.y);
    }
    if visible && !minimized {
        capture(&win, "窗口移动/缩放");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(name: &str, x: i32, y: i32, w: u32, h: u32) -> MonitorKey {
        MonitorKey { name: Some(name.into()), x, y, w, h }
    }

    #[test]
    fn find_target_prefers_name_and_size() {
        let saved = mk("D1", 0, 0, 1920, 1080);
        // 换主屏后 D1 的原点变了，但名字 + 尺寸仍能认回来
        let list = [mk("D2", 0, 0, 2560, 1440), mk("D1", -1920, 0, 1920, 1080)];
        assert_eq!(find_target(&saved, &list), Some(&list[1]));
    }

    #[test]
    fn find_target_falls_back_to_rect_when_renamed() {
        let saved = mk("D2", 1920, 0, 2560, 1440);
        let list = [mk("D1", 0, 0, 1920, 1080), mk("D3", 1920, 0, 2560, 1440)];
        assert_eq!(find_target(&saved, &list), Some(&list[1]));
    }

    #[test]
    fn find_target_none_when_monitor_gone() {
        let saved = mk("D2", 1920, 0, 2560, 1440);
        let list = [mk("D1", 0, 0, 1920, 1080)];
        assert_eq!(find_target(&saved, &list), None);
    }

    #[test]
    fn place_in_keeps_relative_offset_and_clamps() {
        let m = mk("D1", -1920, 0, 1920, 1080);
        assert_eq!(place_in(&m, 100, 50, 1440, 900), (-1820, 50));
        // 偏移超出 → 钳回屏内（留隐形边框余量）
        assert_eq!(place_in(&m, 5000, 5000, 1440, 900), (-1920 + 480 + EDGE_SLACK, 180 + EDGE_SLACK));
        // 窗口比屏大 → 贴左上
        assert_eq!(place_in(&m, 100, 100, 3000, 2000), (-1920, 0));
    }

    #[test]
    fn signature_is_order_independent() {
        let a = [mk("D1", 0, 0, 1920, 1080), mk("D2", 1920, 0, 2560, 1440)];
        let b = [a[1].clone(), a[0].clone()];
        assert_eq!(signature(&a), signature(&b));
    }

    #[test]
    fn placement_roundtrips_through_json() {
        let p = Placement { monitor: mk("D1", 0, 0, 1920, 1080), rel_x: 10, rel_y: 20, w: 800, h: 600, maximized: true };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Placement>(&s).unwrap(), p);
    }
}
