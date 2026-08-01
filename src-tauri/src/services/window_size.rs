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
pub const DEFAULT_WIDTH: f64 = 1388.0;
/// conf.json 的默认高度，同时作为"永不更小"的下限
pub const DEFAULT_HEIGHT: f64 = 830.0;

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
        // 1366×768 老本：宽 75%=1024 撞 floor 1388，再被 95%=1297.7 夹回来；
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
        assert_eq!(size(1707.0, 960.0), (1388, 845)); // 27" 2K @150%：宽走 floor
        assert_eq!(size(2048.0, 1152.0), (1536, 1014)); // 27" 2K @125%
    }

    #[test]
    fn t_degenerate_inputs_do_not_panic() {
        // 拿不到 monitor 时上层会走 conf 默认，但公式本身也不能炸
        let (w, h) = default_window_size(0.0, 0.0);
        assert!(w.is_finite() && h.is_finite());
        assert!(w >= 0.0 && h >= 0.0);
    }
}
