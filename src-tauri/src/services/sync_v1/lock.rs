//! V1 同步互斥：同一个 backend 同时只允许一个同步操作（pull / push / 双向）在跑。
//!
//! 为什么需要：
//! - 两份 pull 交错 → 对同一条远端 entry 都查到"本地没有" → 都走 `create_note_with_uuid`，
//!   第二个撞 `idx_notes_stable_uuid` UNIQUE 约束报错（刷一堆 errors），最坏情况索引没生效时还会真重复行
//! - 两份 push 交错 → 各自 `read_manifest` → `merge_manifests` → `write_manifest`，
//!   后写覆盖先写 → 远端 manifest 丢掉先那次新增的 entry，第三台设备就 pull 不到那几条
//! - "后台同步"按钮被连点 / 自动调度 tick 撞上用户手动同步 → 上面两种都会发生
//!
//! 实现：进程级 `Mutex<HashSet<backend_id>>`，RAII guard 持有期间该 id 在集合里；
//! guard 只在 acquire / Drop 的瞬间锁 `HashSet`，不长期持锁（不会阻塞别的 backend 的同步）。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// 同步互斥闸门（放在 `AppState` 里）。`Clone` 廉价（内部就一个 `Arc`）。
#[derive(Clone, Default)]
pub struct SyncGate {
    in_progress: Arc<Mutex<HashSet<i64>>>,
}

impl SyncGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// 尝试为 `backend_id` 开一次同步：
    /// - 成功 → 返回 [`SyncGuard`]，持有期间该 backend 标记为"同步中"，Drop 时自动释放
    /// - 已在同步中 → 返回 `None`（调用方应拒绝/跳过本次同步）
    ///
    /// `Mutex` 中毒（持锁线程 panic）也返回 `None`，宁可拒绝同步也不在异常态下并发跑。
    pub fn try_acquire(&self, backend_id: i64) -> Option<SyncGuard> {
        let mut set = self.in_progress.lock().ok()?;
        if !set.insert(backend_id) {
            return None; // 已存在 → 正在同步中
        }
        Some(SyncGuard {
            gate: Arc::clone(&self.in_progress),
            backend_id,
        })
    }

    /// 该 backend 当前是否正在同步（用于"已经在跑就别重复触发"的快速判断）
    pub fn is_busy(&self, backend_id: i64) -> bool {
        self.in_progress
            .lock()
            .map(|s| s.contains(&backend_id))
            .unwrap_or(false)
    }
}

/// RAII：构造时已把 `backend_id` 标记为"同步中"，Drop 时清除。
///
/// 用 `let _guard = gate.try_acquire(id)?;` 持有到同步操作结束 —— **不要** `let _ = ...`，
/// 那样会立即 drop、锁等于没加。
#[must_use = "SyncGuard 一旦 drop 就释放同步锁；用 `let _guard = ...` 持有到操作结束"]
pub struct SyncGuard {
    gate: Arc<Mutex<HashSet<i64>>>,
    backend_id: i64,
}

impl Drop for SyncGuard {
    fn drop(&mut self) {
        // lock 中毒（某线程持锁时 panic）→ 忽略：进程已处于异常态，没必要再清理这个 HashSet
        if let Ok(mut set) = self.gate.lock() {
            set.remove(&self.backend_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_then_blocked_then_released() {
        let gate = SyncGate::new();
        assert!(!gate.is_busy(1));

        let g1 = gate.try_acquire(1).expect("首次应成功");
        assert!(gate.is_busy(1));
        assert!(gate.try_acquire(1).is_none(), "同一 backend 第二次 acquire 应失败");

        // 不同 backend 互不影响
        let g2 = gate.try_acquire(2).expect("另一个 backend 应能独立 acquire");
        assert!(gate.is_busy(2));

        drop(g1);
        assert!(!gate.is_busy(1), "guard drop 后应释放");
        assert!(gate.try_acquire(1).is_some(), "释放后可再次 acquire");

        drop(g2);
        assert!(!gate.is_busy(2));
    }

    #[test]
    fn guard_released_on_scope_exit() {
        let gate = SyncGate::new();
        {
            let _g = gate.try_acquire(42).unwrap();
            assert!(gate.is_busy(42));
        }
        assert!(!gate.is_busy(42), "离开作用域后自动释放");
    }

    #[test]
    fn clone_shares_state() {
        // SyncGate clone 后应共享同一份 in_progress（AppState 里 clone 出去给别处用时不能各管各的）
        let gate = SyncGate::new();
        let gate2 = gate.clone();
        let _g = gate.try_acquire(7).unwrap();
        assert!(gate2.is_busy(7), "clone 出来的 gate 必须看到同样的占用");
        assert!(gate2.try_acquire(7).is_none());
    }
}
