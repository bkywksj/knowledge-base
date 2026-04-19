use crate::error::AppError;
use crate::models::{GraphData, GraphEdge, GraphNode, NoteLink};

/// 标题规范化：trim + 连续空白折叠成单空格 + 转小写。
///
/// 和前端 `stripHtml` 的 `/\s+/g → " "` + `trim()` 对齐，
/// 再加 `to_lowercase()` 让英文更宽松（对中文无影响）。
fn normalize_title(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
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
    /// Tiptap 正文经过 `stripHtml` 提取后，会把多空白折叠成单空格（`\s+` → ` `），
    /// 而 DB 里的 `title` 没做同样处理，前端用 `name === t` 严格相等会错失匹配。
    /// 这里在 Rust 侧做 trim + 空白折叠 + 小写 后做精确相等比较，
    /// 命中第一个就返回 id。
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
            "SELECT id, title FROM notes WHERE is_deleted = 0 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, t) = row?;
            if normalize_title(&t) == needle {
                return Ok(Some(id));
            }
        }
        Ok(None)
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

    /// 获取知识图谱数据（所有未删除笔记 + 所有链接关系）
    pub fn get_graph_data(&self) -> Result<GraphData, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // 查询所有未删除笔记节点（含标签数和链接数）
        let mut node_stmt = conn.prepare(
            "SELECT n.id, n.title, n.is_daily, n.is_pinned,
                    (SELECT COUNT(*) FROM note_tags nt WHERE nt.note_id = n.id) AS tag_count,
                    (SELECT COUNT(*) FROM note_links nl WHERE nl.source_id = n.id OR nl.target_id = n.id) AS link_count
             FROM notes n
             WHERE n.is_deleted = 0
             ORDER BY n.updated_at DESC",
        )?;
        let nodes = node_stmt
            .query_map([], |row| {
                Ok(GraphNode {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    is_daily: row.get(2)?,
                    is_pinned: row.get(3)?,
                    tag_count: row.get::<_, i64>(4)? as usize,
                    link_count: row.get::<_, i64>(5)? as usize,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // 查询所有链接边（仅包含未删除笔记之间的链接）
        let mut edge_stmt = conn.prepare(
            "SELECT nl.source_id, nl.target_id
             FROM note_links nl
             JOIN notes n1 ON n1.id = nl.source_id AND n1.is_deleted = 0
             JOIN notes n2 ON n2.id = nl.target_id AND n2.is_deleted = 0",
        )?;
        let edges = edge_stmt
            .query_map([], |row| {
                Ok(GraphEdge {
                    source: row.get(0)?,
                    target: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(GraphData { nodes, edges })
    }
}
