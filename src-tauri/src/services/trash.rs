use std::path::Path;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{PageResult, RestoreBatchResult, TrashAutoPurge, TrashNote};
use crate::services::attachment::AttachmentService;
use crate::services::image::ImageService;
use crate::services::pdf::PdfService;

/// 自动清理天数（app_config）；缺省 = [`DEFAULT_PURGE_DAYS`]，"0" = 从不
const KEY_PURGE_DAYS: &str = "trash.auto_purge_days";
/// 自动清理规则生效时间（app_config），见 [`TrashAutoPurge::since`]
const KEY_PURGE_SINCE: &str = "trash.auto_purge_since";
/// 默认删除满 30 天自动清理（2026-11-04 用户选定）
const DEFAULT_PURGE_DAYS: u32 = 30;
/// 界面上给的选项；别的值一律拒绝，免得手改配置写进 1 天这种一不小心就删光的值
const PURGE_DAYS_CHOICES: [u32; 4] = [0, 7, 30, 90];

fn now_local() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 后台定时清理回收站：启动 1 分钟后跑一次（不跟启动抢 IO），之后每 6 小时一次。
/// 精度要求低（按天算的规则），不必像待办提醒那样精确唤醒
pub async fn run_auto_purge_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
        let app2 = app.clone();
        let res = tokio::task::spawn_blocking(move || {
            // setup 降级启动时可能没注册 AppState，用 try_state 别 panic
            match app2.try_state::<crate::state::AppState>() {
                Some(state) => TrashService::auto_purge(&state.db, &state.data_dir),
                None => Ok(0),
            }
        })
        .await;
        match res {
            Ok(Err(e)) => log::warn!("回收站自动清理失败: {}", e),
            Err(e) => log::warn!("回收站自动清理任务异常: {}", e),
            Ok(Ok(_)) => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
    }
}

/// 回收站服务
pub struct TrashService;

