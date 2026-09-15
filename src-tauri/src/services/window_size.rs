//! 主窗口默认尺寸的计算规则。
//!
//! 抽成纯函数的原因有三：
//!   1. setup（首次启动）和 `reset_window_size` Command（用户点"恢复默认大小"）
//!      必须算出**完全一样**的结果，公式散两处迟早漂移；
//!   2. 公式里有 floor / cap / 屏幕占比三重夹取，边界容易写反，值得单测锁住；
//!   3. 不依赖 tauri 类型，测试不用起 App。
//!
//! ⚠️ floor 必须与 `tauri.conf.json` 的 width/height 保持一致 —— 曾经 floor=1330
//! 而 conf=1388，1080p 上算出 1344 被 floor 兜住但没到 conf 值，改 conf 完全不生效。

/// conf.json 的默认宽度，同时作为"永不更小"的下限。
///
/// 这个值由编辑器工具栏定：按钮全量显示、放不下就 `flex-wrap` 换行，窗口宽直接决定 2 行还是 3 行。
/// 每行可用宽 ≈ 窗口宽 − 609（左侧导航栏 + 笔记面板 + 大纲面板 + 工具栏 12px 内边距 ×2）。
///
/// 1500 → 1524 的依据（实测截图量得，单位逻辑像素，窗口 1500 宽 / DPR 1.5）：
/// 工具栏内容区 339.6..1230.4（宽 890.8），第 2 行末按钮右缘 ≈1211.4 —— **行尾只剩 19px**，
/// 而被挤到第 3 行的「查找替换」按钮要 28（`min-width`）+ 3（`column-gap`）= 31px，缺口 ≈12px。
/// 取 +24 而非刚好 +12：像素测量有 ±3px 误差，且 +24 时第 1 行也多出 44px 余量、会把第 2 行
/// 首个按钮吸上去，第 2 行行尾进一步松开，两条路径都稳。
///
/// ⚠️ 往工具栏加按钮前先回来算一遍这笔账，否则又会掉回 3 行。
pub const DEFAULT_WIDTH: f64 = 1524.0;
/// conf.json 的默认高度，同时作为"永不更小"的下限
pub const DEFAULT_HEIGHT: f64 = 830.0;

/// 一块**物理**像素矩形（工作区 / 窗口外框都用它表示）。
///
/// 只用于 [`fit_into_work_area`] 的入参出参，刻意不依赖 tauri 类型，方便单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 把「想要的窗口外框」塞进目标屏的工作区（扣掉任务栏），全部是**物理**像素。
///
/// 这是窗口几何的**最后一道保险**：出口保证「尺寸 ≤ 工作区」且「窗口完整落在工作区内」，
/// 所以不可能再出现「窗口比屏幕还大」或「标题栏跑到屏幕外拖不回来」。
///
/// 🔴 为什么必须有它：`tauri-plugin-window-state` 存的是**物理**尺寸，还原时也按物理下发
/// （插件 `lib.rs:212-217`），且**不做任何 clamp**；位置只用「四角是否与某块屏相交」判定
/// （插件 `:189-217`、`:528-548`），判定还用的是 `monitor.size()` 而不是工作区。更要命的是
/// 尺寸那段在相交判定的 `for` 循环**之外**无条件执行 —— 于是「位置不还原、尺寸照样套」：
/// 在 200% 副屏调好的窗口（物理 2820×1720）拔掉副屏后，位置因不相交而不还原，尺寸却原样
/// 打到 150% 主屏（物理 2560×1600）上，窗口直接比屏幕还大。本函数就是收掉这一刀。
///
/// `want_pos` 为 `None` 时在工作区内居中（首次启动 / 「恢复默认大小」走这条）。
///
/// ⚠️ 仍有一处兜不住：工作区比 `tauri.conf.json` 的 minWidth/minHeight 还小时（超小屏 /
/// 竖排任务栏占掉大半），tao 会把 `set_size` 顶回最小尺寸，窗口仍会略微超出工作区。
/// 这属于「屏幕本来就装不下」，不是本函数的锅。
pub fn fit_into_work_area(work: Rect, want_pos: Option<(i32, i32)>, want_w: u32, want_h: u32) -> Rect {
    // 虚拟显示器 / 远程桌面可能把工作区报成 0；再兜一层 max(1) 防止下面的 u32 减法下溢
    let avail_w = work.width.max(1);
    let avail_h = work.height.max(1);

    let width = want_w.clamp(1, avail_w);
    let height = want_h.clamp(1, avail_h);

    // clamp 的上下界必定满足 min ≤ max（width ≤ avail_w 已由上一步保证）
    let (x, y) = match want_pos {
        Some((px, py)) => (
            px.clamp(work.x, work.x + (avail_w - width) as i32),
            py.clamp(work.y, work.y + (avail_h - height) as i32),
        ),
        None => (
            work.x + ((avail_w - width) / 2) as i32,
            work.y + ((avail_h - height) / 2) as i32,
        ),
    };

    Rect { x, y, width, height }
}

