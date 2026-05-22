use crate::error::AppError;
use crate::models::{GraphData, GraphEdge, GraphNode, NoteLink, WikiLinkSuggestItem};

/// 去 markdown 转义：把 `\X`（X 为非字母数字）中的 `\` 丢弃。
///
/// 用途：从 markdown 文件导入或经 markdown 序列化往返后，
/// 笔记 content 中的 `_ * # [ ] ( )` 等会被 `\` 转义
/// （例如 `[[A_B]]` → `[[A\_B]]`，甚至外层 `[[` → `\[\[`）。
/// 既会让 `extract_wiki_titles` 找不到 `[[...]]` 配对，
/// 也会让标题字符串无法和原始 `title` 字段对齐。
/// 保留 `\n` 等真正的字母转义不变。
fn unescape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if !next.is_alphanumeric() {
                    chars.next();
                    out.push(next);
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// 标题规范化：去 markdown 转义 + trim + 连续空白折叠成单空格 + 转小写。
///
/// 暴露为 `pub(crate)`：schema 迁移回填、notes DAO 写入 `title_normalized` 列
/// 都需要调用，确保入库值和运行时匹配值用同一套规则。
pub(crate) fn normalize_title(s: &str) -> String {
    unescape_md(s)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// 从笔记 HTML 内容里提取所有 `[[标题]]` / `[[标题|ID]]` —— 与前端 `extractWikiLinks` 对齐。
///
/// 返回 `(title, explicit_id)` 列表，按出现顺序去重。
/// - `[[标题|123]]`：带 ID 锚点（推荐形式，由 wiki 候选下拉选中后生成）
///   → `("标题", Some(123))`
/// - `[[标题]]`：旧的"靠 normalize_title 查 ID"形式，作为 fallback
///   → `("标题", None)`
///
/// 实现：极简 stripHtml → markdown 反转义 → 扫描 `[[ ... ]]` 配对 → 切分 `|`。
/// 反转义这步至关重要：DB 里的 wiki 链接经常是 `\[\[标题\]\]` 这种被 markdown 整体转义的形式。
/// 所有边界操作都在 char 边界（`[`/`]`/`|` 都是 ASCII）。
///
/// 去重规则：以 `(normalize_title(title), explicit_id)` 为键去重。
/// 同一 title 既出现 `[[X]]` 也出现 `[[X|N]]` 时两条都保留（后者更可靠，建边时优先）。
pub(crate) fn extract_wiki_refs(html: &str) -> Vec<(String, Option<i64>)> {
    // 极简 stripHtml
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
            }
        } else if c == '<' {
            in_tag = true;
        } else {
            text.push(c);
        }
    }
    let text = text.replace("&nbsp;", " ");
    // 关键：去 markdown 转义，让 `\[\[…\]\]` 还原为 `[[…]]`
    let text = unescape_md(&text);

    let mut refs: Vec<(String, Option<i64>)> = Vec::new();
    let mut seen: std::collections::HashSet<(String, Option<i64>)> =
        std::collections::HashSet::new();
    let mut rest: &str = text.as_str();
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        match after.find("]]") {
            Some(close) => {
                let inside = &after[..close];
                // 切分 `标题|ID` —— 仅识别"竖线 + 纯数字"形式
                let (title_part, id_part) = match inside.rfind('|') {
                    Some(p) => {
                        let id_str = inside[p + 1..].trim();
                        if !id_str.is_empty() && id_str.chars().all(|c| c.is_ascii_digit()) {
                            (inside[..p].trim(), id_str.parse::<i64>().ok())
                        } else {
                            // 竖线后不是纯数字 → 整体当 title（用户标题里可能有 `|`）
                            (inside.trim(), None)
                        }
                    }
                    None => (inside.trim(), None),
                };
                if !title_part.is_empty() {
                    let key = (normalize_title(title_part), id_part);
                    if seen.insert(key) {
                        refs.push((title_part.to_string(), id_part));
                    }
                }
                rest = &after[close + 2..];
            }
            None => break,
        }
    }
    refs
}

