//! 笔记内容快照策略（存不存、留几份，都在这里定）。
//!
//! 动机见 `database::snapshots`：白板是自动保存的，没有快照就意味着
//! "误删一片图形 + 800ms" = 内容永久消失。
//!
//! 策略的三条约束，都是为了在"救得回来"和"别把库撑爆"之间取平衡：
//!
//! 1. **时间窗节流**：距上一份快照不足 [`AUTO_MIN_INTERVAL_SEC`] 就跳过。
//!    白板保存频率是秒级的，不节流的话画一小时能攒出几千份快照。
//!    代价是最坏情况丢失最近这一个时间窗内的编辑 —— 相比"全丢"是可接受的。
//! 2. **内容去重**：内容和上一份快照一模一样就不再存（切走切回、只挪了下视口都会触发保存）。
//! 3. **份数上限**：每条笔记只留最近 [`MAX_PER_NOTE`] 份，超出的从最旧开始删。

use crate::database::Database;
use crate::error::AppError;

/// 自动快照的最小间隔（秒）。10 分钟 ≈ 连续画一小时留 6 份。
const AUTO_MIN_INTERVAL_SEC: f64 = 600.0;

/// 每条笔记保留的快照份数上限
const MAX_PER_NOTE: i64 = 30;

/// 单份快照的体积上限。超过就不存 —— 这么大的画布多半是内嵌了未外置的 base64，
/// 存 30 份能把库撑到几百 MB，得不偿失。
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// 触发来源常量。与 `note_snapshots.reason` 列对应。
pub mod reason {
    /// 自动保存覆盖前留的底
    pub const AUTO: &str = "auto";
    /// 用户主动存档
    pub const MANUAL: &str = "manual";
    /// 回滚前对"当前版本"的兜底 —— 让回滚这个动作本身也可撤销
    pub const BEFORE_RESTORE: &str = "before_restore";
}

/// 判断这条笔记当前是否适合做快照，顺便把旧内容取出来。
///
/// 返回 `None` 表示"跳过"，调用方直接继续原有流程即可。
///
/// 加密笔记一律跳过：`get_note` 对加密笔记返回的是占位符而不是真实内容，
/// 存下来的快照既没意义，回滚时还会把占位符写回去 —— 那是把数据毁了。
fn old_content_for_snapshot(db: &Database, note_id: i64) -> Option<String> {
    let note = match db.get_note(note_id) {
        Ok(Some(n)) => n,
        Ok(None) => return None,
        Err(e) => {
            log::warn!("[snapshot] 读取笔记 {} 失败，跳过快照: {}", note_id, e);
            return None;
        }
    };
    if note.is_encrypted {
        return None;
    }
    // 空内容没什么好留的（刚建出来还没画过的白板）
    if note.content.trim().is_empty() {
        return None;
    }
    Some(note.content)
}

/// 在覆盖写入**之前**留一份旧内容。
///
/// 返回是否真的存了。任何失败都只记日志并返回 false —— 快照是保险措施，
/// 绝不能因为它出问题而让用户的保存动作失败。
pub fn capture_auto(db: &Database, note_id: i64) -> bool {
    // 先做时间窗判断再读正文：白板每次保存都会走这里，而正文动辄几百 KB，
    // 绝大多数调用都会被节流挡掉 —— 不该为了挡掉的这些去拉一遍整块画布
    let last_hash = match db.latest_snapshot_stamp(note_id) {
        Ok(Some((hash, age_sec))) => {
            if age_sec < AUTO_MIN_INTERVAL_SEC {
                return false;
            }
            Some(hash)
        }
        // 从没有过快照 —— 这一份最该存：它是"用户这次打开之前的样子"
        Ok(None) => None,
        Err(e) => {
            log::warn!("[snapshot] 查最近快照失败，跳过: {}", e);
            return false;
        }
    };

    let Some(content) = old_content_for_snapshot(db, note_id) else {
        return false;
    };

    if content.len() > MAX_BYTES {
        log::debug!(
            "[snapshot] 笔记 {} 内容 {} 字节超过上限，跳过快照",
            note_id,
            content.len()
        );
        return false;
    }

    // 内容和上一份一模一样就别占位置（切走切回、只挪了视口都会触发保存）
    if let Some(last) = last_hash {
        if crate::services::hash::sha256_hex(&content) == last {
            return false;
        }
    }

    write(db, note_id, &content, reason::AUTO)
}

