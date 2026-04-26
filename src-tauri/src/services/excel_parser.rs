//! Excel / ODS / CSV 解析为 markdown 表，供 AI 智能规划「Excel 导入」模式使用。
//!
//! 设计要点：
//! 1. 默认取所有行，不预先截断；交给上层（plan_from_excel）按总字符判断是否截断
//! 2. 把每个 Sheet 转成 markdown 表（LLM 对 markdown 表理解最准）
//! 3. 输出含统计信息（总 sheet 数 / 总行数 / 是否截断），方便前端友好提示

use calamine::{open_workbook_auto, Data, Reader};

use crate::error::AppError;

/// 总字符触发"过大"的阈值（粗略：1 token ≈ 1.5 中文字符；4 万字符≈ 2.5 万 tokens，
/// 留给 system prompt + 输出 + 历史还有较大余量）
const SOFT_TOTAL_CHARS_LIMIT: usize = 60_000;

/// 单 Sheet 触发"过大→自动截断"的字符阈值
const PER_SHEET_HARD_LIMIT: usize = 30_000;

/// 自动截断时每个大 Sheet 保留的"头几行 + 尾几行"
const TRUNCATE_HEAD_ROWS: usize = 40;
const TRUNCATE_TAIL_ROWS: usize = 10;

#[derive(Debug)]
pub struct SheetSnapshot {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    /// 由于过大被截断的行数（0 = 没截断）
    pub truncated_rows: usize,
}

#[derive(Debug)]
pub struct ExcelSummary {
    pub sheets: Vec<SheetSnapshot>,
    /// 拼成的 markdown 全文
    pub markdown: String,
    /// 文件级统计：总行数（所有 sheet 累加）
    pub total_rows: usize,
    /// 因体积过大而被截断的 Sheet 名单
    pub truncated_sheet_names: Vec<String>,
}

/// 读取 Excel/ODS 文件为多 Sheet 快照。
///
/// 支持扩展名：xlsx / xls / xlsm / xlsb / ods（calamine `open_workbook_auto` 自动判别）。
/// CSV 不在 calamine 支持范围内——CSV 走另外路径（暂时让用户先转 xlsx）。
pub fn read_workbook(path: &str) -> Result<ExcelSummary, AppError> {
    let mut workbook = open_workbook_auto(path).map_err(|e| {
        AppError::Custom(format!(
            "打开 Excel 失败（仅支持 xlsx / xls / xlsm / xlsb / ods）：{}",
            e
        ))
    })?;

    let names = workbook.sheet_names();
    if names.is_empty() {
        return Err(AppError::Custom("Excel 文件没有任何 Sheet".into()));
    }

    let mut sheets = Vec::with_capacity(names.len());
    let mut total_rows = 0usize;
    for name in names {
        let range = workbook.worksheet_range(&name).map_err(|e| {
            AppError::Custom(format!("读取 Sheet 「{}」失败：{}", name, e))
        })?;
        let mut iter = range.rows();
        let headers: Vec<String> = iter
            .next()
            .map(|r| r.iter().map(cell_to_string).collect())
            .unwrap_or_default();
        let all_rows: Vec<Vec<String>> = iter
            .map(|r| r.iter().map(cell_to_string).collect())
            .collect();
        let total = all_rows.len();
        total_rows += total;

        // 默认全保留；若该 Sheet 本身就超大，先做一轮硬截断
        let (kept_rows, truncated_rows) = trim_sheet_rows(&all_rows, &headers);
        sheets.push(SheetSnapshot {
            name,
            headers,
            rows: kept_rows,
            total_rows: total,
            truncated_rows,
        });
    }

    // 第一遍：用全量数据拼 markdown
    let mut markdown = render_markdown(&sheets);
    let mut truncated_sheet_names: Vec<String> = sheets
        .iter()
        .filter(|s| s.truncated_rows > 0)
        .map(|s| s.name.clone())
        .collect();

    // 第二遍：若总长度仍超 SOFT 限制，对最大的几个 Sheet 进一步截断
    if markdown.chars().count() > SOFT_TOTAL_CHARS_LIMIT {
        // 按行数从多到少排序，挨个截断直到总长度回落
        let mut order: Vec<usize> = (0..sheets.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(sheets[i].rows.len()));
        for idx in order {
            let s = &mut sheets[idx];
            if s.rows.len() <= TRUNCATE_HEAD_ROWS + TRUNCATE_TAIL_ROWS {
                continue;
            }
            let extra = s.rows.len() - (TRUNCATE_HEAD_ROWS + TRUNCATE_TAIL_ROWS);
            let mut head = s.rows[..TRUNCATE_HEAD_ROWS].to_vec();
            let tail = s.rows[s.rows.len() - TRUNCATE_TAIL_ROWS..].to_vec();
            // 用一个明显的占位行让 AI 知道中间有省略
            head.push(vec![format!("…（中间 {} 行已省略）", extra)]);
            head.extend(tail);
            s.rows = head;
            s.truncated_rows += extra;
            if !truncated_sheet_names.contains(&s.name) {
                truncated_sheet_names.push(s.name.clone());
            }
            markdown = render_markdown(&sheets);
            if markdown.chars().count() <= SOFT_TOTAL_CHARS_LIMIT {
                break;
            }
        }
    }

    Ok(ExcelSummary {
        sheets,
        markdown,
        total_rows,
        truncated_sheet_names,
    })
}