impl TrashService {
    /// 清理某笔记的所有关联文件（图片目录 + 附件目录 + 源文件副本）
    /// 文件层失败仅 warn，不阻塞数据库删除流程
    fn cleanup_note_assets(data_dir: &Path, note_id: i64, source_file_path: &Option<String>) {
        // 1. 删图片目录 kb_assets/images/<id>/
        if let Err(e) = ImageService::delete_note_images(data_dir, note_id) {
            log::warn!("删除笔记 {} 图片目录失败: {}", note_id, e);
        }

        // 2. 删附件目录 kb_assets/attachments/<id>/
        if let Err(e) = AttachmentService::delete_note_attachments(data_dir, note_id) {
            log::warn!("删除笔记 {} 附件目录失败: {}", note_id, e);
        }

        // 3. 删源文件（可能是 sources/<id>.docx、pdfs/<id>.pdf 等）
        //    旧格式 pdfs/<id>.pdf 走这里；新格式 pdfs/<id>/<原名>.pdf 也能被
        //    单文件 remove_file 删掉，但会留下空 pdfs/<id>/ 目录，由下面第 4 步兜底
        if let Some(rel) = source_file_path {
            let abs = data_dir.join(rel);
            if abs.exists() {
                if let Err(e) = std::fs::remove_file(&abs) {
                    log::warn!("删除源文件 {:?} 失败: {}", abs, e);
                } else {
                    log::info!("已删除笔记 {} 源文件: {}", note_id, rel);
                }
            }
        }

        // 4. 删 PDF 子目录 pdfs/<id>/（新方案 C 格式：每个笔记独占目录）
        //    旧格式 pdfs/<id>.pdf 是单文件，这里 is_dir 检查会跳过，互不冲突
        if let Err(e) = PdfService::delete_note_pdfs(data_dir, note_id) {
            log::warn!("删除笔记 {} PDF 子目录失败: {}", note_id, e);
        }
    }
    /// 软删除笔记（移入回收站）
    pub fn soft_delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.soft_delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或已在回收站",
                id
            )));
        }
        Ok(())
    }

    /// 恢复笔记（从回收站恢复）
    ///
    /// 返回值：true = 恢复到原文件夹，false = 落到根目录
    /// （原文件夹被删时外键 ON DELETE SET NULL 已经把 folder_id 抹了）
    pub fn restore(db: &Database, id: i64) -> Result<bool, AppError> {
        // 在 restore 前先 snapshot folder_id（restore 只改 is_deleted，folder_id 不变）
        let folder_id = db.get_note_folder_id(id)?;
        let restored = db.restore_note(id)?;
        if !restored {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或不在回收站",
                id
            )));
        }
        Ok(folder_id.is_some())
    }

    /// 永久删除笔记（连带清理图片 + 源文件）
    pub fn permanent_delete(db: &Database, data_dir: &Path, id: i64) -> Result<(), AppError> {
        // 先查 source_file_path（DB 行删掉后就拿不到了）
        let source = db.get_note_source_path(id)?;

        // 删 DB 行（外键 ON DELETE CASCADE 会自动清 note_tags/note_links，
        // FTS 触发器会清 notes_fts）
        let deleted = db.permanent_delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!(
                "笔记 {} 不存在或不在回收站",
                id
            )));
        }

        // DB 成功后再清理文件（失败仅 warn）
        Self::cleanup_note_assets(data_dir, id, &source);
        Ok(())
    }

    /// 查询回收站（分页）
    pub fn list(
        db: &Database,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PageResult<TrashNote>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_trash(page, page_size)?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 批量恢复
    ///
    /// 返回 (restored=实际恢复条数, to_root=其中落到根目录的条数)。
    /// 不在回收站的 id 静默跳过。
    pub fn restore_batch(db: &Database, ids: &[i64]) -> Result<RestoreBatchResult, AppError> {
        if ids.is_empty() {
            return Ok(RestoreBatchResult {
                restored: 0,
                to_root: 0,
            });
        }
        let mut restored = 0usize;
        let mut to_root = 0usize;
        for id in ids {
            // 先记 folder_id；查不到就当无原文件夹处理
            let folder_id = db.get_note_folder_id(*id).unwrap_or(None);
            if db.restore_note(*id)? {
                restored += 1;
                if folder_id.is_none() {
                    to_root += 1;
                }
            }
        }
        Ok(RestoreBatchResult { restored, to_root })
    }

    /// 批量永久删除（清理资产 + 删 DB 行）；不在回收站的 id 静默跳过
    pub fn permanent_delete_batch(
        db: &Database,
        data_dir: &Path,
        ids: &[i64],
    ) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut count = 0usize;
        for id in ids {
            // 先查 source_path（删行后就拿不到了）；查不到就视为无源文件
            let source = db.get_note_source_path(*id).unwrap_or(None);
            if db.permanent_delete_note(*id)? {
                Self::cleanup_note_assets(data_dir, *id, &source);
                count += 1;
            }
        }
        Ok(count)
    }

    /// 读自动清理设置。
    ///
    /// 第一次读（升级到带自动清理的版本后）把「现在」记成生效时间并落库：
    /// 老用户回收站里的存量笔记从这一刻起算，不会一升级就被成批永久删除。
    pub fn auto_purge_settings(db: &Database) -> Result<TrashAutoPurge, AppError> {
        let days = db
            .get_config(KEY_PURGE_DAYS)?
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|d| PURGE_DAYS_CHOICES.contains(d))
            .unwrap_or(DEFAULT_PURGE_DAYS);
        let since = match db.get_config(KEY_PURGE_SINCE)? {
            Some(s) if !s.trim().is_empty() => s,
            _ => {
                let now = now_local();
                db.set_config(KEY_PURGE_SINCE, &now)?;
                now
            }
        };
        Ok(TrashAutoPurge { days, since })
    }

    /// 改自动清理天数。生效时间同时重置为现在：
    /// 改短天数不会让已在回收站里的笔记立刻被删，用户总有 days 天反悔
    pub fn set_auto_purge_days(db: &Database, days: u32) -> Result<TrashAutoPurge, AppError> {
        if !PURGE_DAYS_CHOICES.contains(&days) {
            return Err(AppError::InvalidInput(format!(
                "自动清理天数只能是 {:?} 之一",
                PURGE_DAYS_CHOICES
            )));
        }
        let since = now_local();
        db.set_config(KEY_PURGE_DAYS, &days.to_string())?;
        db.set_config(KEY_PURGE_SINCE, &since)?;
        Ok(TrashAutoPurge { days, since })
    }

    /// 按设置永久删除到期的回收站笔记（连带图片 / 附件 / 源文件），返回删除条数
    pub fn auto_purge(db: &Database, data_dir: &Path) -> Result<usize, AppError> {
        Self::auto_purge_at(db, data_dir, &now_local())
    }

    fn auto_purge_at(db: &Database, data_dir: &Path, now: &str) -> Result<usize, AppError> {
        let s = Self::auto_purge_settings(db)?;
        if s.days == 0 {
            return Ok(0);
        }
        let ids = db.list_expired_trash_ids(s.days, &s.since, now)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let n = Self::permanent_delete_batch(db, data_dir, &ids)?;
        log::info!("回收站自动清理：删除满 {} 天的 {} 篇笔记已永久删除", s.days, n);
        Ok(n)
    }

    /// 清空回收站（连带清理所有关联图片 + 源文件）
    pub fn empty(db: &Database, data_dir: &Path) -> Result<usize, AppError> {
        // 先拿到所有待删笔记的 (id, source_path)
        let items = db.list_trash_ids_with_sources()?;

        // 删 DB 行（一次性批量）
        let affected = db.empty_trash()?;

        // DB 成功后逐个清文件
        for (id, source) in &items {
            Self::cleanup_note_assets(data_dir, *id, source);
        }

        log::info!(
            "清空回收站: DB 删除 {} 条，清理 {} 个笔记的资产",
            affected,
            items.len()
        );
        Ok(affected)
    }
}

