//! 合并导出：把一个文件夹（或一批笔记）合成**单个**带章节结构的文件。
//!
//! 与 `ExportService::export_notes` 的分工：
//! - `export_notes` 导出"一堆散 .md + assets/"，解决的是**备份 / 迁移**；
//! - 本模块导出"一份带目录和章节层级的文档"，解决的是**交付**（发同事 / 打印 / 存档）。
//!
//! 实现上刻意做得很薄：核心只有一个 markdown 合并器，三种格式全部复用已有渲染管线 ——
//! Word 因此自动享有「系统转换器（LibreOffice/Word/WPS）优先、原生 docx 回退」的既有策略，
//! 不必为合并场景另写一套。

use std::path::Path;

use crate::database::Database;
use crate::error::AppError;
use crate::services::export::inline_assets_base64;
use crate::services::export_html::{ExportFonts, HtmlExportService};
#[cfg(desktop)]
use crate::services::export_word::WordExportService;

/// 合并导出的目标格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeFormat {
    Markdown,
    Html,
    /// 仅桌面端：docx_rs 在移动端编译失败
    Word,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeExportResult {
    pub file_path: String,
    /// 实际合并进文档的笔记篇数
    pub notes_merged: usize,
    pub images_inlined: usize,
    pub images_missing: usize,
}

/// 合并器的输入单元：一篇笔记 + 它相对导出根的文件夹路径
struct MergeNote {
    title: String,
    content: String,
    /// 相对导出根的文件夹层级（不含根自身）。根直属笔记为空数组
    rel_path: Vec<String>,
}

/// markdown 标题最深只到 h6，再深 CommonMark 就不认了
const MAX_HEADING_LEVEL: usize = 6;

pub struct MergeExportService;

impl MergeExportService {
    /// 把 `folder_id` 子树（或全库）的笔记合并导出到 `target_path`。
    ///
    /// - `folder_id = None`：全库（章节按文件夹路径组织）
    /// - `recursive`：指定文件夹时是否含子文件夹，与 `export_notes` 同口径
    /// - `root_title`：文档顶层 `# 标题`，一般传文件夹名；空则用"知识库导出"
    pub fn export_merged(
        db: &Database,
        instance_data_dir: &Path,
        folder_id: Option<i64>,
        recursive: bool,
        root_title: &str,
        target_path: &Path,
        format: MergeFormat,
        fonts: Option<&ExportFonts>,
    ) -> Result<MergeExportResult, AppError> {
        let notes = Self::collect_notes(db, folder_id, recursive)?;
        if notes.is_empty() {
            return Err(AppError::Custom(
                "该范围下没有可导出的笔记（回收站中的笔记不计入）".into(),
            ));
        }

        let title = if root_title.trim().is_empty() {
            "知识库导出"
        } else {
            root_title.trim()
        };
        let merged = build_merged_markdown(title, &notes);
        let notes_merged = notes.len();

        let canon_root = instance_data_dir
            .canonicalize()
            .unwrap_or_else(|_| instance_data_dir.to_path_buf());

        match format {
            MergeFormat::Markdown => {
                // 单文件 .md：图片/附件 base64 内嵌，换台机器也能看
                let (rewritten, inlined) = inline_assets_base64(&merged, &canon_root);
                std::fs::write(target_path, rewritten)?;
                Ok(MergeExportResult {
                    file_path: target_path.to_string_lossy().into(),
                    notes_merged,
                    images_inlined: inlined,
                    images_missing: 0,
                })
            }
            MergeFormat::Html => {
                // 复用单篇 HTML 导出：合并后的 markdown 当作"一篇超长笔记"喂进去，
                // 图片内嵌 + 附件转 data: 下载链接的逻辑全部自动生效
                let r = HtmlExportService::export_single(
                    title,
                    &merged,
                    target_path,
                    instance_data_dir,
                    fonts,
                )?;
                Ok(MergeExportResult {
                    file_path: r.file_path,
                    notes_merged,
                    images_inlined: r.images_inlined,
                    images_missing: r.images_missing,
                })
            }
            #[cfg(desktop)]
            MergeFormat::Word => {
                // body_html 传 None：合并场景没有"前端编辑器实时 DOM"可用，
                // 走 markdown 重渲这条路（标题自动编号是渲染层的 widget，本来就带不出来）
                let r = WordExportService::export_single_best_effort(
                    title,
                    &merged,
                    target_path,
                    instance_data_dir,
                    None,
                    fonts,
                )?;
                Ok(MergeExportResult {
                    file_path: r.file_path,
                    notes_merged,
                    images_inlined: r.images_embedded,
                    images_missing: r.images_missing,
                })
            }
            #[cfg(not(desktop))]
            MergeFormat::Word => Err(AppError::Custom("移动端不支持导出 Word".into())),
        }
    }