/// 单元格 → 字符串。布尔/数字/日期都尽量保留可读形式。
fn cell_to_string(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.replace('\n', " ").replace('|', "\\|").trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{}", f)
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => format!("{}", d),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR:{:?}", e),
    }
}

/// 单 Sheet 字符级硬截断：超过 PER_SHEET_HARD_LIMIT 时取头 [TRUNCATE_HEAD_ROWS] + 尾 [TRUNCATE_TAIL_ROWS]
fn trim_sheet_rows(
    all_rows: &[Vec<String>],
    headers: &[String],
) -> (Vec<Vec<String>>, usize) {
    if all_rows.is_empty() {
        return (Vec::new(), 0);
    }
    let est = estimate_chars(headers, all_rows);
    if est <= PER_SHEET_HARD_LIMIT || all_rows.len() <= TRUNCATE_HEAD_ROWS + TRUNCATE_TAIL_ROWS {
        return (all_rows.to_vec(), 0);
    }
    let extra = all_rows.len() - (TRUNCATE_HEAD_ROWS + TRUNCATE_TAIL_ROWS);
    let mut head = all_rows[..TRUNCATE_HEAD_ROWS].to_vec();
    head.push(vec![format!("…（中间 {} 行已省略）", extra)]);
    head.extend_from_slice(&all_rows[all_rows.len() - TRUNCATE_TAIL_ROWS..]);
    (head, extra)
}

fn estimate_chars(headers: &[String], rows: &[Vec<String>]) -> usize {
    let head_len: usize = headers.iter().map(|s| s.chars().count() + 3).sum();
    let body: usize = rows
        .iter()
        .map(|r| r.iter().map(|s| s.chars().count() + 3).sum::<usize>())
        .sum();
    head_len + body
}

/// 把 SheetSnapshot 列表渲染为 markdown 字符串
fn render_markdown(sheets: &[SheetSnapshot]) -> String {
    let mut out = String::new();
    for s in sheets {
        out.push_str(&format!(
            "\n## Sheet: {} （共 {} 行{}）\n\n",
            s.name,
            s.total_rows,
            if s.truncated_rows > 0 {
                format!("，已截断 {} 行", s.truncated_rows)
            } else {
                String::new()
            }
        ));
        if s.headers.is_empty() {
            out.push_str("（空表）\n");
            continue;
        }
        out.push_str("| ");
        out.push_str(&s.headers.join(" | "));
        out.push_str(" |\n|");
        for _ in &s.headers {
            out.push_str("---|");
        }
        out.push('\n');
        for row in &s.rows {
            out.push_str("| ");
            // 行短于表头时用空串补齐；多于表头时合并多余列
            if row.len() == 1 && row[0].starts_with("…（中间") {
                // 占位行直接横向合并
                out.push_str(&row[0]);
            } else {
                let mut cells: Vec<String> =
                    row.iter().take(s.headers.len()).cloned().collect();
                while cells.len() < s.headers.len() {
                    cells.push(String::new());
                }
                out.push_str(&cells.join(" | "));
            }
            out.push_str(" |\n");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_to_string_basic() {
        assert_eq!(cell_to_string(&Data::Empty), "");
        assert_eq!(cell_to_string(&Data::Bool(true)), "true");
        assert_eq!(cell_to_string(&Data::Int(42)), "42");
        assert_eq!(cell_to_string(&Data::Float(3.14)), "3.14");
        // 整数小数自动转 int
        assert_eq!(cell_to_string(&Data::Float(7.0)), "7");
        // 含 | 时转义，避免破坏 markdown 表
        assert_eq!(
            cell_to_string(&Data::String("a|b".to_string())),
            "a\\|b"
        );
    }

    #[test]
    fn render_small_sheet() {
        let s = SheetSnapshot {
            name: "测试".into(),
            headers: vec!["列A".into(), "列B".into()],
            rows: vec![
                vec!["1".into(), "x".into()],
                vec!["2".into(), "y".into()],
            ],
            total_rows: 2,
            truncated_rows: 0,
        };
        let md = render_markdown(&[s]);
        assert!(md.contains("## Sheet: 测试"));
        assert!(md.contains("| 列A | 列B |"));
        assert!(md.contains("| 1 | x |"));
    }
}
