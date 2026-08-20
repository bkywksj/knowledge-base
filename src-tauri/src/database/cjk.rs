//! 中文查询的分段与加权 n-gram 展开。
//!
//! # 为什么需要
//!
//! SQLite FTS5 的 `unicode61` 分词器把**连续汉字合并成一个长 token**：
//! 「本地仓库说明」整体是一个 token。这带来两层问题：
//!
//! 1. 精确匹配 `"仓库"` 找不到它（token 不等于 "仓库"）——
//!    现有做法是改用前缀匹配 `仓库*`，但**前缀只从 token 开头匹配**，
//!    「仓库」在中间照样 miss；
//! 2. FTS 落空后退到 LIKE 兜底，而 `%本地说明%` 要求**连续出现** ——
//!    用户搜「本地说明」，笔记里写的是「本地仓库说明」，一样找不到。
//!
//! 第 2 条是真实的召回缺口：中文用户不会像英文那样自觉加空格分词。
//!
//! # 做法
//!
//! 不引入分词器（jieba 之类要带词典、增体积、且对新词/专有名词一样会切错），
//! 改用**加权 n-gram**：把一个中文 token 展开成「整体 + 3-gram + 2-gram」，
//! 按可信度给不同权重，最后用累加分过及格线。
//!
//! | 模式 | 权重 | 含义 |
//! |---|---|---|
//! | 整个 token | 5 | 完整命中，最可信 |
//! | 3-gram | 2 | 较可信 |
//! | 2-gram | 1 | 弱信号，单独一个不算数 |
//!
//! 「本地说明」→ 整体(5) + 本地说(2)/地说明(2) + 本地(1)/地说(1)/说明(1)。
//! 对「本地仓库说明」：本地 ✓ + 说明 ✓ = 2 分，过线 → 召回。
//! 而对一篇只碰巧出现「说明」的无关笔记：1 分，不过线 → 不召回。
//! 及格线取 2 正是为了**挡住"只因为撞上一个通用二字词就命中"**。
//!
//! # 与用户输入的空格的关系
//!
//! 空格是用户明确的「收窄」意图（搜「docker 部署」= 两者都要有），
//! 所以**token 之间是 AND**，token 内部才是 n-gram 加权 OR。
//! 这比一律 OR 更贴合预期 —— 否则用户加了空格反而搜出更多结果。

/// 展开后单个匹配模式
#[derive(Debug, Clone, PartialEq)]
pub struct WeightedTerm {
    /// 待匹配的子串（调用方自行包 `%..%`）
    pub term: String,
    /// 命中该子串得多少分
    pub weight: i32,
}

/// 用户输入的**一个** token 展开出的模式组
#[derive(Debug, Clone, PartialEq)]
pub struct TokenPatterns {
    pub patterns: Vec<WeightedTerm>,
    /// 该组的及格线：累加分 >= 此值才算这个 token 命中
    pub threshold: i32,
}

/// 整体命中的权重
const W_WHOLE: i32 = 5;
/// 3-gram 权重
const W_TRIGRAM: i32 = 2;
/// 2-gram 权重
const W_BIGRAM: i32 = 1;

/// 单个 token 最多展开多少个模式。
///
/// 上限存在的意义是**兜住 SQL 体积**：每个模式都会变成一个 `CASE WHEN ... LIKE ?n`，
/// 一段长句若不设限会生成几百个占位符，SQL 解析本身就成了瓶颈。
const MAX_PATTERNS_PER_TOKEN: usize = 16;

/// 中文里高频出现、单独命中毫无信息量的二字组合。
///
/// 只用于**过滤 n-gram**，不过滤用户输入的完整 token ——
/// 用户真要搜「什么」这两个字（比如找一篇讲"什么是 RAG"的笔记）应当照搜不误。
const NOISE_GRAMS: &[&str] = &[
    "什么", "怎么", "如何", "为何", "为什", "哪些", "哪个", "多少", "是否", "可以", "能否",
    "这个", "那个", "这些", "那些", "我们", "他们", "你们", "自己", "一个", "一下", "一些",
    "没有", "有没", "的话", "里面", "里的", "上面", "下面", "关于", "对于", "以及", "还有",
    "然后", "但是", "因为", "所以", "如果", "虽然", "而且", "或者",
];