    /// 查询范围内的笔记，并算出每篇相对导出根的文件夹路径。
    ///
    /// 排序：先按文件夹路径、再按标题 —— 同一个文件夹的笔记聚在一起，
    /// 章节顺序才符合"目录树从上到下"的直觉（`export_notes` 按 updated_at 排是因为
    /// 它落的是独立文件，顺序无所谓）。
    fn collect_notes(
        db: &Database,
        folder_id: Option<i64>,
        recursive: bool,
    ) -> Result<Vec<MergeNote>, AppError> {
        use std::collections::HashMap;

        let conn = db.conn_lock()?;

        let mut folder_names: HashMap<i64, String> = HashMap::new();
        let mut folder_parents: HashMap<i64, Option<i64>> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT id, name, parent_id FROM folders")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })?;
            for row in rows {
                let (id, name, parent_id) = row?;
                folder_names.insert(id, name);
                folder_parents.insert(id, parent_id);
            }
        }

        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
            if let Some(fid) = folder_id {
                // 同 export_notes：已持锁，只能用接收 &Connection 的版本
                let ids = if recursive {
                    crate::database::folders::bfs_descendant_ids(&conn, fid)?
                } else {
                    vec![fid]
                };
                let placeholders = (1..=ids.len())
                    .map(|i| format!("?{}", i))
                    .collect::<Vec<_>>()
                    .join(",");
                (
                    format!(
                        "SELECT title, content, folder_id, is_daily, daily_date \
                         FROM notes WHERE is_deleted = 0 AND folder_id IN ({})",
                        placeholders
                    ),
                    ids.into_iter()
                        .map(|i| Box::new(i) as Box<dyn rusqlite::types::ToSql>)
                        .collect(),
                )
            } else {
                (
                    "SELECT title, content, folder_id, is_daily, daily_date \
                     FROM notes WHERE is_deleted = 0"
                        .into(),
                    vec![],
                )
            };

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        let mut notes = Vec::new();
        for row in rows {
            let (title, content, note_folder_id, is_daily, daily_date) = row?;
            let rel_path = if is_daily {
                vec!["日记".to_string()]
            } else {
                match note_folder_id {
                    Some(fid) => rel_path_to_root(fid, folder_id, &folder_names, &folder_parents),
                    None => vec!["未分类".to_string()],
                }
            };
            // 日记的 title 常常是空/重复的，用日期当章节名更可读
            let title = if is_daily {
                daily_date.clone().unwrap_or(title)
            } else {
                title
            };
            notes.push(MergeNote {
                title,
                content,
                rel_path,
            });
        }

        notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path).then_with(|| a.title.cmp(&b.title)));
        Ok(notes)
    }
}

/// 从 `folder_id` 沿 parent 链上溯，收集到 `root_id`（不含）为止的文件夹名。
///
/// `root_id = None`（全库导出）时一路收到顶层；链断裂（脏数据）时收到断点为止，
/// 不 panic、不无限循环（`visited` 兜底自引用 / 环）。
fn rel_path_to_root(
    folder_id: i64,
    root_id: Option<i64>,
    names: &std::collections::HashMap<i64, String>,
    parents: &std::collections::HashMap<i64, Option<i64>>,
) -> Vec<String> {
    let mut parts = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut current = Some(folder_id);

    while let Some(id) = current {
        if Some(id) == root_id || !visited.insert(id) {
            break;
        }
        match names.get(&id) {
            Some(name) => parts.push(name.clone()),
            None => break,
        }
        current = parents.get(&id).copied().flatten();
    }

    parts.reverse();
    parts
}