/// 用户主动存档：跳过节流，但仍然去重（内容没变就没必要多存一份）。
pub fn capture_manual(db: &Database, note_id: i64) -> Result<bool, AppError> {
    let Some(content) = old_content_for_snapshot(db, note_id) else {
        return Err(AppError::InvalidInput(
            "这条笔记当前内容为空或已加密，无法存档".into(),
        ));
    };
    if content.len() > MAX_BYTES {
        return Err(AppError::InvalidInput(format!(
            "内容 {} MB 超过单份存档上限 {} MB",
            content.len() / 1024 / 1024,
            MAX_BYTES / 1024 / 1024
        )));
    }
    if let Ok(Some((last_hash, _))) = db.latest_snapshot_stamp(note_id) {
        if crate::services::hash::sha256_hex(&content) == last_hash {
            return Ok(false);
        }
    }
    Ok(write(db, note_id, &content, reason::MANUAL))
}

/// 回滚前给"当前版本"留底，让回滚本身也能被撤销。
///
/// 与自动快照不同，这份**必须**写进去（不节流），否则用户点了恢复就再也回不到现在这一版。
pub fn capture_before_restore(db: &Database, note_id: i64) -> bool {
    let Some(content) = old_content_for_snapshot(db, note_id) else {
        return false;
    };
    if content.len() > MAX_BYTES {
        return false;
    }
    write(db, note_id, &content, reason::BEFORE_RESTORE)
}

/// 实际落库 + 裁剪超额份数。
fn write(db: &Database, note_id: i64, content: &str, reason: &str) -> bool {
    if let Err(e) = db.insert_note_snapshot(note_id, content, reason) {
        log::warn!("[snapshot] 笔记 {} 写快照失败: {}", note_id, e);
        return false;
    }
    if let Err(e) = db.prune_note_snapshots(note_id, MAX_PER_NOTE) {
        // 裁剪失败只是留多了几份，不影响正确性
        log::warn!("[snapshot] 笔记 {} 裁剪旧快照失败: {}", note_id, e);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteInput;

    fn mem_db() -> Database {
        Database::init(":memory:").unwrap()
    }

    fn new_note(db: &Database, content: &str) -> i64 {
        db.create_note(&NoteInput {
            title: "白板".into(),
            content: content.into(),
            folder_id: None,
        })
        .unwrap()
        .id
    }

    /// 第一份必须存下 —— 它是"用户这次打开之前的样子"，最有救回价值。
    #[test]
    fn first_capture_always_writes() {
        let db = mem_db();
        let id = new_note(&db, "画布 v1");
        assert!(capture_auto(&db, id));
        assert_eq!(db.list_note_snapshots(id).unwrap().len(), 1);
    }

    /// 白板每停手一次就保存一次，紧接着的第二次必须被时间窗挡掉，
    /// 否则画一小时能攒出几千份快照。
    #[test]
    fn second_capture_is_throttled() {
        let db = mem_db();
        let id = new_note(&db, "画布 v1");
        assert!(capture_auto(&db, id));

        // 即便内容变了，只要还在时间窗内就不再存
        db.update_note_content(id, "画布 v2").unwrap();
        assert!(!capture_auto(&db, id), "时间窗内不该重复存");
        assert_eq!(db.list_note_snapshots(id).unwrap().len(), 1);
    }

    /// 加密笔记的 `get_note` 返回的是占位符而不是真内容 —— 存下来毫无意义，
    /// 回滚还会把占位符写回去，等于毁数据。必须跳过。
    #[test]
    fn encrypted_note_is_skipped() {
        let db = mem_db();
        let id = new_note(&db, "机密画布");
        {
            let conn = db.conn_lock().unwrap();
            conn.execute("UPDATE notes SET is_encrypted = 1 WHERE id = ?1", [id])
                .unwrap();
        }
        assert!(!capture_auto(&db, id));
        assert!(db.list_note_snapshots(id).unwrap().is_empty());
    }

    /// 刚建出来还没画过的白板没什么好留的。
    #[test]
    fn empty_content_is_skipped() {
        let db = mem_db();
        let id = new_note(&db, "");
        assert!(!capture_auto(&db, id));
        assert!(db.list_note_snapshots(id).unwrap().is_empty());
    }

    /// 回滚前的兜底不受时间窗限制 —— 没有它，"恢复"就成了不可逆操作。
    #[test]
    fn before_restore_ignores_throttle() {
        let db = mem_db();
        let id = new_note(&db, "画布 v1");
        assert!(capture_auto(&db, id));
        assert!(
            capture_before_restore(&db, id),
            "回滚兜底必须无视时间窗写进去"
        );
        assert_eq!(db.list_note_snapshots(id).unwrap().len(), 2);
    }

    /// 手动存档同样绕过时间窗，但内容没变就不必占一个位置。
    #[test]
    fn manual_skips_when_unchanged() {
        let db = mem_db();
        let id = new_note(&db, "画布 v1");
        assert!(capture_manual(&db, id).unwrap());
        assert!(
            !capture_manual(&db, id).unwrap(),
            "内容没变时不该重复存档"
        );
        assert_eq!(db.list_note_snapshots(id).unwrap().len(), 1);
    }
}
