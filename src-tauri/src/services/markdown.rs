//! HTML ↔ Markdown 转换共享工具
//!
//! 原来 import.rs / export.rs 各自有一份私有实现，迁移到此作为单一来源。
//! 未来 HTML → Markdown 存储迁移、编辑器 MD I/O、".md 文件打开"等功能
//! 都基于这里的两个函数。
//!
//! - `html_to_markdown`：Tiptap 产出的 HTML → Markdown（使用 `html2md` crate）
//! - `markdown_to_html`：Markdown → Tiptap 可吃的 HTML（使用 `pulldown-cmark`）

use pulldown_cmark::{html, Options, Parser};
use serde::Deserialize;

/// 从 markdown 文本头部解析 YAML frontmatter
///
/// 形如
/// ```text
/// ---
/// title: My Note
/// tags:
///   - foo
///   - bar
/// ---
/// 正文
/// ```
/// 或
/// ```text
/// ---
/// tags: [foo, bar]
/// ---
/// 正文
/// ```
///
/// 返回 `(parsed, body_without_frontmatter)`。如果文本不以 `---\n` 开头、或没有
/// 闭合的 `---`、或 yaml 解析失败，则返回 `(None, original_text)` —— 永远不丢内容。
///
/// 主要用于 T-009 OB 整库导入：把 frontmatter 中的 `tags` 解析出来后剥离正文，
/// 让导入的笔记内容保持纯净。
pub fn parse_frontmatter(text: &str) -> (Option<FrontMatter>, String) {
    // 必须以 ---\n（或 ---\r\n） 开头
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"));
    let Some(rest) = rest else {
        return (None, text.to_string());
    };

    // 找闭合的 \n---\n 或 \n---\r\n 或文末 \n---
    let (yaml_str, body) = match find_frontmatter_end(rest) {
        Some((y, b)) => (y, b),
        None => return (None, text.to_string()),
    };

    match serde_yml::from_str::<FrontMatter>(yaml_str) {
        Ok(fm) => (Some(fm), body.to_string()),
        Err(_) => (None, text.to_string()),
    }
}

/// 在 `rest`（去掉首个 `---\n` 后的剩余文本）中找闭合的 `---` 行
/// 返回 (yaml_inner, body_after)
fn find_frontmatter_end(rest: &str) -> Option<(&str, &str)> {
    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            let yaml_str = &rest[..idx];
            let body_after = &rest[idx + line.len()..];
            return Some((yaml_str, body_after));
        }
        idx += line.len();
    }
    // 文末没换行的 ---
    let trimmed = rest.trim_end();
    if trimmed.ends_with("---") || trimmed.ends_with("...") {
        let line_start = rest.rfind('\n').map(|p| p + 1).unwrap_or(0);
        let yaml_str = &rest[..line_start];
        return Some((yaml_str, ""));
    }
    None
}

/// 去掉文档开头的 YAML front-matter，返回正文。用于导出 HTML / Word 这类排版输出：
/// pulldown-cmark 不认 front-matter，不去掉会渲染成一条分割线加一个二级标题。
///
/// 不用 `parse_frontmatter`：那个靠 yaml 解析，`---\n\n## 标题\n\n---` 这种以分割线开头的
/// 普通文档也可能通过。判定规则与前端 src/lib/frontMatter.ts 保持一致，改一边记得改另一边。
pub fn strip_front_matter(text: &str) -> &str {
    fn is_key_line(line: &str) -> bool {
        let Some(first) = line.chars().next() else {
            return false;
        };
        if first.is_whitespace() || matches!(first, '#' | ':' | '-') {
            return false;
        }
        match line.find(':') {
            Some(i) => line[i + 1..]
                .chars()
                .next()
                .map_or(true, char::is_whitespace),
            None => false,
        }
    }

    let mut lines = text.split_inclusive('\n');
    let mut offset = match lines.next() {
        Some(first) if first.trim_end() == "---" => first.len(),
        _ => return text,
    };
    let mut is_first_body_line = true;
    for line in lines {
        let bare = line.trim_end_matches(['\n', '\r']);
        offset += line.len();
        if is_first_body_line {
            if !is_key_line(bare) {
                return text;
            }
            is_first_body_line = false;
            continue;
        }
        let trimmed = bare.trim_end();
        if trimmed == "---" || trimmed == "..." {
            return &text[offset..];
        }
        let is_yaml_line = bare.trim().is_empty()
            || bare.starts_with(char::is_whitespace)
            || bare.starts_with('#')
            || bare.starts_with("- ")
            || is_key_line(bare);
        if !is_yaml_line {
            return text;
        }
    }
    text
}

