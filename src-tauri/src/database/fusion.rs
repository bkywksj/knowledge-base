//! 多路召回结果融合（Reciprocal Rank Fusion）。
//!
//! # 为什么需要
//!
//! RAG 检索有两条通道：LIKE 加权命中（中文友好）与 FTS5（英文 tokenize 正确）。
//! 两者的分数**量纲完全不同** —— LIKE 是"命中关键词的加权计数"（整数，几分到几十分），
//! FTS5 的 `rank` 是 bm25 负值（越小越相关）。把它们放一起比大小没有任何意义。
//!
//! 原先的做法是"主通道 + 填空"：LIKE 结果不足 limit 时才用 FTS 补，
//! 等于 FTS 只在"LIKE 没查够"时才有发言权 —— 一条被两路同时命中的笔记，
//! 并不会因为"两边都认可"而排得更前。
//!
//! # RRF 怎么解决
//!
//! 只用**名次**不用分数：`score(d) = Σ 1 / (k + rank_i(d))`。
//! 名次是跨通道可比的，天然免疫量纲问题；被多路命中的文档得分自然叠加。
//! `k` 取 60 是 RRF 原论文（Cormack et al., 2009）的经验值，也是业界通用默认。
//!
//! 参数少、无需训练、无需归一化 —— 这正是它在混合检索里被广泛采用的原因。

use std::collections::HashMap;

/// RRF 平滑常数。
///
/// 取 60 有两个作用：① 压低头部名次之间的差距（第 1 与第 2 不会拉开太多），
/// 让"被多路同时命中"比"在单路里排第一"更有优势；② 避免 rank=1 时分数爆炸。
pub const RRF_K: f64 = 60.0;

/// 对多路排序结果做 RRF 融合，返回 `id -> 融合分`。
///
/// - 每一路内部**重复 id 只记首次名次**（后面的重复项不再加分，否则一路里出现两次
///   就等于投了两票）
/// - 名次从 1 开始
pub fn rrf_scores(rankings: &[Vec<i64>], k: f64) -> HashMap<i64, f64> {
    let mut scores: HashMap<i64, f64> = HashMap::new();
    for ranking in rankings {
        let mut seen = std::collections::HashSet::new();
        for (idx, id) in ranking.iter().enumerate() {
            if !seen.insert(*id) {
                continue;
            }
            let rank = (idx + 1) as f64;
            *scores.entry(*id).or_insert(0.0) += 1.0 / (k + rank);
        }
    }
    scores
}

/// 融合并返回排好序的 id 列表（分高在前）。
///
/// 分数相同时按 **id 升序**兜底排序：浮点数比较在不同平台可能给出不同的相等判定，
/// 没有这个兜底，同分文档的先后会随运行而变 —— 检索结果不可复现会让排查问题变得极难。
pub fn rrf_fuse(rankings: &[Vec<i64>], k: f64) -> Vec<i64> {
    let scores = rrf_scores(rankings, k);
    let mut ids: Vec<(i64, f64)> = scores.into_iter().collect();
    ids.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    ids.into_iter().map(|(id, _)| id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_ranking_preserves_order() {
        // 只有一路时 RRF 必须退化成原顺序，不能打乱
        let fused = rrf_fuse(&[vec![10, 20, 30]], RRF_K);
        assert_eq!(fused, vec![10, 20, 30]);
    }

    #[test]
    fn multi_hit_document_ranks_higher() {
        // 20 在两路都排第二；10 只在第一路排第一。
        // 两路认可应该胜过单路第一 —— 这正是"主+填空"做不到的事。
        let a = vec![10, 20, 30];
        let b = vec![40, 20, 50];
        let fused = rrf_fuse(&[a, b], RRF_K);
        assert_eq!(fused[0], 20, "被两路同时命中的应排首位，实际: {:?}", fused);
    }

    #[test]
    fn scores_match_formula() {
        let scores = rrf_scores(&[vec![7]], 60.0);
        // rank=1 → 1/(60+1)
        assert!((scores[&7] - 1.0 / 61.0).abs() < 1e-12);

        let scores = rrf_scores(&[vec![7], vec![7]], 60.0);
        // 两路都排第一 → 2/(60+1)
        assert!((scores[&7] - 2.0 / 61.0).abs() < 1e-12);
    }

    #[test]
    fn duplicate_in_same_ranking_counts_once() {
        // 同一路里出现两次不能算两票
        let once = rrf_scores(&[vec![5]], RRF_K);
        let twice = rrf_scores(&[vec![5, 5]], RRF_K);
        assert!((once[&5] - twice[&5]).abs() < 1e-12);
    }

    #[test]
    fn ties_break_by_id_deterministically() {
        // 三个 id 各自在不同路排第一 → 同分，必须按 id 升序稳定输出
        let fused = rrf_fuse(&[vec![30], vec![10], vec![20]], RRF_K);
        assert_eq!(fused, vec![10, 20, 30]);
        // 换个输入顺序，结果必须一致（不可复现的排序会让排查变得极难）
        let fused2 = rrf_fuse(&[vec![20], vec![30], vec![10]], RRF_K);
        assert_eq!(fused, fused2);
    }

    #[test]
    fn empty_inputs_are_safe() {
        assert!(rrf_fuse(&[], RRF_K).is_empty());
        assert!(rrf_fuse(&[vec![]], RRF_K).is_empty());
        assert!(rrf_fuse(&[vec![], vec![]], RRF_K).is_empty());
    }

    #[test]
    fn disjoint_rankings_interleave_by_rank() {
        // 两路完全不相交时，应按名次交错：各自第一名并列（id 升序），再各自第二名
        let fused = rrf_fuse(&[vec![1, 3], vec![2, 4]], RRF_K);
        assert_eq!(fused, vec![1, 2, 3, 4]);
    }
}
