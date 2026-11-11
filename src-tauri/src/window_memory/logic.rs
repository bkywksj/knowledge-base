//! 纯逻辑：显示器组合、认屏、「这次要不要记」「窗口该放哪」。不依赖 Tauri，可单测。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 最多记多少种显示器组合，超过时淘汰最久没用的。
const MAX_LAYOUTS: usize = 16;
/// Windows 10/11 窗口外框有约 7px 的隐形边框，贴边 / 吸附时外框坐标会略微为负，钳制时留点余量。
const EDGE_SLACK: i32 = 16;
/// 判断窗口「没变」的容差（物理像素）：边框和 DPI 换算的舍入会差几个像素，不值得挪一次。
const RECT_TOLERANCE: i64 = 4;
/// 最小化最早可以比屏幕变化提前多久，仍算屏幕变化引起的（系统先最小化、后发显示变化通知）。
const MINIMIZE_BEFORE_TOPOLOGY: Duration = Duration::from_secs(2);

/// 一块显示器的身份（名字 + 物理像素矩形）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonitorKey {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 窗口位置：所在屏 + 相对该屏左上角的偏移 + 外框尺寸（均为物理像素）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Placement {
    pub monitor: MonitorKey,
    pub rel_x: i32,
    pub rel_y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Slot {
    placement: Placement,
    used: u64,
}

/// 按显示器组合分别记的窗口位置。
///
/// 只存一条记录时，「合盖只剩副屏」的位置会盖掉「双屏时在主屏」的选择；分开存之后互不影响。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Memory {
    layouts: BTreeMap<String, Slot>,
    clock: u64,
}

impl Memory {
    pub fn get(&self, layout: &str) -> Option<&Placement> {
        self.layouts.get(layout).map(|s| &s.placement)
    }

    pub fn put(&mut self, layout: String, placement: Placement) {
        self.clock += 1;
        self.layouts.insert(layout, Slot { placement, used: self.clock });
        if self.layouts.len() > MAX_LAYOUTS {
            if let Some(oldest) = self.layouts.iter().min_by_key(|(_, s)| s.used).map(|(k, _)| k.clone()) {
                self.layouts.remove(&oldest);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.layouts.is_empty()
    }
}

/// 显示器组合的标识：各屏分辨率排序后拼接。不含坐标（换主屏后原点会变），
/// 不含名字（Windows 的 `\\.\DISPLAYn` 重新插拔后可能换号）。
pub fn layout_key(list: &[MonitorKey]) -> String {
    let mut sizes: Vec<String> = list.iter().map(|m| format!("{}x{}", m.w, m.h)).collect();
    sizes.sort();
    sizes.join("+")
}

/// 显示器拓扑的完整签名（含名字和坐标），变了就说明插拔 / 换主屏 / 改分辨率。
pub fn signature(list: &[MonitorKey]) -> String {
    let mut v: Vec<String> = list
        .iter()
        .map(|m| format!("{}@{},{},{}x{}", m.name.as_deref().unwrap_or("?"), m.x, m.y, m.w, m.h))
        .collect();
    v.sort();
    v.join("|")
}

/// 两条记录指的是不是同一块物理屏。换主屏后坐标会变，所以先认名字 + 尺寸。
pub fn same_screen(a: &MonitorKey, b: &MonitorKey) -> bool {
    (a.name.is_some() && a.name == b.name && a.w == b.w && a.h == b.h) || (a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h)
}

/// 在当前显示器列表里找回记录的那块屏。认屏顺序：名字 + 尺寸 → 位置 + 尺寸 → 仅名字。
pub fn find_target<'a>(saved: &MonitorKey, list: &'a [MonitorKey]) -> Option<&'a MonitorKey> {
    let named = |m: &&MonitorKey| m.name.is_some() && m.name == saved.name;
    list.iter()
        .find(|m| named(m) && m.w == saved.w && m.h == saved.h)
        .or_else(|| list.iter().find(|m| m.x == saved.x && m.y == saved.y && m.w == saved.w && m.h == saved.h))
        .or_else(|| list.iter().find(named))
}

