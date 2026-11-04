//! Markdown 正文 → 给人扫一眼的纯文本（搜索摘要、白板笔记卡片、字数统计共用）。
//!
//! 放在 kb-core 而不是主应用：字数触发器调用的 `kb_word_count()` 要在
//! 主应用和 kb-mcp 两边的连接上都注册，两边都依赖 kb-core。
//!
//! 刻意不做完整的 Markdown 解析：这里只要"看着像正文"，
//! 为此引一个解析器不值得，且解析失败的边角情况反而更难处理。
//! 处理的是正文里最常见、留着最碍眼的几类符号：
//! HTML 标签、行首标题 / 引用 / 列表符号、代码围栏、加粗 / 删除线 / 行内代码、
//! 反斜杠转义（`\[`）、链接 / 图片 / 双链只留文字。

/// 搜索高亮标签的占位符：转换前换掉，转换完再换回来，免得被当成 HTML 标签剥掉
const MARK_OPEN: char = '\u{E000}';
const MARK_CLOSE: char = '\u{E001}';

/// 正文 → 纯文本。
///
/// `keep_newlines = true`：保留换行（白板卡片多行展示）；
/// `false`：合成一行，行之间用空格隔开（搜索摘要单行展示）。
/// 空行一律丢掉。
pub fn markdown_to_plain(content: &str, keep_newlines: bool) -> String {
    let no_tags = strip_html_tags(content);

    let lines: Vec<String> = no_tags
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            // 代码围栏行本身（```rust / ~~~）没有内容，整行丢掉；围栏里的代码照常保留
            if t.starts_with("```") || t.starts_with("~~~") {
                return None;
            }
            let t = strip_line_prefix(t);
            let t = strip_inline(t);
            let t = t.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .collect();

    lines.join(if keep_newlines { "\n" } else { " " })
}

/// 已带 `<mark>…</mark>` 高亮的摘要（SQLite snippet() 的输出）→ 纯文本，高亮保留。
pub fn snippet_to_plain(snippet: &str) -> String {
    let guarded = snippet
        .replace("<mark>", &MARK_OPEN.to_string())
        .replace("</mark>", &MARK_CLOSE.to_string());
    markdown_to_plain(&guarded, false)
        .replace(MARK_OPEN, "<mark>")
        .replace(MARK_CLOSE, "</mark>")
}

/// 在连接上注册 `kb_word_count(text, is_encrypted)`，供 notes 的字数触发器调用。
///
/// 🔴 每个可能写 notes 的连接都必须注册，否则触发器执行时报 `no such function`：
/// 主应用 `Database::init / reopen`（经 `schema::migrate`）与 kb-core `KbDb::open` 已接上。
/// 加密笔记的正文是密文，记 0。
pub fn register_sql_functions(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "kb_word_count",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            use rusqlite::types::ValueRef;
            // 🔴 永不报错：它跑在触发器里，一报错整条 INSERT / UPDATE 都失败。
            // 坏库里的正文可能不是合法 UTF-8（text_health 修复流程正要写回它），按字节宽松解码
            if let ValueRef::Integer(n) = ctx.get_raw(1) {
                if n != 0 {
                    return Ok(0i64);
                }
            }
            let n = match ctx.get_raw(0) {
                ValueRef::Text(b) | ValueRef::Blob(b) => count_words(&String::from_utf8_lossy(b)),
                _ => 0,
            };
            Ok(n as i64)
        },
    )
}

/// 字数，与编辑器状态栏同一口径（`src/lib/textStats.ts` 的 calcTextStats）：
/// 中文（含扩展 A）/ 日文假名每个算 1 字，其余按空白分词每词算 1 字。
/// notes.word_count 列由触发器经 `kb_word_count()` 调它维护（schema v69 起）。
pub fn count_words(content: &str) -> usize {
    let plain = markdown_to_plain(content, true);
    let is_cjk = |c: char| {
        matches!(c, '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}' | '\u{3040}'..='\u{309f}' | '\u{30a0}'..='\u{30ff}')
    };
    let cjk = plain.chars().filter(|&c| is_cjk(c)).count();
    let non_cjk: String = plain.chars().map(|c| if is_cjk(c) { ' ' } else { c }).collect();
    cjk + non_cjk.split_whitespace().count()
}

/// 去掉 `<…>` 标签（正文里可能混有 HTML）
fn strip_html_tags(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_tag = false;
    for ch in content.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// 去掉行首的标题 / 引用 / 无序列表 / 有序列表 / 任务框符号
fn strip_line_prefix(line: &str) -> &str {
    let mut t = line.trim_start_matches(['#', '>', '-', '*', '+']).trim_start();
    // 有序列表「1. 」「12) 」
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            t = r.trim_start();
        } else if rest == "." || rest == ")" {
            // 空列表项「1.」（行已 trim，后面的空格没了）
            return "";
        }
    }
    // 任务框「[ ] 」「[x] 」
    for pre in ["[ ] ", "[x] ", "[X] "] {
        if let Some(r) = t.strip_prefix(pre) {
            return r.trim_start();
        }
    }
    // 标注块类型「> [!info] 」：引用符号已在上面去掉，剩下的类型标记对读者没意义
    if let Some(rest) = t.strip_prefix("[!") {
        if let Some(end) = rest.find(']') {
            return rest[end + 1..].trim_start();
        }
    }
    t
}