#[cfg(test)]
mod auto_purge_tests {
    use super::*;
    use crate::models::NoteInput;

    fn trashed(db: &Database, deleted_at: Option<&str>) -> i64 {
        let id = db
            .create_note(&NoteInput {
                title: "t".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap()
            .id;
        db.soft_delete_note(id).unwrap();
        let conn = db.conn_lock().unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at = ?1 WHERE id = ?2",
            rusqlite::params![deleted_at, id],
        )
        .unwrap();
        id
    }

    fn exists(db: &Database, id: i64) -> bool {
        let conn = db.conn_lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM notes WHERE id = ?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
            > 0
    }

    fn setup(days: &str, since: &str) -> (Database, std::path::PathBuf) {
        let db = Database::init(":memory:").unwrap();
        db.set_config(KEY_PURGE_DAYS, days).unwrap();
        db.set_config(KEY_PURGE_SINCE, since).unwrap();
        // 删资产目录时用；目录不存在只会 warn
        let dir = std::env::temp_dir().join(format!("kb-purge-test-{}", std::process::id()));
        (db, dir)
    }

    /// 生效前就在回收站里的笔记从生效时间起算：一升级不能把老东西成批删掉
    #[test]
    fn old_items_count_from_since_not_deleted_at() {
        let (db, dir) = setup("30", "2026-11-01 00:00:00");
        let old = trashed(&db, Some("2025-01-01 00:00:00"));
        let no_time = trashed(&db, None);

        assert_eq!(TrashService::auto_purge_at(&db, &dir, "2026-11-30 23:59:59").unwrap(), 0);
        assert!(exists(&db, old) && exists(&db, no_time));

        assert_eq!(TrashService::auto_purge_at(&db, &dir, "2026-12-01 00:00:00").unwrap(), 2);
        assert!(!exists(&db, old) && !exists(&db, no_time));
    }

    #[test]
    fn new_items_count_from_deleted_at() {
        let (db, dir) = setup("7", "2026-01-01 00:00:00");
        let a = trashed(&db, Some("2026-11-01 10:00:00"));
        let b = trashed(&db, Some("2026-11-05 10:00:00"));
        assert_eq!(TrashService::auto_purge_at(&db, &dir, "2026-11-08 10:00:00").unwrap(), 1);
        assert!(!exists(&db, a));
        assert!(exists(&db, b), "没满 7 天的不能删");
    }

    #[test]
    fn zero_days_never_purges_and_live_notes_untouched() {
        let (db, dir) = setup("0", "2020-01-01 00:00:00");
        let t = trashed(&db, Some("2020-01-01 00:00:00"));
        assert_eq!(TrashService::auto_purge_at(&db, &dir, "2030-01-01 00:00:00").unwrap(), 0);
        assert!(exists(&db, t));

        // 正常笔记无论多老都不碰
        let (db, dir) = setup("7", "2020-01-01 00:00:00");
        let live = db
            .create_note(&NoteInput {
                title: "活".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap()
            .id;
        TrashService::auto_purge_at(&db, &dir, "2030-01-01 00:00:00").unwrap();
        assert!(exists(&db, live));
    }

    #[test]
    fn first_read_records_since_and_defaults_to_30() {
        let db = Database::init(":memory:").unwrap();
        let s = TrashService::auto_purge_settings(&db).unwrap();
        assert_eq!(s.days, 30);
        assert_eq!(db.get_config(KEY_PURGE_SINCE).unwrap(), Some(s.since.clone()));
        // 再读不会挪动生效时间
        assert_eq!(TrashService::auto_purge_settings(&db).unwrap().since, s.since);
    }

    #[test]
    fn set_days_validates_and_resets_since() {
        let db = Database::init(":memory:").unwrap();
        db.set_config(KEY_PURGE_SINCE, "2020-01-01 00:00:00").unwrap();
        assert!(TrashService::set_auto_purge_days(&db, 1).is_err());
        let s = TrashService::set_auto_purge_days(&db, 7).unwrap();
        assert_eq!(s.days, 7);
        assert_ne!(s.since, "2020-01-01 00:00:00", "改天数要重置生效时间");
    }
}
