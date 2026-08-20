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
use crate::models::{Note, SnapshotUsage};

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
    let last_hash = match db.latest_snapshot_stamp(note_id, None) {
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

    write(db, note_id, &content, reason::AUTO, None)
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
    if let Ok(Some((last_hash, _))) = db.latest_snapshot_stamp(note_id, None) {
        if crate::services::hash::sha256_hex(&content) == last_hash {
            return Ok(false);
        }
    }
    Ok(write(db, note_id, &content, reason::MANUAL, None))
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
    write(db, note_id, &content, reason::BEFORE_RESTORE, None)
}

/// 把普通笔记回滚到某一份历史版本。
///
/// 回滚前先把**当前**正文另存一份（`before_restore`），所以点错了还能再滚回来 ——
/// 没有这一步的话，"恢复"就是个不可逆操作，比不提供还危险。
///
/// **只回滚正文，不动标题**：快照存的就只有 content。用户改标题与改正文是两件事，
/// 恢复旧正文时把标题一起换掉往往不是他想要的。
///
/// 白板走不通这条路：它的 content 是 Excalidraw JSON，回写时还要重建
/// `search_text` 与画布双链 —— 那套在 `services::whiteboard::restore_snapshot`。
pub fn restore(db: &Database, note_id: i64, snapshot_id: i64) -> Result<Note, AppError> {
    let snap = db
        .get_note_snapshot(snapshot_id)?
        .ok_or_else(|| AppError::NotFound(format!("历史版本 {} 不存在", snapshot_id)))?;
    if snap.note_id != note_id {
        // 防前端传串了 id 把 A 的内容盖到 B 上
        return Err(AppError::InvalidInput("该历史版本不属于这条笔记".into()));
    }

    let note = db
        .get_note(note_id)?
        .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", note_id)))?;
    if note.note_type == crate::models::note_type::WHITEBOARD {
        return Err(AppError::InvalidInput(
            "白板请在白板页恢复历史版本".into(),
        ));
    }
    if note.is_encrypted {
        // 加密笔记的 content 是占位符，回滚等于把占位符写成正文
        return Err(AppError::InvalidInput("加密笔记暂不支持恢复历史版本".into()));
    }

    capture_before_restore(db, note_id);
    db.update_note(
        note_id,
        &crate::models::NoteInput {
            title: note.title,
            content: snap.content,
            folder_id: note.folder_id,
        },
    )
}

// ─── 笔记内嵌的白板块 ────────────────────────────────────
//
// 与上面几个函数的根本区别：内嵌白板的内容不在 `notes.content` 里，
// 而在磁盘上的独立文件（`kb_assets/images/<note_id>/wb-<uuid>.excalidraw`）。
// 所以内容必须由调用方读好传进来 —— 让快照策略去碰文件系统和解密逻辑，
// 会把这一层的职责搅浑。

/// 内嵌白板覆盖保存前留底。`old_content` 是**即将被覆盖的那一版**场景 JSON。
///
/// 走与笔记正文相同的时间窗节流 + 内容去重：内嵌白板虽然是"确认才保存"
/// （不像整页白板那样自动存），但用户反复微调时照样能一分钟点好几次保存。
pub fn capture_embedded(
    db: &Database,
    note_id: i64,
    rel_path: &str,
    old_content: &str,
) -> bool {
    if old_content.trim().is_empty() || old_content.len() > MAX_BYTES {
        return false;
    }

    let target = Some(rel_path);
    let last_hash = match db.latest_snapshot_stamp(note_id, target) {
        Ok(Some((hash, age_sec))) => {
            if age_sec < AUTO_MIN_INTERVAL_SEC {
                return false;
            }
            Some(hash)
        }
        Ok(None) => None,
        Err(e) => {
            log::warn!("[snapshot] 查内嵌白板最近快照失败，跳过: {}", e);
            return false;
        }
    };
    if let Some(last) = last_hash {
        if crate::services::hash::sha256_hex(old_content) == last {
            return false;
        }
    }

    write(db, note_id, old_content, reason::AUTO, target)
}

/// 列出某块内嵌白板的历史版本。
pub fn list_embedded(
    db: &Database,
    note_id: i64,
    rel_path: &str,
) -> Result<Vec<crate::models::NoteSnapshotMeta>, AppError> {
    db.list_note_snapshots(note_id, Some(rel_path))
}

/// 回滚前给内嵌白板的当前版本留底（不节流，与 `capture_before_restore` 同理）。
pub fn capture_embedded_before_restore(
    db: &Database,
    note_id: i64,
    rel_path: &str,
    current: &str,
) -> bool {
    if current.trim().is_empty() || current.len() > MAX_BYTES {
        return false;
    }
    write(
        db,
        note_id,
        current,
        reason::BEFORE_RESTORE,
        Some(rel_path),
    )
}

// ─── 用量与清理（设置页）──────────────────────────────────
//
// 快照是"悄悄攒数据"的功能：每条笔记留 30 份，重度使用下库会稳步变大，
// 而用户看不见也管不着。这一组给他一个交代。