/// 是否为 CJK 字符（含日文假名，用户笔记里可能有）
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF   // CJK 统一表意文字
        | 0x3400..=0x4DBF // 扩展 A
        | 0x3040..=0x309F // 平假名
        | 0x30A0..=0x30FF // 片假名
        | 0xF900..=0xFAFF // 兼容表意文字
    )
}

/// 把查询串切成「用户 token」：连续 CJK 为一段，连续字母数字为一段，其余字符作分隔。
///
/// 注意**不按空格切 CJK**：中文用户不加空格，「本地仓库说明」必须是一个整体
/// 交给下面的 n-gram 展开，而不是被当成一个不可拆的长词。
pub fn split_tokens(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cjk_buf = String::new();
    let mut ascii_buf = String::new();

    let flush = |buf: &mut String, out: &mut Vec<String>| {
        if !buf.is_empty() {
            out.push(std::mem::take(buf));
        }
    };

    for ch in query.chars() {
        if is_cjk(ch) {
            flush(&mut ascii_buf, &mut tokens);
            cjk_buf.push(ch);
        } else if ch.is_alphanumeric() || ch == '_' {
            flush(&mut cjk_buf, &mut tokens);
            ascii_buf.push(ch);
        } else {
            flush(&mut cjk_buf, &mut tokens);
            flush(&mut ascii_buf, &mut tokens);
        }
    }
    flush(&mut cjk_buf, &mut tokens);
    flush(&mut ascii_buf, &mut tokens);
    tokens
}

