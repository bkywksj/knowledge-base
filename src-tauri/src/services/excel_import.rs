//! Excel / ODS / CSV 导入为笔记（仅桌面端：依赖 calamine）。
//!
//! 一个文件 = 一篇笔记：标题取文件名，正文按工作表分段、每段一张 GFM 表格，
//! 原文件拷进 `sources/` 并记为笔记的源文件（编辑器顶部可一键用系统应用打开）。
//!
//! # 为什么正文要限行
//!
//! 几千行的表整张转 markdown 塞进笔记，编辑器渲染和全文索引都会明显变慢，
//! 而笔记正文本来就不是看大表的地方。所以每个工作表只放前 [`MAX_ROWS_PER_SHEET`] 行，
//! 被截掉的行数**明确写进正文**（不静默丢），完整数据留在源文件里。

use std::path::Path;

use serde::Serialize;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ImportProgress, Note, NoteInput};
use crate::services::excel_parser::{self, SheetSnapshot};
use crate::services::source_file::SourceFileService;

/// 每个工作表正文最多放多少行数据（不含表头）。
pub const MAX_ROWS_PER_SHEET: usize = 500;

/// 支持导入的扩展名（小写），与 `excel_parser::read_workbook` 能读的格式一致。
pub const EXCEL_EXTENSIONS: [&str; 7] = ["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"];

/// 单个文件的导入结果，供前端展示进度 / 错误清单。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelImportResult {
    pub source_path: String,
    /// 成功：对应的笔记 id；失败：None
    pub note_id: Option<i64>,
    /// 成功：笔记标题；失败：None
    pub title: Option<String>,
    /// 失败时的错误消息
    pub error: Option<String>,
    /// 因行数超限被截断的工作表名（正文不全，完整数据在源文件里）
    pub truncated_sheets: Vec<String>,
}

pub struct ExcelImportService;

impl ExcelImportService {
    /// 导入单个表格文件，返回新笔记和被截断的工作表名。
    pub fn import_one(
        app_data_dir: &Path,
        db: &Database,
        source_path: &str,
        folder_id: Option<i64>,
    ) -> Result<(Note, Vec<String>), AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!(
                "文件不存在: {}",
                source_path
            )));
        }
        let ext = source
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !EXCEL_EXTENSIONS.contains(&ext.as_str()) {
            return Err(AppError::Custom(format!(
                "不支持的文件类型「.{}」（仅支持 {}）",
                ext,
                EXCEL_EXTENSIONS.join(" / ")
            )));
        }

        // Full：一行不丢（正文限行由本模块自己负责，并在正文里写明）
        let summary = excel_parser::read_workbook_full(source_path)?;
        if summary.sheets.iter().all(|s| s.headers.is_empty()) {
            return Err(AppError::Custom("文件里没有任何数据（所有工作表都是空的）".into()));
        }

        let title = source
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "未命名表格".to_string());
        let file_name = source
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| title.clone());

        let (content, truncated_sheets) =
            render_note_markdown(&file_name, &summary.sheets, MAX_ROWS_PER_SHEET);

        let note = db.create_note(&NoteInput {
            title,
            content,
            folder_id,
        })?;

        // 原文件落盘失败不让导入失败：笔记已建好，只是少了「打开源文件」入口（同 PDF 导入）
        match SourceFileService::attach(app_data_dir, note.id, source, &ext) {
            Ok(rel) => db.set_note_source_file(note.id, Some(&rel), Some(&ext))?,
            Err(e) => log::warn!("表格源文件拷贝失败（笔记已建）: {}", e),
        }

        let note = db
            .get_note(note.id)?
            .ok_or_else(|| AppError::NotFound("刚创建的笔记查询失败".into()))?;
        Ok((note, truncated_sheets))
    }

    /// 批量导入，逐个独立处理，单个失败不影响其他。
    ///
    /// 每开始处理一个文件发一条 `excel:import-progress`。用独立事件名，
    /// 避免与 markdown / PDF 导入的进度事件互相串数字（理由同 PDF）。
    /// 事件尽力而为（`let _ =`）：发不出去只是没进度，不该让导入本身失败。
    pub fn import_many<R: tauri::Runtime, E: tauri::Emitter<R>>(
        app_data_dir: &Path,
        db: &Database,
        source_paths: &[String],
        folder_id: Option<i64>,
        emitter: &E,
    ) -> Vec<ExcelImportResult> {
        let total = source_paths.len();
        source_paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let _ = emitter.emit(
                    "excel:import-progress",
                    ImportProgress {
                        current: i + 1,
                        total,
                        file_name: Path::new(p)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or(p)
                            .to_string(),
                    },
                );
                match Self::import_one(app_data_dir, db, p, folder_id) {
                    Ok((note, truncated_sheets)) => ExcelImportResult {
                        source_path: p.clone(),
                        note_id: Some(note.id),
                        title: Some(note.title),
                        error: None,
                        truncated_sheets,
                    },
                    Err(e) => ExcelImportResult {
                        source_path: p.clone(),
                        note_id: None,
                        title: None,
                        error: Some(e.to_string()),
                        truncated_sheets: Vec::new(),
                    },
                }
            })
            .collect()
    }
}