/// 设置页展示的"占用最大的笔记"条数。
///
/// 10 条足够定位"是哪几块大白板在吃空间"，再多就成了没人看的长列表。
const USAGE_TOP_N: i64 = 10;

/// 全库快照用量。
pub fn usage(db: &Database) -> Result<SnapshotUsage, AppError> {
    db.note_snapshot_usage(USAGE_TOP_N)
}

/// 清理某条笔记的全部历史版本。
pub fn clear_note(db: &Database, note_id: i64) -> Result<usize, AppError> {
    db.delete_note_snapshots(note_id)
}

/// 清理所有超过 `days` 天的历史版本。
pub fn clear_older_than(db: &Database, days: i64) -> Result<usize, AppError> {
    if days < 1 {
        // 0 天等价于"全清"，但那该走 clear_all —— 让调用方明确表达意图，
        // 免得前端某个默认值算成 0 就把用户的全部历史抹了
        return Err(AppError::InvalidInput(
            "天数至少为 1；要清空全部请用「清空所有历史版本」".into(),
        ));
    }
    db.delete_note_snapshots_older_than(days)
}

/// 清空全部历史版本。
pub fn clear_all(db: &Database) -> Result<usize, AppError> {
    db.delete_all_note_snapshots()
}

/// 实际落库 + 裁剪超额份数。
///
/// `target`：None = 笔记正文；Some(相对路径) = 笔记内嵌的那块白板。
/// 份数上限按 target 独立计算 —— 一条笔记里插了三块白板，
/// 不该让它们互相挤掉对方的历史。
fn write(
    db: &Database,
    note_id: i64,
    content: &str,
    reason: &str,
    target: Option<&str>,
) -> bool {
    if let Err(e) = db.insert_note_snapshot(note_id, content, reason, target) {
        log::warn!("[snapshot] 笔记 {} 写快照失败: {}", note_id, e);
        return false;
    }
    if let Err(e) = db.prune_note_snapshots(note_id, MAX_PER_NOTE, target) {
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
        assert_eq!(db.list_note_snapshots(id, None).unwrap().len(), 1);
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
        assert_eq!(db.list_note_snapshots(id, None).unwrap().len(), 1);
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
        assert!(db.list_note_snapshots(id, None).unwrap().is_empty());
    }

    /// 刚建出来还没画过的白板没什么好留的。
    #[test]
    fn empty_content_is_skipped() {
        let db = mem_db();
        let id = new_note(&db, "");
        assert!(!capture_auto(&db, id));
        assert!(db.list_note_snapshots(id, None).unwrap().is_empty());
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
        assert_eq!(db.list_note_snapshots(id, None).unwrap().len(), 2);
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
        assert_eq!(db.list_note_snapshots(id, None).unwrap().len(), 1);
    }

    // ─── 回滚 ────────────────────────────────────────────────

    fn set_content(db: &Database, id: i64, title: &str, content: &str) {
        db.update_note(
            id,
            &NoteInput {
                title: title.into(),
                content: content.into(),
                folder_id: None,
            },
        )
        .unwrap();
    }

    /// 回滚要把正文换回旧版，同时**必须**给当前版本留底 —— 否则"恢复"就是不可逆的。
    #[test]
    fn restore_rolls_back_and_keeps_undo() {
        let db = mem_db();
        let id = new_note(&db, "第一版");
        assert!(capture_manual(&db, id).unwrap());
        let snap_id = db.list_note_snapshots(id, None).unwrap()[0].id;

        set_content(&db, id, "笔记", "第二版");

        let restored = restore(&db, id, snap_id).unwrap();
        assert_eq!(restored.content, "第一版", "正文应回到旧版");
        assert_eq!(restored.title, "笔记", "标题不该被回滚带走");

        let metas = db.list_note_snapshots(id, None).unwrap();
        assert!(
            metas.iter().any(|m| m.reason == reason::BEFORE_RESTORE),
            "回滚前必须给'第二版'留底，否则滚回来就没了"
        );
    }

    /// 白板的 content 是 Excalidraw JSON，回写还要重建 search_text 与画布双链，
    /// 必须走 services::whiteboard 那条路，这里要挡住。
    #[test]
    fn restore_rejects_whiteboard() {
        let db = mem_db();
        let wb = db
            .create_whiteboard(
                &NoteInput {
                    title: "画布".into(),
                    content: r#"{"type":"excalidraw","elements":[]}"#.into(),
                    folder_id: None,
                },
                "",
            )
            .unwrap();
        assert!(capture_manual(&db, wb.id).unwrap());
        let snap_id = db.list_note_snapshots(wb.id, None).unwrap()[0].id;

        assert!(restore(&db, wb.id, snap_id).is_err());
    }

    /// 防前端把 id 传串，拿 A 的历史盖到 B 上。
    #[test]
    fn restore_rejects_foreign_snapshot() {
        let db = mem_db();
        let a = new_note(&db, "A 的内容");
        let b = new_note(&db, "B 的内容");
        assert!(capture_manual(&db, a).unwrap());
        let a_snap = db.list_note_snapshots(a, None).unwrap()[0].id;

        assert!(restore(&db, b, a_snap).is_err());
    }
}