/// 取一个 CJK 串的全部 n-gram（按出现顺序，已去重）
fn ngrams(chars: &[char], n: usize) -> Vec<String> {
    if chars.len() < n {
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    chars
        .windows(n)
        .map(|w| w.iter().collect::<String>())
        .filter(|g| seen.insert(g.clone()))
        .collect()
}

/// 把单个 token 展开成加权模式组
fn expand_token(token: &str) -> Option<TokenPatterns> {
    if token.is_empty() {
        return None;
    }
    let chars: Vec<char> = token.chars().collect();
    let is_cjk_token = chars.iter().any(|c| is_cjk(*c));

    // 非中文 token（英文单词 / 数字）：本来就自带边界，不需要 n-gram
    if !is_cjk_token || chars.len() < 3 {
        return Some(TokenPatterns {
            patterns: vec![WeightedTerm {
                term: token.to_string(),
                weight: W_WHOLE,
            }],
            // 整体必须命中
            threshold: W_WHOLE,
        });
    }

    let mut patterns = vec![WeightedTerm {
        term: token.to_string(),
        weight: W_WHOLE,
    }];
    let mut seen: std::collections::HashSet<String> =
        std::iter::once(token.to_string()).collect();

    for (grams, weight) in [(ngrams(&chars, 3), W_TRIGRAM), (ngrams(&chars, 2), W_BIGRAM)] {
        for g in grams {
            if patterns.len() >= MAX_PATTERNS_PER_TOKEN {
                break;
            }
            // 噪声词只在 n-gram 层过滤：用户完整输入的 token 一律保留
            if NOISE_GRAMS.contains(&g.as_str()) || !seen.insert(g.clone()) {
                continue;
            }
            patterns.push(WeightedTerm { term: g, weight });
        }
    }

    Some(TokenPatterns {
        patterns,
        // 及格线 2：一个 2-gram（1 分）不够，需要整体命中、一个 3-gram，
        // 或两个不同的 2-gram —— 挡住"只撞上一个通用二字词"的误召回
        threshold: W_TRIGRAM,
    })
}

/// 把整条查询展开成「每个 token 一组加权模式」。
///
/// 组间是 AND（用户用空格表达的收窄意图），组内按权重累加过及格线。
pub fn expand_query(query: &str) -> Vec<TokenPatterns> {
    split_tokens(query)
        .into_iter()
        .filter_map(|t| expand_token(&t))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(tp: &TokenPatterns) -> Vec<(&str, i32)> {
        tp.patterns
            .iter()
            .map(|p| (p.term.as_str(), p.weight))
            .collect()
    }

    #[test]
    fn splits_cjk_and_ascii_runs() {
        assert_eq!(split_tokens("本地docker部署"), vec!["本地", "docker", "部署"]);
        assert_eq!(split_tokens("docker k8s"), vec!["docker", "k8s"]);
        assert_eq!(split_tokens("本地仓库说明"), vec!["本地仓库说明"]);
        // 标点作分隔
        assert_eq!(split_tokens("部署，回滚"), vec!["部署", "回滚"]);
    }

    #[test]
    fn ascii_token_requires_whole_match() {
        let tp = expand_token("docker").unwrap();
        assert_eq!(terms(&tp), vec![("docker", 5)]);
        // 英文自带词边界，不该被拆成 n-gram
        assert_eq!(tp.threshold, 5);
    }

    #[test]
    fn short_cjk_token_requires_whole_match() {
        // 两个字的词本身就是最小语义单位，拆 2-gram 等于没拆
        let tp = expand_token("部署").unwrap();
        assert_eq!(terms(&tp), vec![("部署", 5)]);
        assert_eq!(tp.threshold, 5);
    }

    #[test]
    fn long_cjk_token_expands_to_weighted_ngrams() {
        let tp = expand_token("本地说明").unwrap();
        assert_eq!(tp.threshold, 2);
        // 整体 5 分
        assert_eq!(tp.patterns[0], WeightedTerm { term: "本地说明".into(), weight: 5 });
        // 3-gram 2 分
        assert!(tp.patterns.iter().any(|p| p.term == "本地说" && p.weight == 2));
        assert!(tp.patterns.iter().any(|p| p.term == "地说明" && p.weight == 2));
        // 2-gram 1 分
        assert!(tp.patterns.iter().any(|p| p.term == "本地" && p.weight == 1));
        assert!(tp.patterns.iter().any(|p| p.term == "说明" && p.weight == 1));
    }

    /// 这是整个模块存在的理由：用户搜「本地说明」，笔记里写的是「本地仓库说明」。
    /// FTS 前缀匹配和 `%本地说明%` 都找不到，加权 n-gram 能找到。
    #[test]
    fn recalls_non_contiguous_chinese() {
        let tp = expand_token("本地说明").unwrap();
        let doc = "本地仓库说明";
        let score: i32 = tp
            .patterns
            .iter()
            .filter(|p| doc.contains(&p.term))
            .map(|p| p.weight)
            .sum();
        // 本地(1) + 说明(1) = 2，正好过线
        assert!(score >= tp.threshold, "得分 {} 应过线 {}", score, tp.threshold);
    }

    /// 反面：只碰巧撞上一个通用二字词的无关笔记不该被召回
    #[test]
    fn rejects_single_generic_bigram_hit() {
        let tp = expand_token("本地说明").unwrap();
        let doc = "今天天气不错，说明会推迟";
        let score: i32 = tp
            .patterns
            .iter()
            .filter(|p| doc.contains(&p.term))
            .map(|p| p.weight)
            .sum();
        // 只有 说明(1)，不过线
        assert!(score < tp.threshold, "得分 {} 不该过线 {}", score, tp.threshold);
    }

    #[test]
    fn filters_noise_grams_but_keeps_user_token() {
        // 「什么」作为 n-gram 被过滤
        let tp = expand_token("这是什么东西").unwrap();
        assert!(
            !tp.patterns.iter().any(|p| p.term == "什么"),
            "噪声 n-gram 应被过滤: {:?}",
            terms(&tp)
        );
        // 但用户直接搜「什么」时照搜不误
        let tp2 = expand_token("什么").unwrap();
        assert_eq!(terms(&tp2), vec![("什么", 5)]);
    }

    #[test]
    fn caps_pattern_count() {
        // 长句不能炸出几百个占位符
        let tp = expand_token("这是一段非常长的中文查询用来测试模式数量上限是否生效").unwrap();
        assert!(
            tp.patterns.len() <= 16,
            "模式数 {} 超过上限",
            tp.patterns.len()
        );
    }

    #[test]
    fn dedups_repeated_grams() {
        // 「说明说明」的 2-gram「说明」只应出现一次
        let tp = expand_token("说明说明").unwrap();
        let count = tp.patterns.iter().filter(|p| p.term == "说明").count();
        assert_eq!(count, 1, "重复 n-gram 应去重: {:?}", terms(&tp));
    }

    #[test]
    fn expands_mixed_query_into_multiple_groups() {
        let groups = expand_query("docker 本地部署说明");
        assert_eq!(groups.len(), 2);
        // 英文组要求整体命中
        assert_eq!(groups[0].threshold, 5);
        // 中文长 token 走 n-gram
        assert_eq!(groups[1].threshold, 2);
    }

    #[test]
    fn empty_query_yields_nothing() {
        assert!(expand_query("").is_empty());
        assert!(expand_query("   ").is_empty());
        assert!(expand_query("!!!").is_empty());
    }
}