/// 行内：反斜杠转义还原、链接 / 图片 / 双链只留文字、去掉 ** ~~ ` 强调符号
fn strip_inline(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // 反斜杠转义：`\[` → `[`；转义出来的字符原样保留，不再参与后面的链接识别
        if c == '\\' && i + 1 < chars.len() && chars[i + 1].is_ascii_punctuation() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        // 行尾单个反斜杠是硬换行标记，不是正文
        if c == '\\' && i + 1 == chars.len() {
            break;
        }
        // 双链 [[标题]] / [[标题|别名]] → 显示文字
        if c == '[' && chars.get(i + 1) == Some(&'[') {
            if let Some(end) = find_seq(&chars, i + 2, &[']', ']']) {
                let inner: String = chars[i + 2..end].iter().collect();
                let shown = inner.rsplit('|').next().unwrap_or(&inner);
                out.push_str(shown);
                i = end + 2;
                continue;
            }
        }
        // 图片 ![说明](地址) / 链接 [文字](地址) → 只留说明 / 文字
        let is_image = c == '!' && chars.get(i + 1) == Some(&'[');
        if c == '[' || is_image {
            let text_start = if is_image { i + 2 } else { i + 1 };
            if let Some(close) = find_char(&chars, text_start, ']') {
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(paren) = find_char(&chars, close + 2, ')') {
                        out.extend(&chars[text_start..close]);
                        i = paren + 1;
                        continue;
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out.replace("**", "").replace("~~", "").replace('`', "")
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&k| chars[k] == target)
}

fn find_seq(chars: &[char], from: usize, seq: &[char]) -> Option<usize> {
    if chars.len() < seq.len() {
        return None;
    }
    (from..=chars.len() - seq.len()).find(|&k| chars[k..k + seq.len()] == *seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_world_escaped_timestamp() {
        // dev 库实际出现过的摘要：AI 对话归档里的时间戳
        assert_eq!(markdown_to_plain("**\\[11:06\\]** 你好", false), "[11:06] 你好");
    }

    #[test]
    fn headings_bold_lists_and_lines_join() {
        let md = "## 会议信息\n**日期：** 今天\n\n- 议题一\n1. 决策事项\n- [ ] 待办";
        assert_eq!(
            markdown_to_plain(md, false),
            "会议信息 日期： 今天 议题一 决策事项 待办"
        );
        assert_eq!(
            markdown_to_plain(md, true),
            "会议信息\n日期： 今天\n议题一\n决策事项\n待办"
        );
    }

    #[test]
    fn links_images_wikilinks_keep_text() {
        let md = "见 [官网](https://kb.ruoyi.plus) 和 ![架构图](a.png)，参考 [[Rust 所有权]] 与 [[长标题|短名]]";
        assert_eq!(
            markdown_to_plain(md, false),
            "见 官网 和 架构图，参考 Rust 所有权 与 短名"
        );
    }

    #[test]
    fn code_fence_inline_code_strike_and_html() {
        let md = "```rust\nlet x = 1;\n```\n用 `cargo test` 跑，~~旧做法~~<br>新做法";
        assert_eq!(
            markdown_to_plain(md, false),
            "let x = 1; 用 cargo test 跑，旧做法新做法"
        );
    }

    #[test]
    fn unmatched_brackets_are_left_alone() {
        // 摘要窗口可能把链接切断，残缺的括号原样保留，不能吞字
        assert_eq!(markdown_to_plain("前缀 [只有半个", false), "前缀 [只有半个");
        assert_eq!(markdown_to_plain("[文字](没闭合", false), "[文字](没闭合");
    }

    #[test]
    fn hard_break_and_callout_marker() {
        // dev 库实际出现过：AI 对话归档的时间戳行尾带硬换行，标注块带 [!info]
        let md = "> [!info] 🕐 14:58\\\n你好";
        assert_eq!(markdown_to_plain(md, false), "🕐 14:58 你好");
    }

    #[test]
    fn count_words_matches_editor_rules() {
        assert_eq!(count_words("<p><br></p>"), 0, "空日记不该有字数");
        assert_eq!(count_words("# \n\n<p><br></p>"), 0);
        // 会议模板里的空有序列表项，编辑器不计
        assert_eq!(count_words("1. <p><br></p>\n\n- <p><br></p>"), 0);
        // 中文按字、英文按词；符号不计
        assert_eq!(count_words("**\\[11:06\\]** 你好"), 3);
        assert_eq!(count_words("## 会议\n用 Rust 写 hello world"), 7);
    }

    /// 触发器里的函数遇到坏数据也不能报错，否则整条写入失败
    #[test]
    fn sql_function_never_errors() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        register_sql_functions(&conn).unwrap();
        let q = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(q("SELECT kb_word_count('你好 world', 0)"), 3);
        assert_eq!(q("SELECT kb_word_count('你好', 1)"), 0, "加密记 0");
        assert_eq!(q("SELECT kb_word_count(NULL, NULL)"), 0);
        assert_eq!(q("SELECT kb_word_count(CAST(X'E4BDA0FF' AS TEXT), 0)"), 2, "非法 UTF-8 宽松解码");
    }

    #[test]
    fn snippet_keeps_mark_tags() {
        let s = "...**\\[11:06\\]** <mark>日记</mark> ## 标题";
        assert_eq!(snippet_to_plain(s), "...[11:06] <mark>日记</mark> ## 标题");
    }
}
