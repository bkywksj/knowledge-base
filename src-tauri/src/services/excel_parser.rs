//! Excel / ODS / CSV 解析为 markdown 表，供 AI 智能规划「Excel 导入」模式使用。
//!
//! 设计要点：
//! 1. 默认取所有行，不预先截断；交给上层（plan_from_excel）按总字符判断是否截断
//! 2. 把每个 Sheet 转成 markdown 表（LLM 对 markdown 表理解最准）
//! 3. 输出含统计信息（总 sheet 数 / 总行数 / 是否截断），方便前端友好提示

use calamine::{open_workbook_auto, Data, Dimensions, Range, Reader, Sheets};

use crate::error::AppError;

/// 把合并单元格的值回填到区域内其余格子。
///
/// # 为什么必须做
///
/// Excel 里合并 A1:C1 后，**只有左上角 A1 存值，B1/C1 是空的**。中文报表几乎必然
/// 用到合并（多行表头、分类跨行、小计跨列），不处理的话这些格子全是空白 ——
/// 表头会缺一大半，AI 拿到的表结构直接是错的。
///
/// 对标项目在这一点上是**零处理**（全仓搜不到 merged 相关代码），
/// 中文报表进去就丢数据。这是我们能做得更好的地方。
///
/// # 坐标换算
///
/// `Dimensions` 是**工作表绝对坐标**，而 `Range` 可能有偏移
/// （数据不从 A1 开始时 `range.start()` 就不是 `(0,0)`），必须减去偏移才是行列下标。
fn fill_merged_cells(rows: &mut [Vec<String>], range_start: (u32, u32), regions: &[&Dimensions]) {
    for region in regions {
        let (sr, sc) = region.start;
        let (er, ec) = region.end;
        // 换算到 rows 的相对下标；越界（区域在 range 之外）直接跳过
        let (Some(rel_sr), Some(rel_sc)) = (
            sr.checked_sub(range_start.0),
            sc.checked_sub(range_start.1),
        ) else {
            continue;
        };
        let (rel_sr, rel_sc) = (rel_sr as usize, rel_sc as usize);

        // 取左上角的值 —— 合并区域里唯一有内容的那个格子
        let Some(anchor) = rows.get(rel_sr).and_then(|r| r.get(rel_sc)).cloned() else {
            continue;
        };
        if anchor.is_empty() {
            continue; // 合并了但本来就没填内容，没必要铺开一片空串
        }

        let rel_er = (er.saturating_sub(range_start.0)) as usize;
        let rel_ec = (ec.saturating_sub(range_start.1)) as usize;
        for (ri, row) in rows.iter_mut().enumerate().take(rel_er + 1).skip(rel_sr) {
            for (ci, cell) in row.iter_mut().enumerate().take(rel_ec + 1).skip(rel_sc) {
                // 左上角本身不用改；其余只在为空时填（不覆盖已有内容，防御脏文件）
                if (ri, ci) != (rel_sr, rel_sc) && cell.is_empty() {
                    *cell = anchor.clone();
                }
            }
        }
    }
}

/// 读取某个 sheet 的合并区域。
///
/// 只有 xlsx 支持 —— calamine 把 `merged_regions` 放在 `Xlsx<RS>` 上，
/// `open_workbook_auto` 返回的 `Sheets` 枚举并不暴露它。xls / xlsb / ods
/// 拿不到合并信息，返回空列表按"无合并"处理（不报错，其余数据照常可用）。
///
/// ⚠️ `merged_regions()` 在未加载时会 **panic**，所以必须先 `load_merged_regions()`。
fn merged_regions_of(
    workbook: &mut Sheets<std::io::BufReader<std::fs::File>>,
    sheet: &str,
) -> Vec<Dimensions> {
    let Sheets::Xlsx(xlsx) = workbook else {
        return Vec::new();
    };
    if xlsx.load_merged_regions().is_err() {
        log::debug!("[excel] 读取合并单元格失败，按无合并处理：{}", sheet);
        return Vec::new();
    }
    xlsx.merged_regions_by_sheet(sheet)
        .into_iter()
        .map(|(_, _, dim)| *dim)
        .collect()
}

