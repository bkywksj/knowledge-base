//! T-S025 孤儿附件 GC
//!
//! 远端 `attachments/<aa>/<bb>/<hash>` 中可能堆积"已无 manifest 引用"的孤儿附件
//! （笔记被删 / 图片被替换后旧 hash 没人引用了）。本模块负责标记并清理。
//!
//! ## 安全策略：宽限期标记
//! - 不立即删除——首次发现孤儿只"打标记"，记录到远端 `attachments/_gc_marks.json`
//! - 超过 [`GC_GRACE_DAYS`] 天仍是孤儿才真删（防止"某端 push 了笔记但还没 push manifest"
//!   这种短暂窗口误删；也给跨设备同步留缓冲时间）
//! - 一旦某 hash 又被引用，从标记里移除
//!
//! ## 触发
//! - 手动 Command `sync_v1_gc_attachments`（设置页"清理孤儿附件"按钮）
//! - 不在 push/pull 流程里自动跑（list_attachment_hashes 可能很慢，按需触发）
//!
//! ## backend 支持情况
//! - Local / S3：支持（walkdir / ListObjects）
//! - WebDAV：暂返回空（递归 PROPFIND 待后续），GC 对 WebDAV 是 no-op

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::AppError;

use super::backend::SyncBackendImpl;

/// 孤儿宽限天数：首次发现孤儿后保留多久才真删
pub const GC_GRACE_DAYS: i64 = 7;

/// GC 标记文件在远端的路径（也存在 attachments/ 下，但以 `_` 开头，
/// list_attachment_hashes 的实现会过滤掉它）
const GC_MARKS_PATH: &str = "attachments/_gc_marks.json";

/// GC 标记文件内容：hash -> "首次发现是孤儿"的本地时间戳（`%Y-%m-%d %H:%M:%S`）
#[derive(Debug, Default, Serialize, Deserialize)]
struct GcMarks {
    #[serde(default)]
    marks: HashMap<String, String>,
}

/// GC 执行结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GcResult {
    /// 本次真删除的孤儿附件数（超过宽限期）
    pub deleted: usize,
    /// 本次新打标记的孤儿数（还在宽限期内，未删）
    pub newly_marked: usize,
    /// 之前被标记但现在又被引用 → 移除标记的数量
    pub unmarked: usize,
    /// 远端 attachments/ 下的附件总数（统计参考）
    pub remote_total: usize,
    /// 出错信息（单个文件删除失败不阻塞整体）
    pub errors: Vec<String>,
}

/// 解析时间戳字符串为 chrono 时间（失败返回 None）
fn parse_ts(s: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
}

