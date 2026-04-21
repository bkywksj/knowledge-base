//! HTML ↔ Markdown 转换共享工具
//!
//! 原来 import.rs / export.rs 各自有一份私有实现，迁移到此作为单一来源。
//! 未来 HTML → Markdown 存储迁移、编辑器 MD I/O、".md 文件打开"等功能
//! 都基于这里的两个函数。
//!
//! - `html_to_markdown`：Tiptap 产出的 HTML → Markdown（使用 `html2md` crate）
//! - `markdown_to_html`：Markdown → Tiptap 可吃的 HTML（使用 `pulldown-cmark`）

use pulldown_cmark::{html, Options, Parser};

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
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
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
}
