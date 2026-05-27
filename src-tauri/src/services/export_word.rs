//! T-020 笔记导出为 Word（.docx）
//!
//! 设计：
//! - 用 `pulldown-cmark` 解析 markdown（项目已装），事件驱动地映射到 docx 元素
//! - 用 `docx-rs` 生成 .docx 文件
//! - 图片：识别 markdown 中的 ![](url)，对 asset:// / 本地相对路径 / 绝对路径都尝试解析为字节嵌入；
//!   失败的图片保留 alt 文本（不报错）
//!
//! 不在 v1：
//! - LaTeX 公式 `$$...$$` → 当作 plain text 段落
//! - 任务列表 `- [ ]` → 当成普通列表
//! - 嵌套表格 → 拍平为段落
//! - 复杂 inline 样式组合（粗体+斜体+链接交错）→ 简化处理

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use docx_rs::*;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::error::AppError;
use crate::services::asset_path::resolve_content_url;
use crate::services::converter::{self, DocConverter};
use crate::services::export_html::HtmlExportService;
use crate::services::markdown::html_to_markdown;

/// GFM 扩展开关（表格 / 删除线 / 任务列表）。
///
/// 笔记内容是 tiptap-markdown 产出的「Markdown 夹 HTML」混合体——管道表格、删除线、
/// 任务列表都可能出现，必须开启这些扩展，否则会被当成普通段落文本。
fn gfm_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts
}

/// 原生回退路径里「HTML 块 → Markdown」递归展开的最大深度，防呆护栏：
/// 万一 html2md 产出仍含 raw HTML、再被 pulldown 当 HTML 块吐回来，
/// 到达深度上限后直接按纯文本落盘，杜绝无限递归。
const MAX_HTML_FLUSH_DEPTH: u32 = 4;

/// 导出结果
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExportResult {
    pub file_path: String,
    pub images_embedded: usize,
    pub images_missing: usize,
    /// 拷贝到 `<docx 同名>.attachments/` 目录里的非图片附件数（docx 装不下任意文件，只能旁挂）
    pub attachments_copied: usize,
}

pub struct WordExportService;

impl WordExportService {
    /// 导出单条笔记为 .docx —— 尽力而为（hybrid）策略：
    ///
    /// 1. **优先走系统转换器**（LibreOffice / Word / WPS）：先用 `export_html` 把笔记渲染成
    ///    自包含 HTML（表格/分栏/Callout/图片/样式全保真），再交给转换器转成 docx。保真度最高。
    /// 2. **无转换器或转换失败时回退到原生 docx 生成**（`export_single`）：纯 Rust、零外部依赖、
    ///    离线可用，但复杂结构（嵌套分栏/自定义样式）会被简化。
    ///
    /// 这样：装了 Office/WPS/LibreOffice 的机器拿到高保真结果，裸机也至少能把
    /// 文字 + 表格 + 图片 + 列表导出来，不再「只剩标题」。
    pub fn export_single_best_effort(
        title: &str,
        content: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        if converter::detect_converter() != DocConverter::None {
            match Self::export_via_converter(title, content, target_path, assets_root) {
                Ok(result) => return Ok(result),
                Err(e) => {
                    log::warn!("Word 导出：转换器路径失败，回退原生 docx 生成：{}", e);
                }
            }
        }
        Self::export_single(title, content, target_path, assets_root)
    }

    /// 转换器路径：笔记 → 自包含 HTML → 系统转换器 → docx → 拷到用户目标路径。
    fn export_via_converter(
        title: &str,
        content: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        // 渲染为自包含 HTML（图片已内嵌为 base64 data: URL）
        let (html, images_inlined, images_missing) =
            HtmlExportService::render_html(title, content, assets_root)?;

        // 临时工作目录用纯 ASCII 路径与文件名，规避部分转换器对非 ASCII 路径的兼容问题
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp_dir = std::env::temp_dir().join(format!("kb_word_export_{}", nanos));
        std::fs::create_dir_all(&tmp_dir)?;
        let tmp_html = tmp_dir.join("note.html");
        std::fs::write(&tmp_html, html.as_bytes())?;

        // HTML → docx（产物固定为 <tmp_dir>/note.docx）
        let convert_result = converter::convert_to_docx(&tmp_html, &tmp_dir);
        let produced = match convert_result {
            Ok(p) => p,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(e);
            }
        };

