use crate::error::AppError;
use crate::models::{SearchFilters, SearchResult};

use super::Database;

/// 把筛选条件编译成 SQL 片段 + 绑定参数。
///
/// 返回的片段形如 `" AND n.folder_id IN (1,2) AND ..."`，可直接拼到 WHERE 尾部；
/// 无约束时返回空串。
///
/// 设计要点：
/// - **只生成条件，不做事后裁剪**。筛选必须下推到 SQL —— 若先取 top-N 再在 Rust 里
///   过滤，用户筛选后拿到的就不是 N 条而是 N 条里碰巧合规的那几条。
/// - i64 直接内联（整数无注入风险），字符串一律走占位符。
///   这样能避免与调用方已有的 n-gram 占位符编号打架。
fn build_filter_clause(
    filters: &SearchFilters,
    next_param_index: usize,
) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut binds: Vec<String> = Vec::new();
    let mut idx = next_param_index;

    if let Some(ids) = &filters.folder_ids {
        if !ids.is_empty() {
            let list = ids
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND n.folder_id IN ({})", list));
        }
    }

    if let Some(ids) = &filters.tag_ids {
        if !ids.is_empty() {
            // AND 语义：选了「工作」+「重要」= 两个标签都得有。
            // 用计数子查询而非多个 EXISTS —— 后者条件数随标签数线性膨胀。
            let list = ids
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(
                " AND (SELECT COUNT(DISTINCT nt.tag_id) FROM note_tags nt
                       WHERE nt.note_id = n.id AND nt.tag_id IN ({})) = {}",
                list,
                ids.len()
            ));
        }
    }

    if let Some(after) = &filters.updated_after {
        sql.push_str(&format!(" AND n.updated_at >= ?{}", idx));
        binds.push(after.clone());
        idx += 1;
    }
    if let Some(before) = &filters.updated_before {
        sql.push_str(&format!(" AND n.updated_at <= ?{}", idx));
        binds.push(before.clone());
        idx += 1;
    }

    if let Some(types) = &filters.note_types {
        if !types.is_empty() {
            let placeholders: Vec<String> = types
                .iter()
                .map(|t| {
                    let p = format!("?{}", idx);
                    binds.push(t.clone());
                    idx += 1;
                    p
                })
                .collect();
            sql.push_str(&format!(" AND n.note_type IN ({})", placeholders.join(",")));
        }
    }

    (sql, binds)
}

impl Database {
    /// 全文搜索（无筛选）。
    ///
    /// 生产路径一律走 [`Self::search_notes_filtered`]；这里只是测试里的便捷包装，
    /// 顺带充当"加了筛选不该改变无筛选时的行为"的对照组。
    #[cfg(test)]
    pub fn search_notes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, AppError> {
        self.search_notes_filtered(query, limit, &SearchFilters::default())
    }