/// 把多篇笔记拼成一份带章节层级的 markdown。
///
/// 结构：
/// ```text
/// # 工作                 ← root_title（h1）
/// ## 目录                ← 纯列表，不带锚点链接（见下方注释）
/// ## 周报                ← 子文件夹（h2）
/// ### 第一周             ← 笔记（h3）
/// #### 正文原 h1          ← 正文标题整体下推
/// ```
///
/// **目录为什么不做锚点链接**：渲染走 `pulldown_cmark::push_html`，它不给 heading 生成
/// `id` 属性 —— 写了 `[x](#x)` 点了也跳不动，Word 转换器那条路更是直接丢失。
/// 与其给一份点不动的链接，不如老实给纯文本索引，三种格式表现一致。
fn build_merged_markdown(root_title: &str, notes: &[MergeNote]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", root_title));

    // ─── 目录 ───
    out.push_str("## 目录\n\n");
    let mut toc_path: Vec<String> = Vec::new();
    for note in notes {
        for (depth, seg) in note.rel_path.iter().enumerate() {
            if toc_path.get(depth) != Some(seg) {
                out.push_str(&format!("{}- **{}**\n", "  ".repeat(depth), seg));
                toc_path.truncate(depth);
                toc_path.push(seg.clone());
            }
        }
        toc_path.truncate(note.rel_path.len());
        out.push_str(&format!(
            "{}- {}\n",
            "  ".repeat(note.rel_path.len()),
            display_title(&note.title)
        ));
    }
    out.push('\n');

    // ─── 正文 ───
    let mut current_path: Vec<String> = Vec::new();
    for note in notes {
        // 文件夹变了就补文件夹章节标题（h2 起，每深一层降一级）
        for (depth, seg) in note.rel_path.iter().enumerate() {
            if current_path.get(depth) != Some(seg) {
                let level = (depth + 2).min(MAX_HEADING_LEVEL);
                out.push_str(&format!("{} {}\n\n", "#".repeat(level), seg));
                current_path.truncate(depth);
                current_path.push(seg.clone());
            }
        }
        current_path.truncate(note.rel_path.len());

        // 笔记标题：文件夹层级之下再降一级
        let note_level = (note.rel_path.len() + 2).min(MAX_HEADING_LEVEL);
        out.push_str(&format!(
            "{} {}\n\n",
            "#".repeat(note_level),
            display_title(&note.title)
        ));

        let body = shift_headings(note.content.trim(), note_level);
        if !body.is_empty() {
            out.push_str(&body);
            out.push_str("\n\n");
        }
        // 章节分隔线。前面已保证有空行 —— 否则紧贴正文末行的 `---` 会被
        // CommonMark 当成 setext 二级标题，把上一段文字变成大标题
        out.push_str("---\n\n");
    }

    out
}

/// 空标题在文档里会变成一个孤零零的 `###`，给个占位更好读
fn display_title(title: &str) -> &str {
    let t = title.trim();
    if t.is_empty() {
        "（无标题）"
    } else {
        t
    }
}