/// 执行附件 GC
///
/// 流程：
/// 1. `remote_hashes` = backend.list_attachment_hashes()（远端有哪些附件文件）
/// 2. `referenced` = 远端 manifest.attachments 引用的 hash（用远端 manifest 而非本地索引，
///    避免本地索引不全误删；无 manifest 直接放弃 GC）
/// 3. `orphans` = remote_hashes - referenced
/// 4. 读 `_gc_marks.json`：
///    - orphan 在标记里 + 已超 GC_GRACE_DAYS → 删除 + 移除标记
///    - orphan 在标记里 + 未超期 → 保留标记
///    - orphan 不在标记里 → 新打标记（记当前时间）
///    - 标记里的 hash 已不是 orphan（又被引用了）→ 移除标记
/// 5. 写回 `_gc_marks.json`
pub fn gc_attachments(
    _db: &Database,
    backend: &dyn SyncBackendImpl,
) -> Result<GcResult, AppError> {
    let mut result = GcResult::default();

    // 1. 远端附件文件清单
    let remote_hashes: HashSet<String> = backend
        .list_attachment_hashes()?
        .into_iter()
        .collect();
    result.remote_total = remote_hashes.len();
    if remote_hashes.is_empty() {
        return Ok(result); // 远端没附件 / backend 不支持列举 → no-op
    }

    // 2. manifest 引用的 hash —— 必须用远端 manifest（保守，防止本地索引不全误删）
    let referenced: HashSet<String> = match backend.read_manifest()? {
        Some(m) => m.attachments.iter().map(|a| a.hash.clone()).collect(),
        None => {
            // 远端连 manifest 都没有，无法判断哪些被引用 → 不敢删任何东西
            log::warn!("[attachment-gc] 远端无 manifest，跳过 GC（避免误删）");
            return Ok(result);
        }
    };

    // 3. 孤儿集合
    let orphans: HashSet<String> = remote_hashes.difference(&referenced).cloned().collect();

    // 4. 读取标记文件（不存在 → 空标记）
    let mut marks: GcMarks = match backend.get_note(GC_MARKS_PATH) {
        Ok(Some(s)) => serde_json::from_str(&s).unwrap_or_default(),
        Ok(None) => GcMarks::default(),
        Err(e) => {
            log::warn!("[attachment-gc] 读取标记文件失败 ({}), 当作空标记继续", e);
            GcMarks::default()
        }
    };

    let now = chrono::Local::now().naive_local();
    let grace = chrono::Duration::days(GC_GRACE_DAYS);

    // 4a. 移除"已不是孤儿"的标记
    let no_longer_orphan: Vec<String> = marks
        .marks
        .keys()
        .filter(|h| !orphans.contains(h.as_str()))
        .cloned()
        .collect();
    for h in no_longer_orphan {
        marks.marks.remove(&h);
        result.unmarked += 1;
    }

    // 4b. 处理当前孤儿
    let mut to_delete: Vec<String> = Vec::new();
    for h in &orphans {
        match marks.marks.get(h) {
            Some(first_seen) => {
                // 已标记过 → 看是否超期
                let expired = parse_ts(first_seen)
                    .map(|ts| now.signed_duration_since(ts) >= grace)
                    .unwrap_or(true); // 时间戳损坏 → 视为已超期，本次删
                if expired {
                    to_delete.push(h.clone());
                }
            }
            None => {
                // 首次发现孤儿 → 打标记
                marks
                    .marks
                    .insert(h.clone(), now.format("%Y-%m-%d %H:%M:%S").to_string());
                result.newly_marked += 1;
            }
        }
    }

    // 4c. 删除超期孤儿（用 delete_note，路径是 cas_path）
    for h in &to_delete {
        let path = super::backend::cas_path(h);
        match backend.delete_note(&path) {
            Ok(_) => {
                marks.marks.remove(h);
                result.deleted += 1;
            }
            Err(e) => result.errors.push(format!("删除孤儿附件 {} 失败: {}", h, e)),
        }
    }

    // 5. 写回标记文件
    let json = serde_json::to_string_pretty(&marks)
        .map_err(|e| AppError::Custom(format!("序列化 GC 标记失败: {}", e)))?;
    if let Err(e) = backend.put_note(GC_MARKS_PATH, &json) {
        result.errors.push(format!("写回 GC 标记文件失败: {}", e));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ts_roundtrip() {
        let s = "2026-05-11 12:34:56";
        let dt = parse_ts(s).expect("应能解析");
        assert_eq!(dt.format("%Y-%m-%d %H:%M:%S").to_string(), s);
        assert_eq!(parse_ts("not a date"), None);
    }

    #[test]
    fn gc_marks_serde_default() {
        // 旧/空文件反序列化为空标记
        let m: GcMarks = serde_json::from_str("{}").unwrap();
        assert!(m.marks.is_empty());
        let m: GcMarks = serde_json::from_str(r#"{"marks":{"abc":"2026-01-01 00:00:00"}}"#).unwrap();
        assert_eq!(m.marks.len(), 1);
        assert_eq!(m.marks.get("abc").map(|s| s.as_str()), Some("2026-01-01 00:00:00"));
    }

    /// 用 LocalPathBackend 跑完整 GC 流程：
    /// - 远端有 3 个附件，manifest 引用 1 个 → 2 个孤儿
    /// - 首轮：2 个新标记，0 删除
    /// - 把标记时间改成 8 天前 → 第二轮：2 个删除
    #[test]
    fn gc_e2e_grace_then_delete() {
        use super::super::backend::SyncBackendImpl;
        use super::super::backend_local::LocalPathBackend;
        use crate::models::{AttachmentEntry, SyncManifestV1};

        let dir = std::env::temp_dir().join(format!(
            "kb-gc-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();

        // 三个附件 hash（合法 64 hex 长度，cas_path 才能分桶）
        let h_keep = "aaaa000000000000000000000000000000000000000000000000000000000001";
        let h_orphan1 = "bbbb000000000000000000000000000000000000000000000000000000000002";
        let h_orphan2 = "cccc000000000000000000000000000000000000000000000000000000000003";
        for h in [h_keep, h_orphan1, h_orphan2] {
            backend.put_attachment(h, format!("data-{}", h).as_bytes()).unwrap();
        }

        // manifest 只引用 h_keep
        let manifest = SyncManifestV1 {
            manifest_version: 1,
            app_version: "test".into(),
            device: "host".into(),
            generated_at: "2026-05-11 00:00:00".into(),
            entries: vec![],
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![AttachmentEntry {
                hash: h_keep.into(),
                size: 9,
                mime: None,
                ext: None,
                paths: vec![],
            }],
            projects: vec![],
            tasks: vec![],
            task_categories: vec![],
        };
        backend.write_manifest(&manifest).unwrap();

        let db = Database::init(":memory:").unwrap();

        // 第一轮：两个孤儿应被标记，不删
        let r1 = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r1.remote_total, 3);
        assert_eq!(r1.newly_marked, 2, "首轮应新标记 2 个孤儿");
        assert_eq!(r1.deleted, 0, "首轮不删");
        // 三个文件都还在
        assert!(backend.has_attachment(h_keep).unwrap());
        assert!(backend.has_attachment(h_orphan1).unwrap());
        assert!(backend.has_attachment(h_orphan2).unwrap());

        // 把标记时间改成 8 天前（超过宽限期）
        let eight_days_ago = (chrono::Local::now() - chrono::Duration::days(8))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let fake_marks = format!(
            r#"{{"marks":{{"{}":"{}","{}":"{}"}}}}"#,
            h_orphan1, eight_days_ago, h_orphan2, eight_days_ago
        );
        backend.put_note("attachments/_gc_marks.json", &fake_marks).unwrap();

        // 第二轮：两个孤儿超期 → 删除
        let r2 = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r2.deleted, 2, "第二轮应删 2 个超期孤儿");
        assert!(backend.has_attachment(h_keep).unwrap(), "被引用的不删");
        assert!(!backend.has_attachment(h_orphan1).unwrap(), "孤儿1 应被删");
        assert!(!backend.has_attachment(h_orphan2).unwrap(), "孤儿2 应被删");

        // 第三轮：无孤儿 → no-op
        let r3 = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r3.deleted, 0);
        assert_eq!(r3.newly_marked, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 标记的 hash 又被引用 → 应移除标记
    #[test]
    fn gc_unmark_when_referenced_again() {
        use super::super::backend::SyncBackendImpl;
        use super::super::backend_local::LocalPathBackend;
        use crate::models::{AttachmentEntry, SyncManifestV1};

        let dir = std::env::temp_dir().join(format!(
            "kb-gc-unmark-{}",
            std::process::id()
        ));
        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();

        let h = "dddd000000000000000000000000000000000000000000000000000000000004";
        backend.put_attachment(h, b"data").unwrap();

        // 第一轮：manifest 不引用 h → h 是孤儿，被标记
        let manifest_empty = SyncManifestV1 {
            manifest_version: 1,
            app_version: "t".into(),
            device: "h".into(),
            generated_at: "x".into(),
            entries: vec![],
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![],
            projects: vec![],
            tasks: vec![],
            task_categories: vec![],
        };
        backend.write_manifest(&manifest_empty).unwrap();
        let db = Database::init(":memory:").unwrap();
        let r1 = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r1.newly_marked, 1);

        // 第二轮：manifest 现在引用 h → h 不再是孤儿，标记应被移除
        let manifest_ref = SyncManifestV1 {
            attachments: vec![AttachmentEntry {
                hash: h.into(),
                size: 4,
                mime: None,
                ext: None,
                paths: vec![],
            }],
            ..manifest_empty
        };
        backend.write_manifest(&manifest_ref).unwrap();
        let r2 = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r2.unmarked, 1, "重新被引用 → 移除标记");
        assert_eq!(r2.deleted, 0);
        assert!(backend.has_attachment(h).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 远端无 manifest → 不敢删任何东西
    #[test]
    fn gc_no_manifest_does_nothing() {
        use super::super::backend::SyncBackendImpl;
        use super::super::backend_local::LocalPathBackend;

        let dir = std::env::temp_dir().join(format!("kb-gc-nomanifest-{}", std::process::id()));
        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();
        let h = "eeee000000000000000000000000000000000000000000000000000000000005";
        backend.put_attachment(h, b"x").unwrap();

        let db = Database::init(":memory:").unwrap();
        let r = gc_attachments(&db, &backend).unwrap();
        assert_eq!(r.deleted, 0);
        assert_eq!(r.newly_marked, 0, "无 manifest 时连标记都不打");
        assert!(backend.has_attachment(h).unwrap(), "无 manifest 时不删");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