        // 拷到用户在 save dialog 选定的最终路径
        let copy_result = std::fs::copy(&produced, target_path);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        copy_result.map_err(|e| AppError::Custom(format!("写 docx 失败: {}", e)))?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: images_inlined,
            images_missing,
            // 转换器路径下图片已内嵌进 HTML/docx，无旁挂附件
            attachments_copied: 0,
        })
    }

    /// 原生 docx 生成（回退路径）：用 `pulldown-cmark` 解析「Markdown 夹 HTML」内容，
    /// 事件驱动地映射到 docx 元素。
    ///
    /// `assets_root` 是 kb_assets 目录的绝对路径（用于解析相对图片路径）；
    /// 不存在时所有非绝对路径图片都会算"缺失"。
    pub fn export_single(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        let mut docx = Docx::new();

        // 标题（H1 大字号）
        if !title.is_empty() {
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Heading1")
                    .add_run(Run::new().add_text(title).size(48).bold()),
            );
        }

        let mut state = RenderState::new(assets_root.to_path_buf());

        // 走统一的事件驱动器：它会在遇到非 HTML 事件前先 flush 累积的 HTML 块
        drive_parser(markdown, &mut state, &mut docx)?;

        // flush 收尾：剩余 HTML 块 + 最后一个段落
        flush_html_buffer(&mut state, &mut docx)?;
        state.flush_paragraph(&mut docx);

        // ── 附件打包 ──
        // docx 容器塞不进任意文件，所以走"旁挂"：把笔记里指向本地文件的链接对应的文件
        // 拷到 `<目标 docx 同名>.attachments/` 目录，并在文档末尾追加一个「📎 附件」清单
        // （写明每个附件在旁挂目录里的相对路径）。
        let attachments_copied = pack_attachments(markdown, target_path, assets_root, &mut docx)?;

        // 写文件
        let file = std::fs::File::create(target_path)?;
        docx.build()
            .pack(file)
            .map_err(|e| AppError::Custom(format!("写 docx 失败: {}", e)))?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: state.images_embedded,
            images_missing: state.images_missing,
            attachments_copied,
        })
    }
}

/// 渲染期累计状态：当前段落构造中的 runs + 样式开关 + 图片统计
struct RenderState {
    /// 当前段落正在累积的 runs
    pending_runs: Vec<Run>,
    /// inline 样式栈
    bold: u32,
    italic: u32,
    strikethrough: u32,
    code: u32,
    /// 链接 url（出现 Tag::Link 时压入；EndTag 时弹出）
    link_url: Option<String>,
    /// 标题级别（None = 普通段落）
    current_heading: Option<HeadingLevel>,
    /// 在代码块内
    in_code_block: bool,
    code_block_lang: String,
    code_block_content: String,
    /// 在引用内（Blockquote）
    in_blockquote: bool,
    /// 列表层级（嵌套深度）+ 当前是有序列表？
    list_stack: Vec<bool>,
    /// 当前列表项编号（按层级）
    list_counters: Vec<u32>,
    /// 表格状态
    in_table: bool,
    table_rows: Vec<TableRow>,
    current_row_cells: Vec<TableCell>,
    current_cell_text: String,

    /// 累积当前连续的 raw HTML 块（pulldown-cmark 可能把一段 HTML 拆成多个 Event::Html）。
    /// 遇到下一个非 HTML 事件时统一冲刷：html2md 转成 Markdown 后递归喂回解析器。
    html_buffer: String,
    /// HTML 块递归展开深度（防呆，配合 `MAX_HTML_FLUSH_DEPTH`）
    html_flush_depth: u32,

    /// 图片解析根
    assets_root: PathBuf,
    images_embedded: usize,
    images_missing: usize,
}

impl RenderState {
    fn new(assets_root: PathBuf) -> Self {
        Self {
            pending_runs: Vec::new(),
            bold: 0,
            italic: 0,
            strikethrough: 0,
            code: 0,
            link_url: None,
            current_heading: None,
            in_code_block: false,
            code_block_lang: String::new(),
            code_block_content: String::new(),
            in_blockquote: false,
            list_stack: Vec::new(),
            list_counters: Vec::new(),
            in_table: false,
            table_rows: Vec::new(),
            current_row_cells: Vec::new(),
            current_cell_text: String::new(),
            html_buffer: String::new(),
            html_flush_depth: 0,
            assets_root,
            images_embedded: 0,
            images_missing: 0,
        }
    }

    /// 把"当前累积的 runs"打包成段落 push 到 docx
    fn flush_paragraph(&mut self, docx: &mut Docx) {
        if self.pending_runs.is_empty() {
            return;
        }
        let mut p = Paragraph::new();
        if let Some(level) = self.current_heading {
            let style = match level {
                HeadingLevel::H1 => "Heading1",
                HeadingLevel::H2 => "Heading2",
                HeadingLevel::H3 => "Heading3",
                HeadingLevel::H4 => "Heading4",
                HeadingLevel::H5 => "Heading5",
                HeadingLevel::H6 => "Heading6",
            };
            p = p.style(style);
        }
        if self.in_blockquote {
            // 引用：左缩进 + 灰色 + 斜体感
            p = p.indent(Some(720), None, None, None);
        }
        // 列表前缀（手动加，简化版）
        if let Some(&ordered) = self.list_stack.last() {
            let depth = self.list_stack.len();
            let indent = (depth as i32) * 360;
            p = p.indent(Some(indent), None, None, None);
            let prefix = if ordered {
                let n = self.list_counters.last().copied().unwrap_or(1);
                format!("{}. ", n)
            } else {
                "• ".to_string()
            };
            // 在第一个 run 前插一个 prefix run
            let prefix_run = Run::new().add_text(prefix);
            self.pending_runs.insert(0, prefix_run);
        }
        for r in self.pending_runs.drain(..) {
            p = p.add_run(r);
        }
        let _ = std::mem::replace(&mut self.pending_runs, Vec::new());
        *docx = std::mem::take(docx).add_paragraph(p);
    }