/// 这次位置变化要不要记下来。
///
/// 同一块屏上的移动、缩放照常记；**换了屏必须是用户动的**，系统在拓扑变化后挪窗口不算用户的选择。
pub fn should_record(prev: Option<&Placement>, new: &Placement, user_moved: bool) -> bool {
    match prev {
        None => true,
        Some(p) => same_screen(&p.monitor, &new.monitor) || user_moved,
    }
}

/// 窗口该怎么摆。
#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    /// 已经在该在的屏上
    Keep,
    /// 挪到 `target`，`size` 是目标屏上的外框尺寸
    Move { target: MonitorKey, rel_x: i32, rel_y: i32, size: (u32, u32), maximized: bool },
}

/// 按这个组合的记录算出窗口该放哪。没有记录（第一次见到这个组合）时放主屏居中，
/// `size_on_primary` 是当前窗口换算到主屏缩放比后的外框尺寸。
///
/// `actual` 是窗口此刻的外框 (x, y, 宽, 高)，最大化时传 None（几何由系统管，不比较）。
/// 屏对了不等于没事：开关副屏时窗口可能留在原屏，尺寸却被系统按另一块屏的缩放改掉。
pub fn plan(rec: Option<&Placement>, keys: &[MonitorKey], primary: Option<&MonitorKey>, current: Option<&MonitorKey>, actual: Option<(i32, i32, u32, u32)>, size_on_primary: (u32, u32)) -> Plan {
    let on = |t: &MonitorKey| current.is_some_and(|c| same_screen(c, t));
    if let Some(r) = rec {
        if let Some(t) = find_target(&r.monitor, keys) {
            let size = (r.w.min(t.w), r.h.min(t.h));
            let close = |a: i64, b: i64| (a - b).abs() <= RECT_TOLERANCE;
            let unchanged = actual.is_none_or(|(x, y, w, h)| {
                close((x - t.x) as i64, r.rel_x as i64) && close((y - t.y) as i64, r.rel_y as i64) && close(w as i64, size.0 as i64) && close(h as i64, size.1 as i64)
            });
            if on(t) && unchanged {
                return Plan::Keep;
            }
            return Plan::Move { target: t.clone(), rel_x: r.rel_x, rel_y: r.rel_y, size, maximized: r.maximized };
        }
    }
    let Some(p) = primary else { return Plan::Keep };
    if on(p) {
        return Plan::Keep;
    }
    let size = (size_on_primary.0.min(p.w), size_on_primary.1.min(p.h));
    let (rel_x, rel_y) = centered_rel(p, size.0, size.1);
    Plan::Move { target: p.clone(), rel_x, rel_y, size, maximized: false }
}

/// 旧版单条记录能不能给当前组合打底：只认主屏上的那条。
/// 旧记录分不清位置是用户选的还是系统挪的（正是要修的问题），在副屏上的宁可不用，窗口回主屏。
pub fn legacy_usable(old: &Placement, keys: &[MonitorKey], primary: Option<&MonitorKey>) -> bool {
    find_target(&old.monitor, keys).is_some_and(|t| primary == Some(t))
}

/// 窗口是不是在屏幕变化前后被最小化的（`*_ago` 是距现在多久）。
/// 显示器断开时系统可能把上面的窗口最小化，这不是用户的操作，应该恢复；
/// 用户早就最小化好的窗口不在此列，所以只认屏幕变化前 2 秒以内才最小化的。
pub fn minimized_around_topology(minimized_ago: Option<Duration>, topology_ago: Option<Duration>) -> bool {
    match (minimized_ago, topology_ago) {
        (Some(m), Some(t)) => m <= t + MINIMIZE_BEFORE_TOPOLOGY,
        _ => false,
    }
}

