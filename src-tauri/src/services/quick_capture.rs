use chrono::Local;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, NoteInput};

/// 快速捕获服务：把剪贴板内容存为一条新笔记。
///
/// 标题规则：`YYYY-MM-DD HH:mm 首句（截断 30 字符）`
/// - 首句：按段首换行 → 句末标点（。！？.!?；;）切分
/// - 空剪贴板：返回 InvalidInput，由调用方决定如何告知用户
/// - 完全无可用首句（例如全是符号）时退化为纯时间戳
pub struct QuickCaptureService;

impl QuickCaptureService {
    /// 从一段文本创建新笔记。folder_id 当前固定 None（落到根目录），
    /// 后续如要支持"指定默认文件夹"再从 app_config 读。
    ///
    /// 内容会经过两道规范化：
    /// 1. `merge_orphan_list_markers`：把「数字.\n内容」「-\n内容」这类孤立列表标记
    ///    合并成 markdown 合法的 `数字. 内容` —— 修复从 Notion / 飞书等富文本复制
    ///    出来的列表丢编号 / 丢缩进
    /// 2. `preserve_plain_text_indent`：行首 ASCII 空格 / Tab → NBSP，
    ///    避免 markdown 把缩进当代码块或直接吃掉
    pub fn capture_from_text(db: &Database, raw: &str) -> Result<Note, AppError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput("剪贴板内容为空".into()));
        }

        let title = build_title(trimmed);
        let normalized = normalize_plain_text_for_markdown(raw);
        let input = NoteInput {
            title,
            content: normalized,
            folder_id: None,
        };
        db.create_note(&input)
    }
}

/// plain text → markdown-friendly 格式的统一入口。
///
/// 顺序：先合并孤立列表标记（基于行结构），再做缩进 NBSP 化（动行首空白）。
/// 反过来不行：先 NBSP 化后行首变 NBSP，列表标记的 trim 就识别不准
pub fn normalize_plain_text_for_markdown(text: &str) -> String {
    preserve_plain_text_indent(&merge_orphan_list_markers(text))
}

