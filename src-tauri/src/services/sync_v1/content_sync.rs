//! v72：闪卡 / 复习记录 / 提示词 / 笔记模板的 manifest 构建、合并、对比与拉取落库
//!
//! 和任务同步一样直接内联在 manifest.json 里（量小，不单独传文件）。规则：
//! - 提示词 / 笔记模板：按 stable_id outer-join，`updated_at` 新者赢；删除靠 tombstone 传播
//! - 闪卡：内容按 `updated_at`、调度按 `last_review` 各自取较新的一边
//!   （「电脑上改正面、手机上随后复习」两边的改动都要留住）
//! - 复习记录：只增不改，按 stable_id 取并集，只带最近 [`CARD_LOG_RETENTION_DAYS`] 天
//!
//! 超过 [`TOMBSTONE_RETENTION_DAYS`] 天的 tombstone 不再写进 manifest，和笔记一致。

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use super::manifest::TOMBSTONE_RETENTION_DAYS;
use crate::database::sync_content::{TOMBSTONE_KIND_NOTE_TEMPLATE, TOMBSTONE_KIND_PROMPT};
use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    CardManifestEntry, CardReviewLogManifestEntry, NoteTemplateManifestEntry, PromptManifestEntry,
    SyncPullResult, CARD_LOG_RETENTION_DAYS,
};