/// 把各工作表渲染成笔记正文（Markdown），返回 (正文, 被截断的工作表名)。
///
/// 正文是 Markdown 而不是 HTML：编辑器用 tiptap-markdown 加载，GFM 管道表格可直接还原成表格。
pub fn render_note_markdown(
    file_name: &str,
    sheets: &[SheetSnapshot],
    max_rows: usize,
) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut truncated = Vec::new();

    out.push_str(&format!(
        "> 导入自 {}，共 {} 个工作表。\n\n",
        escape_md(file_name),
        sheets.len()
    ));

    for sheet in sheets {
        out.push_str(&format!("## {}\n\n", escape_md(&sheet.name)));

        if sheet.headers.is_empty() {
            out.push_str("（空表）\n\n");
            continue;
        }

        let shown = sheet.rows.len().min(max_rows);
        // total_rows 是数据行总数（不含表头）；大于 shown 说明正文没放全
        if sheet.total_rows > shown {
            truncated.push(sheet.name.clone());
            out.push_str(&format!(
                "> 共 {} 行，正文仅显示前 {} 行，完整数据请打开源文件查看。\n\n",
                sheet.total_rows, shown
            ));
        }

        let rows = &sheet.rows[..shown];
        // 个别行比表头长时按最宽的算，免得多出来的单元格被静默吞掉
        let cols = rows
            .iter()
            .map(|r| r.len())
            .max()
            .unwrap_or(0)
            .max(sheet.headers.len());

        push_row(&mut out, &sheet.headers, cols);
        out.push('|');
        for _ in 0..cols {
            out.push_str("---|");
        }
        out.push('\n');
        for row in rows {
            push_row(&mut out, row, cols);
        }
        out.push('\n');
    }

    (out, truncated)
}

/// 输出一行表格：不足 `cols` 列用空单元格补齐。
fn push_row(out: &mut String, cells: &[String], cols: usize) {
    out.push('|');
    for i in 0..cols {
        out.push(' ');
        if let Some(c) = cells.get(i) {
            out.push_str(&escape_md(&restore_pipes(c)));
        }
        out.push_str(" |");
    }
    out.push('\n');
}

/// 还原解析器给 `|` 加的转义。
///
/// `excel_parser::sanitize_cell` 为了喂 LLM 的 markdown 表，读单元格时就把 `|` 换成了 `\|`。
/// 这里不还原的话，`a|b` 会被本模块再转义一遍变成 `a\\\|b`，显示出来多出反斜杠。
/// 解析器的转换对每个 `|` 都恰好前置一个 `\`，所以这个逆操作对任意输入都无歧义。
fn restore_pipes(s: &str) -> String {
    s.replace("\\|", "|")
}

