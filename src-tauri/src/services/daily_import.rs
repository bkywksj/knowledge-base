//! 历史日记导入 / 转换。
//!
//! 解决的问题：别的笔记软件导出的日记结构是 `日期文件夹/笔记文件.md`，
//! 直接按普通 Markdown 导进来只会变成一堆普通笔记，日记页看不到 —— 用户"记了好多年的
//! 日记转过来都成普通笔记了"。
//!
//! 两个入口共用本模块的识别 + 合并逻辑：
//!   ① **转换已导入的**：扫库里日期命名的文件夹，把其下笔记认领成日记（`scan_library` → `apply`）
//!   ② **导入时识别**：扫描阶段就标出每个文件的日期（`detect_date_from_relative_dir`），
//!      导入时直接落成日记
//!
//! 设计取舍（都是用户拍板的）：
//!   · 一天多个文件 → **合并成一篇**，每段前加 `## 原标题` 分隔（不是丢弃、也不是各自成篇）
//!   · 标题 → **保留原标题**（日记列表显示的就是 title，「工作记录」比「2020-05-15 的日记」有信息量）
//!   · 文件夹 → 认领成日记后**摘出日期文件夹**（folder_id = NULL），空掉的日期文件夹顺手清掉。
//!     早期版本是"原地不动"，想做成"日记页按日期看 + 笔记树保持原结构"的双保险，
//!     结果是有害的：`list_notes` 一律过滤 `is_daily = 0`，日期文件夹在用户眼里是空的，
//!     删它时却被告知"还有 1 篇笔记"，确认后当天日记被扫进回收站（真实用户反馈）。
//!     现在日记只由 daily_date 组织，归属关系不再自相矛盾。
//!
//! ⚠️ 认领是 `UPDATE is_daily=1, daily_date=?`，与 `get_or_create_daily` 里既有的
//! "认领伪日记"是同一套路子（database/notes.rs），不新建笔记 —— 避免日记增殖。

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::AppError;

// ─── 日期识别（纯函数，全部可单测）──────────────────────────────

/// 把一个名字解析成 `YYYY-MM-DD`；不像日期或日期非法时返回 None。
///
/// 支持的写法（覆盖常见导出软件）：
///   · `2020-05-15` / `2020_05_15` / `2020.05.15` / `2020/05/15`
///   · `20200515`（紧凑 8 位）
///   · `2020年05月15日`
///   · `2020-05-15 周五` / `2020-05-15_工作`（日期后跟分隔符再跟任意后缀）
///   · 月 / 日允许单位数：`2020-5-1`
///
/// **必须是真实存在的日期**：`2020-02-30`、`2020-13-01` 一律返回 None
/// （用 chrono 校验，而不是简单判 `1..=31` —— 项目里旧的 `validate_date` 就漏了闰月这类）。
pub fn parse_date_token(name: &str) -> Option<String> {
    use std::sync::OnceLock;
    static COMPACT: OnceLock<regex::Regex> = OnceLock::new();
    static SEPARATED: OnceLock<regex::Regex> = OnceLock::new();

    let s = name.trim();
    if s.is_empty() {
        return None;
    }

    // 紧凑 8 位：必须**正好** 8 位数字，否则 "202005151" 这种也会被切出日期
    let compact = COMPACT.get_or_init(|| {
        regex::Regex::new(r"^(\d{4})(\d{2})(\d{2})$").expect("compact date regex")
    });
    if let Some(c) = compact.captures(s) {
        return build_date(&c[1], &c[2], &c[3]);
    }

    // 带分隔符：年月日之间是 - _ . / 或中文单位；日期后可跟空格/-/_/·再接任意后缀
    let sep = SEPARATED.get_or_init(|| {
        regex::Regex::new(r"^(\d{4})\s*[-_./年]\s*(\d{1,2})\s*[-_./月]\s*(\d{1,2})\s*日?(?:[\s\-_·(（].*)?$")
            .expect("separated date regex")
    });
    let c = sep.captures(s)?;
    build_date(&c[1], &c[2], &c[3])
}