/// 把「裸列表标记 + 内容分两行」的模式合并成 markdown 合法的列表项。
///
/// **触发场景**：从 Notion / 飞书 / 钉钉等富文本应用复制 plain text 时，列表项常常被
/// 序列化成：
/// ```text
/// 1.
/// 第一项内容
///
/// 2.
/// 第二项内容
/// ```
///
/// markdown 标准要求列表标记后必须紧跟空格 + 内容（`1. 内容`），所以上面的格式渲染时
/// 既不算列表也没缩进，看起来非常乱。
///
/// **处理规则**：当某行 trim 后**只**是列表标记（`数字.` / `数字)` / `-` / `*` / `•` 等），
/// 且下一行非空，就把两行合并成「标记 + 空格 + 下一行内容」，并保留原行首的缩进
/// 用于嵌套列表场景
///
/// **不会误伤**：列表标记后跟其他字符的行（如 `1. 已经是合法列表项`）保持原样
pub fn merge_orphan_list_markers(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if i + 1 < lines.len() {
            let trimmed = line.trim_end();
            // 提取行首缩进（保留给嵌套列表，例如 "  -\n  内容" → "  - 内容"）
            let leading: String = line
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .collect();
            let body = trimmed.trim_start();
            if is_orphan_list_marker(body) {
                let next = lines[i + 1].trim();
                if !next.is_empty() {
                    out.push(format!("{}{} {}", leading, body, next));
                    i += 2;
                    continue;
                }
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

/// 判断字符串是否「裸列表标记」（trim 后只剩列表前缀，没有内容）
fn is_orphan_list_marker(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    // 数字列表：1. / 12. / 1) / 1）
    let trimmed_end = s.strip_suffix('.').or_else(|| s.strip_suffix(')')).or_else(|| s.strip_suffix('）'));
    if let Some(stripped) = trimmed_end {
        if !stripped.is_empty() && stripped.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    // 项目符号
    matches!(
        s,
        "-" | "*" | "+" | "•" | "○" | "●" | "■" | "□" | "▪" | "▫" | "▸" | "▶" | "·"
    )
}

/// 把行首 ASCII 空格 / Tab 转成不间断空格（U+00A0），保留 plain text 的视觉缩进。
///
/// **为什么要转**：笔记 content 字段会被 `tiptap-markdown` 当 Markdown 解析渲染。
/// Markdown 标准里：
/// - 段落内的行首 ASCII 空格会被 trim
/// - 行首 4+ ASCII 空格会被识别为代码块（缩进式 fenced code）
///
/// 结果：用户从 Word / 网页 / 任意编辑器复制的「段首空 4 格」中文段落、Python 代码缩进
/// 全部丢失或被错误地包成代码块。
///
/// **为什么 NBSP（\u{00A0}）能修**：markdown-it（tiptap-markdown 的解析器）只把 ASCII
/// 空格当成"空白"参与缩进规则；NBSP 是普通字符，不会触发 trim / 代码块判定。在
/// HTML 渲染里 NBSP 又不会被浏览器折叠，视觉上完全等价 ASCII 空格。
///
/// **作用范围**：只动行首空白，行内空格 / Tab 不动 ——
/// - 避免误伤 markdown 表格 / 行内代码内部对齐
/// - Tab 按 4 NBSP 展开，与多数编辑器视觉一致
///
/// **不适用场景**：来源已经是合法 Markdown（有列表 / 代码 fence / 引用嵌套）。.md 文件
/// 导入应保持原样，不调用本函数；本函数只处理 plain text（剪贴板 / .txt 等）
pub fn preserve_plain_text_indent(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let chars: Vec<char> = line.chars().collect();
            let mut prefix_len = 0;
            while prefix_len < chars.len()
                && (chars[prefix_len] == ' ' || chars[prefix_len] == '\t')
            {
                prefix_len += 1;
            }
            if prefix_len == 0 {
                return line.to_string();
            }
            let mut out = String::with_capacity(line.len() + prefix_len * 2);
            for &c in &chars[..prefix_len] {
                match c {
                    ' ' => out.push('\u{00A0}'),
                    '\t' => out.push_str("\u{00A0}\u{00A0}\u{00A0}\u{00A0}"),
                    _ => unreachable!(),
                }
            }
            for &c in &chars[prefix_len..] {
                out.push(c);
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 标题 = 时间戳 + 首句（≤30 字）；首句拿不到时仅时间戳
fn build_title(text: &str) -> String {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M").to_string();
    let summary = extract_first_sentence(text, 30);
    if summary.is_empty() {
        timestamp
    } else {
        format!("{} {}", timestamp, summary)
    }
}

/// 提取首句：取第一行非空 → 第一个句末标点前的部分 → 截断到 max_chars 字符。
/// max_chars 按 Unicode 字符（非字节）计算，避免中文截半。
fn extract_first_sentence(s: &str, max_chars: usize) -> String {
    let line = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        return String::new();
    }

    let punct = ['。', '！', '？', '!', '?', '.', '；', ';', '\t'];
    let chars: Vec<char> = line.chars().collect();
    let cut_at = chars
        .iter()
        .position(|c| punct.contains(c))
        .unwrap_or(chars.len());

    let take = cut_at.min(max_chars);
    chars.iter().take(take).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sentence_chinese_punct() {
        assert_eq!(extract_first_sentence("你好世界。这是第二句", 30), "你好世界");
    }

    #[test]
    fn first_sentence_english_punct() {
        assert_eq!(extract_first_sentence("Hello world. Bye.", 30), "Hello world");
    }

    #[test]
    fn first_sentence_truncate() {
        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
        let out = extract_first_sentence(long, 10);
        assert_eq!(out.chars().count(), 10);
    }

    #[test]
    fn first_sentence_skips_blank_lines() {
        assert_eq!(extract_first_sentence("\n\n   \nReal line", 30), "Real line");
    }

    #[test]
    fn build_title_includes_timestamp() {
        let t = build_title("Hello world");
        assert!(t.contains("Hello world"));
        assert!(t.len() > "Hello world".len()); // 含时间戳前缀
    }

    #[test]
    fn preserve_indent_keeps_4_space_chinese_paragraph() {
        // 中文段首空 4 个 ASCII 空格 → 4 个 NBSP（视觉等价，但 markdown 不会变代码块）
        let input = "    我是中文段落开头";
        let out = preserve_plain_text_indent(input);
        assert!(out.starts_with("\u{00A0}\u{00A0}\u{00A0}\u{00A0}"));
        assert!(out.ends_with("我是中文段落开头"));
        // 不应该再含 ASCII 空格在前
        assert!(!out.starts_with(' '));
    }

    #[test]
    fn preserve_indent_expands_tab_to_4_nbsp() {
        let input = "\tdef foo():";
        let out = preserve_plain_text_indent(input);
        assert_eq!(out, "\u{00A0}\u{00A0}\u{00A0}\u{00A0}def foo():");
    }

    #[test]
    fn preserve_indent_only_touches_leading_whitespace() {
        // 行内的空格不动（避免破坏 markdown 表格 / 行内代码对齐）
        let input = "abc   def";
        assert_eq!(preserve_plain_text_indent(input), "abc   def");
    }

    #[test]
    fn preserve_indent_handles_multiline() {
        let input = "段落 1\n    段落 2 缩进\n\tcode line";
        let out = preserve_plain_text_indent(input);
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines[0], "段落 1");
        assert!(lines[1].starts_with("\u{00A0}\u{00A0}\u{00A0}\u{00A0}"));
        assert!(lines[2].starts_with("\u{00A0}\u{00A0}\u{00A0}\u{00A0}"));
    }

    #[test]
    fn preserve_indent_empty_lines_unchanged() {
        let input = "a\n\nb";
        assert_eq!(preserve_plain_text_indent(input), "a\n\nb");
    }

    #[test]
    fn merge_orphan_numeric_marker() {
        // Notion / 飞书复制典型格式
        let input = "1.\n第一项\n\n2.\n第二项";
        let out = merge_orphan_list_markers(input);
        assert_eq!(out, "1. 第一项\n\n2. 第二项");
    }

    #[test]
    fn merge_orphan_dash_marker() {
        let input = "-\n第一项\n-\n第二项";
        let out = merge_orphan_list_markers(input);
        assert_eq!(out, "- 第一项\n- 第二项");
    }

    #[test]
    fn merge_orphan_keeps_leading_indent_for_nested() {
        let input = "  -\n  嵌套项";
        let out = merge_orphan_list_markers(input);
        assert_eq!(out, "  - 嵌套项");
    }

    #[test]
    fn merge_orphan_does_not_touch_legal_lists() {
        // 已经合法的 markdown 列表不动
        let input = "1. 已经合法\n2. 也合法";
        assert_eq!(merge_orphan_list_markers(input), input);
    }

    #[test]
    fn merge_orphan_does_not_merge_when_next_blank() {
        // 数字标记后跟空行 → 用户可能就是想留空段落，不动
        let input = "1.\n\n下一段";
        assert_eq!(merge_orphan_list_markers(input), input);
    }

    #[test]
    fn normalize_full_pipeline_notion_paste() {
        // 整套链路：Notion 风格剪贴板 → 合并标记 → NBSP 缩进 → 可被 markdown 正确渲染
        let input = "流程是：\n\n1.\n我把 .claude/skills/ 目录发给他\n\n2.\n他手动放到他项目里";
        let out = normalize_plain_text_for_markdown(input);
        assert!(out.contains("1. 我把 .claude/skills/ 目录发给他"));
        assert!(out.contains("2. 他手动放到他项目里"));
    }
}
