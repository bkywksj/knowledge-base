//! 从原始表格数据里识别「二维数据集」：区域切分 + 表头识别 + 字段画像。
//!
//! # 为什么需要这一层
//!
//! 一个 Sheet 里往往不止一张表：上面一段说明文字、中间一张主表、下面再跟一张小计表。
//! 直接把整个 Sheet 当成一张表会得到一堆错位的列。这里负责把 Sheet 切成若干
//! **数据区域**，各自识别表头、推断字段类型。
//!
//! # 全部是确定性规则，不用 LLM
//!
//! 对标项目的 ADR-014 讲得很清楚：LLM 逐篇判类型成本高、边界不稳、破坏幂等
//! （同一个文件两次导入可能切出不同结构，引用全失效）。这里同样坚持确定性 ——
//! 规则错了可以改规则，模型抖了则无从复现。

use std::collections::HashMap;

/// 切分数据区域所需的**连续**空行数。
///
/// 取 2 而不是 1：真实表格里经常用**单个**空行做视觉分隔（分组、小计前留白），
/// 一行就切会把一张完整的表劈成好几个数据集，各自重新猜表头 —— 全是错的。
/// 对标项目正是"任意一整行全空即切"，这是它的一个明确缺陷。
const REGION_GAP_ROWS: usize = 2;

/// 数据区域至少要有多少行（含表头）才值得作为数据集。
///
/// 1 行没法推断任何东西；2 行（表头 + 一条数据）是有意义的最小单位。
const MIN_REGION_ROWS: usize = 2;

/// 表头单元格的长度上限。超过基本是一整句说明文字，不是列名。
const MAX_HEADER_CELL_CHARS: usize = 40;

/// "第二行有数字"这条判据下，表头单元格的长度上限（更严）
const MAX_HEADER_CELL_CHARS_STRICT: usize = 24;

/// 类型推断的投票阈值：某类型占非空值的比例达到此值即采纳。
///
/// 取 0.9 而非 1.0：真实表格总有几个"暂无"「-」「N/A」混在数字列里，
/// 要求 100% 会让绝大多数列退化成 text，画像就没意义了。
const TYPE_VOTE_RATIO: f64 = 0.9;

/// 字段推断出的数据类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Number,
    Date,
    Boolean,
    Text,
}

impl FieldType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FieldType::Number => "number",
            FieldType::Date => "date",
            FieldType::Boolean => "boolean",
            FieldType::Text => "text",
        }
    }
}

/// 字段的语义角色 —— 按列名关键词判定，用来给 UI / AI 提示"这列大概是干什么的"
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SemanticRole {
    /// 时间维度（日期 / 时间 / 年月）
    Time,
    /// 度量（金额 / 数量 / 单价…）—— 可求和求平均的列
    Measure,
    /// 标识（编号 / ID / 单号）—— 通常唯一，不该被求和
    Identifier,
    /// 状态（状态 / 是否 / 完成…）
    Status,
    /// 分类（类别 / 部门 / 地区…）—— 适合 group by
    Category,
}

impl SemanticRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            SemanticRole::Time => "time",
            SemanticRole::Measure => "measure",
            SemanticRole::Identifier => "identifier",
            SemanticRole::Status => "status",
            SemanticRole::Category => "category",
        }
    }
}

/// 单个字段（列）的画像
#[derive(Debug, Clone, serde::Serialize)]
pub struct FieldProfile {
    pub col_index: usize,
    pub name: String,
    pub inferred_type: FieldType,
    pub semantic_role: Option<SemanticRole>,
    /// 非空率 0.0~1.0
    pub completeness: f64,
    /// 去重后的取值数
    pub distinct_count: usize,
}

/// 一个识别出来的数据区域
#[derive(Debug, Clone)]
pub struct DataRegion {
    /// 同一 Sheet 内的序号（从 0 开始）
    pub region_index: usize,
    /// 表头在**原始行数组**里的下标；无表头时为 None
    pub header_row: Option<usize>,
    /// 列名（无表头时是 `A列` / `B列` …）
    pub headers: Vec<String>,
    /// 数据行（不含表头）
    pub rows: Vec<Vec<String>>,
    pub fields: Vec<FieldProfile>,
}