    fn make_run(&self, text: &str) -> Run {
        let mut r = Run::new().add_text(text);
        if self.bold > 0 {
            r = r.bold();
        }
        if self.italic > 0 {
            r = r.italic();
        }
        if self.strikethrough > 0 {
            r = r.strike();
        }
        if self.code > 0 {
            r = r.fonts(
                RunFonts::new()
                    .east_asia("Courier New")
                    .ascii("Courier New"),
            );
            r = r.color("c7254e");
        }
        if self.link_url.is_some() {
            r = r.color("0563c1").underline("single");
        }
        r
    }
}

/// 统一事件驱动器：解析 `markdown`（开 GFM 扩展），逐事件喂给 `handle_event`。
///
/// 关键点：在处理任何**非 HTML 事件**之前，先 flush 已累积的 HTML 块——保证
/// 「HTML 块里的内容」与「前后 Markdown 内容」在 docx 里的先后顺序正确。
fn drive_parser(markdown: &str, state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    let parser = Parser::new_ext(markdown, gfm_options());
    for event in parser {
        if !matches!(event, Event::Html(_)) {
            flush_html_buffer(state, docx)?;
        }
        handle_event(event, state, docx)?;
    }
    Ok(())
}

/// 冲刷累积的 raw HTML 块：html2md 转成 Markdown 后递归喂回 `drive_parser`，
/// 从而把表格 `<table>`、图片 `<figure><img>`、分栏 `<div data-type=columns>` 等
/// tiptap-markdown 退化成 HTML 的结构，重新还原成 docx 元素。
fn flush_html_buffer(state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    if state.html_buffer.is_empty() {
        return Ok(());
    }
    let html = std::mem::take(&mut state.html_buffer);

    // 防呆：递归过深直接按纯文本落盘，杜绝 html2md ↔ pulldown 之间反复横跳
    if state.html_flush_depth >= MAX_HTML_FLUSH_DEPTH {
        let text = strip_html_tags(&html);
        if !text.trim().is_empty() {
            *docx = std::mem::take(docx)
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(text)));
        }
        return Ok(());
    }

    let md = html_to_markdown(&html);
    if md.trim().is_empty() {
        // 纯标签（如孤立的 <span> / <br>）转换后为空，跳过即可（被包裹文本已另行渲染）
        return Ok(());
    }

    state.html_flush_depth += 1;
    drive_parser(&md, state, docx)?;
    flush_html_buffer(state, docx)?; // 排空本层递归过程中再次累积的 HTML
    state.flush_paragraph(docx);
    state.html_flush_depth -= 1;
    Ok(())
}

/// 极简去标签：把 `<...>` 全部抹掉，仅保留可见文本。
/// 仅用于递归护栏触发时的兜底，正常路径不会走到。
fn strip_html_tags(html: &str) -> String {
    match regex::Regex::new(r"<[^>]+>") {
        Ok(re) => re.replace_all(html, "").trim().to_string(),
        Err(_) => html.to_string(),
    }
}