/// 把 Range 转成"表头 + 数据行"，并回填合并单元格
fn range_to_rows(range: &Range<Data>, merged: &[Dimensions]) -> (Vec<String>, Vec<Vec<String>>) {
    let mut all: Vec<Vec<String>> = range
        .rows()
        .map(|r| r.iter().map(cell_to_string).collect())
        .collect();
    if all.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if !merged.is_empty() {
        let start = range.start().unwrap_or((0, 0));
        let refs: Vec<&Dimensions> = merged.iter().collect();
        fill_merged_cells(&mut all, start, &refs);
    }
    let headers = all.remove(0);
    (headers, all)
}

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

/// 读取表格文件为多 Sheet 快照。
///
/// 支持扩展名：
/// - xlsx / xls / xlsm / xlsb / ods —— calamine `open_workbook_auto` 自动判别
/// - **csv / tsv** —— calamine 不支持，走 [`read_csv`]（P1-3a 起支持，
///   在此之前用户会被要求"先转成 xlsx"）
pub fn read_workbook(path: &str) -> Result<ExcelSummary, AppError> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "csv" || ext == "tsv" {
        return read_csv(path, if ext == "tsv" { b'\t' } else { b',' });
    }

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
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| AppError::Custom(format!("读取 Sheet 「{}」失败：{}", name, e)))?;
        // 合并单元格回填：Excel 只在左上角存值，不回填的话多行表头 / 跨行分类全是空白
        let merged = merged_regions_of(&mut workbook, &name);
        let (headers, all_rows) = range_to_rows(&range, &merged);
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

/// 读取 CSV / TSV 为单 Sheet 快照。
///
/// 两个决定：
/// - **编码先嗅探再解析**：国内导出的 CSV 大量是 GBK / GB18030，直接按 UTF-8 读会满屏乱码。
///   复用 `import::read_text_auto_encoding`（已含 BOM 处理）。
/// - **用 csv crate 而非 split(',')**：字段里的逗号、换行、`""` 转义引号
///   这几条 RFC 4180 规则手写必翻车（Excel 导出的 CSV 全都会用到）。
fn read_csv(path: &str, delimiter: u8) -> Result<ExcelSummary, AppError> {
    let text = crate::services::import::read_text_auto_encoding(std::path::Path::new(path))?;

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        // 不让 csv crate 自己认表头：表头由我们统一取首行，与 Excel 路径口径一致
        .has_headers(false)
        // 允许各行列数不一致 —— 真实 CSV 常有尾部空列 / 缺列，
        // 报错中断的话用户连"看一眼"都做不到
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut all: Vec<Vec<String>> = Vec::new();
    for rec in reader.records() {
        let rec = rec.map_err(|e| AppError::Custom(format!("解析 CSV 失败：{}", e)))?;
        all.push(rec.iter().map(sanitize_cell).collect());
    }

    if all.is_empty() {
        return Err(AppError::Custom("CSV 文件没有任何内容".into()));
    }
    let headers = all.remove(0);
    let total = all.len();

    let name = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("CSV")
        .to_string();

    let (kept_rows, truncated_rows) = trim_sheet_rows(&all, &headers);
    let sheets = vec![SheetSnapshot {
        name: name.clone(),
        headers,
        rows: kept_rows,
        total_rows: total,
        truncated_rows,
    }];
    let markdown = render_markdown(&sheets);
    let truncated_sheet_names = if truncated_rows > 0 { vec![name] } else { Vec::new() };

    Ok(ExcelSummary {
        sheets,
        markdown,
        total_rows: total,
        truncated_sheet_names,
    })
}

/// 文本单元格清洗：与 [`cell_to_string`] 的字符串分支保持同一口径
/// （换行压成空格、`|` 转义以免打断 markdown 表）
fn sanitize_cell(s: &str) -> String {
    s.replace('\n', " ").replace('|', "\\|").trim().to_string()
}