/// 整行是否为空（全部单元格 trim 后为空）
fn is_blank_row(row: &[String]) -> bool {
    row.iter().all(|c| c.trim().is_empty())
}

/// 把原始行切成若干数据区域的**行下标区间**（左闭右开）。
///
/// 规则：连续 >= [`REGION_GAP_ROWS`] 个空行才算区域分隔；
/// 单个空行视为表内留白，不切。
pub fn split_regions(rows: &[Vec<String>]) -> Vec<(usize, usize)> {
    let mut regions = Vec::new();
    let mut start: Option<usize> = None;
    let mut blank_run = 0usize;

    for (i, row) in rows.iter().enumerate() {
        if is_blank_row(row) {
            blank_run += 1;
            // 攒够了分隔空行 → 结束当前区域
            if blank_run >= REGION_GAP_ROWS {
                if let Some(s) = start.take() {
                    let end = i + 1 - blank_run;
                    if end > s {
                        regions.push((s, end));
                    }
                }
            }
        } else {
            blank_run = 0;
            if start.is_none() {
                start = Some(i);
            }
        }
    }
    if let Some(s) = start {
        if rows.len() > s {
            regions.push((s, rows.len()));
        }
    }
    regions
        .into_iter()
        .filter(|(s, e)| e - s >= MIN_REGION_ROWS)
        .collect()
}

/// 中英文常见表头词。命中即强判为表头 —— 这类词几乎不会出现在纯数据行里。
const HEADER_HINTS: &[&str] = &[
    "编号", "序号", "名称", "姓名", "日期", "时间", "金额", "数量", "单价", "总计", "合计",
    "类型", "类别", "分类", "状态", "备注", "说明", "地址", "电话", "邮箱", "部门", "项目",
    "标题", "内容", "价格", "规格", "型号", "单位", "负责人", "客户", "产品", "id", "name",
    "date", "time", "amount", "price", "qty", "quantity", "total", "type", "status", "note",
    "remark", "title", "code", "email", "phone", "count", "value",
];

/// 该单元格是否"看起来是个纯数字"
fn looks_numeric(s: &str) -> bool {
    let t = s.trim().replace([',', '，'], "");
    if t.is_empty() {
        return false;
    }
    let t = t.trim_end_matches('%').trim_start_matches(['￥', '$', '¥']);
    t.parse::<f64>().is_ok()
}

/// 判断某一行是否像表头。
///
/// 移植自对标项目 `spreadsheet.py:104-122` 的启发式，逐条都有理由：
/// 1. 非空单元格 >= 2 且**去重后过半** —— 少量重名（两个「备注」）在真表里很常见，
///    交给 `normalize_headers` 加后缀即可；重复过半的才更像数据行
/// 2. 没有超长单元格、没有公式残留（`=` 开头）
/// 3. **不含纯数字** —— 数字是数据不是列名
/// 4. 满足以下之一：命中表头词表 / 下一行有数字且本行单元格都较短
fn looks_like_header(row: &[String], next_row: Option<&[String]>) -> bool {
    let non_empty: Vec<&str> = row
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if non_empty.len() < 2 {
        return false;
    }
    // 重复**过半**才判定不是表头。
    //
    // 曾经这里是"只要有一个重复就 return false"，后果是整张表的列名全丢：
    // 真实 Excel 里两个「备注」「金额」太常见，而一列重名就让另外 5 个好列名
    // 一起退化成 A列/B列。更糟的是会级联 —— 表头行混进数据后，
    // 「销售额」列的类型投票被文字表头拉成 text，于是 sum/avg 也被拒了。
    //
    // 而 `normalize_headers` 本来就有重名改名（`备注` / `备注_2`），
    // 只是被这个早退挡住、永远走不到（它的单测直接调 normalize_headers，所以一直是绿的）。
    //
    // 保留"过半重复"这条是因为纯文本的**数据行**也可能被误判成表头
    // （如 `已回款/已回款/已回款`）—— 那种行的去重率很低，用比例正好区分。
    let uniq: std::collections::HashSet<&&str> = non_empty.iter().collect();
    if uniq.len() * 2 <= non_empty.len() {
        return false;
    }
    if non_empty
        .iter()
        .any(|c| c.chars().count() > MAX_HEADER_CELL_CHARS || c.starts_with('='))
    {
        return false;
    }
    if non_empty.iter().any(|c| looks_numeric(c)) {
        return false;
    }

    let lower: Vec<String> = non_empty.iter().map(|c| c.to_lowercase()).collect();
    if lower
        .iter()
        .any(|c| HEADER_HINTS.iter().any(|h| c.contains(h)))
    {
        return true;
    }

    // 兜底判据：下一行出现数字（说明本行是列名、下一行才是数据），且本行都是短词
    match next_row {
        Some(next) => {
            let next_has_num = next.iter().any(|c| looks_numeric(c));
            next_has_num
                && non_empty
                    .iter()
                    .all(|c| c.chars().count() <= MAX_HEADER_CELL_CHARS_STRICT)
        }
        None => false,
    }
}

