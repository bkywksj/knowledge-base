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

/// conf.json 的默认宽度，同时作为"永不更小"的下限
pub const DEFAULT_WIDTH: f64 = 1408.0;
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
        // 1920×1080：宽 75% = 1440，高 88% = 950，都没撞上下限
        assert_eq!(size(1920.0, 1080.0), (1440, 950));
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
        // 1366×768 老本：宽 75%=1024 撞 floor 1408，再被 95%=1297.7 夹回来；
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
        assert_eq!(size(1707.0, 960.0), (1408, 845)); // 27" 2K @150%：宽走 floor
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
}