fn handle_event(event: Event, state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    match event {
        // ── 段落 ──
        Event::Start(Tag::Paragraph) => {}
        Event::End(TagEnd::Paragraph) => {
            state.flush_paragraph(docx);
        }

        // ── 标题 ──
        Event::Start(Tag::Heading { level, .. }) => {
            state.current_heading = Some(level);
        }
        Event::End(TagEnd::Heading(_)) => {
            state.flush_paragraph(docx);
            state.current_heading = None;
        }

        // ── 文本 ──
        Event::Text(t) => {
            if state.in_code_block {
                state.code_block_content.push_str(&t);
            } else if state.in_table {
                state.current_cell_text.push_str(&t);
            } else {
                let run = state.make_run(&t);
                state.pending_runs.push(run);
            }
        }
        Event::Code(t) => {
            // 行内代码
            state.code += 1;
            let run = state.make_run(&t);
            state.pending_runs.push(run);
            state.code -= 1;
        }

        // ── inline 样式 ──
        Event::Start(Tag::Strong) => state.bold += 1,
        Event::End(TagEnd::Strong) => {
            state.bold = state.bold.saturating_sub(1);
        }
        Event::Start(Tag::Emphasis) => state.italic += 1,
        Event::End(TagEnd::Emphasis) => {
            state.italic = state.italic.saturating_sub(1);
        }
        Event::Start(Tag::Strikethrough) => state.strikethrough += 1,
        Event::End(TagEnd::Strikethrough) => {
            state.strikethrough = state.strikethrough.saturating_sub(1);
        }
        Event::Start(Tag::Link { dest_url, .. }) => {
            state.link_url = Some(dest_url.into_string());
        }
        Event::End(TagEnd::Link) => {
            state.link_url = None;
        }

        // ── 代码块 ──
        Event::Start(Tag::CodeBlock(kind)) => {
            state.in_code_block = true;
            state.code_block_lang = match kind {
                CodeBlockKind::Fenced(lang) => lang.into_string(),
                CodeBlockKind::Indented => String::new(),
            };
            state.code_block_content.clear();
        }
        Event::End(TagEnd::CodeBlock) => {
            state.flush_paragraph(docx); // 先冲掉之前的内容
                                         // 整个代码块当作一个等宽字体段落，灰底（手工 shading）
            let content = std::mem::take(&mut state.code_block_content);
            for line in content.lines() {
                let p = Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(line)
                            .fonts(
                                RunFonts::new()
                                    .east_asia("Courier New")
                                    .ascii("Courier New"),
                            )
                            .size(20),
                    )
                    .indent(Some(360), None, None, None);
                *docx = std::mem::take(docx).add_paragraph(p);
            }
            state.in_code_block = false;
        }

        // ── 引用 ──
        Event::Start(Tag::BlockQuote(_)) => {
            state.in_blockquote = true;
        }
        Event::End(TagEnd::BlockQuote(_)) => {
            state.in_blockquote = false;
        }

        // ── 列表 ──
        Event::Start(Tag::List(start)) => {
            state.list_stack.push(start.is_some());
            state.list_counters.push(start.unwrap_or(1) as u32);
        }
        Event::End(TagEnd::List(_)) => {
            state.list_stack.pop();
            state.list_counters.pop();
        }
        Event::Start(Tag::Item) => {}
        Event::End(TagEnd::Item) => {
            state.flush_paragraph(docx);
            // 有序列表自增
            if let Some(true) = state.list_stack.last() {
                if let Some(c) = state.list_counters.last_mut() {
                    *c += 1;
                }
            }
        }

        // ── 图片 ──
        Event::Start(Tag::Image {
            dest_url, title: _, ..
        }) => {
            // 先冲段落（避免图片插入与文本交错）
            state.flush_paragraph(docx);
            let url = dest_url.into_string();
            match resolve_image(&url, &state.assets_root) {
                Some(bytes) => {
                    // 读图片真实像素 → 按 A4 可用宽度等比缩放，保留原宽高比。
                    // 旧实现硬编码 4_000_000 × 3_000_000 EMU（4:3），导致竖图 / 16:9 横图被拉伸变形。
                    let (w_emu, h_emu) = compute_image_emu(&bytes);
                    let pic = Pic::new(&bytes).size(w_emu, h_emu);
                    let p = Paragraph::new().add_run(Run::new().add_image(pic));
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_embedded += 1;
                }
                None => {
                    // 缺失：插入占位文本
                    let p = Paragraph::new().add_run(
                        Run::new()
                            .add_text(format!("[图片缺失: {}]", url))
                            .italic()
                            .color("999999"),
                    );
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_missing += 1;
                }
            }
        }
        Event::End(TagEnd::Image) => {}

        // ── 表格（v1 简化：单元格只取纯文本） ──
        Event::Start(Tag::Table(_)) => {
            state.flush_paragraph(docx);
            state.in_table = true;
            state.table_rows = Vec::new();
        }
        Event::End(TagEnd::Table) => {
            if !state.table_rows.is_empty() {
                let rows = std::mem::take(&mut state.table_rows);
                let table = Table::new(rows);
                *docx = std::mem::take(docx).add_table(table);
                // 表格后插一个空段，避免下一个块紧贴表格底
                *docx = std::mem::take(docx).add_paragraph(Paragraph::new());
            }
            state.in_table = false;
        }
        Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {
            state.current_row_cells = Vec::new();
        }
        Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
            let cells = std::mem::take(&mut state.current_row_cells);
            if !cells.is_empty() {
                state.table_rows.push(TableRow::new(cells));
            }
        }
        Event::Start(Tag::TableCell) => {
            state.current_cell_text.clear();
        }
        Event::End(TagEnd::TableCell) => {
            let text = std::mem::take(&mut state.current_cell_text);
            let cell =
                TableCell::new().add_paragraph(Paragraph::new().add_run(Run::new().add_text(text)));
            state.current_row_cells.push(cell);
        }

        // ── 软换行 / 硬换行 ──
        Event::SoftBreak => {
            state.pending_runs.push(Run::new().add_text(" "));
        }
        Event::HardBreak => {
            state
                .pending_runs
                .push(Run::new().add_break(BreakType::TextWrapping));
        }

        // ── 水平线 ──
        Event::Rule => {
            state.flush_paragraph(docx);
            *docx = std::mem::take(docx)
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text("─".repeat(40))));
        }

        // ── raw HTML ──
        Event::Html(t) => {
            // 块级 HTML：先冲掉当前段落，再累积到 html_buffer，
            // 由 drive_parser/flush_html_buffer 统一交给 html2md 还原（表格/图片/分栏等）
            state.flush_paragraph(docx);
            state.html_buffer.push_str(&t);
        }
        Event::InlineHtml(_) => {
            // 内联 HTML 标签（如 <span> / </span>）：忽略标签本身，
            // 被它包裹的文本会以独立的 Event::Text 正常渲染，不丢内容
        }
        Event::FootnoteReference(_)
        | Event::Start(Tag::FootnoteDefinition(_))
        | Event::End(TagEnd::FootnoteDefinition) => {
            // v1 不支持脚注
        }
        Event::TaskListMarker(checked) => {
            // 任务列表 [x] / [ ] → 简单插入文本
            let mark = if checked { "☑ " } else { "☐ " };
            state.pending_runs.push(Run::new().add_text(mark));
        }
        // 其它块级标签默认不需要处理
        _ => {}
    }
    Ok(())
}