/// 无表头时生成 `A列` / `B列` … `AA列`
fn column_label(idx: usize) -> String {
    let mut n = idx;
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    format!("{}列", s)
}

/// 规整列名：空 → 列标；重名 → 加 `_2` / `_3`
fn normalize_headers(raw: &[String], col_count: usize) -> Vec<String> {
    let mut used: HashMap<String, usize> = HashMap::new();
    (0..col_count)
        .map(|i| {
            let base = raw
                .get(i)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| column_label(i));
            let count = used.entry(base.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{}_{}", base, count)
            }
        })
        .collect()
}

/// 该值是否像日期。只认常见格式，不做万能解析 —— 宁可判成 text 也别乱认。
fn looks_like_date(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 6 || t.chars().count() > 32 {
        return false;
    }
    let digits = t.chars().filter(|c| c.is_ascii_digit()).count();
    let seps = t.chars().filter(|c| matches!(c, '-' | '/' | '.')).count();
    let has_cjk_date = t.contains('年') && t.contains('月');
    // 形如 2024-01-05 / 2024/1/5 / 2024.01.05 / 2024年1月5日
    (digits >= 6 && seps >= 2) || has_cjk_date
}

fn looks_boolean(s: &str) -> bool {
    matches!(
        s.trim().to_lowercase().as_str(),
        "true" | "false" | "yes" | "no" | "是" | "否" | "有" | "无"
    )
}

/// 按 [`TYPE_VOTE_RATIO`] 投票推断列类型
fn infer_type(values: &[&str]) -> FieldType {
    let non_empty: Vec<&&str> = values.iter().filter(|v| !v.trim().is_empty()).collect();
    if non_empty.is_empty() {
        return FieldType::Text;
    }
    let total = non_empty.len() as f64;
    let ratio = |f: fn(&str) -> bool| -> f64 {
        non_empty.iter().filter(|v| f(v)).count() as f64 / total
    };

    // 顺序有讲究：日期形如 2024-01-05 不会被 looks_numeric 认走（有分隔符），
    // 但布尔要排在数字前 —— 0/1 也可能是布尔，这里按"字面像不像"判，
    // 纯 0/1 仍算数字（更保守，不擅自把数量列当成开关）
    if ratio(looks_boolean) >= TYPE_VOTE_RATIO {
        return FieldType::Boolean;
    }
    if ratio(looks_like_date) >= TYPE_VOTE_RATIO {
        return FieldType::Date;
    }
    if ratio(looks_numeric) >= TYPE_VOTE_RATIO {
        return FieldType::Number;
    }
    FieldType::Text
}