/// 把 markdown 正文里的 ATX 标题整体下推 `shift` 级，最深截到 h6。
///
/// 必须跳过**围栏代码块**内的行：笔记里贴 shell 脚本（`# 注释`）或 markdown 示例极常见，
/// 不做保护就会把代码内容改坏 —— 这是合并导出唯一真正有风险的一步。
/// 缩进代码块（4 空格）同理跳过；ATX 标题本身最多允许 3 个前导空格。
fn shift_headings(md: &str, shift: usize) -> String {
    let mut out = String::with_capacity(md.len());
    // 围栏状态：Some((围栏字符, 围栏长度))
    let mut fence: Option<(char, usize)> = None;

    for line in md.lines() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();

        // ─── 围栏开合 ───
        if let Some((fence_char, fence_len)) = fence {
            if is_fence(trimmed, fence_char).is_some_and(|len| len >= fence_len)
                && trimmed[fence_len.min(trimmed.len())..].trim().is_empty()
            {
                fence = None;
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        for ch in ['`', '~'] {
            if let Some(len) = is_fence(trimmed, ch) {
                fence = Some((ch, len));
                break;
            }
        }
        if fence.is_some() {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // ─── ATX 标题下推 ───
        // 缩进 ≥ 4 空格是代码块，不是标题
        if indent < 4 && trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            let rest = &trimmed[hashes..];
            // `#foo` 不是标题，`# foo` / 单独一行 `#` 才是
            if (1..=MAX_HEADING_LEVEL).contains(&hashes)
                && (rest.is_empty() || rest.starts_with([' ', '\t']))
            {
                let new_level = (hashes + shift).min(MAX_HEADING_LEVEL);
                out.push_str(&" ".repeat(indent));
                out.push_str(&"#".repeat(new_level));
                out.push_str(rest);
                out.push('\n');
                continue;
            }
        }

        out.push_str(line);
        out.push('\n');
    }

    out.trim_end().to_string()
}

/// 行首是否是 `ch` 组成的围栏（至少 3 个）；是则返回围栏长度
fn is_fence(trimmed: &str, ch: char) -> Option<usize> {
    let len = trimmed.chars().take_while(|c| *c == ch).count();
    if len >= 3 {
        Some(len)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(title: &str, content: &str, rel: &[&str]) -> MergeNote {
        MergeNote {
            title: title.into(),
            content: content.into(),
            rel_path: rel.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn 标题按章节层级下推() {
        let out = shift_headings("# 一级\n## 二级\n正文", 3);
        assert_eq!(out, "#### 一级\n##### 二级\n正文");
    }

    #[test]
    fn 下推超过_h6_截断() {
        let out = shift_headings("##### 五级\n###### 六级", 4);
        assert_eq!(out, "###### 五级\n###### 六级");
    }

    #[test]
    fn 围栏代码块内的井号不动() {
        let md = "# 标题\n\n```bash\n# 这是注释\n echo hi\n```\n\n# 尾标题";
        let out = shift_headings(md, 2);
        assert!(out.contains("### 标题"), "正文标题应下推: {}", out);
        assert!(out.contains("\n# 这是注释\n"), "代码块内不应改动: {}", out);
        assert!(out.contains("### 尾标题"), "围栏关闭后应恢复下推: {}", out);
    }

    #[test]
    fn 波浪号围栏同样保护() {
        let out = shift_headings("~~~\n# 代码里的井号\n~~~", 2);
        assert!(out.contains("\n# 代码里的井号\n"), "{}", out);
    }

    #[test]
    fn 非标题的井号不受影响() {
        // `#foo`（无空格）在 CommonMark 里不是标题；4 空格缩进的是代码块
        let out = shift_headings("#hashtag\n    # 缩进代码", 2);
        assert_eq!(out, "#hashtag\n    # 缩进代码");
    }

    #[test]
    fn 合并文档带目录与章节层级() {
        let notes = vec![
            note("周报一", "# 本周", &["周报"]),
            note("随手记", "正文", &[]),
        ];
        let out = build_merged_markdown("工作", &notes);

        assert!(out.starts_with("# 工作\n"), "{}", out);
        assert!(out.contains("## 目录"), "{}", out);
        // 根直属笔记 → h2；子文件夹 → h2，其下笔记 → h3
        assert!(out.contains("\n## 随手记\n"), "{}", out);
        assert!(out.contains("\n## 周报\n"), "{}", out);
        assert!(out.contains("\n### 周报一\n"), "{}", out);
        // 笔记正文的 h1 被下推到 h4（章节 h3 之下）
        assert!(out.contains("\n#### 本周"), "{}", out);
    }

    #[test]
    fn 章节分隔线前必有空行() {
        // 紧贴正文的 `---` 会被 CommonMark 当成 setext 标题，把上一行变成大标题
        let out = build_merged_markdown("x", &[note("a", "末行文字", &[])]);
        assert!(out.contains("末行文字\n\n---"), "{}", out);
    }

    #[test]
    fn 空标题有占位() {
        let out = build_merged_markdown("x", &[note("   ", "正文", &[])]);
        assert!(out.contains("## （无标题）"), "{}", out);
    }

    #[test]
    fn 相对路径上溯到导出根为止() {
        let mut names = std::collections::HashMap::new();
        let mut parents = std::collections::HashMap::new();
        // 工作(1) → 周报(2) → 月度(3)
        names.insert(1, "工作".to_string());
        names.insert(2, "周报".to_string());
        names.insert(3, "月度".to_string());
        parents.insert(1, None);
        parents.insert(2, Some(1));
        parents.insert(3, Some(2));

        // 以"工作"为根导出：月度 的相对路径是 周报/月度
        assert_eq!(
            rel_path_to_root(3, Some(1), &names, &parents),
            vec!["周报".to_string(), "月度".to_string()]
        );
        // 全库导出：一路收到顶层
        assert_eq!(
            rel_path_to_root(3, None, &names, &parents),
            vec!["工作".to_string(), "周报".to_string(), "月度".to_string()]
        );
        // 根自身的笔记：相对路径为空
        assert!(rel_path_to_root(1, Some(1), &names, &parents).is_empty());
    }

    #[test]
    fn 父链成环不死循环() {
        let mut names = std::collections::HashMap::new();
        let mut parents = std::collections::HashMap::new();
        names.insert(1, "a".to_string());
        names.insert(2, "b".to_string());
        parents.insert(1, Some(2));
        parents.insert(2, Some(1));
        let path = rel_path_to_root(1, None, &names, &parents);
        assert_eq!(path.len(), 2, "环应在重复访问时停下: {:?}", path);
    }
}
