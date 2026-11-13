//! v72：闪卡 / 复习记录 / 提示词 / 笔记模板的同步读写
//!
//! 只给 sync_v1 用：读出带 stable_uuid 的全量行拼 manifest，拉取时按 stable_uuid 落库。
//! 拉取写入一律用远端的 updated_at，不打本地时间戳 —— 否则刚拉下来的条目会显得比远端新，
//! 下一轮又被当成本地改动推回去。

use rusqlite::{params, OptionalExtension};

use super::Database;
use crate::error::AppError;
use crate::models::{
    CardManifestEntry, CardReviewLogManifestEntry, NoteTemplateManifestEntry, PromptManifestEntry,
};

/// `sync_tombstones.kind` 取值
pub const TOMBSTONE_KIND_PROMPT: &str = "prompt";
pub const TOMBSTONE_KIND_NOTE_TEMPLATE: &str = "note_template";

impl Database {
    // ─── 闪卡 ─────────────────────────────────────────────────

    /// 未删除的卡片 + `updated_at >= tombstone_cutoff` 的已删卡片（作为 tombstone）。
    /// content_hash 留空，由 manifest 层统一计算。
    pub fn list_cards_for_sync(
        &self,
        tombstone_cutoff: &str,
    ) -> Result<Vec<CardManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT c.stable_uuid, c.updated_at, c.front, c.back, c.deck, n.stable_uuid,
                    c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days,
                    c.reps, c.lapses, c.state, c.last_review, c.is_deleted
             FROM cards c LEFT JOIN notes n ON n.id = c.note_id
             WHERE c.stable_uuid IS NOT NULL
               AND (c.is_deleted = 0 OR c.updated_at >= ?1)",
        )?;
        let rows = stmt
            .query_map(params![tombstone_cutoff], |r| {
                Ok(CardManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    front: r.get(2)?,
                    back: r.get(3)?,
                    deck: r.get(4)?,
                    note_uuid: r.get(5)?,
                    due: r.get(6)?,
                    stability: r.get(7)?,
                    difficulty: r.get(8)?,
                    elapsed_days: r.get(9)?,
                    scheduled_days: r.get(10)?,
                    reps: r.get(11)?,
                    lapses: r.get(12)?,
                    state: r.get(13)?,
                    last_review: r.get(14)?,
                    tombstone: r.get::<_, i64>(15)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 stable_uuid 找卡片（含已删除的 —— 远端复活 / 更新时要命中同一行）
    pub fn get_card_sync_ref(
        &self,
        stable_uuid: &str,
    ) -> Result<Option<(i64, Option<String>)>, AppError> {
        let conn = self.conn_lock()?;
        let row = conn
            .query_row(
                "SELECT id, last_review FROM cards WHERE stable_uuid = ?1",
                params![stable_uuid],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// 拉取落库：本地没有 → 插入；有 → 覆盖内容。
    /// `keep_local_schedule=true` 时不动调度字段（本地复习得更晚，见 manifest::adopt_newer_schedule）。
    pub fn upsert_card_synced(
        &self,
        e: &CardManifestEntry,
        note_id: Option<i64>,
        keep_local_schedule: bool,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM cards WHERE stable_uuid = ?1",
                params![e.stable_id],
                |r| r.get(0),
            )
            .optional()?;
        let deleted = i64::from(e.tombstone);
        match existing {
            None => {
                conn.execute(
                    "INSERT INTO cards (stable_uuid, note_id, front, back, deck, due, stability,
                        difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review,
                        is_deleted, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![
                        e.stable_id,
                        note_id,
                        e.front,
                        e.back,
                        e.deck,
                        e.due,
                        e.stability,
                        e.difficulty,
                        e.elapsed_days,
                        e.scheduled_days,
                        e.reps,
                        e.lapses,
                        e.state,
                        e.last_review,
                        deleted,
                        e.updated_at,
                    ],
                )?;
            }
            Some(id) => {
                conn.execute(
                    "UPDATE cards SET note_id = ?1, front = ?2, back = ?3, deck = ?4,
                        is_deleted = ?5, updated_at = ?6 WHERE id = ?7",
                    params![note_id, e.front, e.back, e.deck, deleted, e.updated_at, id],
                )?;
                if !keep_local_schedule {
                    conn.execute(
                        "UPDATE cards SET due = ?1, stability = ?2, difficulty = ?3,
                            elapsed_days = ?4, scheduled_days = ?5, reps = ?6, lapses = ?7,
                            state = ?8, last_review = ?9 WHERE id = ?10",
                        params![
                            e.due,
                            e.stability,
                            e.difficulty,
                            e.elapsed_days,
                            e.scheduled_days,
                            e.reps,
                            e.lapses,
                            e.state,
                            e.last_review,
                            id,
                        ],
                    )?;
                }
            }
        }
        Ok(())
    }

    /// `review >= cutoff` 的复习记录（所属卡片要有 stable_uuid）
    pub fn list_card_logs_for_sync(
        &self,
        cutoff: &str,
    ) -> Result<Vec<CardReviewLogManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT l.stable_uuid, c.stable_uuid, l.rating, l.state, l.due, l.stability,
                    l.difficulty, l.elapsed_days, l.last_elapsed_days, l.scheduled_days, l.review
             FROM card_review_logs l JOIN cards c ON c.id = l.card_id
             WHERE l.stable_uuid IS NOT NULL AND c.stable_uuid IS NOT NULL AND l.review >= ?1",
        )?;
        let rows = stmt
            .query_map(params![cutoff], |r| {
                Ok(CardReviewLogManifestEntry {
                    stable_id: r.get(0)?,
                    card_uuid: r.get(1)?,
                    rating: r.get(2)?,
                    state: r.get(3)?,
                    due: r.get(4)?,
                    stability: r.get(5)?,
                    difficulty: r.get(6)?,
                    elapsed_days: r.get(7)?,
                    last_elapsed_days: r.get(8)?,
                    scheduled_days: r.get(9)?,
                    review: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 插入一条远端复习记录；卡片在本端不存在时返回 Ok(false)，已存在同 stable_uuid 时忽略
    pub fn insert_card_log_synced(&self, e: &CardReviewLogManifestEntry) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let card_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM cards WHERE stable_uuid = ?1",
                params![e.card_uuid],
                |r| r.get(0),
            )
            .optional()?;
        let Some(card_id) = card_id else {
            return Ok(false);
        };
        conn.execute(
            "INSERT OR IGNORE INTO card_review_logs (stable_uuid, card_id, rating, state, due,
                stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, review)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                e.stable_id,
                card_id,
                e.rating,
                e.state,
                e.due,
                e.stability,
                e.difficulty,
                e.elapsed_days,
                e.last_elapsed_days,
                e.scheduled_days,
                e.review,
            ],
        )?;
        Ok(true)
    }

    // ─── 提示词 ───────────────────────────────────────────────

    /// 全部提示词（tombstone 由 [`Self::list_sync_tombstones`] 另外补）
    pub fn list_prompts_for_sync(&self) -> Result<Vec<PromptManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, updated_at, title, description, prompt, output_mode, icon,
                    builtin_code, sort_order, enabled
             FROM prompt_templates WHERE stable_uuid IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PromptManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    prompt: r.get(4)?,
                    output_mode: r.get(5)?,
                    icon: r.get(6)?,
                    builtin_code: r.get(7)?,
                    sort_order: r.get(8)?,
                    enabled: r.get::<_, i64>(9)? != 0,
                    tombstone: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 拉取落库：本地没有 → 插入（同时清掉本地对它的删除记录）；有 → 覆盖
    pub fn upsert_prompt_synced(&self, e: &PromptManifestEntry) -> Result<(), AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE prompt_templates SET title = ?1, description = ?2, prompt = ?3,
                output_mode = ?4, icon = ?5, sort_order = ?6, enabled = ?7, updated_at = ?8
             WHERE stable_uuid = ?9",
            params![
                e.title,
                e.description,
                e.prompt,
                e.output_mode,
                e.icon,
                e.sort_order,
                i64::from(e.enabled),
                e.updated_at,
                e.stable_id,
            ],
        )?;
        if updated == 0 {
            tx.execute(
                "INSERT INTO prompt_templates (stable_uuid, title, description, prompt, output_mode,
                    icon, is_builtin, builtin_code, sort_order, enabled, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    e.stable_id,
                    e.title,
                    e.description,
                    e.prompt,
                    e.output_mode,
                    e.icon,
                    i64::from(e.builtin_code.is_some()),
                    e.builtin_code,
                    e.sort_order,
                    i64::from(e.enabled),
                    e.updated_at,
                ],
            )?;
        }
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = ?1 AND stable_uuid = ?2",
            params![TOMBSTONE_KIND_PROMPT, e.stable_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ─── 笔记模板 ─────────────────────────────────────────────

    pub fn list_note_templates_for_sync(&self) -> Result<Vec<NoteTemplateManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, COALESCE(updated_at, created_at), name, description, content
             FROM note_templates WHERE stable_uuid IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NoteTemplateManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    name: r.get(2)?,
                    description: r.get(3)?,
                    content: r.get(4)?,
                    tombstone: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn upsert_note_template_synced(&self, e: &NoteTemplateManifestEntry) -> Result<(), AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE note_templates SET name = ?1, description = ?2, content = ?3, updated_at = ?4
             WHERE stable_uuid = ?5",
            params![e.name, e.description, e.content, e.updated_at, e.stable_id],
        )?;
        if updated == 0 {
            tx.execute(
                "INSERT INTO note_templates (stable_uuid, name, description, content, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![e.stable_id, e.name, e.description, e.content, e.updated_at],
            )?;
        }
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = ?1 AND stable_uuid = ?2",
            params![TOMBSTONE_KIND_NOTE_TEMPLATE, e.stable_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ─── 删除记录 ─────────────────────────────────────────────

    /// 某类的删除记录：(stable_uuid, deleted_at)，只取 `deleted_at >= cutoff` 的
    pub fn list_sync_tombstones(
        &self,
        kind: &str,
        cutoff: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, deleted_at FROM sync_tombstones
             WHERE kind = ?1 AND deleted_at >= ?2",
        )?;
        let rows = stmt
            .query_map(params![kind, cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按远端删除事件删掉本地行（提示词 / 笔记模板）。
    /// DELETE 触发器会写一条删除记录，时间改成远端的删除时间：
    /// 用本机当前时间的话，这条删除会显得比别端随后的编辑还新。
    pub fn delete_synced_by_uuid(
        &self,
        kind: &str,
        stable_uuid: &str,
        deleted_at: &str,
    ) -> Result<bool, AppError> {
        let table = match kind {
            TOMBSTONE_KIND_PROMPT => "prompt_templates",
            TOMBSTONE_KIND_NOTE_TEMPLATE => "note_templates",
            _ => return Err(AppError::Custom(format!("未知的删除记录类型: {}", kind))),
        };
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let affected = tx.execute(
            &format!("DELETE FROM {} WHERE stable_uuid = ?1", table),
            params![stable_uuid],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_tombstones (kind, stable_uuid, deleted_at)
             VALUES (?1, ?2, ?3)",
            params![kind, stable_uuid, deleted_at],
        )?;
        tx.commit()?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str) -> CardManifestEntry {
        CardManifestEntry {
            stable_id: id.into(),
            content_hash: String::new(),
            updated_at: "2026-11-01 10:00:00".into(),
            front: "Q".into(),
            back: "A".into(),
            deck: "default".into(),
            note_uuid: None,
            due: "2026-11-02 10:00:00".into(),
            stability: 1.5,
            difficulty: 5.0,
            elapsed_days: 0,
            scheduled_days: 1,
            reps: 1,
            lapses: 0,
            state: 1,
            last_review: Some("2026-11-01 10:00:00".into()),
            tombstone: false,
        }
    }

    #[test]
    fn migration_fills_uuids_for_new_rows_and_presets() {
        let db = Database::init(":memory:").unwrap();
        // 预置笔记模板固定 stable_id
        let tpls = db.list_note_templates_for_sync().unwrap();
        assert!(tpls.iter().any(|t| t.stable_id == "preset:周报"), "{:?}", tpls);
        // 内置提示词固定为 builtin:<code>
        let prompts = db.list_prompts_for_sync().unwrap();
        assert!(!prompts.is_empty());
        assert!(prompts
            .iter()
            .filter(|p| p.builtin_code.is_some())
            .all(|p| p.stable_id == format!("builtin:{}", p.builtin_code.as_ref().unwrap())));
        // 普通 DAO 新建的卡片由触发器补 stable_uuid
        db.create_card(&crate::models::CreateCardInput {
            front: "f".into(),
            back: "b".into(),
            note_id: None,
            deck: None,
        })
        .unwrap();
        let cards = db.list_cards_for_sync("2000-01-01 00:00:00").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].stable_id.len(), 36);
    }

    #[test]
    fn card_upsert_respects_keep_local_schedule() {
        let db = Database::init(":memory:").unwrap();
        db.upsert_card_synced(&card("c1"), None, false).unwrap();
        let mut newer = card("c1");
        newer.front = "Q2".into();
        newer.reps = 9;
        db.upsert_card_synced(&newer, None, true).unwrap();
        let got = &db.list_cards_for_sync("2000-01-01 00:00:00").unwrap()[0];
        assert_eq!(got.front, "Q2", "内容应被覆盖");
        assert_eq!(got.reps, 1, "调度应保留本地");
    }

    #[test]
    fn card_log_needs_local_card_and_is_idempotent() {
        let db = Database::init(":memory:").unwrap();
        let log = CardReviewLogManifestEntry {
            stable_id: "l1".into(),
            card_uuid: "c1".into(),
            rating: 3,
            state: 2,
            due: "2026-11-05 10:00:00".into(),
            stability: 3.0,
            difficulty: 5.0,
            elapsed_days: 1,
            last_elapsed_days: 0,
            scheduled_days: 3,
            review: "2026-11-02 10:00:00".into(),
        };
        assert!(!db.insert_card_log_synced(&log).unwrap(), "卡片不存在应跳过");
        db.upsert_card_synced(&card("c1"), None, false).unwrap();
        assert!(db.insert_card_log_synced(&log).unwrap());
        assert!(db.insert_card_log_synced(&log).unwrap());
        assert_eq!(db.list_card_logs_for_sync("2000-01-01 00:00:00").unwrap().len(), 1);
    }

    #[test]
    fn template_delete_records_tombstone_and_upsert_clears_it() {
        let db = Database::init(":memory:").unwrap();
        let t = db
            .create_template(&crate::models::NoteTemplateInput {
                name: "x".into(),
                description: String::new(),
                content: "c".into(),
            })
            .unwrap();
        let uuid = db
            .list_note_templates_for_sync()
            .unwrap()
            .into_iter()
            .find(|e| e.name == "x")
            .unwrap()
            .stable_id;
        db.delete_template(t.id).unwrap();
        let tombs = db
            .list_sync_tombstones(TOMBSTONE_KIND_NOTE_TEMPLATE, "2000-01-01 00:00:00")
            .unwrap();
        assert_eq!(tombs.len(), 1);
        assert_eq!(tombs[0].0, uuid);

        // 远端在删除之后又编辑过 → 拉回来，删除记录要清掉
        let entry = NoteTemplateManifestEntry {
            stable_id: uuid,
            content_hash: String::new(),
            updated_at: "2099-01-01 00:00:00".into(),
            name: "x".into(),
            description: String::new(),
            content: "c2".into(),
            tombstone: false,
        };
        db.upsert_note_template_synced(&entry).unwrap();
        assert!(db
            .list_sync_tombstones(TOMBSTONE_KIND_NOTE_TEMPLATE, "2000-01-01 00:00:00")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn delete_synced_uses_remote_time() {
        let db = Database::init(":memory:").unwrap();
        let p = db.list_prompts_for_sync().unwrap().remove(0);
        db.delete_synced_by_uuid(TOMBSTONE_KIND_PROMPT, &p.stable_id, "2026-01-01 00:00:00")
            .unwrap();
        let tombs = db
            .list_sync_tombstones(TOMBSTONE_KIND_PROMPT, "2000-01-01 00:00:00")
            .unwrap();
        assert_eq!(tombs, vec![(p.stable_id, "2026-01-01 00:00:00".to_string())]);
    }
}
