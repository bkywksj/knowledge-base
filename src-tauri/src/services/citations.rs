//! AI 回答的引用标记解析与白名单校验。
//!
//! # 解决什么问题
//!
//! 改造前，对话气泡下方的"参考了 N 篇笔记"展示的是**检索召回了什么**，
//! 而不是**模型实际用了什么** —— RAG 一次召回十几篇，模型可能只用了其中两篇，
//! 用户点开溯源却看到一堆不相关的笔记。
//!
//! 现在让模型在回答末尾自报用到了哪几篇（`<!--refs:[1,3]-->`），但**绝不能直接采信**：
//! 模型完全可能编出一个不存在的编号。所以这里做白名单校验 —— 编号必须落在本次
//! 实际投喂的证据范围内，越界的一律丢弃。
//!
//! 这是"不信任模型输出"的一贯做法：与其在 prompt 里反复叮嘱"不要编造"，
//! 不如在代码里让编造**不可能生效**。
//!
//! # 为什么用 HTML 注释而不是 JSON
//!
//! 我们的回答是**流式**逐 token 推给前端的。若像藏知那样要求模型返回一整个 JSON
//! （`{answer, citations}`），就必须等全部生成完才能解析、才能显示 —— 流式体验直接没了。
//!
//! 折中方案：正文照常流式，末尾附一个 HTML 注释标记。注释对 Markdown 渲染无副作用，
//! 且前后端都用 [`strip_citation_marker`] 剥掉，用户看不到。

use std::collections::HashSet;

/// 引用标记的正则片段：`<!--refs:[1,3]-->`
///
/// 宽松匹配的几处考量：
/// - `\s*`：模型可能写成 `<!-- refs: [1, 3] -->`
/// - `-->|$`：**流式途中标记可能只吐了一半**，未闭合也要能剥掉，
///   否则用户会看到半截 `<!--refs:[1` 挂在回答末尾
const MARKER_PREFIX: &str = "<!--";

/// 从回答里解析出模型自报的引用编号（1-based）。
///
/// 只认**最后一个**标记：模型偶尔会在正文中途也写一个，以最终那个为准。
pub fn parse_citation_marker(text: &str) -> Option<Vec<usize>> {
    let start = text.rfind("<!--")?;
    let rest = &text[start..];
    // 去掉 `<!--` 后必须紧跟（可含空白的）`refs:`
    let body = rest.strip_prefix("<!--")?.trim_start();
    let body = body.strip_prefix("refs")?.trim_start();
    let body = body.strip_prefix(':')?.trim_start();
    // 取到 `-->` 或字符串结尾（流式未闭合的情况）
    let inner = match body.find("-->") {
        Some(end) => &body[..end],
        None => body,
    };
    let inner = inner.trim().trim_start_matches('[').trim_end_matches(']');

    let nums: Vec<usize> = inner
        .split(',')
        .filter_map(|s| s.trim().parse::<usize>().ok())
        .collect();
    Some(nums)
}

/// 把引用标记从展示文本里剥掉。
///
/// 前后端都要调用：后端保证**存库的历史记录**干净，前端保证**流式过程中**不闪现。
pub fn strip_citation_marker(text: &str) -> String {
    let Some(start) = text.rfind(MARKER_PREFIX) else {
        return text.to_string();
    };
    // 确认这个 `<!--` 确实是引用标记（而不是用户内容里正常的 HTML 注释）
    let rest = &text[start..];
    let is_marker = rest
        .strip_prefix("<!--")
        .map(|r| r.trim_start().trim_start_matches("refs").len() < r.trim_start().len())
        .unwrap_or(false);
    if !is_marker {
        return text.to_string();
    }
    let tail = match rest.find("-->") {
        Some(end) => &rest[end + 3..],
        None => "", // 流式未闭合：后面本来也没内容了
    };
    format!("{}{}", &text[..start], tail).trim_end().to_string()
}