    /// 带筛选条件的全文搜索（P1-2）。
    ///
    /// 筛选**下推到两条通道的 SQL 里**，而不是先搜完再在 Rust 侧裁剪 ——
    /// 否则"筛选后只剩 3 条"其实是"前 50 条里碰巧有 3 条合规"，
    /// 用户会以为知识库里就这么多。
    pub fn search_notes_filtered(
        &self,
        query: &str,
        limit: usize,
        filters: &SearchFilters,
    ) -> Result<Vec<SearchResult>, AppError> {
        // fail-closed：用户勾了某个维度却一个都没选中 → 明确返回空，
        // 绝不退化成"忽略该维度"（那会把整个知识库倒给用户）
        if filters.has_empty_selection() {
            return Ok(Vec::new());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // 1. 尝试 FTS5 搜索（需要转换为 FTS5 语法）
        let fts_query = sanitize_fts_query(query);
        if !fts_query.is_empty() {
            let fts_results = Self::search_fts(&conn, &fts_query, limit, filters);
            if let Ok(ref results) = fts_results {
                if !results.is_empty() {
                    return fts_results;
                }
            }
        }

        // 2. FTS5 无结果，用 LIKE 模糊搜索兜底（用原始查询）
        Self::search_like(&conn, query, limit, filters)
    }

    fn search_fts(
        conn: &rusqlite::Connection,
        fts_query: &str,
        limit: usize,
        filters: &SearchFilters,
    ) -> Result<Vec<SearchResult>, AppError> {
        // ?1 = MATCH 表达式，?2 = limit，故筛选条件的占位符从 ?3 起编号
        let (filter_sql, filter_binds) = build_filter_clause(filters, 3);
        // 与 LIKE fallback 路径保持一致：过滤回收站 + 隐藏笔记 + 临时编辑笔记。
        // 之前 FTS5 路径漏了 is_hidden = 0，会让 FTS5 命中的隐藏笔记泄露到主搜索结果里
        //
        // 排序：bm25 自定义权重，title 列权重 5.0、content 列 1.0。
        // FTS5 的 bm25() 分数越小越相关，ASC 让标题命中靠前。
        //
        // 时间衰减：bm25 + 久远天数 * 0.005。
        // 例子：相关度差不多的两个笔记，相差 30 天 → 旧的得分 +0.15，足以让新的排前但不会
        // 让相关度更高的老笔记被一篇刚改的边缘相关笔记盖掉（bm25 量级通常在 1~30）。
        // 未来想加访问频率加权也是从这里改 ORDER BY。
        let sql = format!(
            "SELECT n.id, n.title,
                    snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
                    n.updated_at, n.folder_id, n.note_type
             FROM notes_fts fts
             JOIN notes n ON fts.rowid = n.id
             WHERE notes_fts MATCH ?1
               AND n.is_deleted = 0
               AND n.is_hidden = 0
               AND n.is_scratch = 0{}
             ORDER BY bm25(notes_fts, 5.0, 1.0)
                    + (julianday('now') - julianday(n.updated_at)) * 0.005
             LIMIT ?2",
            filter_sql
        );
        let mut stmt = conn.prepare(&sql)?;

        // ?1 / ?2 固定，其后依次绑筛选参数
        let mut binds: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
            Box::new(fts_query.to_string()),
            Box::new(limit as i64),
        ];
        binds.extend(
            filter_binds
                .into_iter()
                .map(|b| Box::new(b) as Box<dyn rusqlite::types::ToSql>),
        );
        let binds_ref: Vec<&dyn rusqlite::types::ToSql> =
            binds.iter().map(|b| b.as_ref()).collect();

        let results = stmt
            .query_map(&*binds_ref, |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    // snippet() 取的是 fts5 第 1 列 = fts_body 生成列
                    // (= COALESCE(search_text, content))，白板拿到画布文字而非 JSON
                    snippet: row.get(2)?,
                    updated_at: row.get(3)?,
                    folder_id: row.get(4)?,
                    note_type: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(results)
    }

    fn search_like(
        conn: &rusqlite::Connection,
        query: &str,
        limit: usize,
        filters: &SearchFilters,
    ) -> Result<Vec<SearchResult>, AppError> {
        let raw_keywords: Vec<&str> = query.split_whitespace().filter(|s| !s.is_empty()).collect();

        // 中文加权 n-gram 展开（见 database::cjk）。
        //
        // 为什么不再是"按空格切 + 每段 LIKE %词%"：FTS5 的 unicode61 把连续汉字并成
        // 一个长 token，用户搜「本地说明」而笔记里写的是「本地仓库说明」时，
        // FTS 的前缀匹配（`本地说明*`）和这里的 `%本地说明%` **都会 miss** ——
        // 而这正是中文用户最常见的输入方式（不自觉加空格分词）。
        //
        // 展开后：token 之间 AND（空格 = 用户明确的收窄意图），
        // token 内部按权重累加过及格线（整体 5 / 3-gram 2 / 2-gram 1，线是 2）。
        let groups = super::cjk::expand_query(query);
        if groups.is_empty() {
            return Ok(Vec::new());
        }

        // 每个模式一个占位符，按顺序编号；同一个模式在 title / 正文里复用同一编号
        let mut patterns: Vec<String> = Vec::new();
        // 每组的 (占位符起始下标, 组内模式数, 该组权重, 及格线)
        let mut group_meta: Vec<(usize, usize, Vec<i32>, i32)> = Vec::new();
        for g in &groups {
            let start = patterns.len();
            let weights: Vec<i32> = g.patterns.iter().map(|p| p.weight).collect();
            patterns.extend(g.patterns.iter().map(|p| format!("%{}%", p.term)));
            group_meta.push((start, g.patterns.len(), weights, g.threshold));
        }

        // 正文用 COALESCE(search_text, content) 而不是裸 content —— 白板的 content 是
        // Excalidraw JSON，直接 LIKE 会让「strokeColor」「appState」这类属性名命中每一块白板。
        // 与 FTS 路径（fts_body 生成列，见 schema v53）保持同一口径。
        const BODY: &str = "COALESCE(n.search_text, n.content)";

        // 每组生成一个"加权累加 >= 及格线"的条件，组间 AND
        let where_clauses: Vec<String> = group_meta
            .iter()
            .map(|(start, count, weights, threshold)| {
                let score: String = (0..*count)
                    .map(|i| {
                        let ph = start + i + 1;
                        format!(
                            "(CASE WHEN n.title LIKE ?{ph} OR {BODY} LIKE ?{ph} THEN {w} ELSE 0 END)",
                            ph = ph,
                            w = weights[i],
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" + ");
                format!("(({}) >= {})", score, threshold)
            })
            .collect();

        // 标题命中表达式：任一模式出现在 title 中即视为"标题命中"，排序优先。
        // 只看整体模式（每组第一个，权重最高的那个）—— 用 2-gram 判定标题命中
        // 会让"标题里碰巧有两个字"的笔记冒到前面，反而不准。
        let title_hit_expr: String = group_meta
            .iter()
            .map(|(start, _, _, _)| format!("n.title LIKE ?{}", start + 1))
            .collect::<Vec<_>>()
            .join(" OR ");

        // 筛选条件的占位符编号接在 n-gram 模式与 limit 之后
        let (filter_sql, filter_binds) = build_filter_clause(filters, patterns.len() + 2);

        // T-003: 过滤隐藏笔记；隐藏笔记在主搜索里完全不可见
        // ORDER BY：先按"标题命中(0) vs 仅内容命中(1)"分组，再按 updated_at DESC
        let sql = format!(
            "SELECT n.id, n.title, COALESCE(n.search_text, n.content), n.updated_at, n.folder_id,
                    n.note_type,
                    CASE WHEN ({}) THEN 0 ELSE 1 END AS _title_score
             FROM notes n
             WHERE n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_scratch = 0 AND ({}){}
             ORDER BY _title_score ASC, n.updated_at DESC
             LIMIT ?{}",
            title_hit_expr,
            where_clauses.join(" AND "),
            filter_sql,
            patterns.len() + 1
        );

        let mut stmt = conn.prepare(&sql)?;

        // 绑定参数
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = patterns
            .iter()
            .map(|k| Box::new(k.clone()) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        param_values.push(Box::new(limit as i64));
        param_values.extend(
            filter_binds
                .into_iter()
                .map(|b| Box::new(b) as Box<dyn rusqlite::types::ToSql>),
        );

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let results = stmt
            .query_map(&*params_ref, |row| {
                // 第 2 列已在 SQL 里 COALESCE 成"可读正文"：白板拿到的是画布文字，
                // 不是 Excalidraw JSON —— 否则摘要会把一坨 {"appState":... 糊给用户
                let body: String = row.get(2)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    body,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // 生成带高亮的 snippet
        //
        // 🔴 高亮必须用**和召回同一套词元**：笔记是靠「本地」+「说明」两个 n-gram
        // 命中的，若这里只拿用户原样输入的「本地说明」去 find，必然找不到
        // → 退化成"截前 140 字、零高亮"，用户看不出为什么这条被搜出来。
        // （对标项目正是栽在这里：召回用 n-gram、高亮用整句，中文高亮基本失效。）
        //
        // 顺序：先放用户原词（最长、最精确，优先作为定位锚点），
        // 再放展开出的 n-gram 作兜底。
        let mut highlight_terms: Vec<&str> = raw_keywords.clone();
        for g in &groups {
            for p in &g.patterns {
                if !highlight_terms.iter().any(|t| *t == p.term) {
                    highlight_terms.push(&p.term);
                }
            }
        }

        let results = results
            .into_iter()
            .map(|(id, title, body, updated_at, folder_id, note_type)| {
                let snippet = build_highlight_snippet(&body, &highlight_terms);
                SearchResult {
                    id,
                    title,
                    snippet,
                    updated_at,
                    folder_id,
                    note_type,
                }
            })
            .collect();

        Ok(results)
    }
}

/// 生成带 <mark> 高亮的摘要：截取第一个关键词附近的上下文
fn build_highlight_snippet(content: &str, keywords: &[&str]) -> String {
    // 去掉 HTML 标签，取纯文本
    let chars: Vec<char> = strip_tags(content).chars().collect();
    let total = chars.len();
    if total == 0 {
        return String::new();
    }

    let plain_lower: String = chars.iter().collect::<String>().to_lowercase();
    let snippet_len = 140;

    // 找第一个关键词出现的 char 位置
    let first_char_pos = keywords.iter().find_map(|kw| {
        let kw_lower = kw.to_lowercase();
        plain_lower
            .find(&kw_lower)
            .map(|byte_pos| plain_lower[..byte_pos].chars().count())
    });

    // 截取片段：关键词前置只留 10 字符，避免在搜索面板单行/双行截断里
    // 把关键词推到右边看不见
    let (start, end) = if let Some(char_pos) = first_char_pos {
        let s = char_pos.saturating_sub(10);
        let e = (s + snippet_len).min(total);
        (s, e)
    } else {
        (0, snippet_len.min(total))
    };

    let snippet_chars = &chars[start..end];
    let mut snippet: String = snippet_chars.iter().collect();
    if start > 0 {
        snippet = format!("...{}", snippet);
    }
    if end < total {
        snippet.push_str("...");
    }

    // 对所有关键词加 <mark> 高亮（大小写不敏感，基于 char 操作）
    for kw in keywords {
        let kw_lower = kw.to_lowercase();
        let kw_char_len = kw_lower.chars().count();
        let snippet_chars: Vec<char> = snippet.chars().collect();
        let snippet_lower: Vec<char> = snippet.to_lowercase().chars().collect();
        let mut result = String::new();
        let mut i = 0;

        while i < snippet_chars.len() {
            if i + kw_char_len <= snippet_chars.len()
                && snippet_lower[i..i + kw_char_len].iter().collect::<String>() == kw_lower
            {
                result.push_str("<mark>");
                for j in i..i + kw_char_len {
                    result.push(snippet_chars[j]);
                }
                result.push_str("</mark>");
                i += kw_char_len;
            } else {
                result.push(snippet_chars[i]);
                i += 1;
            }
        }
        snippet = result;
    }

    snippet
}

/// 简单去除 HTML 标签
fn strip_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    result
}

/// 将查询转换为 FTS5 语法。
///
/// **关键：用前缀匹配 `term*` 而不是精确 phrase `"term"`。**
///
/// 原因：FTS5 的 unicode61 分词器对中文按 Unicode 字符类合并相邻汉字成一个长 token。
/// 比如 "本地仓库说明23" 会被分成 `["本地仓库说明", "23"]`。
/// 用户搜 "本地"（精确 phrase）时，FTS5 找不到完全等于 "本地" 的 token → miss。
/// 用前缀匹配 `本地*`，能命中以 "本地" 开头的任何 token，包括 "本地仓库说明"。
///
/// 副作用：英文场景 `hello*` 也会匹配 helloworld 等，命中率提高、精确度略降。
/// 但对桌面知识库这种"找东西"为主的场景，宁宽勿漏。
fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | ':' | '^' | '{' | '}'))
                .collect();
            if clean.is_empty() {
                String::new()
            } else {
                // 前缀匹配，让中文长 token 能被部分命中
                format!("{}*", clean)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::models::{NoteInput, SearchFilters};

    fn temp_db() -> Database {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_search_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        Database::init(dir.join("t.db").to_str().unwrap()).expect("init db")
    }

    fn add(db: &Database, title: &str, content: &str) -> i64 {
        db.create_note(&NoteInput {
            title: title.into(),
            content: content.into(),
            folder_id: None,
        })
        .expect("create note")
        .id
    }

    /// P1-1 的核心场景：用户搜「本地说明」，笔记里写的是「本地仓库说明」。
    ///
    /// 改造前 FTS 前缀匹配（`本地说明*`）与 LIKE（`%本地说明%`）都会 miss ——
    /// 中文用户不会自觉加空格分词，这是最常见的召回缺口。
    #[test]
    fn recalls_non_contiguous_chinese_query() {
        let db = temp_db();
        let target = add(&db, "本地仓库说明", "介绍如何在本地搭建仓库");
        let hits = db.search_notes("本地说明", 20).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(
            ids.contains(&target),
            "「本地说明」应能召回「本地仓库说明」，实际: {:?}",
            ids
        );
    }

    /// 反面：只碰巧撞上一个通用二字词的笔记不该被召回（及格线 = 2 的意义）
    #[test]
    fn rejects_weak_single_bigram_match() {
        let db = temp_db();
        add(&db, "会议纪要", "今天的说明会推迟到下周");
        let hits = db.search_notes("本地说明", 20).unwrap();
        assert!(
            hits.is_empty(),
            "只命中一个通用二字词不该召回，实际: {:?}",
            hits.iter().map(|r| &r.title).collect::<Vec<_>>()
        );
    }

    /// 空格是用户明确的收窄意图：两个 token 都要命中
    #[test]
    fn space_separated_tokens_are_and() {
        let db = temp_db();
        let both = add(&db, "Docker 部署手册", "docker 部署流程");
        add(&db, "Docker 入门", "docker 基础概念");
        let hits = db.search_notes("docker 部署", 20).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&both));
        assert_eq!(ids.len(), 1, "只含 docker 不含部署的不该召回，实际: {:?}", ids);
    }

    /// 高亮必须与召回用同一套词元 —— 否则 snippet 退化成"截前 140 字、零高亮"，
    /// 用户看不出这条为什么被搜出来。对标项目正是栽在这里。
    #[test]
    fn highlight_uses_same_terms_as_recall() {
        let db = temp_db();
        add(
            &db,
            "无关标题",
            "前面是一大段无关的铺垫文字用来把关键词推到后面去，\
             这样如果高亮定位失败就只会看到这段铺垫。真正的内容是本地仓库说明。",
        );
        let hits = db.search_notes("本地说明", 20).unwrap();
        assert_eq!(hits.len(), 1, "应召回 1 条");
        assert!(
            hits[0].snippet.contains("<mark>"),
            "snippet 必须有高亮，实际: {}",
            hits[0].snippet
        );
    }

    // ─── P1-2 筛选维度 ───────────────────────────────

    fn add_in_folder(db: &Database, title: &str, content: &str, folder_id: Option<i64>) -> i64 {
        db.create_note(&NoteInput {
            title: title.into(),
            content: content.into(),
            folder_id,
        })
        .expect("create note")
        .id
    }

    #[test]
    fn filters_by_folder() {
        let db = temp_db();
        let f1 = db.create_folder("工作", None).unwrap().id;
        let f2 = db.create_folder("生活", None).unwrap().id;
        let in_f1 = add_in_folder(&db, "本地仓库说明", "工作笔记", Some(f1));
        let in_f2 = add_in_folder(&db, "本地仓库说明", "生活笔记", Some(f2));

        let filters = SearchFilters {
            folder_ids: Some(vec![f1]),
            ..Default::default()
        };
        let hits = db.search_notes_filtered("本地说明", 20, &filters).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&in_f1));
        assert!(!ids.contains(&in_f2), "不该返回其它文件夹的笔记: {:?}", ids);
    }

    #[test]
    fn filters_by_note_type() {
        let db = temp_db();
        let md = add(&db, "本地仓库说明", "普通笔记");
        let wb = add(&db, "本地仓库说明白板", "白板");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE notes SET note_type = 'whiteboard' WHERE id = ?1",
                [wb],
            )
            .unwrap();
        }
        let filters = SearchFilters {
            note_types: Some(vec!["markdown".into()]),
            ..Default::default()
        };
        let hits = db.search_notes_filtered("本地说明", 20, &filters).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&md));
        assert!(!ids.contains(&wb), "只要 markdown 时不该返回白板: {:?}", ids);
    }

    #[test]
    fn filters_by_updated_range() {
        let db = temp_db();
        let old = add(&db, "本地仓库说明旧", "旧笔记");
        let new = add(&db, "本地仓库说明新", "新笔记");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE notes SET updated_at = '2020-01-01 00:00:00' WHERE id = ?1",
                [old],
            )
            .unwrap();
        }
        let filters = SearchFilters {
            updated_after: Some("2021-01-01 00:00:00".into()),
            ..Default::default()
        };
        let hits = db.search_notes_filtered("本地说明", 20, &filters).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&new));
        assert!(!ids.contains(&old), "时间下界应排除旧笔记: {:?}", ids);
    }

    /// 多标签是 AND：选了两个标签，笔记要**同时**含有才算命中
    #[test]
    fn multi_tag_filter_is_and() {
        let db = temp_db();
        let both = add(&db, "本地仓库说明A", "两个标签都有");
        let only_one = add(&db, "本地仓库说明B", "只有一个标签");
        let t1 = db.create_tag("工作", None, None).unwrap().id;
        let t2 = db.create_tag("重要", None, None).unwrap().id;
        {
            let conn = db.conn.lock().unwrap();
            for (n, t) in [(both, t1), (both, t2), (only_one, t1)] {
                conn.execute(
                    "INSERT INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
                    [n, t],
                )
                .unwrap();
            }
        }
        let filters = SearchFilters {
            tag_ids: Some(vec![t1, t2]),
            ..Default::default()
        };
        let hits = db.search_notes_filtered("本地说明", 20, &filters).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&both));
        assert!(!ids.contains(&only_one), "只含一个标签不该命中: {:?}", ids);
    }

    /// 🔴 fail-closed：勾了维度却一个都没选中 → 返回空，
    /// **绝不能**退化成"忽略该维度"把整个知识库倒出来
    #[test]
    fn empty_selection_fails_closed() {
        let db = temp_db();
        add(&db, "本地仓库说明", "内容");

        for filters in [
            SearchFilters { folder_ids: Some(vec![]), ..Default::default() },
            SearchFilters { tag_ids: Some(vec![]), ..Default::default() },
            SearchFilters { note_types: Some(vec![]), ..Default::default() },
        ] {
            let hits = db.search_notes_filtered("本地说明", 20, &filters).unwrap();
            assert!(
                hits.is_empty(),
                "显式空选择必须返回零结果，实际拿到 {} 条",
                hits.len()
            );
        }
    }

    /// 无筛选时与旧接口行为一致
    #[test]
    fn no_filter_matches_legacy_behavior() {
        let db = temp_db();
        add(&db, "本地仓库说明", "内容");
        let legacy = db.search_notes("本地说明", 20).unwrap();
        let filtered = db
            .search_notes_filtered("本地说明", 20, &SearchFilters::default())
            .unwrap();
        assert_eq!(legacy.len(), filtered.len());
        assert_eq!(legacy[0].id, filtered[0].id);
    }

    /// 隐藏 / 临时 / 回收站笔记在主搜索里不可见（T-003）
    #[test]
    fn respects_visibility_flags() {
        let db = temp_db();
        let visible = add(&db, "本地仓库说明", "正常笔记");
        let hidden = add(&db, "本地仓库说明私密", "隐藏笔记");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE notes SET is_hidden = 1 WHERE id = ?1", [hidden])
                .unwrap();
        }
        let hits = db.search_notes("本地说明", 20).unwrap();
        let ids: Vec<i64> = hits.iter().map(|r| r.id).collect();
        assert!(ids.contains(&visible));
        assert!(!ids.contains(&hidden), "隐藏笔记不该出现在搜索结果");
    }
}