/// 按主显示器**逻辑**分辨率算出主窗口的默认尺寸，返回 `(宽, 高)`。
///
/// 规则：
/// - 宽取屏宽 75%，高取屏高 88%
/// - 不小于 conf.json 默认（floor）
/// - 不超过屏幕 95%（屏幕本身比默认还小时退让，如 1366×768 老本）
/// - 不超过 1700×1050（cap，超宽屏防"一行横扫一大片"）
///
/// 高度系数取 0.88 而非更高：`center()` 是按整屏居中，窗口底边 = (屏高 + 窗高) / 2，
/// 要不压任务栏需 `窗高 ≤ 屏高 - 2×任务栏高`，1080p 上约 984。0.88 → 950 有余量，
/// 0.93 → 1004 就越界了。
pub fn default_window_size(logical_w: f64, logical_h: f64) -> (f64, f64) {
    let w = (logical_w * 0.75)
        .max(DEFAULT_WIDTH)
        .min(logical_w * 0.95)
        .min(1700.0);
    let h = (logical_h * 0.88)
        .max(DEFAULT_HEIGHT)
        .min(logical_h * 0.95)
        .min(1050.0);
    (w, h)
}

/// 「期望逻辑尺寸」与实测逻辑尺寸的容差（相对比例）。
///
/// 2% 是这么定的：DPI 换算的四舍五入误差在 1500 逻辑像素上约 1px（0.07%），远小于它；
/// 而真实的跨 DPI 变化最小一档也是 100%↔125%，偏差 20%，远大于它。取 2% 既不会被
/// 浮点尾差误触发、导致反复下发尺寸，也不会漏掉任何一档真实的缩放变化。
pub const LOGICAL_SIZE_TOLERANCE: f64 = 0.02;

/// 实测逻辑尺寸是否已偏离「期望逻辑尺寸」到需要纠正的程度。
///
/// 🔴 为什么需要这个判据：Windows 11 上 tao 0.34.6 处理 `WM_DPICHANGED` 时，把自己
/// 算好的「保持逻辑尺寸」结果（`new_physical_inner_size`，`event_loop.rs:1966-1973`）
/// **丢掉了** —— Win11 分支（`:2102-2105`，`WIN_VERSION.build >= 22000`）直接
/// `new_outer_rect = suggested_rect`，最终 `SetWindowPos`(`:2107`) 用的是 Windows 给的
/// 建议矩形，既不保证逻辑尺寸守恒，也不 clamp 到工作区。而显示器热插拔期间 Windows
/// 给的那个矩形并不可靠，于是出现「软件明明在 100% 主屏、却按 150% 渲染，窗口内容区
/// 缩水」。Win10 分支反而是用了 `new_physical_inner_size` 的，所以这是 Win11 专属坑。
///
/// 任一维度漂移即判 true —— 宽高会被 `fit_into_work_area` 独立 clamp，不能只看一边。
pub fn logical_size_drifted(cur: (f64, f64), want: (f64, f64)) -> bool {
    let drift = |c: f64, w: f64| {
        // 期望值非正（存档损坏）或出现 NaN / inf 时一律判「没漂移」：
        // 宁可不动窗口，也不能拿垃圾数据去 set_size。
        // `is_finite` 必须排在 `<= 0.0` 前面 —— NaN 的所有比较都是 false，
        // 只靠 `w <= 0.0` 是拦不住 NaN 的，靠短路求值先把它筛掉。
        if !w.is_finite() || w <= 0.0 || !c.is_finite() {
            return false;
        }
        ((c - w).abs() / w) > LOGICAL_SIZE_TOLERANCE
    };
    drift(cur.0, want.0) || drift(cur.1, want.1)
}