/// 解析图片 url 为字节
///
/// 支持：
/// - `data:image/...;base64,...` 内嵌
/// - `kb-asset://...` / `asset://localhost/...` / `file://...` / 绝对 / 相对路径
///   （统一交给 `asset_path::resolve_content_url`）
/// - 跳过 `http(s)://` 外链（避免迁移 docx 时拉外网）
fn resolve_image(url: &str, data_dir: &Path) -> Option<Vec<u8>> {
    // data: URL
    if let Some(stripped) = url.strip_prefix("data:") {
        if let Some(idx) = stripped.find(";base64,") {
            let b64 = &stripped[idx + 8..];
            return base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok();
        }
    }
    let abs = resolve_content_url(url, data_dir)?;
    std::fs::read(&abs).ok()
}

/// 96 DPI 下 1 像素对应的 EMU（English Metric Unit）值。
/// docx 里所有尺寸都用 EMU；1 inch = 914400 EMU，标准屏 96 DPI → 914400 / 96 = 9525。
const EMU_PER_PIXEL: u64 = 9525;

/// A4 纵向页面可用宽度上限（约 14.83 cm，预留左右各 2.5 cm 边距 + 一点余量）。
/// 超过这个宽度的图片按比例缩小到此宽度。
const MAX_WIDTH_EMU: u64 = 5_400_000;

/// 单张图片高度上限（约 23.7 cm），避免一张超高竖图独占整页打断阅读。
const MAX_HEIGHT_EMU: u64 = 8_640_000;

/// 默认尺寸：图片头解析失败时兜底用的"约 11×8.3 cm 4:3"——和旧硬编码一致，
/// 保证未知格式（SVG / TIFF / 损坏文件等）至少能塞进 docx 不崩。
const DEFAULT_W_EMU: u32 = 4_000_000;
const DEFAULT_H_EMU: u32 = 3_000_000;

/// 计算图片在 docx 中应使用的 (width, height) EMU 值。
///
/// 流程：读图片像素尺寸 → 按 96 DPI 转 EMU → 超过 MAX_WIDTH / MAX_HEIGHT 则等比缩。
/// 头解析失败时返回默认 4:3 矩形（兼容旧行为，避免崩）。
fn compute_image_emu(bytes: &[u8]) -> (u32, u32) {
    let Some((w_px, h_px)) = read_image_dimensions(bytes) else {
        return (DEFAULT_W_EMU, DEFAULT_H_EMU);
    };
    if w_px == 0 || h_px == 0 {
        return (DEFAULT_W_EMU, DEFAULT_H_EMU);
    }
    let mut w_emu = (w_px as u64) * EMU_PER_PIXEL;
    let mut h_emu = (h_px as u64) * EMU_PER_PIXEL;
    // 先按宽限制
    if w_emu > MAX_WIDTH_EMU {
        h_emu = h_emu * MAX_WIDTH_EMU / w_emu;
        w_emu = MAX_WIDTH_EMU;
    }
    // 再按高限制（窄长图）
    if h_emu > MAX_HEIGHT_EMU {
        w_emu = w_emu * MAX_HEIGHT_EMU / h_emu;
        h_emu = MAX_HEIGHT_EMU;
    }
    (w_emu as u32, h_emu as u32)
}