/// 校验模型自报的引用编号，映射回真实的笔记 id。
///
/// `evidence_ids` 是本次**实际投喂给模型**的笔记 id，顺序即 prompt 里的编号顺序
/// （编号 1 对应 `evidence_ids[0]`）。
///
/// 校验规则：
/// - 编号必须在 `1..=evidence_ids.len()` 内 —— 越界即模型编造，丢弃
/// - 去重且保持模型给出的先后顺序
/// - 模型没给标记（`None`）时返回 `None`，由调用方决定回退策略
pub fn resolve_citations(marker: Option<Vec<usize>>, evidence_ids: &[i64]) -> Option<Vec<i64>> {
    let nums = marker?;
    let mut seen = HashSet::new();
    let resolved: Vec<i64> = nums
        .into_iter()
        .filter_map(|n| {
            // 1-based：0 或超出范围都视为模型编造
            if n == 0 || n > evidence_ids.len() {
                log::debug!(
                    "[citations] 丢弃越界引用编号 {}（本次证据共 {} 篇）",
                    n,
                    evidence_ids.len()
                );
                return None;
            }
            let id = evidence_ids[n - 1];
            seen.insert(id).then_some(id)
        })
        .collect();
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_marker() {
        assert_eq!(
            parse_citation_marker("回答正文\n<!--refs:[1,3]-->"),
            Some(vec![1, 3])
        );
    }

    #[test]
    fn parses_loose_whitespace() {
        // 模型未必严格照格式写
        assert_eq!(
            parse_citation_marker("答\n<!-- refs: [2, 5] -->"),
            Some(vec![2, 5])
        );
        assert_eq!(parse_citation_marker("答\n<!--refs:2-->"), Some(vec![2]));
    }

    #[test]
    fn parses_unclosed_marker_from_stream() {
        // 流式途中标记只吐了一半也要能解析
        assert_eq!(parse_citation_marker("答\n<!--refs:[1,2"), Some(vec![1, 2]));
    }

    #[test]
    fn empty_marker_yields_empty_list() {
        // 模型明确表示"没用到任何笔记"
        assert_eq!(parse_citation_marker("答\n<!--refs:[]-->"), Some(vec![]));
    }

    #[test]
    fn no_marker_returns_none() {
        assert_eq!(parse_citation_marker("就是一段普通回答"), None);
        // 普通 HTML 注释不能被误认成引用标记
        assert_eq!(parse_citation_marker("答 <!-- 这是注释 -->"), None);
    }

    #[test]
    fn strips_marker_from_display_text() {
        assert_eq!(strip_citation_marker("正文内容\n<!--refs:[1]-->"), "正文内容");
        assert_eq!(strip_citation_marker("正文\n<!--refs:[1]-->\n尾巴"), "正文\n\n尾巴");
    }

    #[test]
    fn strips_unclosed_marker() {
        assert_eq!(strip_citation_marker("正文\n<!--refs:[1"), "正文");
    }

    #[test]
    fn strips_marker_at_every_stream_stage() {
        // 流式逐 token 到达：标记从半截长到完整，每个阶段都不能漏在展示文本里。
        // 前端 aiFilter.test.ts 有对应的同款用例（同一份契约，两侧都要守住）。
        for partial in [
            "正文\n<!--",
            "正文\n<!--refs",
            "正文\n<!--refs:",
            "正文\n<!--refs:[",
            "正文\n<!--refs:[1",
            "正文\n<!--refs:[1]",
            "正文\n<!--refs:[1]--",
            "正文\n<!--refs:[1]-->",
        ] {
            let stripped = strip_citation_marker(partial);
            assert!(
                !stripped.contains("refs"),
                "阶段 {:?} 未剥干净，得到 {:?}",
                partial,
                stripped
            );
        }
    }

    #[test]
    fn keeps_normal_html_comments() {
        // 用户笔记里可能就有 HTML 注释，不能误删
        let text = "正文 <!-- 用户自己的注释 -->";
        assert_eq!(strip_citation_marker(text), text);
    }

    #[test]
    fn rejects_fabricated_indices() {
        // 本次只喂了 2 篇，模型却说引用了第 5 篇 —— 必须丢弃
        let ids = vec![100, 200];
        assert_eq!(
            resolve_citations(Some(vec![1, 5, 2]), &ids),
            Some(vec![100, 200])
        );
        // 0 是无效编号（约定 1-based）
        assert_eq!(resolve_citations(Some(vec![0]), &ids), Some(vec![]));
        // 全部越界 → 空列表（而不是回退成"全部引用"）
        assert_eq!(resolve_citations(Some(vec![9, 10]), &ids), Some(vec![]));
    }

    #[test]
    fn dedups_preserving_order() {
        let ids = vec![10, 20, 30];
        assert_eq!(
            resolve_citations(Some(vec![3, 1, 3, 1]), &ids),
            Some(vec![30, 10])
        );
    }

    #[test]
    fn no_marker_resolves_to_none() {
        assert_eq!(resolve_citations(None, &[1, 2]), None);
    }

    #[test]
    fn empty_evidence_rejects_everything() {
        // 没喂任何证据时，模型报什么引用都是编的
        assert_eq!(resolve_citations(Some(vec![1, 2]), &[]), Some(vec![]));
    }
}