/// 把逻辑尺寸按给定缩放换算成**物理**尺寸，顺带兜住非法输入。
///
/// 🔴 调用方传进来的 `scale` 必须是**实时查询**的 `MonitorHandle::scale_factor()`
/// （tao `monitor.rs:226-232` → `GetDpiForMonitor`），**不能**用
/// `Window::scale_factor()` —— 后者读的是 tao 的窗口状态缓存
/// （`window.rs:508-510`），而 tao 完全不处理 `WM_DISPLAYCHANGE`（全仓搜不到该消息），
/// 显示器增删后若 Windows 没补发 `WM_DPICHANGED`，那个缓存会长期停在旧值 ——
/// 它本身就是要纠正的错误来源。
pub fn physical_for_logical(logical: (f64, f64), scale: f64) -> (u32, u32) {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let conv = |v: f64| {
        if !v.is_finite() || v <= 0.0 {
            return 1;
        }
        (v * s).round().clamp(1.0, u32::MAX as f64) as u32
    };
    (conv(logical.0), conv(logical.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四舍五入到整数再比，避免浮点尾差让断言看起来很脏
    fn size(w: f64, h: f64) -> (i64, i64) {
        let (a, b) = default_window_size(w, h);
        (a.round() as i64, b.round() as i64)
    }

    #[test]
    fn t_1080p_uses_percentage() {
        // 1920×1080：宽 75% = 1440 撞 floor 1524（工具栏 2 行的下限），高 88% = 950 未撞
        assert_eq!(size(1920.0, 1080.0), (1524, 950));
    }

    #[test]
    fn t_1080p_height_fits_workarea_when_centered() {
        // center() 按整屏居中 → 底边 = (屏高 + 窗高) / 2。
        // 典型 48px 任务栏时工作区底 = 1032，底边必须在其之上，否则窗口被任务栏压住。
        let (_, h) = default_window_size(1920.0, 1080.0);
        let bottom = (1080.0 + h) / 2.0;
        assert!(bottom <= 1080.0 - 48.0, "居中后底边 {bottom} 压住了任务栏");
    }

    #[test]
    fn t_small_screen_falls_back_to_floor_then_clamps() {
        // 1366×768 老本：宽 75%=1024 撞 floor 1524，再被 95%=1297.7 夹回来；
        // 高 88%=675.8 撞 floor 830，再被 95%=729.6 夹回来。
        // 结论：屏幕比默认还小时，窗口退让到屏幕的 95%，不会超出屏幕。
        let (w, h) = default_window_size(1366.0, 768.0);
        assert!(w <= 1366.0 * 0.95 + 0.01, "宽 {w} 超出屏幕 95%");
        assert!(h <= 768.0 * 0.95 + 0.01, "高 {h} 超出屏幕 95%");
    }

    #[test]
    fn t_never_smaller_than_conf_default_on_big_screens() {
        // 大屏上永远不该比 conf.json 默认还小（floor 的存在意义）
        for (w, h) in [(1920.0, 1080.0), (2048.0, 1152.0), (2560.0, 1440.0)] {
            let (rw, rh) = default_window_size(w, h);
            assert!(rw >= DEFAULT_WIDTH, "{w}×{h} 算出的宽 {rw} 比默认还小");
            assert!(rh >= DEFAULT_HEIGHT, "{w}×{h} 算出的高 {rh} 比默认还小");
        }
    }

    #[test]
    fn t_ultrawide_hits_cap() {
        // 2560×1440：75%=1920 / 88%=1267，双双撞 cap 1700×1050
        assert_eq!(size(2560.0, 1440.0), (1700, 1050));
        // 更宽的屏也不会再涨
        assert_eq!(size(3840.0, 2160.0), (1700, 1050));
    }

    #[test]
    fn t_2k_scaled_configs() {
        assert_eq!(size(1707.0, 960.0), (1524, 845)); // 27" 2K @150%：宽走 floor
        assert_eq!(size(2048.0, 1152.0), (1536, 1014)); // 27" 2K @125%
    }

    #[test]
    fn t_degenerate_inputs_do_not_panic() {
        // 拿不到 monitor 时上层会走 conf 默认，但公式本身也不能炸
        let (w, h) = default_window_size(0.0, 0.0);
        assert!(w.is_finite() && h.is_finite());
        assert!(w >= 0.0 && h >= 0.0);
    }

    // ─── fit_into_work_area ───────────────────────
    //
    // 场景取自真机：主屏笔记本 2560×1600 @150%（任务栏 72px），
    // 外接 4K 3840×2160 @200% 摆在主屏左侧（物理 X 为负）。

    /// 主屏工作区（扣 72px 任务栏）
    fn primary_work() -> Rect {
        Rect { x: 0, y: 0, width: 2560, height: 1528 }
    }

    /// 🔴 核心回归：在 200% 副屏调好的窗口（物理 2820×1720）拔掉副屏后，
    /// 插件会把这个物理尺寸原样打到主屏上 —— 必须被压回工作区内。
    #[test]
    fn t_oversized_from_hidpi_monitor_is_clamped() {
        let r = fit_into_work_area(primary_work(), Some((640, 400)), 2820, 1720);
        assert_eq!((r.width, r.height), (2560, 1528), "超过工作区的尺寸必须被压下来");
        assert_eq!((r.x, r.y), (0, 0), "压成工作区大小后只能贴在工作区原点");
    }

    /// 位置越界（副屏拔了 / 换了更小的分辨率）时把窗口拉回工作区，而不是留在屏幕外。
    #[test]
    fn t_out_of_bounds_position_is_pulled_back() {
        let r = fit_into_work_area(primary_work(), Some((9000, 9000)), 1200, 800);
        assert_eq!((r.width, r.height), (1200, 800), "装得下就不该改尺寸");
        assert_eq!(r.x, 2560 - 1200);
        assert_eq!(r.y, 1528 - 800);
        // 负方向同样要拉回
        let r = fit_into_work_area(primary_work(), Some((-500, -300)), 1200, 800);
        assert_eq!((r.x, r.y), (0, 0));
    }

    /// 已经完整落在工作区内的窗口必须原样保留（不能每次启动都被挪一下）。
    #[test]
    fn t_sane_geometry_is_untouched() {
        let want = (143, 208);
        let r = fit_into_work_area(primary_work(), Some(want), 2082, 1245);
        assert_eq!((r.x, r.y), want);
        assert_eq!((r.width, r.height), (2082, 1245));
    }

    /// 副屏摆在主屏左侧（工作区原点为负）是正常拓扑，不能被 clamp 误伤。
    #[test]
    fn t_negative_work_origin_is_respected() {
        let secondary = Rect { x: -3840, y: -170, width: 3840, height: 2160 };
        let r = fit_into_work_area(secondary, Some((-3720, -90)), 2820, 1720);
        assert_eq!((r.x, r.y), (-3720, -90));
        assert_eq!((r.width, r.height), (2820, 1720));
    }

    /// `want_pos = None` → 在工作区内居中（首启 / 恢复默认大小走这条）。
    #[test]
    fn t_none_position_centers_in_work_area() {
        let r = fit_into_work_area(primary_work(), None, 2082, 1245);
        assert_eq!(r.x, (2560 - 2082) / 2);
        assert_eq!(r.y, (1528 - 1245) / 2);
        // 居中依据是工作区而非整屏：整屏居中的 y 会是 (1600-1245)/2 = 177，比这里大
        assert!(r.y < 177, "必须按工作区居中，否则底边会压住任务栏");
    }

    /// 工作区被报成 0（虚拟显示器 / 远程桌面）时绝不 panic，也不产生 0 尺寸窗口。
    #[test]
    fn t_zero_work_area_does_not_panic() {
        let broken = Rect { x: 0, y: 0, width: 0, height: 0 };
        let r = fit_into_work_area(broken, None, 99999, 99999);
        assert_eq!((r.width, r.height), (1, 1));
        assert_eq!((r.x, r.y), (0, 0));
    }

    // ─── logical_size_drifted ─────────────────────

    /// 每一档真实的 Windows 缩放跳变都必须被识别为漂移（最小一档 100%↔125% 也不能漏）。
    #[test]
    fn t_every_real_dpi_step_counts_as_drift() {
        let want = (1500.0, 950.0);
        // 物理尺寸没变、缩放被误判成更高 → 逻辑尺寸缩水，正是用户报的症状
        for scale in [1.25_f64, 1.5, 1.75, 2.0] {
            let cur = (1500.0 / scale, 950.0 / scale);
            assert!(
                logical_size_drifted(cur, want),
                "缩放 {scale} 造成的逻辑尺寸缩水必须判为漂移"
            );
        }
        // 反方向（缓存卡在高缩放、实际回到 100%）同样要识别
        assert!(logical_size_drifted((2250.0, 1425.0), want));
    }

    /// DPI 换算的四舍五入尾差不能被当成漂移 —— 否则每次校正都会再触发一次校正。
    #[test]
    fn t_rounding_noise_is_not_drift() {
        let want = (1500.0, 950.0);
        // 150% 下 set_size 物理 2250×1425，回读除回来最多差 1px 量级
        for scale in [1.0_f64, 1.25, 1.5, 2.0] {
            let (pw, ph) = physical_for_logical(want, scale);
            let cur = (pw as f64 / scale, ph as f64 / scale);
            assert!(
                !logical_size_drifted(cur, want),
                "缩放 {scale} 下的换算尾差被误判成漂移了：{cur:?}"
            );
        }
    }

    /// 用户自己拖动窗口（同一缩放下的正常改尺寸）由 note_user_resize 记账，
    /// 但判据本身必须如实反映「已偏离基准」，否则校正会把用户拖的尺寸拉回去。
    #[test]
    fn t_drift_is_per_axis() {
        let want = (1500.0, 950.0);
        assert!(logical_size_drifted((1200.0, 950.0), want), "只有宽变了也算漂移");
        assert!(logical_size_drifted((1500.0, 700.0), want), "只有高变了也算漂移");
        assert!(!logical_size_drifted((1500.0, 950.0), want), "完全相等不算漂移");
    }

    /// 存档损坏 / 最小化读到 0 / NaN 时一律判「不漂移」：宁可不动窗口，也不拿垃圾去 set_size。
    #[test]
    fn t_degenerate_drift_inputs_are_ignored() {
        assert!(!logical_size_drifted((1500.0, 950.0), (0.0, 0.0)));
        assert!(!logical_size_drifted((1500.0, 950.0), (-1.0, -1.0)));
        assert!(!logical_size_drifted((f64::NAN, 950.0), (1500.0, 950.0)));
        assert!(!logical_size_drifted((1500.0, 950.0), (f64::INFINITY, 950.0)));
    }

    // ─── physical_for_logical ─────────────────────

    #[test]
    fn t_physical_for_logical_scales_and_rounds() {
        assert_eq!(physical_for_logical((1500.0, 950.0), 1.0), (1500, 950));
        assert_eq!(physical_for_logical((1500.0, 950.0), 1.5), (2250, 1425));
        assert_eq!(physical_for_logical((1500.0, 845.0), 1.25), (1875, 1056)); // 1056.25 → 1056
    }

    /// 非法缩放退回 1.0、非法尺寸退回 1px：绝不产生 0 尺寸或 panic。
    #[test]
    fn t_physical_for_logical_degenerate_inputs() {
        assert_eq!(physical_for_logical((1500.0, 950.0), 0.0), (1500, 950));
        assert_eq!(physical_for_logical((1500.0, 950.0), f64::NAN), (1500, 950));
        assert_eq!(physical_for_logical((1500.0, 950.0), -2.0), (1500, 950));
        assert_eq!(physical_for_logical((0.0, -5.0), 1.5), (1, 1));
        assert_eq!(physical_for_logical((f64::NAN, f64::INFINITY), 1.5), (1, 1));
    }
}