impl super::Database {
    /// 从笔记 content 解析 `[[wiki]]` 并写入 note_links（sync v1 pull 后补齐反链用）。
    ///
    /// 跟前端 handleSave 时的"extractWikiLinks + findIdByTitle + syncLinks"链路同等效果，
    /// 但完全在 Rust 侧一次完成，避免 pull 完之后用户不打开笔记就拿不到反链。
    ///
    /// 解析规则与 [`extract_wiki_refs`] / `compute_graph` 完全一致：
    /// - `[[Title|N]]` 显式 ID 命中 + 目标可见 → 用该 id
    /// - explicit_id 指向已删除 / 隐藏 → 当作无目标，不退化到同名笔记（避免静默指错）
    /// - `[[Title]]` 走 `find_note_id_by_title_loose`（normalize_title 精确匹配）
    /// - 防自引用 + 去重
    pub fn rebuild_note_links_from_content(
        &self,
        source_id: i64,
        content: &str,
    ) -> Result<(), AppError> {
        let refs = extract_wiki_refs(content);
        if refs.is_empty() {
            // 空 refs 也要走一遍 sync_note_links 把旧的清干净
            return self.sync_note_links(source_id, Vec::new());
        }
        // explicit_id 走存在性校验，过滤掉已删 / 隐藏
        let mut target_ids: Vec<i64> = Vec::with_capacity(refs.len());
        let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for (title, explicit_id) in refs {
            let candidate = match explicit_id {
                Some(id) => {
                    // 校验目标存在且 visible
                    let conn = self
                        .conn
                        .lock()
                        .map_err(|e| AppError::Custom(e.to_string()))?;
                    let visible: Option<i64> = conn
                        .query_row(
                            "SELECT id FROM notes
                             WHERE id = ?1 AND is_deleted = 0 AND is_hidden = 0",
                            rusqlite::params![id],
                            |row| row.get(0),
                        )
                        .ok();
                    drop(conn);
                    visible
                }
                None => self.find_note_id_by_title_loose(&title)?,
            };
            if let Some(tid) = candidate {
                if tid != source_id && seen.insert(tid) {
                    target_ids.push(tid);
                }
            }
        }
        self.sync_note_links(source_id, target_ids)
    }

    /// 同步笔记的出链（先删除旧链接，再插入新链接）
    pub fn sync_note_links(&self, source_id: i64, target_ids: Vec<i64>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM note_links WHERE source_id = ?1", [source_id])?;
        let mut stmt = conn
            .prepare("INSERT OR IGNORE INTO note_links (source_id, target_id) VALUES (?1, ?2)")?;
        for target_id in target_ids {
            if target_id != source_id {
                // 防止自引用
                stmt.execute(rusqlite::params![source_id, target_id])?;
            }
        }
        Ok(())
    }