/// 窗口逻辑尺寸是否达到配置的最小值。合盖 / 休眠时的中间态可能比它小，这种几何不记。差 1 以内算浮点误差。
pub fn big_enough(logical: (f64, f64), min: (f64, f64)) -> bool {
    logical.0 + 1.0 >= min.0 && logical.1 + 1.0 >= min.1
}

/// 把「相对偏移 + 尺寸」放进某块屏，钳制在屏内（窗口比屏大就贴左上）。
pub fn place_in(mon: &MonitorKey, rel_x: i32, rel_y: i32, w: u32, h: u32) -> (i32, i32) {
    let clamp = |rel: i32, win: i32, scr: i32| {
        if win >= scr {
            0
        } else {
            rel.clamp(-EDGE_SLACK, scr - win + EDGE_SLACK)
        }
    };
    (mon.x + clamp(rel_x, w as i32, mon.w as i32), mon.y + clamp(rel_y, h as i32, mon.h as i32))
}

/// 屏内居中的相对偏移。
pub fn centered_rel(mon: &MonitorKey, w: u32, h: u32) -> (i32, i32) {
    ((mon.w as i32 - w as i32).max(0) / 2, (mon.h as i32 - h as i32).max(0) / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(name: &str, x: i32, y: i32, w: u32, h: u32) -> MonitorKey {
        MonitorKey { name: Some(name.into()), x, y, w, h }
    }

    fn at(m: &MonitorKey, rel_x: i32) -> Placement {
        Placement { monitor: m.clone(), rel_x, rel_y: 50, w: 1000, h: 800, maximized: false }
    }

    fn laptop() -> MonitorKey {
        mk("D1", 0, 0, 2560, 1600)
    }
    fn external_beside() -> MonitorKey {
        mk("D5", -3840, -170, 3840, 2160)
    }
    fn external_alone() -> MonitorKey {
        mk("D5", 0, 0, 3840, 2160)
    }

    /// 用户的真实流程：双屏时窗口在主屏 → 关副屏 → 合盖 → 只开副屏 → 开盖，窗口要回主屏。
    #[test]
    fn lid_sequence_returns_to_laptop_screen() {
        let dual = [external_beside(), laptop()];
        let only_laptop = [laptop()];
        let only_external = [external_alone()];
        let mut mem = Memory::default();
        mem.put(layout_key(&dual), at(&laptop(), 100));

        // 关副屏：只剩笔记本屏，这个组合单独记
        mem.put(layout_key(&only_laptop), at(&laptop(), 100));
        // 合盖后只开副屏：系统把窗口挪到副屏，只写「只有副屏」这一份
        let moved = at(&external_alone(), 100);
        assert!(should_record(mem.get(&layout_key(&only_external)), &moved, false));
        mem.put(layout_key(&only_external), moved);
        assert_eq!(mem.get(&layout_key(&dual)).unwrap().monitor, laptop(), "双屏的记录不受影响");

        // 开盖回到双屏，窗口此刻还在副屏 → 按双屏的记录回笔记本屏
        let p = plan(mem.get(&layout_key(&dual)), &dual, Some(&laptop()), Some(&external_beside()), None, (1000, 800));
        assert!(matches!(p, Plan::Move { ref target, rel_x: 100, .. } if *target == laptop()), "{p:?}");
    }

    /// 只开副屏时启动、之后开盖：记录分开存，开盖照样回主屏（实际日志里最常见的情形）。
    #[test]
    fn launching_on_external_only_does_not_change_dual_layout() {
        let dual = [external_beside(), laptop()];
        let mut mem = Memory::default();
        mem.put(layout_key(&dual), at(&laptop(), 100));
        mem.put(layout_key(&[external_alone()]), at(&external_alone(), 200));
        let p = plan(mem.get(&layout_key(&dual)), &dual, Some(&laptop()), Some(&external_beside()), None, (1000, 800));
        assert!(matches!(p, Plan::Move { ref target, .. } if *target == laptop()), "{p:?}");
    }

    /// 用户在双屏时主动拖到副屏：记住，下次双屏还在副屏。
    #[test]
    fn user_drag_to_external_is_remembered() {
        let dual = [external_beside(), laptop()];
        let key = layout_key(&dual);
        let mut mem = Memory::default();
        mem.put(key.clone(), at(&laptop(), 100));
        let dragged = at(&external_beside(), 300);
        assert!(should_record(mem.get(&key), &dragged, true));
        mem.put(key.clone(), dragged);
        assert_eq!(plan(mem.get(&key), &dual, Some(&laptop()), Some(&external_beside()), None, (1000, 800)), Plan::Keep);
    }

    /// 系统在双屏时把窗口挪到别的屏：不是用户动的，不记。
    #[test]
    fn system_move_to_another_screen_is_not_recorded() {
        let prev = at(&laptop(), 100);
        assert!(!should_record(Some(&prev), &at(&external_beside(), 100), false));
        assert!(should_record(Some(&prev), &at(&external_beside(), 100), true));
        // 同一块屏（换主屏后坐标变了）上的变化照常记
        assert!(should_record(Some(&at(&external_alone(), 10)), &at(&external_beside(), 10), false));
        assert!(should_record(None, &at(&laptop(), 1), false), "这个组合还没有记录时直接记");
    }

    /// 第一次见到的组合：放主屏居中；已在主屏就不动。
    #[test]
    fn unknown_layout_goes_to_primary() {
        let dual = [external_beside(), laptop()];
        let p = plan(None, &dual, Some(&laptop()), Some(&external_beside()), None, (1000, 800));
        assert_eq!(p, Plan::Move { target: laptop(), rel_x: 780, rel_y: 400, size: (1000, 800), maximized: false });
        assert_eq!(plan(None, &dual, Some(&laptop()), Some(&laptop()), None, (1000, 800)), Plan::Keep);
        // 窗口比主屏大：压到屏幕大小，贴左上
        let big = plan(None, &dual, Some(&laptop()), Some(&external_beside()), None, (3000, 2000));
        assert_eq!(big, Plan::Move { target: laptop(), rel_x: 0, rel_y: 0, size: (2560, 1600), maximized: false });
    }

    /// 开关副屏后窗口留在原屏，尺寸却被系统改了：要按记录恢复，不能因为屏对了就放过。
    #[test]
    fn right_screen_with_wrong_size_is_restored() {
        let dual = [external_beside(), laptop()];
        let rec = at(&laptop(), 100);
        let p = plan(Some(&rec), &dual, Some(&laptop()), Some(&laptop()), Some((100, 50, 1500, 1200)), (1000, 800));
        assert!(matches!(p, Plan::Move { size: (1000, 800), rel_x: 100, .. }), "{p:?}");
    }

    #[test]
    fn right_screen_with_right_rect_stays_put() {
        let dual = [external_beside(), laptop()];
        let rec = at(&laptop(), 100);
        assert_eq!(plan(Some(&rec), &dual, Some(&laptop()), Some(&laptop()), Some((100, 50, 1000, 800)), (1000, 800)), Plan::Keep);
        // 边框、DPI 舍入差几个像素不算变化
        assert_eq!(plan(Some(&rec), &dual, Some(&laptop()), Some(&laptop()), Some((102, 48, 1003, 797)), (1000, 800)), Plan::Keep);
        // 最大化时几何由系统管，不比较
        assert_eq!(plan(Some(&rec), &dual, Some(&laptop()), Some(&laptop()), None, (1000, 800)), Plan::Keep);
    }

    /// 旧记录在副屏上（可能是系统挪的）不打底，在主屏上的才用；屏已不在的也不用。
    #[test]
    fn legacy_record_is_trusted_only_on_primary() {
        let dual = [external_beside(), laptop()];
        assert!(legacy_usable(&at(&laptop(), 1), &dual, Some(&laptop())));
        assert!(!legacy_usable(&at(&external_beside(), 1), &dual, Some(&laptop())));
        assert!(!legacy_usable(&at(&external_alone(), 1), &[laptop()], Some(&laptop())));
    }

    /// 合盖时被系统最小化要恢复；用户早就最小化好的窗口不动。
    #[test]
    fn only_minimizes_around_a_screen_change_count_as_system_ones() {
        let s = Duration::from_secs;
        assert!(minimized_around_topology(Some(s(3)), Some(s(4))), "屏幕变化之后才最小化");
        assert!(minimized_around_topology(Some(s(5)), Some(s(4))), "屏幕变化前 1 秒最小化");
        assert!(!minimized_around_topology(Some(s(60)), Some(s(4))), "用户一分钟前就最小化了");
        assert!(!minimized_around_topology(None, Some(s(4))));
        assert!(!minimized_around_topology(Some(s(3)), None), "没有发生过屏幕变化");
    }

    #[test]
    fn transient_small_geometry_is_rejected() {
        assert!(big_enough((900.0, 600.0), (900.0, 600.0)));
        assert!(big_enough((899.4, 600.0), (900.0, 600.0)), "浮点误差不算太小");
        assert!(!big_enough((640.0, 480.0), (900.0, 600.0)));
    }

    /// 恢复时尺寸不能超过目标屏（智码日志里窗口曾以 3169 宽停在 2560 宽的屏上）。
    #[test]
    fn restored_size_fits_the_target_screen() {
        let dual = [external_beside(), laptop()];
        let mut big = at(&laptop(), 0);
        big.w = 3169;
        big.h = 1777;
        match plan(Some(&big), &dual, Some(&laptop()), Some(&external_beside()), None, (1000, 800)) {
            Plan::Move { size, .. } => assert_eq!(size, (2560, 1600)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn layout_key_ignores_order_position_and_name() {
        assert_eq!(layout_key(&[external_beside(), laptop()]), layout_key(&[mk("X", 0, 0, 2560, 1600), mk("Y", 2560, 0, 3840, 2160)]));
        assert_ne!(layout_key(&[laptop()]), layout_key(&[external_alone(), laptop()]));
    }

    #[test]
    fn memory_evicts_least_recently_used() {
        let mut mem = Memory::default();
        for i in 0..MAX_LAYOUTS + 1 {
            mem.put(format!("L{i}"), at(&laptop(), i as i32));
        }
        assert!(mem.get("L0").is_none());
        assert!(mem.get(&format!("L{MAX_LAYOUTS}")).is_some());
    }

    #[test]
    fn find_target_prefers_name_and_size() {
        let saved = mk("D1", 0, 0, 1920, 1080);
        let list = [mk("D2", 0, 0, 2560, 1440), mk("D1", -1920, 0, 1920, 1080)];
        assert_eq!(find_target(&saved, &list), Some(&list[1]));
        // 换号后按位置 + 尺寸
        let renamed = [mk("D9", 0, 0, 1920, 1080)];
        assert_eq!(find_target(&saved, &renamed), Some(&renamed[0]));
        assert_eq!(find_target(&mk("D3", 5, 5, 800, 600), &list), None);
    }

    #[test]
    fn place_in_keeps_relative_offset_and_clamps() {
        let m = mk("D1", -1920, 0, 1920, 1080);
        assert_eq!(place_in(&m, 100, 50, 1440, 900), (-1820, 50));
        assert_eq!(place_in(&m, 5000, 5000, 1440, 900), (-1920 + 480 + EDGE_SLACK, 180 + EDGE_SLACK));
        assert_eq!(place_in(&m, 100, 100, 3000, 2000), (-1920, 0));
    }

    #[test]
    fn signature_is_order_independent() {
        let a = [mk("D1", 0, 0, 1920, 1080), mk("D2", 1920, 0, 2560, 1440)];
        let b = [a[1].clone(), a[0].clone()];
        assert_eq!(signature(&a), signature(&b));
    }
}