/// OB 风格 frontmatter 关心的子集
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrontMatter {
    /// `tags: [a, b]` 或 `tags:\n  - a\n  - b` 都接受
    #[serde(default, deserialize_with = "deserialize_string_or_seq")]
    pub tags: Vec<String>,
    /// OB `aliases:` — 当前不入库，预留 T-009b 用作"别名搜索"
    #[allow(dead_code)]
    #[serde(default, deserialize_with = "deserialize_string_or_seq")]
    pub aliases: Vec<String>,
    /// 用户写的标题（覆盖正文 `# H1` 兜底）
    #[serde(default)]
    pub title: Option<String>,
}

/// 兼容 yaml 写成单字符串 / 字符串数组 / 用空字符串占位 三种情况
fn deserialize_string_or_seq<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    use std::fmt;

    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("string or seq of strings")
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
            if s.is_empty() {
                Ok(vec![])
            } else {
                // OB 也支持 `tags: foo, bar` 这种内联，自然分割逗号
                Ok(s.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect())
            }
        }
        fn visit_string<E: de::Error>(self, s: String) -> Result<Self::Value, E> {
            self.visit_str(&s)
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(v) = seq.next_element::<serde_yml::Value>()? {
                if let Some(s) = v.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        out.push(t.to_string());
                    }
                }
            }
            Ok(out)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(vec![])
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(vec![])
        }
    }
    d.deserialize_any(V)
}

/// HTML → Markdown
///
/// 空串/仅空白直接返回空串，避免 html2md 在边界情况下的异常。
///
/// 注意：`html2md` 对 `<h1>` / `<h2>` 用 setext 风格（`===` / `---` 下划线），
/// 其它级别用 ATX 风格（`### ...`）。不影响渲染，但与其它工具互通时需注意。
pub fn html_to_markdown(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    html2md::parse_html(html)
}