    /// 获取反向链接（哪些笔记链接到了 target_id）
    pub fn get_backlinks(&self, target_id: i64) -> Result<Vec<NoteLink>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // T-003: 反向链接也过滤隐藏源笔记——不想在"普通笔记"的反链面板里泄露
        // "哪些隐藏笔记引用了你"。跳转 [[...]] 本身不受影响（走 find_note_id_by_title_loose）。
        let mut stmt = conn.prepare(
            "SELECT nl.source_id, n.title, nl.context, n.updated_at
             FROM note_links nl
             JOIN notes n ON n.id = nl.source_id
             WHERE nl.target_id = ?1 AND n.is_deleted = 0 AND n.is_hidden = 0
             ORDER BY n.updated_at DESC",
        )?;
        let links = stmt
            .query_map([target_id], |row| {
                Ok(NoteLink {
                    source_id: row.get(0)?,
                    source_title: row.get(1)?,
                    context: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(links)
    }

    /// 通过"规范化精确匹配"查找笔记 ID
    ///
    /// 优化：从全表扫 + 应用层逐行规范化，改为直接命中 `idx_notes_title_normalized`
    /// 索引。`title_normalized` 列在 v17 迁移时回填，`create_note` / `update_note` /
    /// `get_or_create_daily` 同步维护。这条路径被 wiki 链接编辑器、保存前链接同步
    /// 等高频调用，改完后 10k 笔记库下的 IPC 响应从 ~50ms 级降到亚毫秒级。
    pub fn find_note_id_by_title_loose(&self, title: &str) -> Result<Option<i64>, AppError> {
        let needle = normalize_title(title);
        if needle.is_empty() {
            return Ok(None);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id FROM notes
             WHERE title_normalized = ?1 AND is_deleted = 0
             ORDER BY updated_at DESC
             LIMIT 1",
        )?;
        let result: Option<i64> = stmt.query_row([&needle], |row| row.get(0)).ok();
        Ok(result)
    }

    /// 根据标题模糊搜索笔记（用于 [[ 自动补全）
    ///
    /// 返回带 folder_name 的 `WikiLinkSuggestItem`，让前端候选下拉在**重名标题**时
    /// 用直接父文件夹名做消歧义提示。LEFT JOIN folders：无父文件夹时 folder_name = NULL。
    pub fn search_notes_by_title(
        &self,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<WikiLinkSuggestItem>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let pattern = format!("%{}%", keyword);
        // T-003: wiki link 候选下拉不暴露隐藏笔记标题（弱保护）；
        // 用户已经写好的 [[隐藏笔记]] 跳转仍可用（走 find_note_id_by_title_loose，那里不过滤）。
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, f.name
             FROM notes n
             LEFT JOIN folders f ON f.id = n.folder_id
             WHERE n.title LIKE ?1 AND n.is_deleted = 0 AND n.is_hidden = 0
             ORDER BY n.updated_at DESC
             LIMIT ?2",
        )?;
        let results = stmt
            .query_map(rusqlite::params![pattern, limit as i64], |row| {
                Ok(WikiLinkSuggestItem {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    folder_name: row.get::<_, Option<String>>(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    }

    /// 获取知识图谱数据（所有未删除笔记 + 实时计算的链接关系）
    ///
    /// 边的来源：**实时扫描每条笔记 content 里的 `[[标题]]`**，与所有笔记标题做规范化匹配建边。
    /// 不再依赖 `note_links` 表（该表由 handleSave 时同步，存在"目标笔记后创建则永远不补全"的问题）。
    /// `note_links` 表仍由其他功能（反向链接面板）使用，本方法不读它。
    pub fn get_graph_data(&self) -> Result<GraphData, AppError> {
        use std::collections::{HashMap, HashSet};

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // 一次性查所有未删除笔记的元信息 + content（用于扫 wiki 链接）
        struct Row {
            id: i64,
            title: String,
            content: String,
            is_daily: bool,
            is_pinned: bool,
            tag_count: usize,
        }

        // 用 LEFT JOIN + GROUP BY 一次性拿到 tag_count，替代原来每行一条相关子查询（N+1）。
        // 对于 10k+ 笔记、平均 3 标签的情况，扫描量从 10k * 10k → 10k + 30k，快十数倍。
        // T-003: 过滤隐藏笔记。节点不返回后，下面扫 wiki 建边时 title_to_id 里也没这些笔记，
        // 对隐藏笔记的 [[wiki link]] 自动成为"断边"，图里既无节点也无指向它的边，达到隐身效果。
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.content, n.is_daily, n.is_pinned,
                    COUNT(nt.tag_id) AS tag_count
             FROM notes n
             LEFT JOIN note_tags nt ON nt.note_id = n.id
             WHERE n.is_deleted = 0 AND n.is_hidden = 0
             GROUP BY n.id
             ORDER BY n.updated_at DESC",
        )?;
        let rows: Vec<Row> = stmt
            .query_map([], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    content: r.get(2)?,
                    is_daily: r.get(3)?,
                    is_pinned: r.get(4)?,
                    tag_count: r.get::<_, i64>(5)? as usize,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // 建索引：
        //   - title_to_id：normalized_title → id（同名取最新的；fallback 路径用）
        //   - valid_ids：所有可见笔记 ID 集合（带 ID 锚点要校验目标还存在）
        let mut title_to_id: HashMap<String, i64> = HashMap::with_capacity(rows.len());
        let mut valid_ids: HashSet<i64> = HashSet::with_capacity(rows.len());
        for r in &rows {
            title_to_id.entry(normalize_title(&r.title)).or_insert(r.id);
            valid_ids.insert(r.id);
        }

        // 扫 content 提取 wiki ref，匹配建边
        // 优先级：explicit_id（且目标可见）> normalize_title fallback
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut link_count: HashMap<i64, usize> = HashMap::new();
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        for r in &rows {
            let refs = extract_wiki_refs(&r.content);
            for (title, explicit_id) in refs {
                let target_id = match explicit_id {
                    Some(id) if valid_ids.contains(&id) => Some(id),
                    // explicit_id 指向已删除 / 隐藏的笔记 → 不要 fallback 到同名笔记，
                    // 避免出现「想引用 A1，A1 删了，边却悄悄指向同名 A2」的诡异行为
                    Some(_) => None,
                    None => title_to_id.get(&normalize_title(&title)).copied(),
                };
                let Some(target_id) = target_id else {
                    continue;
                };
                if target_id == r.id {
                    continue; // 防自引用
                }
                if !seen.insert((r.id, target_id)) {
                    continue; // 同 (source, target) 在 content 中可能出现多次，去重
                }
                edges.push(GraphEdge {
                    source: r.id,
                    target: target_id,
                });
                *link_count.entry(r.id).or_insert(0) += 1;
                *link_count.entry(target_id).or_insert(0) += 1;
            }
        }

        // 组装节点（link_count 取自实时统计）
        let nodes: Vec<GraphNode> = rows
            .into_iter()
            .map(|r| GraphNode {
                link_count: link_count.get(&r.id).copied().unwrap_or(0),
                id: r.id,
                title: r.title,
                is_daily: r.is_daily,
                is_pinned: r.is_pinned,
                tag_count: r.tag_count,
            })
            .collect();

        Ok(GraphData { nodes, edges })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_md_drops_backslash_before_punctuation() {
        // 转义的标点：吃掉反斜杠
        assert_eq!(unescape_md(r"\[\[Note\]\]"), "[[Note]]");
        assert_eq!(unescape_md(r"\*emph\*"), "*emph*");
        assert_eq!(unescape_md(r"A\_B"), "A_B");
    }

    #[test]
    fn unescape_md_keeps_letter_escapes() {
        // \n / \t 这种字母转义：保留原样（不丢 \）
        assert_eq!(unescape_md(r"line\nbreak"), r"line\nbreak");
        assert_eq!(unescape_md(r"col\tsep"), r"col\tsep");
    }

    #[test]
    fn extract_wiki_refs_basic() {
        let refs = extract_wiki_refs("正文 [[A]] 中间 [[B]] 末尾");
        assert_eq!(refs, vec![("A".to_string(), None), ("B".to_string(), None)]);
    }

    #[test]
    fn extract_wiki_refs_handles_escaped_brackets() {
        // 核心回归点：TaskItem 序列化 markdown 时把 [[X]] 写成 \[\[X\]\]
        // 修复前会扫不到任何 wiki-link，反链整体失效
        let refs = extract_wiki_refs(r"<p>任务 \[\[测试2\]\] 完成</p>");
        assert_eq!(refs, vec![("测试2".to_string(), None)]);
    }

    #[test]
    fn extract_wiki_refs_handles_escaped_underscore_inside() {
        // 标题里有 _ 时，markdown 会转义成 \_
        let refs = extract_wiki_refs(r"<p>查看 [[A\_B]]</p>");
        assert_eq!(refs, vec![("A_B".to_string(), None)]);
    }

    #[test]
    fn extract_wiki_refs_dedupes() {
        let refs = extract_wiki_refs("[[A]] [[A]] [[B]] [[A]]");
        assert_eq!(refs, vec![("A".to_string(), None), ("B".to_string(), None)]);
    }

    #[test]
    fn extract_wiki_refs_skips_unclosed() {
        // 未配对的 [[ 不应卡死或误识别
        let refs = extract_wiki_refs("正文 [[unclosed 后续");
        assert!(refs.is_empty());
    }

    // ─── 新增：带 ID 锚点的形式 ──────────────────

    #[test]
    fn extract_wiki_refs_with_explicit_id() {
        // 候选下拉选中后插入的标准形式：[[标题|ID]]
        let refs = extract_wiki_refs("看 [[张三|42]] 和 [[李四|7]]");
        assert_eq!(
            refs,
            vec![("张三".to_string(), Some(42)), ("李四".to_string(), Some(7))]
        );
    }

    #[test]
    fn extract_wiki_refs_id_with_escaped_brackets() {
        // markdown 序列化转义后仍应正确识别 ID
        let refs = extract_wiki_refs(r"<p>\[\[标题\|42\]\]</p>");
        assert_eq!(refs, vec![("标题".to_string(), Some(42))]);
    }

    // ─── rebuild_note_links_from_content（sync v1 pull 后反链重建）─────────

    use crate::models::NoteInput;

    fn mem_db() -> crate::database::Database {
        crate::database::Database::init(":memory:").unwrap()
    }

    #[test]
    fn rebuild_links_creates_edge_by_title() {
        let db = mem_db();
        let a = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let b = db
            .create_note(&NoteInput {
                title: "B".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        // 让 A 的内容指向 [[B]]
        db.rebuild_note_links_from_content(a.id, "看 [[B]]")
            .unwrap();
        // B 的反链应能查到 A
        let backlinks = db.get_backlinks(b.id).unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_id, a.id);
    }

    #[test]
    fn rebuild_links_clears_when_no_refs() {
        let db = mem_db();
        let a = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let b = db
            .create_note(&NoteInput {
                title: "B".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        db.rebuild_note_links_from_content(a.id, "[[B]]").unwrap();
        assert_eq!(db.get_backlinks(b.id).unwrap().len(), 1);
        // 重建为空内容 → 反链清零
        db.rebuild_note_links_from_content(a.id, "现在没有引用了")
            .unwrap();
        assert!(db.get_backlinks(b.id).unwrap().is_empty());
    }

    #[test]
    fn rebuild_links_skips_invisible_explicit_id() {
        let db = mem_db();
        let a = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let b = db
            .create_note(&NoteInput {
                title: "B".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        // 删掉 B 后用 explicit ID 引用 → 不应建边（避免静默指错）
        db.soft_delete_note(b.id).unwrap();
        db.rebuild_note_links_from_content(a.id, &format!("[[B|{}]]", b.id))
            .unwrap();
        assert!(db.get_backlinks(b.id).unwrap().is_empty());
    }

    #[test]
    fn rebuild_links_dedupes_and_skips_self() {
        let db = mem_db();
        let a = db
            .create_note(&NoteInput {
                title: "A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let b = db
            .create_note(&NoteInput {
                title: "B".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        // 多次引用 B + 一次自引用 A → 只产生一条 A→B
        db.rebuild_note_links_from_content(a.id, "[[B]] 又 [[B]] 又 [[A]]")
            .unwrap();
        let backlinks_b = db.get_backlinks(b.id).unwrap();
        assert_eq!(backlinks_b.len(), 1);
        let backlinks_a = db.get_backlinks(a.id).unwrap();
        assert!(backlinks_a.is_empty(), "不能有自环边");
    }

    #[test]
    fn extract_wiki_refs_pipe_in_title_no_id() {
        // 用户手敲的标题里含 `|`：竖线后不是纯数字 → 当成 title 一部分
        let refs = extract_wiki_refs("[[A | B]]");
        assert_eq!(refs, vec![("A | B".to_string(), None)]);
    }

    #[test]
    fn extract_wiki_refs_id_takes_rightmost_pipe() {
        // 标题里有 `|`，最后是 `|N` 形式 → 切最右侧竖线
        let refs = extract_wiki_refs("[[A|B|42]]");
        assert_eq!(refs, vec![("A|B".to_string(), Some(42))]);
    }

    #[test]
    fn extract_wiki_refs_mixed_dedupe_keeps_both() {
        // 同一标题既有带 ID 又有不带 ID → 两条都保留（建边时优先用带 ID 的）
        let refs = extract_wiki_refs("[[张三]] 又出现 [[张三|9]]");
        assert_eq!(
            refs,
            vec![("张三".to_string(), None), ("张三".to_string(), Some(9))]
        );
    }

    #[test]
    fn extract_wiki_refs_non_numeric_id_falls_back_to_title() {
        // 竖线后是非数字 → 不识别为 ID，整体当 title
        let refs = extract_wiki_refs("[[标题|abc]]");
        assert_eq!(refs, vec![("标题|abc".to_string(), None)]);
    }
}