/// 年月日三段 → 规范化 `YYYY-MM-DD`，非真实日期返回 None
fn build_date(y: &str, m: &str, d: &str) -> Option<String> {
    let year: i32 = y.parse().ok()?;
    let month: u32 = m.parse().ok()?;
    let day: u32 = d.parse().ok()?;
    // 年份下限跟 DailyService::list_dates 保持一致，防止把 "0001-01-01" 这种噪音收进来
    if !(1970..=9999).contains(&year) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)?;
    Some(format!("{:04}-{:02}-{:02}", year, month, day))
}

/// 从「相对目录」里识别日期。
///
/// `relative_dir` 是 `ScannedFile.relative_dir` 那种斜杠分隔的相对路径（根层为空串）。
/// 从**最深一层往外**找第一个像日期的片段 —— 深的更具体（`日记/2020/2020-05-15` 应取后者）。
///
/// 另外支持**三层嵌套**写法 `2020/05/15`：单看任一段都不是日期，连起来才是。
pub fn detect_date_from_relative_dir(relative_dir: &str) -> Option<String> {
    let segs: Vec<&str> = relative_dir
        .split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if segs.is_empty() {
        return None;
    }

    // 先试整段命名（由深到浅）
    for seg in segs.iter().rev() {
        if let Some(d) = parse_date_token(seg) {
            return Some(d);
        }
    }

    // 再试 年/月/日 三层嵌套（取最后三段）
    if segs.len() >= 3 {
        let n = segs.len();
        let joined = format!("{}-{}-{}", segs[n - 3], segs[n - 2], segs[n - 1]);
        if let Some(d) = parse_date_token(&joined) {
            return Some(d);
        }
    }
    None
}

/// 综合文件夹名与文件名判定日期。
///
/// **文件夹优先**：文件夹名是导出软件按日期批量生成的，比文件名可信
/// （文件名可能是「工作记录」，也可能是用户随手改过的）。
/// 两边都能解析且不一致时同样以文件夹为准 —— 但把冲突报出去，让用户知道。
///
/// 返回 `(日期, 是否存在文件夹/文件名日期冲突)`。
pub fn detect_date(relative_dir: &str, file_stem: &str) -> (Option<String>, bool) {
    let from_dir = detect_date_from_relative_dir(relative_dir);
    let from_file = parse_date_token(file_stem);
    match (&from_dir, &from_file) {
        (Some(a), Some(b)) => (Some(a.clone()), a != b),
        (Some(a), None) => (Some(a.clone()), false),
        (None, Some(b)) => (Some(b.clone()), false),
        (None, None) => (None, false),
    }
}

// ─── 转换计划 / 结果模型 ────────────────────────────────────────

/// 一天对应的转换候选（可能由多篇笔记合并而来）
///
/// 同时派生 Deserialize：前端拿到 plan 后可能会**改动它再传回来**
/// （比如用户在预览里勾掉某几天），所以 apply 收的是前端传回的 plan 而不是重新扫一遍。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCandidate {
    /// 目标日期 YYYY-MM-DD
    pub date: String,
    /// 参与这一天的笔记 id（按标题排序，合并时按此顺序拼接）
    pub note_ids: Vec<i64>,
    /// 对应标题，与 note_ids 同序，供前端预览
    pub titles: Vec<String>,
    /// 该日期已存在日记时，指向那条已有日记的 id
    pub existing_daily_id: Option<i64>,
}

/// 扫描结果：告诉用户「将会发生什么」，确认后才动数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyConvertPlan {
    /// 单文件日期（直接认领）
    pub single: Vec<DailyCandidate>,
    /// 多文件日期（按选项合并 / 选主）
    pub multi: Vec<DailyCandidate>,
    /// 与已有日记冲突的日期
    pub conflicts: Vec<DailyCandidate>,
    /// 名字不像日期、被跳过的文件夹名（去重，最多留 50 条给前端展示）
    pub skipped_folders: Vec<String>,
    /// 识别到的最早 / 最晚日期，给前端显示范围
    pub date_from: Option<String>,
    pub date_to: Option<String>,
}