fn days_ago(days: i64) -> String {
    (chrono::Local::now() - chrono::Duration::days(days))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn tombstone_cutoff() -> String {
    days_ago(TOMBSTONE_RETENTION_DAYS)
}

// ─── content_hash ─────────────────────────────────────────────

/// 闪卡指纹：参与同步的字段全拼接（含调度状态，复习一次就会变）
pub fn card_content_hash(c: &CardManifestEntry) -> String {
    let mut h = Sha256::new();
    for part in [
        c.front.as_str(),
        c.back.as_str(),
        c.deck.as_str(),
        c.note_uuid.as_deref().unwrap_or(""),
        c.due.as_str(),
        &c.stability.to_string(),
        &c.difficulty.to_string(),
        &c.elapsed_days.to_string(),
        &c.scheduled_days.to_string(),
        &c.reps.to_string(),
        &c.lapses.to_string(),
        &c.state.to_string(),
        c.last_review.as_deref().unwrap_or(""),
        if c.tombstone { "1" } else { "0" },
    ] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

pub fn prompt_content_hash(p: &PromptManifestEntry) -> String {
    let mut h = Sha256::new();
    for part in [
        p.title.as_str(),
        p.description.as_str(),
        p.prompt.as_str(),
        p.output_mode.as_str(),
        p.icon.as_deref().unwrap_or(""),
        p.builtin_code.as_deref().unwrap_or(""),
        &p.sort_order.to_string(),
        if p.enabled { "1" } else { "0" },
        if p.tombstone { "1" } else { "0" },
    ] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

pub fn note_template_content_hash(t: &NoteTemplateManifestEntry) -> String {
    let mut h = Sha256::new();
    for part in [
        t.name.as_str(),
        t.description.as_str(),
        t.content.as_str(),
        if t.tombstone { "1" } else { "0" },
    ] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

// ─── 从本地库构建 ─────────────────────────────────────────────

pub fn build_card_entries(db: &Database) -> Result<Vec<CardManifestEntry>, AppError> {
    let mut out = db.list_cards_for_sync(&tombstone_cutoff())?;
    for c in &mut out {
        c.content_hash = card_content_hash(c);
    }
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

pub fn build_card_log_entries(db: &Database) -> Result<Vec<CardReviewLogManifestEntry>, AppError> {
    let mut out = db.list_card_logs_for_sync(&days_ago(CARD_LOG_RETENTION_DAYS))?;
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

pub fn build_prompt_entries(db: &Database) -> Result<Vec<PromptManifestEntry>, AppError> {
    let mut out = db.list_prompts_for_sync()?;
    let live: HashSet<String> = out.iter().map(|p| p.stable_id.clone()).collect();
    for (uuid, deleted_at) in db.list_sync_tombstones(TOMBSTONE_KIND_PROMPT, &tombstone_cutoff())? {
        if live.contains(&uuid) {
            continue; // 删了又从远端拉回来过，以现存行为准
        }
        out.push(PromptManifestEntry {
            stable_id: uuid,
            content_hash: String::new(),
            updated_at: deleted_at,
            title: String::new(),
            description: String::new(),
            prompt: String::new(),
            output_mode: String::new(),
            icon: None,
            builtin_code: None,
            sort_order: 0,
            enabled: false,
            tombstone: true,
        });
    }
    for p in &mut out {
        p.content_hash = prompt_content_hash(p);
    }
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

pub fn build_note_template_entries(db: &Database) -> Result<Vec<NoteTemplateManifestEntry>, AppError> {
    let mut out = db.list_note_templates_for_sync()?;
    let live: HashSet<String> = out.iter().map(|t| t.stable_id.clone()).collect();
    for (uuid, deleted_at) in
        db.list_sync_tombstones(TOMBSTONE_KIND_NOTE_TEMPLATE, &tombstone_cutoff())?
    {
        if live.contains(&uuid) {
            continue;
        }
        out.push(NoteTemplateManifestEntry {
            stable_id: uuid,
            content_hash: String::new(),
            updated_at: deleted_at,
            name: String::new(),
            description: String::new(),
            content: String::new(),
            tombstone: true,
        });
    }
    for t in &mut out {
        t.content_hash = note_template_content_hash(t);
    }
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

// ─── 合并（push 写远端前） ────────────────────────────────────

/// `a` 的复习时间是否比 `b` 晚。None = 从没复习过，比任何有值的都早
fn reviewed_later(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

/// 把 `src` 的调度字段抄到 `dst`
fn copy_schedule(dst: &mut CardManifestEntry, src: &CardManifestEntry) {
    dst.due = src.due.clone();
    dst.stability = src.stability;
    dst.difficulty = src.difficulty;
    dst.elapsed_days = src.elapsed_days;
    dst.scheduled_days = src.scheduled_days;
    dst.reps = src.reps;
    dst.lapses = src.lapses;
    dst.state = src.state;
    dst.last_review = src.last_review.clone();
}

/// 同一张卡两个版本合成一个：内容取 updated_at 新的（相等取 `local`），调度取 last_review 晚的
pub fn combine_card(local: &CardManifestEntry, remote: &CardManifestEntry) -> CardManifestEntry {
    let mut out = if remote.updated_at > local.updated_at {
        remote.clone()
    } else {
        local.clone()
    };
    let sched_src = if reviewed_later(remote.last_review.as_deref(), local.last_review.as_deref()) {
        remote
    } else {
        local
    };
    copy_schedule(&mut out, sched_src);
    out.content_hash = card_content_hash(&out);
    out
}

pub fn merge_cards(
    local: &[CardManifestEntry],
    remote: &[CardManifestEntry],
) -> Vec<CardManifestEntry> {
    let cutoff = tombstone_cutoff();
    let mut map: HashMap<String, CardManifestEntry> =
        local.iter().map(|e| (e.stable_id.clone(), e.clone())).collect();
    for re in remote {
        let merged = match map.get(&re.stable_id) {
            Some(le) => combine_card(le, re),
            None => re.clone(),
        };
        map.insert(re.stable_id.clone(), merged);
    }
    let mut out: Vec<_> = map
        .into_values()
        .filter(|e| !e.tombstone || e.updated_at >= cutoff)
        .collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
}

pub fn merge_card_logs(
    local: &[CardReviewLogManifestEntry],
    remote: &[CardReviewLogManifestEntry],
) -> Vec<CardReviewLogManifestEntry> {
    let cutoff = days_ago(CARD_LOG_RETENTION_DAYS);
    let mut map: HashMap<String, CardReviewLogManifestEntry> = HashMap::new();
    for e in local.iter().chain(remote.iter()) {
        if e.review >= cutoff {
            map.entry(e.stable_id.clone()).or_insert_with(|| e.clone());
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
}

/// 提示词 / 笔记模板共用的「updated_at 新者赢」合并
trait LwwEntry: Clone {
    fn id(&self) -> &str;
    fn updated(&self) -> &str;
    fn hash(&self) -> &str;
    fn is_tombstone(&self) -> bool;
}

impl LwwEntry for PromptManifestEntry {
    fn id(&self) -> &str {
        &self.stable_id
    }
    fn updated(&self) -> &str {
        &self.updated_at
    }
    fn hash(&self) -> &str {
        &self.content_hash
    }
    fn is_tombstone(&self) -> bool {
        self.tombstone
    }
}

impl LwwEntry for NoteTemplateManifestEntry {
    fn id(&self) -> &str {
        &self.stable_id
    }
    fn updated(&self) -> &str {
        &self.updated_at
    }
    fn hash(&self) -> &str {
        &self.content_hash
    }
    fn is_tombstone(&self) -> bool {
        self.tombstone
    }
}

fn merge_lww<T: LwwEntry>(local: &[T], remote: &[T]) -> Vec<T> {
    let cutoff = tombstone_cutoff();
    let mut map: HashMap<String, T> = local.iter().map(|e| (e.id().to_string(), e.clone())).collect();
    for re in remote {
        match map.get(re.id()) {
            Some(le) if le.updated() >= re.updated() => {}
            _ => {
                map.insert(re.id().to_string(), re.clone());
            }
        }
    }
    let mut out: Vec<T> = map
        .into_values()
        .filter(|e| !e.is_tombstone() || e.updated() >= cutoff.as_str())
        .collect();
    out.sort_by(|a, b| a.id().cmp(b.id()));
    out
}

/// 要拉的条目：远端独有且不是 tombstone，或双方都有、指纹不同且远端更新
fn diff_lww<T: LwwEntry>(local: &[T], remote: &[T]) -> Vec<T> {
    let local_map: HashMap<&str, &T> = local.iter().map(|e| (e.id(), e)).collect();
    remote
        .iter()
        .filter(|re| match local_map.get(re.id()) {
            None => !re.is_tombstone(),
            Some(le) => le.hash() != re.hash() && re.updated() > le.updated(),
        })
        .cloned()
        .collect()
}

pub fn merge_prompts(
    local: &[PromptManifestEntry],
    remote: &[PromptManifestEntry],
) -> Vec<PromptManifestEntry> {
    merge_lww(local, remote)
}

pub fn merge_note_templates(
    local: &[NoteTemplateManifestEntry],
    remote: &[NoteTemplateManifestEntry],
) -> Vec<NoteTemplateManifestEntry> {
    merge_lww(local, remote)
}

// ─── 对比（pull 用） ──────────────────────────────────────────

/// 要拉的卡片：远端独有，或远端内容更新 / 复习得更晚（任一成立）
pub fn diff_cards(
    local: &[CardManifestEntry],
    remote: &[CardManifestEntry],
) -> Vec<CardManifestEntry> {
    let local_map: HashMap<&str, &CardManifestEntry> =
        local.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    remote
        .iter()
        .filter(|re| match local_map.get(re.stable_id.as_str()) {
            // 远端独有的 tombstone 也要拉：本地可能有一行超出 GC 窗口、没进本地 manifest 的旧卡
            None => true,
            Some(le) => {
                le.content_hash != re.content_hash
                    && (re.updated_at > le.updated_at
                        || reviewed_later(re.last_review.as_deref(), le.last_review.as_deref()))
            }
        })
        .cloned()
        .collect()
}

pub fn diff_card_logs(
    local: &[CardReviewLogManifestEntry],
    remote: &[CardReviewLogManifestEntry],
) -> Vec<CardReviewLogManifestEntry> {
    let have: HashSet<&str> = local.iter().map(|e| e.stable_id.as_str()).collect();
    remote
        .iter()
        .filter(|e| !have.contains(e.stable_id.as_str()))
        .cloned()
        .collect()
}

pub fn diff_prompts(
    local: &[PromptManifestEntry],
    remote: &[PromptManifestEntry],
) -> Vec<PromptManifestEntry> {
    diff_lww(local, remote)
}

pub fn diff_note_templates(
    local: &[NoteTemplateManifestEntry],
    remote: &[NoteTemplateManifestEntry],
) -> Vec<NoteTemplateManifestEntry> {
    diff_lww(local, remote)
}

// ─── 拉取落库 ─────────────────────────────────────────────────

/// 卡片要在笔记之后、复习记录之前落库：note_uuid 要能解析到本地笔记，复习记录要能找到卡片
pub fn apply_pulled_cards(db: &Database, entries: &[CardManifestEntry], result: &mut SyncPullResult) {
    for e in entries {
        let local = match db.get_card_sync_ref(&e.stable_id) {
            Ok(v) => v,
            Err(err) => {
                result.errors.push(format!("查闪卡失败 {}: {}", e.front, err));
                continue;
            }
        };
        // 本地有这张卡且复习得不比远端早 → 只取内容，调度留本地
        let keep_local_schedule = match &local {
            Some((_, local_review)) => {
                !reviewed_later(e.last_review.as_deref(), local_review.as_deref())
            }
            None => false,
        };
        let note_id = match e.note_uuid.as_deref() {
            Some(u) => db.get_note_id_by_stable_uuid(u).unwrap_or(None),
            None => None,
        };
        if let Err(err) = db.upsert_card_synced(e, note_id, keep_local_schedule) {
            result.errors.push(format!("写入闪卡 {} 失败: {}", e.front, err));
        }
    }
}

pub fn apply_pulled_card_logs(
    db: &Database,
    entries: &[CardReviewLogManifestEntry],
    result: &mut SyncPullResult,
) {
    for e in entries {
        // 卡片本端没有（超出 GC 窗口的旧删除等）→ 记录没地方挂，跳过即可
        if let Err(err) = db.insert_card_log_synced(e) {
            result.errors.push(format!("写入复习记录失败: {}", err));
        }
    }
}

pub fn apply_pulled_prompts(
    db: &Database,
    entries: &[PromptManifestEntry],
    result: &mut SyncPullResult,
) {
    for e in entries {
        let r = if e.tombstone {
            db.delete_synced_by_uuid(TOMBSTONE_KIND_PROMPT, &e.stable_id, &e.updated_at)
                .map(|_| ())
        } else {
            db.upsert_prompt_synced(e)
        };
        if let Err(err) = r {
            result.errors.push(format!("同步提示词 {} 失败: {}", e.title, err));
        }
    }
}

pub fn apply_pulled_note_templates(
    db: &Database,
    entries: &[NoteTemplateManifestEntry],
    result: &mut SyncPullResult,
) {
    for e in entries {
        let r = if e.tombstone {
            db.delete_synced_by_uuid(TOMBSTONE_KIND_NOTE_TEMPLATE, &e.stable_id, &e.updated_at)
                .map(|_| ())
        } else {
            db.upsert_note_template_synced(e)
        };
        if let Err(err) = r {
            result.errors.push(format!("同步笔记模板 {} 失败: {}", e.name, err));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, updated: &str, front: &str, review: Option<&str>, reps: i64) -> CardManifestEntry {
        let mut c = CardManifestEntry {
            stable_id: id.into(),
            content_hash: String::new(),
            updated_at: updated.into(),
            front: front.into(),
            back: "A".into(),
            deck: "default".into(),
            note_uuid: None,
            due: "2026-11-20 00:00:00".into(),
            stability: 1.0,
            difficulty: 5.0,
            elapsed_days: 0,
            scheduled_days: 1,
            reps,
            lapses: 0,
            state: 1,
            last_review: review.map(String::from),
            tombstone: false,
        };
        c.content_hash = card_content_hash(&c);
        c
    }

    fn tpl(id: &str, updated: &str, content: &str, tombstone: bool) -> NoteTemplateManifestEntry {
        let mut t = NoteTemplateManifestEntry {
            stable_id: id.into(),
            content_hash: String::new(),
            updated_at: updated.into(),
            name: "n".into(),
            description: String::new(),
            content: content.into(),
            tombstone,
        };
        t.content_hash = note_template_content_hash(&t);
        t
    }

    fn now() -> String {
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
    }

    /// 电脑上改了正面（updated_at 新），手机上更晚复习过（last_review 新）→ 两边都保留
    #[test]
    fn combine_card_keeps_newer_content_and_newer_schedule() {
        let pc = card("c", "2026-11-10 12:00:00", "改过的正面", Some("2026-11-01 00:00:00"), 1);
        let phone = card("c", "2026-11-09 08:00:00", "旧正面", Some("2026-11-09 08:00:00"), 2);
        let m = combine_card(&pc, &phone);
        assert_eq!(m.front, "改过的正面");
        assert_eq!(m.reps, 2);
        assert_eq!(m.last_review.as_deref(), Some("2026-11-09 08:00:00"));
        assert_eq!(m.content_hash, card_content_hash(&m));
    }

    #[test]
    fn diff_cards_pulls_when_only_schedule_is_newer() {
        let local = card("c", "2026-11-10 12:00:00", "Q", Some("2026-11-01 00:00:00"), 1);
        let remote = card("c", "2026-11-09 08:00:00", "Q", Some("2026-11-09 08:00:00"), 2);
        assert_eq!(diff_cards(&[local.clone()], &[remote.clone()]).len(), 1);
        // 反过来本地全都更新 → 不拉
        assert!(diff_cards(&[remote.clone()], &[remote]).is_empty());
        let older = card("c", "2026-11-01 00:00:00", "Q0", None, 0);
        assert!(diff_cards(&[local], &[older]).is_empty());
    }

    #[test]
    fn card_logs_union_and_drop_expired() {
        let log = |id: &str, review: &str| CardReviewLogManifestEntry {
            stable_id: id.into(),
            card_uuid: "c".into(),
            rating: 3,
            state: 2,
            due: review.into(),
            stability: 1.0,
            difficulty: 5.0,
            elapsed_days: 0,
            last_elapsed_days: 0,
            scheduled_days: 1,
            review: review.into(),
        };
        let fresh = now();
        let merged = merge_card_logs(
            &[log("a", &fresh)],
            &[log("a", &fresh), log("b", &fresh), log("old", "2000-01-01 00:00:00")],
        );
        let ids: Vec<_> = merged.iter().map(|l| l.stable_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert_eq!(diff_card_logs(&[log("a", &fresh)], &merged).len(), 1);
    }

    #[test]
    fn template_tombstone_beats_older_edit_but_loses_to_newer_edit() {
        let t = now();
        let deleted = tpl("x", &t, "", true);
        let older_edit = tpl("x", "2026-01-01 00:00:00", "c", false);
        let merged = merge_note_templates(&[deleted.clone()], &[older_edit.clone()]);
        assert!(merged[0].tombstone);
        // 对端拿到 tombstone：本地是旧编辑 → 要拉（删除）
        assert_eq!(diff_note_templates(&[older_edit], &[deleted.clone()]).len(), 1);
        // 对端在删除之后又编辑 → 编辑赢
        let newer_edit = tpl("x", "2099-01-01 00:00:00", "c2", false);
        assert!(!merge_note_templates(&[deleted], &[newer_edit])[0].tombstone);
    }

    #[test]
    fn remote_only_tombstone_template_is_not_pulled_and_expired_is_dropped() {
        let gone = tpl("y", &now(), "", true);
        assert!(diff_note_templates(&[], &[gone]).is_empty());
        let expired = tpl("z", "2000-01-01 00:00:00", "", true);
        assert!(merge_note_templates(&[], &[expired]).is_empty());
    }

    /// 端到端：A 库建的卡片 / 改的模板，经 manifest 合并后在 B 库落地
    #[test]
    fn roundtrip_between_two_databases() {
        let a = Database::init(":memory:").unwrap();
        let b = Database::init(":memory:").unwrap();
        a.create_card(&crate::models::CreateCardInput {
            front: "TCP 第二步".into(),
            back: "SYN+ACK".into(),
            deck: None,
            note_id: None,
        })
        .unwrap();
        let weekly = a
            .list_templates()
            .unwrap()
            .into_iter()
            .find(|t| t.name == "周报")
            .unwrap();
        a.update_template(
            weekly.id,
            &crate::models::NoteTemplateInput {
                name: "周报".into(),
                description: weekly.description.clone(),
                content: "<p>新版周报</p>".into(),
            },
        )
        .unwrap();
        // 两个库在同一秒内建好，A 的修改时间可能和 B 预置模板的创建时间撞秒；拉开它
        a.conn_lock()
            .unwrap()
            .execute(
                "UPDATE note_templates SET updated_at = '2099-01-01 00:00:00' WHERE id = ?1",
                [weekly.id],
            )
            .unwrap();

        let remote_cards = merge_cards(&build_card_entries(&a).unwrap(), &[]);
        let remote_tpls = merge_note_templates(&build_note_template_entries(&a).unwrap(), &[]);

        let mut result = SyncPullResult::default();
        let pull_cards = diff_cards(&build_card_entries(&b).unwrap(), &remote_cards);
        apply_pulled_cards(&b, &pull_cards, &mut result);
        let pull_tpls = diff_note_templates(&build_note_template_entries(&b).unwrap(), &remote_tpls);
        apply_pulled_note_templates(&b, &pull_tpls, &mut result);
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let cards = b.list_cards(None).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].back, "SYN+ACK");
        let tpls = b.list_templates().unwrap();
        assert_eq!(tpls.iter().filter(|t| t.name == "周报").count(), 1, "预置模板不能重复");
        assert_eq!(
            tpls.iter().find(|t| t.name == "周报").unwrap().content,
            "<p>新版周报</p>"
        );
        // B 再算一次 → 与远端一致，不再有要拉的
        assert!(diff_cards(&build_card_entries(&b).unwrap(), &remote_cards).is_empty());
        assert!(diff_note_templates(&build_note_template_entries(&b).unwrap(), &remote_tpls).is_empty());
    }
}