/// 极简图片头解析：返回 (width_px, height_px)。
///
/// 仅识别 PNG / JPEG / GIF / BMP / WebP（覆盖编辑器里常见的所有格式）。
/// 不调用 image 解码 crate —— 只读 header 几十字节、零依赖、几乎零开销。
/// 不识别时返回 None，调用方走默认尺寸兜底。
fn read_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 12 {
        return None;
    }

    // PNG: 8 字节签名 + 长度(4) + "IHDR"(4) + width(4 BE) + height(4 BE)
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
            let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
            let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
            return Some((w, h));
        }
        return None;
    }

    // GIF87a / GIF89a: 6 字节签名 + width(2 LE) + height(2 LE)
    if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 10 {
        let w = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let h = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return Some((w, h));
    }

    // BMP: "BM" 后 BITMAPINFOHEADER 在偏移 14 开始；width@18(4 LE) height@22(4 LE，可负=正向存储)
    if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        let w = u32::from_le_bytes(bytes[18..22].try_into().ok()?);
        let h_signed = i32::from_le_bytes(bytes[22..26].try_into().ok()?);
        let h = h_signed.unsigned_abs();
        return Some((w, h));
    }

    // WebP: "RIFF????WEBP" + 子 chunk
    if bytes.starts_with(b"RIFF") && bytes.len() >= 30 && &bytes[8..12] == b"WEBP" {
        let chunk = &bytes[12..16];
        if chunk == b"VP8 " {
            // 有损 VP8：bytes[26..28] = width 14bit LE，bytes[28..30] = height 14bit LE
            let w = (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3FFF) as u32;
            let h = (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3FFF) as u32;
            return Some((w, h));
        }
        if chunk == b"VP8L" {
            // 无损 VP8L：signature 0x2F 后 4 字节里塞了两个 14-bit (w-1) (h-1)
            if bytes.len() >= 25 && bytes[20] == 0x2F {
                let b0 = bytes[21] as u32;
                let b1 = bytes[22] as u32;
                let b2 = bytes[23] as u32;
                let b3 = bytes[24] as u32;
                let w = (b0 | ((b1 & 0x3F) << 8)) + 1;
                let h = ((b1 >> 6) | (b2 << 2) | ((b3 & 0xF) << 10)) + 1;
                return Some((w, h));
            }
            return None;
        }
        if chunk == b"VP8X" {
            // 扩展 VP8X：bytes[24..27] = width-1 (3B LE), bytes[27..30] = height-1
            let w = ((bytes[24] as u32)
                | ((bytes[25] as u32) << 8)
                | ((bytes[26] as u32) << 16))
                + 1;
            let h = ((bytes[27] as u32)
                | ((bytes[28] as u32) << 8)
                | ((bytes[29] as u32) << 16))
                + 1;
            return Some((w, h));
        }
        return None;
    }

    // JPEG: SOI(0xFFD8) → 扫描各 segment 找 SOFn（含尺寸）
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2usize;
        while i + 1 < bytes.len() {
            // segment 必须以 0xFF 开头
            if bytes[i] != 0xFF {
                return None;
            }
            // 跳过填充 0xFF（标准允许多个 0xFF 串联）
            while i < bytes.len() && bytes[i] == 0xFF {
                i += 1;
            }
            if i >= bytes.len() {
                return None;
            }
            let marker = bytes[i];
            i += 1;
            // 无负载的 marker：RSTn(D0-D7) / SOI(D8) / EOI(D9) / TEM(01)
            if matches!(marker, 0xD0..=0xD9 | 0x01) {
                continue;
            }
            // SOFn (Start Of Frame，含尺寸)：0xC0-0xC3 / 0xC5-0xC7 / 0xC9-0xCB / 0xCD-0xCF
            // 排除 0xC4(DHT) / 0xC8(JPG) / 0xCC(DAC)
            if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                // segment 内偏移：长度(2 BE) + 精度(1) + 高(2 BE) + 宽(2 BE)
                if i + 7 > bytes.len() {
                    return None;
                }
                let h = u16::from_be_bytes(bytes[i + 3..i + 5].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                return Some((w, h));
            }
            // 其他 segment：读长度（含自身 2 字节），跳过
            if i + 2 > bytes.len() {
                return None;
            }
            let seg_len = u16::from_be_bytes(bytes[i..i + 2].try_into().ok()?) as usize;
            if seg_len < 2 {
                return None;
            }
            i += seg_len;
        }
        return None;
    }

    None
}