/// 多文件日期的处理策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MultiFileStrategy {
    /// 合并成一篇，每段前加 `## 原标题`（默认）
    Merge,
    /// 只认领一篇（文件名=日期的优先，否则第一篇），其余保持普通笔记
    KeepFirst,
    /// 跳过这些日期，不处理
    Skip,
}

/// 与已有日记冲突时的处理策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStrategy {
    /// 跳过，保留已有日记不动（默认，最安全）
    Skip,
    /// 把待转换内容追加到已有日记末尾
    Append,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyConvertOptions {
    pub multi_file: MultiFileStrategy,
    pub conflict: ConflictStrategy,
}

impl Default for DailyConvertOptions {
    fn default() -> Self {
        Self {
            multi_file: MultiFileStrategy::Merge,
            conflict: ConflictStrategy::Skip,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyConvertResult {
    /// 成功认领为日记的天数
    pub converted_days: usize,
    /// 因合并而被并入其它笔记、随后删除的笔记数
    pub merged_notes: usize,
    /// 追加进已有日记的天数
    pub appended_days: usize,
    /// 跳过的天数（策略所致）
    pub skipped_days: usize,
    /// 日记摘出后被清掉的空日期文件夹数
    pub folders_removed: usize,
    /// 出错条目（date -> 原因）
    pub errors: Vec<String>,
}

// ─── 合并 ───────────────────────────────────────────────────────

/// 把多篇笔记的正文合并成一篇。
///
/// 每段前插一个 `<h2>原标题</h2>` 作分隔 —— 用 HTML 而不是 Markdown 的 `## `：
/// 本项目笔记正文存的就是 HTML（编辑器是 Tiptap），存 `## ` 会被原样显示成字面量。
///
/// 首段是否也加标题由 `label_first` 控制：合并时加（否则读者不知道第一段来自哪个文件），
/// 追加到已有日记时也加。
pub fn merge_contents(parts: &[(String, String)], label_first: bool) -> String {
    let mut out = String::new();
    for (i, (title, content)) in parts.iter().enumerate() {
        let need_label = label_first || i > 0;
        if need_label && !title.trim().is_empty() {
            out.push_str(&format!("<h2>{}</h2>", html_escape(title.trim())));
        }
        out.push_str(content);
        // 段间补一个空段落，避免两段正文在编辑器里粘成一坨
        if i + 1 < parts.len() {
            out.push_str("<p></p>");
        }
    }
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 多篇笔记里挑一篇当"主"笔记（KeepFirst 策略用）。
///
/// 优先文件名/标题就是日期的那篇（`2020-05-20.md` 这种通常是导出软件生成的当天主文件），
/// 否则取第一篇。返回在 `titles` 里的下标。
pub fn pick_primary_index(titles: &[String], date: &str) -> usize {
    titles
        .iter()
        .position(|t| parse_date_token(t).as_deref() == Some(date))
        .unwrap_or(0)
}

// ─── 服务 ───────────────────────────────────────────────────────

pub struct DailyImportService;

impl DailyImportService {
    /// 扫描**已在库里**的笔记，找出「所在文件夹名是日期」的那些，生成转换计划。
    ///
    /// 只看普通笔记（`is_daily = 0`）—— 已经是日记的不用再转。
    /// 不改任何数据，纯查询；用户看完预览确认后才调 `apply`。
    pub fn scan_library(db: &Database) -> Result<DailyConvertPlan, AppError> {
        let rows = db.list_notes_with_folder_path()?;

        // date -> (note_id, title) 列表
        let mut by_date: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        let mut skipped: Vec<String> = Vec::new();

        for (note_id, title, folder_path) in rows {
            match detect_date_from_relative_dir(&folder_path) {
                Some(date) => by_date.entry(date).or_default().push((note_id, title)),
                None => {
                    // 只记最后一层文件夹名，且去重 —— 给用户看"哪些没被识别"
                    if let Some(last) = folder_path.rsplit('/').next() {
                        let last = last.trim();
                        if !last.is_empty() && !skipped.iter().any(|s| s == last) {
                            skipped.push(last.to_string());
                        }
                    }
                }
            }
        }

        // 已有日记的日期 → id，用于判冲突
        let existing: HashMap<String, i64> = db
            .list_all_dailies()?
            .into_iter()
            .map(|e| (e.daily_date, e.id))
            .collect();

        let mut single = Vec::new();
        let mut multi = Vec::new();
        let mut conflicts = Vec::new();

        let mut dates: Vec<String> = by_date.keys().cloned().collect();
        dates.sort();
        let date_from = dates.first().cloned();
        let date_to = dates.last().cloned();

        for date in dates {
            let mut items = by_date.remove(&date).unwrap_or_default();
            // 按标题排序，保证合并顺序稳定可预期（用户预览时看到的就是最终顺序）
            items.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            let cand = DailyCandidate {
                date: date.clone(),
                note_ids: items.iter().map(|(i, _)| *i).collect(),
                titles: items.iter().map(|(_, t)| t.clone()).collect(),
                existing_daily_id: existing.get(&date).copied(),
            };
            if cand.existing_daily_id.is_some() {
                conflicts.push(cand);
            } else if cand.note_ids.len() > 1 {
                multi.push(cand);
            } else {
                single.push(cand);
            }
        }

        skipped.sort();
        skipped.truncate(50);

        Ok(DailyConvertPlan {
            single,
            multi,
            conflicts,
            skipped_folders: skipped,
            date_from,
            date_to,
        })
    }

    /// 按计划执行转换。
    ///
    /// 单文件日期：直接 `UPDATE is_daily=1, daily_date=?`，**不动正文、不动文件夹**。
    /// 多文件日期：按 `multi_file` 策略处理。
    /// 冲突日期：按 `conflict` 策略处理。
    ///
    /// 逐条独立失败：某天出错只记进 `errors`，不影响其它天 —— 几千天的转换不该被一条坏数据整体回滚。
    pub fn apply(
        db: &Database,
        plan: &DailyConvertPlan,
        options: &DailyConvertOptions,
    ) -> Result<DailyConvertResult, AppError> {
        let mut result = DailyConvertResult::default();
        // 认领成功的笔记 id —— 收尾时统一从日期文件夹里摘出来（见函数末尾）
        let mut claimed_ids: Vec<i64> = Vec::new();

        // ① 单文件：直接认领
        for cand in &plan.single {
            if let Some(&id) = cand.note_ids.first() {
                match db.mark_note_as_daily(id, &cand.date) {
                    Ok(_) => {
                        result.converted_days += 1;
                        claimed_ids.push(id);
                    }
                    Err(e) => result.errors.push(format!("{}: {}", cand.date, e)),
                }
            }
        }

        // ② 多文件
        for cand in &plan.multi {
            match options.multi_file {
                MultiFileStrategy::Skip => result.skipped_days += 1,
                MultiFileStrategy::KeepFirst => {
                    let idx = pick_primary_index(&cand.titles, &cand.date);
                    match db.mark_note_as_daily(cand.note_ids[idx], &cand.date) {
                        Ok(_) => {
                            result.converted_days += 1;
                            claimed_ids.push(cand.note_ids[idx]);
                        }
                        Err(e) => result.errors.push(format!("{}: {}", cand.date, e)),
                    }
                }
                MultiFileStrategy::Merge => match Self::merge_into_daily(db, cand) {
                    Ok(merged) => {
                        result.converted_days += 1;
                        result.merged_notes += merged;
                        claimed_ids.push(cand.note_ids[0]);
                    }
                    Err(e) => result.errors.push(format!("{}: {}", cand.date, e)),
                },
            }
        }

        // ③ 冲突
        for cand in &plan.conflicts {
            match options.conflict {
                ConflictStrategy::Skip => result.skipped_days += 1,
                ConflictStrategy::Append => {
                    match Self::append_into_existing(db, cand) {
                        Ok(merged) => {
                            result.appended_days += 1;
                            result.merged_notes += merged;
                        }
                        Err(e) => result.errors.push(format!("{}: {}", cand.date, e)),
                    }
                }
            }
        }

        // ④ 收尾：把认领成日记的笔记从日期文件夹里摘出来，再清掉因此变空的日期文件夹。
        //
        // 原先的取舍是"文件夹原地不动"（日记页按日期看 + 笔记树保持原结构，双保险），
        // 真机反馈证明这个双保险是有害的：日记在笔记列表里被 `is_daily = 0` 过滤掉，
        // 用户看到的是个空文件夹，删它时却被告知"还有 1 篇笔记"，确认后当天日记进了回收站。
        // 现在日记只由 daily_date 组织，日期文件夹空了就清掉，不再留下会误导人的空壳。
        // 失败只记 error 不整体失败 —— 认领本身已经成功，不该因为收尾没做成而回退。
        if !claimed_ids.is_empty() {
            match db.detach_notes_from_folders(&claimed_ids) {
                Ok(folder_ids) => match db.prune_empty_folders(&folder_ids) {
                    Ok(n) => result.folders_removed = n,
                    Err(e) => result.errors.push(format!("清理空日期文件夹失败: {}", e)),
                },
                Err(e) => result
                    .errors
                    .push(format!("把日记移出日期文件夹失败: {}", e)),
            }
        }

        Ok(result)
    }

    /// 把一天里的多篇笔记合并进第一篇，其余移入回收站。
    ///
    /// 用回收站而不是硬删：合并是有损操作，用户反悔时还能从回收站捞回来。
    /// 返回被并入的笔记数（不含主笔记）。
    ///
    /// 🔴 必须用 `soft_delete_note`（UPDATE is_deleted=1）而**不是** `delete_note`
    /// —— 后者名字看着像软删，实际是 `DELETE FROM notes`（真删，回收站里找不到）。
    /// 真机实测踩过：UI 承诺"可还原"，被合并的笔记却被永久删除。
    fn merge_into_daily(db: &Database, cand: &DailyCandidate) -> Result<usize, AppError> {
        let mut parts: Vec<(String, String)> = Vec::new();
        for id in &cand.note_ids {
            let note = db
                .get_note(*id)?
                .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))?;
            parts.push((note.title, note.content));
        }
        // label_first=true：合并后每段都带原标题，读者才分得清哪段来自哪个文件
        let merged = merge_contents(&parts, true);

        let primary = cand.note_ids[0];
        db.update_note_content(primary, &merged)?;
        db.mark_note_as_daily(primary, &cand.date)?;

        let mut moved = 0usize;
        for id in &cand.note_ids[1..] {
            db.soft_delete_note(*id)?; // 进回收站，可还原
            moved += 1;
        }
        Ok(moved)
    }

    /// 把待转换的笔记追加到该日期**已有的**日记末尾，源笔记移入回收站。
    fn append_into_existing(db: &Database, cand: &DailyCandidate) -> Result<usize, AppError> {
        let existing_id = cand
            .existing_daily_id
            .ok_or_else(|| AppError::Custom("缺少已有日记 id".into()))?;
        let existing = db
            .get_note(existing_id)?
            .ok_or_else(|| AppError::NotFound(format!("日记 {} 不存在", existing_id)))?;

        let mut parts: Vec<(String, String)> = vec![(String::new(), existing.content)];
        for id in &cand.note_ids {
            let note = db
                .get_note(*id)?
                .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))?;
            parts.push((note.title, note.content));
        }
        // label_first=false：已有日记那段保持原样不加标题，只给追加进来的加
        let merged = merge_contents(&parts, false);
        db.update_note_content(existing_id, &merged)?;

        let mut moved = 0usize;
        for id in &cand.note_ids {
            db.soft_delete_note(*id)?; // 同上：必须软删，不能用 delete_note
            moved += 1;
        }
        Ok(moved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_date_token ──

    #[test]
    fn parses_common_separators() {
        for s in ["2020-05-15", "2020_05_15", "2020.05.15", "2020/05/15"] {
            assert_eq!(parse_date_token(s).as_deref(), Some("2020-05-15"), "{s}");
        }
    }

    #[test]
    fn parses_compact_eight_digits() {
        assert_eq!(parse_date_token("20200515").as_deref(), Some("2020-05-15"));
    }

    #[test]
    fn compact_must_be_exactly_eight_digits() {
        // 多一位少一位都不该被切出日期来
        assert_eq!(parse_date_token("2020051"), None);
        assert_eq!(parse_date_token("202005151"), None);
    }

    #[test]
    fn parses_chinese_units() {
        assert_eq!(
            parse_date_token("2020年05月15日").as_deref(),
            Some("2020-05-15")
        );
        assert_eq!(parse_date_token("2020年5月1日").as_deref(), Some("2020-05-01"));
    }

    #[test]
    fn pads_single_digit_month_and_day() {
        assert_eq!(parse_date_token("2020-5-1").as_deref(), Some("2020-05-01"));
    }

    #[test]
    fn accepts_suffix_after_date() {
        // 日记文件夹常见「日期 + 星期 / 备注」
        for s in [
            "2020-05-15 周五",
            "2020-05-15_工作",
            "2020-05-15-出差",
            "2020-05-15（休假）",
        ] {
            assert_eq!(parse_date_token(s).as_deref(), Some("2020-05-15"), "{s}");
        }
    }

    #[test]
    fn rejects_non_dates() {
        for s in ["工作记录", "", "   ", "随笔2020", "abc-de-fg", "2020年总结"] {
            assert_eq!(parse_date_token(s), None, "{s}");
        }
    }

    #[test]
    fn rejects_impossible_dates() {
        // 旧的 validate_date 只判 1..=31，这几条会被放过；chrono 才拦得住
        for s in ["2020-02-30", "2021-02-29", "2020-13-01", "2020-00-10", "2020-05-32"] {
            assert_eq!(parse_date_token(s), None, "{s}");
        }
    }

    #[test]
    fn accepts_real_leap_day() {
        assert_eq!(parse_date_token("2020-02-29").as_deref(), Some("2020-02-29"));
    }

    #[test]
    fn rejects_year_out_of_range() {
        assert_eq!(parse_date_token("0001-01-01"), None);
        assert_eq!(parse_date_token("1969-12-31"), None);
        assert_eq!(parse_date_token("1970-01-01").as_deref(), Some("1970-01-01"));
    }

    // ── detect_date_from_relative_dir ──

    #[test]
    fn takes_deepest_date_segment() {
        // 深的更具体：日记/2020 里再套 2020-05-15，应取后者
        assert_eq!(
            detect_date_from_relative_dir("日记/2020/2020-05-15").as_deref(),
            Some("2020-05-15")
        );
    }

    #[test]
    fn ignores_non_date_ancestors() {
        assert_eq!(
            detect_date_from_relative_dir("我的日记/2020-05-15").as_deref(),
            Some("2020-05-15")
        );
    }

    #[test]
    fn supports_year_month_day_nesting() {
        // 单看任一段都不是日期，连起来才是
        assert_eq!(
            detect_date_from_relative_dir("日记/2020/05/15").as_deref(),
            Some("2020-05-15")
        );
    }

    #[test]
    fn nesting_must_be_a_real_date() {
        assert_eq!(detect_date_from_relative_dir("日记/2020/02/30"), None);
    }

    #[test]
    fn empty_or_rootless_dir_yields_none() {
        assert_eq!(detect_date_from_relative_dir(""), None);
        assert_eq!(detect_date_from_relative_dir("随笔/杂记"), None);
    }

    // ── detect_date（文件夹 vs 文件名）──

    #[test]
    fn folder_wins_over_file_name() {
        let (date, conflict) = detect_date("2020-05-15", "2020-05-16");
        assert_eq!(date.as_deref(), Some("2020-05-15"), "文件夹更可信");
        assert!(conflict, "不一致要报出来");
    }

    #[test]
    fn agreeing_dates_are_not_conflicts() {
        let (date, conflict) = detect_date("2020-05-20", "2020-05-20");
        assert_eq!(date.as_deref(), Some("2020-05-20"));
        assert!(!conflict);
    }

    #[test]
    fn falls_back_to_file_name_when_folder_has_no_date() {
        let (date, conflict) = detect_date("日记", "2020-05-15");
        assert_eq!(date.as_deref(), Some("2020-05-15"));
        assert!(!conflict);
    }

    #[test]
    fn non_date_file_under_date_folder_uses_folder() {
        // 用户截图里的主场景：2020-05-15/工作记录.md
        let (date, conflict) = detect_date("2020-05-15", "工作记录");
        assert_eq!(date.as_deref(), Some("2020-05-15"));
        assert!(!conflict);
    }

    #[test]
    fn neither_yields_none() {
        let (date, conflict) = detect_date("随笔", "工作记录");
        assert_eq!(date, None);
        assert!(!conflict);
    }

    // ── merge_contents ──

    #[test]
    fn merge_labels_each_section() {
        let parts = vec![
            ("工作记录".to_string(), "<p>今天写了代码</p>".to_string()),
            ("随笔".to_string(), "<p>天气不错</p>".to_string()),
        ];
        let out = merge_contents(&parts, true);
        assert!(out.contains("<h2>工作记录</h2>"));
        assert!(out.contains("<h2>随笔</h2>"));
        assert!(out.contains("今天写了代码"));
        assert!(out.contains("天气不错"));
        // 顺序必须与输入一致
        assert!(out.find("工作记录").unwrap() < out.find("随笔").unwrap());
    }

    #[test]
    fn merge_can_skip_first_label() {
        // 追加到已有日记时：已有那段不该被扣一个空标题
        let parts = vec![
            (String::new(), "<p>原有内容</p>".to_string()),
            ("补记".to_string(), "<p>后来加的</p>".to_string()),
        ];
        let out = merge_contents(&parts, false);
        assert!(!out.contains("<h2></h2>"));
        assert!(out.contains("<h2>补记</h2>"));
        assert!(out.starts_with("<p>原有内容</p>"));
    }

    #[test]
    fn merge_escapes_title_html() {
        // 标题来自文件名，可能含 < > & —— 不转义会把正文结构撑坏
        let parts = vec![("a<b>&c".to_string(), "<p>x</p>".to_string())];
        let out = merge_contents(&parts, true);
        assert!(out.contains("<h2>a&lt;b&gt;&amp;c</h2>"), "实际：{out}");
    }

    #[test]
    fn merge_single_part_still_works() {
        let parts = vec![("标题".to_string(), "<p>正文</p>".to_string())];
        assert_eq!(merge_contents(&parts, true), "<h2>标题</h2><p>正文</p>");
    }

    #[test]
    fn merge_empty_yields_empty() {
        assert_eq!(merge_contents(&[], true), "");
    }

    /// 🔴 合并/追加只能走**软删**（进回收站），绝不能真删。
    ///
    /// 背景：`Database::delete_note` 名字看着像软删，实际是 `DELETE FROM notes`。
    /// 第一版真机测试时误用了它 —— UI 上承诺"被并入的笔记移入回收站（可还原）"，
    /// 实际却把笔记永久删了。这条测试盯住源码，防止以后又改回去。
    #[test]
    fn merge_must_use_soft_delete_not_hard_delete() {
        let src = include_str!("daily_import.rs");
        // 只看 DailyImportService 的实现段（测试里出现 delete_note 字样是允许的）
        let impl_part = src
            .split("impl DailyImportService")
            .nth(1)
            .and_then(|s| s.split("#[cfg(test)]").next())
            .expect("定位 DailyImportService 实现段失败");
        assert!(
            !impl_part.contains("db.delete_note("),
            "合并/追加必须用 db.soft_delete_note（进回收站可还原），不能用 db.delete_note（真删）"
        );
        assert!(
            impl_part.contains("db.soft_delete_note("),
            "应当调用 soft_delete_note 把被并入的笔记移入回收站"
        );
    }

    // ── pick_primary_index ──

    #[test]
    fn primary_prefers_title_matching_date() {
        let titles = vec!["工作记录".into(), "2020-05-20".into(), "随笔".into()];
        assert_eq!(pick_primary_index(&titles, "2020-05-20"), 1);
    }

    #[test]
    fn primary_falls_back_to_first() {
        let titles = vec!["工作记录".into(), "随笔".into()];
        assert_eq!(pick_primary_index(&titles, "2020-05-20"), 0);
    }
}