/// Markdown → HTML（开启 GFM：表格 / 删除线 / 任务列表）
///
/// 修正点：pulldown-cmark 会在 `</code>` 前插入尾部换行符，导致
/// Tiptap CodeBlock 渲染时多出一个空行，这里统一剥除。
///
/// 当前无调用方（Tiptap 已切 MD I/O，编辑器自行渲染），保留给未来的
/// "MD 预览"/"分享 HTML 片段" 等场景。
#[allow(dead_code)]
pub fn markdown_to_html(md: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(md, options);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out.replace("\n</code></pre>", "</code></pre>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_to_html_basic() {
        let html = markdown_to_html("# 标题\n\n段落文本");
        assert!(html.contains("<h1>"));
        assert!(html.contains("段落文本"));
    }

    #[test]
    fn html_to_md_basic() {
        let md = html_to_markdown("<h1>标题</h1><p>段落文本</p>");
        // html2md 对 h1 用 setext 风格（`=====` 下划线），不硬校验语法
        assert!(md.contains("标题"));
        assert!(md.contains("段落文本"));
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(html_to_markdown(""), "");
        assert_eq!(html_to_markdown("   \n"), "");
    }

    #[test]
    fn roundtrip_preserves_core_structure() {
        let original = "# 标题\n\n- 列表 A\n- 列表 B\n\n**粗体**";
        let html = markdown_to_html(original);
        let back = html_to_markdown(&html);
        assert!(back.contains("标题"));
        assert!(back.contains("列表 A"));
        assert!(back.contains("**粗体**"));
    }

    #[test]
    fn strip_front_matter_removes_yaml_block() {
        assert_eq!(
            strip_front_matter("---\r\nplatform: 安卓\r\ntags:\r\n  - a\r\n---\r\n\r\n# 标题\r\n"),
            "\r\n# 标题\r\n"
        );
        assert_eq!(strip_front_matter("---\na: 1\n..."), "");
    }

    #[test]
    fn strip_front_matter_keeps_ordinary_documents() {
        for text in [
            "# 标题\n\n---\n",
            "---\n\n## 标题\n\n---\n正文",
            "---\n# 标题\n---\n",
            "---\n这是一段正文\n---\n",
            "---\na: 1\n这是一段正文\n---\n",
            "---\na: 1\n\n正文",
            "---\nhttp://a.com\n---\n",
        ] {
            assert_eq!(strip_front_matter(text), text);
        }
    }

    #[test]
    fn fm_no_frontmatter_returns_original() {
        let (fm, body) = parse_frontmatter("# Hello\n\nbody");
        assert!(fm.is_none());
        assert_eq!(body, "# Hello\n\nbody");
    }

    #[test]
    fn fm_inline_array_tags() {
        let text = "---\ntags: [foo, bar, baz]\n---\n# Hello";
        let (fm, body) = parse_frontmatter(text);
        let fm = fm.expect("应解析到 frontmatter");
        assert_eq!(fm.tags, vec!["foo", "bar", "baz"]);
        assert_eq!(body, "# Hello");
    }

    #[test]
    fn fm_block_list_tags() {
        let text = "---\ntags:\n  - alpha\n  - beta\ntitle: My Note\n---\nbody";
        let (fm, body) = parse_frontmatter(text);
        let fm = fm.expect("应解析到 frontmatter");
        assert_eq!(fm.tags, vec!["alpha", "beta"]);
        assert_eq!(fm.title.as_deref(), Some("My Note"));
        assert_eq!(body, "body");
    }

    #[test]
    fn fm_single_string_tag() {
        let text = "---\ntags: solo\n---\nbody";
        let (_, body) = parse_frontmatter(text);
        let (fm, _) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["solo"]);
        assert_eq!(body, "body");
    }

    #[test]
    fn fm_inline_csv_string() {
        let text = "---\ntags: a, b, c\n---\nbody";
        let (fm, _) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["a", "b", "c"]);
    }

    #[test]
    fn fm_unclosed_returns_original() {
        let text = "---\ntags: [a]\n# 缺少闭合";
        let (fm, body) = parse_frontmatter(text);
        assert!(fm.is_none());
        assert_eq!(body, text);
    }

    #[test]
    fn fm_invalid_yaml_returns_original_with_no_data_loss() {
        let text = "---\nthis is { not: valid }: yaml::\n---\nbody";
        let (fm, body) = parse_frontmatter(text);
        assert!(fm.is_none());
        assert_eq!(body, text); // 内容必须原样保留
    }

    #[test]
    fn fm_empty_tags_field() {
        let text = "---\ntags:\ntitle: T\n---\nbody";
        let (fm, _) = parse_frontmatter(text);
        let fm = fm.unwrap();
        assert!(fm.tags.is_empty());
        assert_eq!(fm.title.as_deref(), Some("T"));
    }

    #[test]
    fn fm_crlf_line_endings() {
        let text = "---\r\ntags: [x]\r\n---\r\nbody";
        let (fm, body) = parse_frontmatter(text);
        assert_eq!(fm.unwrap().tags, vec!["x"]);
        assert_eq!(body, "body");
    }
}