/// 把 markdown 里指向本地文件的链接 `[label](url)` 对应的文件拷到 `<target>.attachments/`，
/// 并在 `docx` 末尾追加「📎 附件」清单段落。返回实际拷贝的附件数。
///
/// - 只处理能被 `resolve_content_url` 解析、且 `canonicalize()` 后真实存在的链接（图片走 `![]()`
///   不在此列）；外链 / mailto / 锚点都跳过。
/// - 同一物理文件多次出现只拷一份；同名不同源的自动加 `_1` / `_2` 后缀。
fn pack_attachments(
    markdown: &str,
    target_path: &Path,
    data_dir: &Path,
    docx: &mut Docx,
) -> Result<usize, AppError> {
    // 1. 用 pulldown-cmark 事件流收集 (链接文字, 绝对路径)，比手写 markdown 正则稳
    let mut links: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    {
        let parser = Parser::new(markdown);
        let mut cur: Option<(String, String)> = None; // (url, 累积文字)
        for ev in parser {
            match ev {
                Event::Start(Tag::Link { dest_url, .. }) => {
                    cur = Some((dest_url.into_string(), String::new()));
                }
                Event::Text(t) => {
                    if let Some((_, ref mut txt)) = cur {
                        txt.push_str(&t);
                    }
                }
                Event::End(TagEnd::Link) => {
                    if let Some((url, txt)) = cur.take() {
                        if let Some(abs) = resolve_content_url(&url, data_dir) {
                            if let Ok(canon) = abs.canonicalize() {
                                if canon.is_file() && seen.insert(canon.clone()) {
                                    let label = if txt.trim().is_empty() {
                                        canon
                                            .file_name()
                                            .map(|n| n.to_string_lossy().into_owned())
                                            .unwrap_or_else(|| "附件".to_string())
                                    } else {
                                        txt.trim().to_string()
                                    };
                                    links.push((label, canon));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if links.is_empty() {
        return Ok(0);
    }

    // 2. 拷贝到 <target 同级>/<stem>.attachments/
    let parent = target_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let att_dir_name = format!("{}.attachments", stem);
    let att_dir = parent.join(&att_dir_name);

    let mut taken: HashSet<String> = HashSet::new();
    let mut listed: Vec<(String, String)> = Vec::new(); // (label, 相对路径展示)
    for (label, abs) in links {
        let orig = abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".to_string());
        let unique = unique_attachment_name(&orig, &mut taken);
        if std::fs::create_dir_all(&att_dir).is_err() {
            continue;
        }
        if std::fs::copy(&abs, att_dir.join(&unique)).is_err() {
            continue;
        }
        listed.push((label, format!("{}/{}", att_dir_name, unique)));
    }
    if listed.is_empty() {
        return Ok(0);
    }

    // 3. 文档末尾追加「📎 附件」清单
    *docx = std::mem::take(docx)
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("─".repeat(40))));
    *docx = std::mem::take(docx).add_paragraph(
        Paragraph::new()
            .style("Heading2")
            .add_run(Run::new().add_text("📎 附件").bold().size(28)),
    );
    for (label, rel) in &listed {
        *docx = std::mem::take(docx).add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(format!("• {}  →  {}", label, rel))),
        );
    }
    Ok(listed.len())
}

/// 附件文件名去重：首个直接用，再次出现加 `_1` / `_2` 后缀（保留扩展名）
fn unique_attachment_name(name: &str, taken: &mut HashSet<String>) -> String {
    if taken.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(p) => (&name[..p], &name[p..]),
        None => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一个最小 PNG header（8 字节签名 + IHDR）
    fn make_png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0, 0, 0, 13]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    /// 拼一个最小 JPEG：SOI + SOF0 segment（含尺寸）+ EOI
    fn make_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        // SOF0: 0xFF 0xC0 长度(2 BE) 精度(1) 高(2 BE) 宽(2 BE) 通道(1) 通道描述符
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.push(0x03);
        v.extend_from_slice(&[0; 12]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    fn make_gif(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.extend_from_slice(&[0; 4]);
        v
    }

    fn make_bmp(w: u32, h: i32) -> Vec<u8> {
        let mut v = b"BM".to_vec();
        v.extend_from_slice(&[0; 16]);
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v
    }

    #[test]
    fn read_dimensions_png() {
        assert_eq!(read_image_dimensions(&make_png(1920, 1080)), Some((1920, 1080)));
        assert_eq!(read_image_dimensions(&make_png(800, 600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_jpeg() {
        assert_eq!(read_image_dimensions(&make_jpeg(1920, 1080)), Some((1920, 1080)));
        // 正方形（用户场景）：原图正方形不应该被压扁
        assert_eq!(read_image_dimensions(&make_jpeg(500, 500)), Some((500, 500)));
    }

    #[test]
    fn read_dimensions_jpeg_skips_unrelated_segments() {
        // SOI + APP0(JFIF) + SOF0 + EOI —— SOF0 不是紧跟 SOI，验证段跳过逻辑
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(&[0; 14]);
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&1024u16.to_be_bytes());
        v.extend_from_slice(&768u16.to_be_bytes());
        v.push(0x03);
        v.extend_from_slice(&[0; 12]);
        assert_eq!(read_image_dimensions(&v), Some((768, 1024)));
    }

    #[test]
    fn read_dimensions_gif() {
        assert_eq!(read_image_dimensions(&make_gif(640, 480)), Some((640, 480)));
    }

    #[test]
    fn read_dimensions_bmp_positive_height() {
        assert_eq!(read_image_dimensions(&make_bmp(800, 600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_bmp_negative_height() {
        // BMP height 可负（表示行存储顺序），尺寸应取绝对值
        assert_eq!(read_image_dimensions(&make_bmp(800, -600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_unknown_returns_none() {
        assert!(read_image_dimensions(b"not an image").is_none());
        assert!(read_image_dimensions(&[]).is_none());
        assert!(read_image_dimensions(&[0u8; 12]).is_none());
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_landscape() {
        // 1920×1080 横图：超宽，按宽缩到 MAX_WIDTH，高按比例
        let bytes = make_png(1920, 1080);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w as u64, MAX_WIDTH_EMU);
        let expected_h = (MAX_WIDTH_EMU * 1080 / 1920) as u32;
        assert_eq!(h, expected_h);
        let ratio_in = 1920.0_f64 / 1080.0;
        let ratio_out = w as f64 / h as f64;
        assert!((ratio_in - ratio_out).abs() < 0.01);
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_portrait() {
        // 1080×1920 竖图：旧实现会塞成 4:3 严重变形（这是用户报的 bug）
        let bytes = make_png(1080, 1920);
        let (w, h) = compute_image_emu(&bytes);
        // 1080×9525=10_287_000 EMU 超宽，先缩宽：w=5_400_000, h=5_400_000*1920/1080=9_600_000
        // 9_600_000 > MAX_HEIGHT_EMU(8_640_000)，再缩高：h=8_640_000, w=按比例
        assert_eq!(h as u64, MAX_HEIGHT_EMU);
        let ratio_in = 1080.0_f64 / 1920.0;
        let ratio_out = w as f64 / h as f64;
        assert!((ratio_in - ratio_out).abs() < 0.01);
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_square() {
        // 用户最敏感场景：500×500 正方形 → 必须保持正方形
        let bytes = make_png(500, 500);
        let (w, h) = compute_image_emu(&bytes);
        // 500×9525 = 4_762_500 < MAX_WIDTH_EMU(5_400_000)，不缩放
        assert_eq!(w, 500 * EMU_PER_PIXEL as u32);
        assert_eq!(h, 500 * EMU_PER_PIXEL as u32);
        assert_eq!(w, h);
    }

    #[test]
    fn compute_emu_small_image_no_upscale() {
        // 100×80 小图：不应被强制放大到固定尺寸（旧 bug 的对偶面）
        let bytes = make_png(100, 80);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w, 100 * EMU_PER_PIXEL as u32);
        assert_eq!(h, 80 * EMU_PER_PIXEL as u32);
    }

    #[test]
    fn compute_emu_unknown_format_falls_back_to_default() {
        // 未知格式 / 损坏头：兜底 4:3，至少能塞进去不崩
        let (w, h) = compute_image_emu(b"not an image");
        assert_eq!(w, DEFAULT_W_EMU);
        assert_eq!(h, DEFAULT_H_EMU);
    }

    #[test]
    fn compute_emu_zero_dimension_falls_back_to_default() {
        // 头里写着 0×0（异常但不该 div by zero）
        let bytes = make_png(0, 0);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w, DEFAULT_W_EMU);
        assert_eq!(h, DEFAULT_H_EMU);
    }

    /// 在临时目录里造一个唯一 .docx 路径
    fn tmp_docx(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kb_export_word_test_{}_{}.docx", tag, nanos))
    }

    /// 回归：tiptap 表格带列宽会序列化成 `<table>` HTML 块。
    /// 旧实现把所有 Event::Html 丢弃 → 表格内容全丢（用户报的「只剩标题」）。
    /// 现在原生路径应把 HTML 表格经 html2md 还原，文档体积明显大于纯标题。
    #[test]
    fn native_export_recovers_html_table() {
        let assets = std::env::temp_dir(); // 无图片，随便给个存在的目录
        let html_table = "<table><tr><th>项</th><th>值</th></tr>\
                          <tr><td>服务器</td><td>1.2.3.4</td></tr>\
                          <tr><td>协议</td><td>VLESS</td></tr></table>";

        let with_table = tmp_docx("with_table");
        WordExportService::export_single("标题", html_table, &with_table, &assets)
            .expect("含表格导出应成功");

        let title_only = tmp_docx("title_only");
        WordExportService::export_single("标题", "", &title_only, &assets)
            .expect("纯标题导出应成功");

        let table_len = std::fs::metadata(&with_table).unwrap().len();
        let title_len = std::fs::metadata(&title_only).unwrap().len();
        // 表格内容进入了 docx → 体积应显著大于纯标题文档
        assert!(
            table_len > title_len,
            "HTML 表格内容被丢弃了：with_table={} bytes, title_only={} bytes",
            table_len,
            title_len
        );

        let _ = std::fs::remove_file(&with_table);
        let _ = std::fs::remove_file(&title_only);
    }

    /// 回归：带尺寸/图注的图片会序列化成 `<figure><img src="data:...">`。
    /// 原生路径应把它经 html2md 还原成 `![](data:...)` 并把 base64 图片内嵌进 docx。
    #[test]
    fn native_export_embeds_html_figure_image() {
        // 真实可解码的 1×1 PNG（docx-rs 的 Pic::new 会真正解码图片，假 header 会 panic）
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        let content = format!(
            "<figure><img src=\"data:image/png;base64,{}\" alt=\"图\"></figure>",
            b64
        );

        let assets = std::env::temp_dir();
        let target = tmp_docx("figure_img");
        let result = WordExportService::export_single("标题", &content, &target, &assets)
            .expect("含图片导出应成功");

        assert_eq!(
            result.images_embedded, 1,
            "data: URL 图片应被内嵌（embedded），实际 embedded={} missing={}",
            result.images_embedded, result.images_missing
        );
        let _ = std::fs::remove_file(&target);
    }
}