/// 按列名关键词判定语义角色
fn infer_role(name: &str, ty: FieldType) -> Option<SemanticRole> {
    let n = name.to_lowercase();
    let hit = |ks: &[&str]| ks.iter().any(|k| n.contains(k));

    // 标识优先于度量：「订单编号」含"号"也含数字，但绝不该被求和
    if hit(&["编号", "序号", "单号", "id", "code", "工号", "卡号"]) {
        return Some(SemanticRole::Identifier);
    }
    if hit(&["状态", "是否", "完成", "status", "state", "flag"]) {
        return Some(SemanticRole::Status);
    }
    if hit(&["日期", "时间", "年月", "date", "time", "月份", "年份"]) || ty == FieldType::Date {
        return Some(SemanticRole::Time);
    }
    if hit(&[
        "金额", "数量", "单价", "价格", "总计", "合计", "amount", "price", "qty", "quantity",
        "total", "count", "费用", "成本", "收入",
    ]) {
        return Some(SemanticRole::Measure);
    }
    if hit(&[
        "类型", "类别", "分类", "部门", "地区", "区域", "category", "type", "dept", "region",
        "组别", "渠道",
    ]) {
        return Some(SemanticRole::Category);
    }
    // 没命中词表时按类型兜底：数字列多半是度量，文本列多半是分类
    match ty {
        FieldType::Number => Some(SemanticRole::Measure),
        FieldType::Boolean => Some(SemanticRole::Status),
        _ => None,
    }
}

/// 给一列算画像
fn profile_field(col_index: usize, name: &str, rows: &[Vec<String>]) -> FieldProfile {
    let values: Vec<&str> = rows
        .iter()
        .map(|r| r.get(col_index).map(|s| s.as_str()).unwrap_or(""))
        .collect();
    let filled = values.iter().filter(|v| !v.trim().is_empty()).count();
    let distinct: std::collections::HashSet<&str> = values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect();
    let ty = infer_type(&values);
    FieldProfile {
        col_index,
        name: name.to_string(),
        inferred_type: ty,
        semantic_role: infer_role(name, ty),
        completeness: if values.is_empty() {
            0.0
        } else {
            filled as f64 / values.len() as f64
        },
        distinct_count: distinct.len(),
    }
}