/// 单元格 → 字符串。布尔/数字/日期都尽量保留可读形式。
fn cell_to_string(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => sanitize_cell(s),
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
fn trim_sheet_rows(all_rows: &[Vec<String>], headers: &[String]) -> (Vec<Vec<String>>, usize) {
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
                let mut cells: Vec<String> = row.iter().take(s.headers.len()).cloned().collect();
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
        assert_eq!(cell_to_string(&Data::String("a|b".to_string())), "a\\|b");
    }

    // ─── 合并单元格回填（P1-3a）────────────────────

    fn dim(start: (u32, u32), end: (u32, u32)) -> Dimensions {
        Dimensions { start, end }
    }

    fn rows(v: &[&[&str]]) -> Vec<Vec<String>> {
        v.iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    /// 中文报表最典型的形态：表头「2024年度」横跨三列，合并后只有左上角有值。
    /// 不回填的话表头就剩一个孤零零的「2024年度」+ 两个空列。
    #[test]
    fn fills_horizontal_merged_header() {
        let mut r = rows(&[&["2024年度", "", ""], &["一月", "二月", "三月"]]);
        fill_merged_cells(&mut r, (0, 0), &[&dim((0, 0), (0, 2))]);
        assert_eq!(r[0], vec!["2024年度", "2024年度", "2024年度"]);
        // 非合并行不受影响
        assert_eq!(r[1], vec!["一月", "二月", "三月"]);
    }

    /// 跨行合并：分类列「华东」覆盖多行，只有第一行有值
    #[test]
    fn fills_vertical_merged_cells() {
        let mut r = rows(&[&["华东", "上海"], &["", "杭州"], &["", "南京"]]);
        fill_merged_cells(&mut r, (0, 0), &[&dim((0, 0), (2, 0))]);
        assert_eq!(r[0][0], "华东");
        assert_eq!(r[1][0], "华东");
        assert_eq!(r[2][0], "华东");
        // 第二列原样
        assert_eq!(r[2][1], "南京");
    }

    /// Range 有偏移时（数据不从 A1 开始）必须换算，否则会填错格子
    #[test]
    fn honors_range_offset() {
        // range 从 B2 开始 → start = (1, 1)
        let mut r = rows(&[&["合并值", ""], &["a", "b"]]);
        // 绝对坐标 B2:C2 = ((1,1),(1,2))
        fill_merged_cells(&mut r, (1, 1), &[&dim((1, 1), (1, 2))]);
        assert_eq!(r[0], vec!["合并值", "合并值"]);
    }

    #[test]
    fn ignores_empty_anchor_and_out_of_range() {
        // 左上角本来就空 → 不铺开一片空串（没意义）
        let mut r = rows(&[&["", ""], &["a", "b"]]);
        fill_merged_cells(&mut r, (0, 0), &[&dim((0, 0), (0, 1))]);
        assert_eq!(r[0], vec!["", ""]);

        // 区域落在 range 之外 → 跳过而不是 panic
        let mut r2 = rows(&[&["x"]]);
        fill_merged_cells(&mut r2, (5, 5), &[&dim((0, 0), (0, 1))]);
        assert_eq!(r2[0], vec!["x"]);
    }

    #[test]
    fn does_not_overwrite_existing_values() {
        // 防御脏文件：合并区域里已有内容的格子不该被覆盖
        let mut r = rows(&[&["主", "已有"]]);
        fill_merged_cells(&mut r, (0, 0), &[&dim((0, 0), (0, 1))]);
        assert_eq!(r[0], vec!["主", "已有"]);
    }

    // ─── CSV 解析（P1-3a）──────────────────────────

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_csv_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn reads_csv_with_quoted_fields() {
        // 引号内含逗号 —— 手写 split(',') 必翻车的经典场景
        let csv = "名称,备注,数量\n螺丝,\"红色,大号\",10\n螺母,普通,20\n";
        let p = write_temp("t.csv", csv.as_bytes());
        let s = read_workbook(p.to_str().unwrap()).unwrap();
        assert_eq!(s.sheets.len(), 1);
        assert_eq!(s.sheets[0].headers, vec!["名称", "备注", "数量"]);
        assert_eq!(s.total_rows, 2);
        assert_eq!(s.sheets[0].rows[0][1], "红色,大号", "引号内的逗号不该被切开");
    }

    #[test]
    fn reads_csv_with_gbk_encoding() {
        // 国内导出的 CSV 大量是 GBK，按 UTF-8 硬读会满屏乱码
        let (bytes, _, _) = encoding_rs::GBK.encode("城市,人口\n北京,2189\n");
        let p = write_temp("gbk.csv", &bytes);
        let s = read_workbook(p.to_str().unwrap()).unwrap();
        assert_eq!(s.sheets[0].headers, vec!["城市", "人口"]);
        assert_eq!(s.sheets[0].rows[0][0], "北京");
    }

    #[test]
    fn reads_tsv_with_tab_delimiter() {
        let p = write_temp("t.tsv", b"a\tb\n1\t2\n");
        let s = read_workbook(p.to_str().unwrap()).unwrap();
        assert_eq!(s.sheets[0].headers, vec!["a", "b"]);
        assert_eq!(s.sheets[0].rows[0], vec!["1", "2"]);
    }

    #[test]
    fn csv_tolerates_ragged_rows() {
        // 真实 CSV 常有缺列 / 多列，不该直接报错让用户连看都看不了
        let p = write_temp("ragged.csv", b"a,b,c\n1,2\n3,4,5,6\n");
        let s = read_workbook(p.to_str().unwrap()).unwrap();
        assert_eq!(s.total_rows, 2);
    }

    #[test]
    fn empty_csv_reports_error() {
        let p = write_temp("empty.csv", b"");
        assert!(read_workbook(p.to_str().unwrap()).is_err());
    }


    /// 端到端：真实 xlsx 文件的合并单元格必须被回填。
    ///
    /// 纯函数测试覆盖不到 calamine 的坐标系与 API 用法
    /// （`merged_regions()` 未加载会 panic、Range 可能带偏移），
    /// 所以用一个真文件跑通整条链路。标 ignore 是因为它依赖外部生成的样本文件，
    /// 跑法：先用 openpyxl 造出 %TEMP%/kb_merged_test.xlsx，再
    /// `cargo test -- e2e_merged_xlsx --ignored`。
    #[test]
    #[ignore = "依赖外部生成的 xlsx 样本，手动验证用"]
    fn e2e_merged_xlsx() {
        let p = std::env::temp_dir().join("kb_merged_test.xlsx");
        assert!(p.exists(), "样本文件不存在: {:?}", p);
        let s = read_workbook(p.to_str().unwrap()).unwrap();
        let sheet = &s.sheets[0];
        // A1:C1 横向合并 → 表头三列都应是「2024年度」
        assert_eq!(
            sheet.headers,
            vec!["2024年度", "2024年度", "2024年度"],
            "横向合并的表头未回填"
        );
        // A3:A5 纵向合并 → 第 1 列连续三行都应是「华东」
        assert_eq!(sheet.rows[1][0], "华东", "纵向合并未回填: {:?}", sheet.rows);
        assert_eq!(sheet.rows[2][0], "华东");
    }

    #[test]
    fn render_small_sheet() {
        let s = SheetSnapshot {
            name: "测试".into(),
            headers: vec!["列A".into(), "列B".into()],
            rows: vec![vec!["1".into(), "x".into()], vec!["2".into(), "y".into()]],
            total_rows: 2,
            truncated_rows: 0,
        };
        let md = render_markdown(&[s]);
        assert!(md.contains("## Sheet: 测试"));
        assert!(md.contains("| 列A | 列B |"));
        assert!(md.contains("| 1 | x |"));
    }
}
