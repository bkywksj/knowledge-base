use crate::error::AppError;
use crate::models::{GraphData, GraphEdge, GraphNode, NoteLink};

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

/// 从笔记 HTML 内容里提取所有 `[[标题]]` —— 与前端 `extractWikiLinks` 对齐。
///
/// 实现：极简 stripHtml → markdown 反转义 → 扫描 `[[ ... ]]` 配对 → trim + 去重。
/// 反转义这步至关重要：DB 里的 wiki 链接经常是 `\[\[标题\]\]` 这种被 markdown 整体转义的形式，
/// 不去转义就根本扫描不到 `[[`。所有边界操作都在 char 边界（`[`/`]` 是 ASCII）。
fn extract_wiki_titles(html: &str) -> Vec<String> {
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

    let mut titles: Vec<String> = Vec::new();
    let mut rest: &str = text.as_str();
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        match after.find("]]") {
            Some(close) => {
                let title = after[..close].trim();
                if !title.is_empty() && !titles.iter().any(|t| t == title) {
                    titles.push(title.to_string());
                }
                rest = &after[close + 2..];
            }
            None => break,
        }
    }
    titles
}

impl super::Database {
    /// 同步笔记的出链（先删除旧链接，再插入新链接）
    pub fn sync_note_links(&self, source_id: i64, target_ids: Vec<i64>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM note_links WHERE source_id = ?1", [source_id])?;
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO note_links (source_id, target_id) VALUES (?1, ?2)",
        )?;
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
        let mut stmt = conn.prepare(
            "SELECT nl.source_id, n.title, nl.context, n.updated_at
             FROM note_links nl
             JOIN notes n ON n.id = nl.source_id
             WHERE nl.target_id = ?1 AND n.is_deleted = 0
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
    pub fn search_notes_by_title(
        &self,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let pattern = format!("%{}%", keyword);
        let mut stmt = conn.prepare(
            "SELECT id, title FROM notes WHERE title LIKE ?1 AND is_deleted = 0 ORDER BY updated_at DESC LIMIT ?2",
        )?;
        let results = stmt
            .query_map(rusqlite::params![pattern, limit as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
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
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.content, n.is_daily, n.is_pinned,
                    COUNT(nt.tag_id) AS tag_count
             FROM notes n
             LEFT JOIN note_tags nt ON nt.note_id = n.id
             WHERE n.is_deleted = 0
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

        // 建索引：normalized_title → id（同名取第一个，与 find_note_id_by_title_loose 行为一致）
        let mut title_to_id: HashMap<String, i64> = HashMap::with_capacity(rows.len());
        for r in &rows {
            title_to_id
                .entry(normalize_title(&r.title))
                .or_insert(r.id);
        }

        // 扫 content 提取 wiki，匹配建边
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut link_count: HashMap<i64, usize> = HashMap::new();
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        for r in &rows {
            let titles = extract_wiki_titles(&r.content);
            for t in titles {
                let norm = normalize_title(&t);
                if let Some(&target_id) = title_to_id.get(&norm) {
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