/// 把一个 Sheet 的原始行识别成若干数据集
pub fn detect_regions(rows: &[Vec<String>]) -> Vec<DataRegion> {
    split_regions(rows)
        .into_iter()
        .enumerate()
        .filter_map(|(idx, (start, end))| {
            let slice = &rows[start..end];
            let col_count = slice.iter().map(|r| r.len()).max().unwrap_or(0);
            if col_count == 0 {
                return None;
            }

            let has_header = looks_like_header(&slice[0], slice.get(1).map(|v| v.as_slice()));
            let (header_row, raw_headers, data) = if has_header {
                (Some(start), slice[0].clone(), &slice[1..])
            } else {
                (None, Vec::new(), slice)
            };
            if data.is_empty() {
                return None;
            }

            let headers = normalize_headers(&raw_headers, col_count);
            // 行补齐到同样列数，免得后面各处都要判越界
            let rows: Vec<Vec<String>> = data
                .iter()
                .map(|r| {
                    let mut r = r.clone();
                    r.resize(col_count, String::new());
                    r
                })
                .collect();
            let fields = headers
                .iter()
                .enumerate()
                .map(|(i, name)| profile_field(i, name, &rows))
                .collect();

            Some(DataRegion {
                region_index: idx,
                header_row,
                headers,
                rows,
                fields,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(v: &[&[&str]]) -> Vec<Vec<String>> {
        v.iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    // ─── 区域切分 ───────────────────────────────

    /// 🔴 核心差异点：单个空行是表内留白，**不该**切分。
    /// 对标项目"任意一整行全空即切"会把这张表劈成两个数据集，各自重猜表头。
    #[test]
    fn single_blank_row_does_not_split() {
        let r = rows(&[
            &["名称", "数量"],
            &["甲", "1"],
            &["", ""], // 视觉留白
            &["乙", "2"],
        ]);
        assert_eq!(split_regions(&r), vec![(0, 4)]);
    }

    #[test]
    fn two_blank_rows_split_regions() {
        let r = rows(&[
            &["名称", "数量"],
            &["甲", "1"],
            &["", ""],
            &["", ""],
            &["部门", "人数"],
            &["技术", "10"],
        ]);
        assert_eq!(split_regions(&r), vec![(0, 2), (4, 6)]);
    }

    #[test]
    fn drops_too_short_regions() {
        // 只有一行的"区域"推断不出任何东西
        let r = rows(&[&["孤零零一行"], &["", ""], &["", ""], &["名称", "值"], &["a", "1"]]);
        assert_eq!(split_regions(&r), vec![(3, 5)]);
    }

    // ─── 表头识别 ───────────────────────────────

    #[test]
    fn detects_header_by_hint_words() {
        assert!(looks_like_header(
            &["名称".into(), "金额".into()],
            Some(&["甲".into(), "100".into()])
        ));
    }

    #[test]
    fn detects_header_by_numeric_second_row() {
        // 列名不在词表里，但下一行是数字 → 判为表头
        assert!(looks_like_header(
            &["甲乙".into(), "丙丁".into()],
            Some(&["1".into(), "2".into()])
        ));
    }

    #[test]
    fn rejects_numeric_and_duplicate_headers() {
        // 含纯数字 → 是数据行不是表头
        assert!(!looks_like_header(
            &["名称".into(), "100".into()],
            Some(&["甲".into(), "1".into()])
        ));
        // 列名重复 → 不是表头
        assert!(!looks_like_header(
            &["名称".into(), "名称".into()],
            Some(&["甲".into(), "1".into()])
        ));
        // 超长单元格 → 是说明文字
        let long = "这是一段很长的说明文字".repeat(5);
        assert!(!looks_like_header(
            &[long, "金额".into()],
            Some(&["甲".into(), "1".into()])
        ));
    }

    #[test]
    fn generates_column_labels_without_header() {
        assert_eq!(column_label(0), "A列");
        assert_eq!(column_label(25), "Z列");
        assert_eq!(column_label(26), "AA列");
    }

    #[test]
    fn dedups_duplicate_header_names() {
        let h = normalize_headers(&["金额".into(), "金额".into(), "".into()], 3);
        assert_eq!(h, vec!["金额", "金额_2", "C列"]);
    }

    /// 🔴 上面那条只测 `normalize_headers` **单个函数**，走不到真实路径 ——
    /// `looks_like_header` 曾经"见到一个重名就否决整行"，于是重名改名分支
    /// 在集成路径上是死代码，而单测一直是绿的。这条从 `detect_regions` 进去补上。
    #[test]
    fn duplicate_column_keeps_other_headers() {
        let rows: Vec<Vec<String>> = vec![
            vec!["区域", "城市", "销售额", "备注", "备注"],
            vec!["华东", "上海", "100", "大客户", "已回款"],
            vec!["华北", "北京", "80", "新客户", "已回款"],
        ]
        .into_iter()
        .map(|r| r.into_iter().map(String::from).collect())
        .collect();

        let ds = detect_regions(&rows);
        assert_eq!(ds.len(), 1);
        // 一列重名不该让另外几个好列名一起退化成 A列/B列
        assert_eq!(
            ds[0].headers,
            vec!["区域", "城市", "销售额", "备注", "备注_2"]
        );
        // 表头没混进数据 → 销售额才能被推断成数值列（否则 sum/avg 会被拒）
        assert_eq!(ds[0].rows.len(), 2);
        let amount = ds[0].fields.iter().find(|f| f.name == "销售额").unwrap();
        assert_eq!(amount.inferred_type, FieldType::Number);
    }

    /// 重复**过半**仍要否决 —— 这种更像数据行而不是表头
    #[test]
    fn mostly_duplicated_row_is_not_header() {
        assert!(!looks_like_header(
            &[
                "已回款".into(),
                "已回款".into(),
                "已回款".into(),
                "未回款".into()
            ],
            Some(&["1".into(), "2".into(), "3".into(), "4".into()])
        ));
    }

    // ─── 类型推断 ───────────────────────────────

    #[test]
    fn infers_number_tolerating_dirty_values() {
        // 90% 阈值：混进一个「暂无」不该让整列退化成 text
        let vals = vec!["1", "2", "3", "4", "5", "6", "7", "8", "9", "暂无"];
        assert_eq!(infer_type(&vals), FieldType::Number);
        // 脏值过多 → 老实判 text
        let dirty = vec!["1", "2", "暂无", "待定", "N/A"];
        assert_eq!(infer_type(&dirty), FieldType::Text);
    }

    #[test]
    fn infers_date_and_boolean() {
        assert_eq!(
            infer_type(&["2024-01-05", "2024/2/6", "2024.03.07"]),
            FieldType::Date
        );
        assert_eq!(infer_type(&["2024年1月5日", "2024年2月6日"]), FieldType::Date);
        assert_eq!(infer_type(&["是", "否", "是"]), FieldType::Boolean);
    }

    #[test]
    fn numeric_with_currency_and_percent() {
        assert!(looks_numeric("￥1,200"));
        assert!(looks_numeric("85%"));
        assert!(!looks_numeric("暂无"));
    }

    // ─── 语义角色 ───────────────────────────────

    #[test]
    fn identifier_beats_measure() {
        // 「订单编号」虽是数字，但绝不该被求和 —— 标识优先级必须高于度量
        assert_eq!(
            infer_role("订单编号", FieldType::Number),
            Some(SemanticRole::Identifier)
        );
        assert_eq!(
            infer_role("销售金额", FieldType::Number),
            Some(SemanticRole::Measure)
        );
    }

    #[test]
    fn roles_by_keyword_and_type_fallback() {
        assert_eq!(infer_role("下单日期", FieldType::Text), Some(SemanticRole::Time));
        assert_eq!(infer_role("所属部门", FieldType::Text), Some(SemanticRole::Category));
        assert_eq!(infer_role("是否完成", FieldType::Text), Some(SemanticRole::Status));
        // 没命中词表时按类型兜底
        assert_eq!(infer_role("随便一列", FieldType::Number), Some(SemanticRole::Measure));
        assert_eq!(infer_role("随便一列", FieldType::Text), None);
    }

    // ─── 端到端 ─────────────────────────────────

    #[test]
    fn detects_two_datasets_with_profiles() {
        let r = rows(&[
            &["订单编号", "金额", "下单日期"],
            &["A001", "100", "2024-01-05"],
            &["A002", "200", "2024-01-06"],
            &["", "", ""],
            &["", "", ""],
            &["部门", "人数"],
            &["技术", "10"],
            &["市场", "5"],
        ]);
        let regions = detect_regions(&r);
        assert_eq!(regions.len(), 2, "应识别出两个数据集");

        let d0 = &regions[0];
        assert_eq!(d0.headers, vec!["订单编号", "金额", "下单日期"]);
        assert_eq!(d0.rows.len(), 2);
        assert_eq!(d0.header_row, Some(0));
        // 字段画像
        assert_eq!(d0.fields[0].semantic_role, Some(SemanticRole::Identifier));
        assert_eq!(d0.fields[1].inferred_type, FieldType::Number);
        assert_eq!(d0.fields[2].inferred_type, FieldType::Date);
        assert!((d0.fields[0].completeness - 1.0).abs() < 1e-9);
        assert_eq!(d0.fields[0].distinct_count, 2);

        let d1 = &regions[1];
        assert_eq!(d1.headers, vec!["部门", "人数"]);
        assert_eq!(d1.rows.len(), 2);
    }

    #[test]
    fn handles_headerless_region() {
        // 首行就是数据（含纯数字）→ 无表头，列名回退 A列/B列，首行也算数据
        let r = rows(&[&["甲", "1"], &["乙", "2"], &["丙", "3"]]);
        let regions = detect_regions(&r);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].header_row, None);
        assert_eq!(regions[0].headers, vec!["A列", "B列"]);
        assert_eq!(regions[0].rows.len(), 3, "无表头时首行也是数据");
    }

    #[test]
    fn pads_ragged_rows_to_same_width() {
        let r = rows(&[&["名称", "数量", "备注"], &["甲", "1"], &["乙", "2", "x"]]);
        let regions = detect_regions(&r);
        assert!(regions[0].rows.iter().all(|row| row.len() == 3));
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(detect_regions(&[]).is_empty());
        assert!(detect_regions(&rows(&[&["", ""]])).is_empty());
    }
}