/// 转义 Markdown 元字符，并把单元格内换行换成 `<br>`。
///
/// 不转义的后果是**数据被改写**：`a|b` 会撑破表格列，`2024_01_02` 里的下划线可能被吃成斜体，
/// `a*b*c` 的星号会消失 —— 而用户一保存，被吃掉的字符就永久丢了。
/// 编辑器配了 `html: true`，所以 `<br>` 能在表格单元格里正常换行。
fn escape_md(s: &str) -> String {
    let normalized = s.trim().replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        match ch {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '&' | '|' | '~' => {
                out.push('\\');
                out.push(ch);
            }
            '\n' => out.push_str("<br>"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(name: &str, headers: &[&str], rows: &[&[&str]], total: usize) -> SheetSnapshot {
        SheetSnapshot {
            name: name.to_string(),
            headers: headers.iter().map(|s| s.to_string()).collect(),
            rows: rows
                .iter()
                .map(|r| r.iter().map(|s| s.to_string()).collect())
                .collect(),
            total_rows: total,
            truncated_rows: 0,
        }
    }

    #[test]
    fn 管道符_星号_下划线都被转义_换行变br() {
        assert_eq!(escape_md("a|b"), "a\\|b");
        assert_eq!(escape_md("a*b*c"), "a\\*b\\*c");
        assert_eq!(escape_md("2024_01_02"), "2024\\_01\\_02");
        assert_eq!(escape_md("第一行\r\n第二行"), "第一行<br>第二行");
        assert_eq!(escape_md("C:\\dir"), "C:\\\\dir");
    }

    #[test]
    fn 正常表格渲染成_gfm_表且不报截断() {
        let s = sheet("Sheet1", &["姓名", "年龄"], &[&["张三", "20"], &["李四", "30"]], 2);
        let (md, truncated) = render_note_markdown("a.xlsx", &[s], 500);
        assert!(truncated.is_empty());
        assert!(md.contains("## Sheet1"));
        assert!(md.contains("| 姓名 | 年龄 |\n|---|---|\n| 张三 | 20 |\n| 李四 | 30 |"));
        assert!(!md.contains("正文仅显示"));
    }

    #[test]
    fn 超过上限只放前_n_行并在正文写明总行数() {
        let rows: Vec<Vec<&str>> = (0..10).map(|_| vec!["x"]).collect();
        let row_refs: Vec<&[&str]> = rows.iter().map(|r| r.as_slice()).collect();
        let s = sheet("大表", &["列"], &row_refs, 2208);
        let (md, truncated) = render_note_markdown("a.xlsx", &[s], 3);
        assert_eq!(truncated, vec!["大表".to_string()]);
        assert!(md.contains("共 2208 行，正文仅显示前 3 行"));
        // 表头 + 分隔 + 3 行数据
        assert_eq!(md.matches("| x |").count(), 3);
    }

    #[test]
    fn 行比表头宽时按最宽列补齐_不吞数据() {
        let s = sheet("S", &["A"], &[&["1", "2", "3"], &["4"]], 2);
        let (md, _) = render_note_markdown("a.xlsx", &[s], 500);
        assert!(md.contains("| A |  |  |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 |  |  |"));
    }

    #[test]
    fn 解析器已转义的管道符不会被二次转义() {
        // 解析器输出的 `a|b` 是 `a\|b`；原文里本来就带反斜杠的 `a\|b` 是 `a\\|b`
        let s = sheet("S", &["列"], &[&["a\\|b"], &["a\\\\|b"]], 2);
        let (md, _) = render_note_markdown("a.xlsx", &[s], 500);
        assert!(md.contains("| a\\|b |"), "正文: {}", md);
        assert!(md.contains("| a\\\\\\|b |"), "正文: {}", md);
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_xlsimp_{}_{}_{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn csv_端到端_建笔记_落盘源文件_记源文件类型() {
        let dir = temp_dir("e2e");
        let db = Database::init(dir.join("test.db").to_str().unwrap()).expect("init test db");
        let csv = dir.join("销售报表.csv");
        std::fs::write(&csv, "姓名,备注\n张三,a|b\n李四,2024_01\n").unwrap();

        let (note, truncated) =
            ExcelImportService::import_one(&dir, &db, csv.to_str().unwrap(), None).unwrap();

        assert!(truncated.is_empty());
        assert_eq!(note.title, "销售报表");
        assert!(note.content.contains("| 姓名 | 备注 |"), "正文: {}", note.content);
        assert!(note.content.contains("a\\|b"), "管道符应被转义: {}", note.content);
        assert_eq!(note.source_file_type.as_deref(), Some("csv"));
        let rel = note.source_file_path.expect("应记录源文件路径");
        assert!(dir.join(&rel).exists(), "源文件应已拷进 sources/: {}", rel);
    }

    #[test]
    fn 不支持的扩展名和不存在的文件都报错而不是建空笔记() {
        let dir = temp_dir("err");
        let db = Database::init(dir.join("test.db").to_str().unwrap()).expect("init test db");
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        assert!(ExcelImportService::import_one(&dir, &db, txt.to_str().unwrap(), None).is_err());
        assert!(ExcelImportService::import_one(&dir, &db, "Z:/不存在.xlsx", None).is_err());
    }

    #[test]
    fn 空表输出占位文字() {
        let s = sheet("空", &[], &[], 0);
        let (md, truncated) = render_note_markdown("a.xlsx", &[s], 500);
        assert!(truncated.is_empty());
        assert!(md.contains("（空表）"));
    }
}
