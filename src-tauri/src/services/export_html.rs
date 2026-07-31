//! T-020 笔记导出为 HTML
//!
//! 单文件 HTML：完整可分享（self-contained），含基础样式 + 嵌入图片为 base64。
//! 用 pulldown-cmark（项目已装）渲染 markdown → HTML，再包一层 minimal CSS 模板。

use std::path::Path;

use base64::Engine as _;
use pulldown_cmark::{html::push_html, Options, Parser};

use crate::error::AppError;
use crate::services::asset_path::resolve_content_url;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportResult {
    pub file_path: String,
    pub images_inlined: usize,
    pub images_missing: usize,
    /// 内嵌为 data: URL 下载链接的非图片附件数（PDF / Office / 压缩包等）
    pub attachments_inlined: usize,
    /// 解析失败（文件不存在 / 越权）的附件链接数
    pub attachments_missing: usize,
}

/// 导出时使用的字体（跟随用户在设置里选的「正文字体 / 标题字体」）。
///
/// 值是**完整的 CSS font-family 串**（含 fallback 链），由前端 `resolveEditorFontStack`
/// 生成后传下来 —— Rust 侧不认识字体预设 ID，也不该重复一份映射表。
/// 两个字段都可空：空 = 用模板自带的通用中文字体链（老行为）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFonts {
    /// 正文字体
    pub body: Option<String>,
    /// 标题字体（H1–H6）；空 = 跟随正文
    pub heading: Option<String>,
}

/// 模板自带的正文字体链（用户没设字体时的老行为，原样保留）
const DEFAULT_BODY_FONT: &str = r#"-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
      "PingFang SC", "Source Han Sans SC", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif"#;

/// 过滤字体串里会破坏 CSS / HTML 结构的字符。
///
/// 字体名在设置页是**可手输**的，而导出的 HTML 常常要发给别人 —— `</style><script>`
/// 这类越界注入必须在写进模板前掐掉。顺带剔除 CSS 语法字符（`{}` `;` `@`），
/// 防止一条声明被撑成多条规则。合法字体名（含中文、空格、引号、逗号、连字符）不受影响。
fn sanitize_font_family(v: &str) -> Option<String> {
    let cleaned: String = v
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '{' | '}' | ';' | '@' | '\\'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub struct HtmlExportService;

impl HtmlExportService {
    /// 渲染笔记为单文件 HTML 字符串（图片内嵌 base64，可独立分享）。
    ///
    /// 与 `export_single` 的区别：不写文件，直接返回 HTML 字符串。
    /// 用于 R-005 PDF 导出场景：前端拿字符串塞 iframe → window.print() → 用户另存为 PDF。
    ///
    /// 返回 `(html_string, images_inlined, images_missing)`。
    pub fn render_html(
        title: &str,
        markdown: &str,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> Result<(String, usize, usize), AppError> {
        let mut options = Options::empty();
        options.insert(Options::ENABLE_TABLES);
        options.insert(Options::ENABLE_STRIKETHROUGH);
        options.insert(Options::ENABLE_TASKLISTS);
        options.insert(Options::ENABLE_FOOTNOTES);

        let parser = Parser::new_ext(markdown, options);
        let mut body = String::new();
        push_html(&mut body, parser);

        // 把 <img src="..."> 中的本地路径 inline 成 base64
        let (body, inlined, missing) = inline_images(&body, assets_root);

        let html = wrap_template(title, &body, fonts);
        Ok((html, inlined, missing))
    }

    /// 导出单条笔记为单文件 HTML（图片内嵌 base64 + 非图片附件内嵌为 data: 下载链接，可独立分享）
    pub fn export_single(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> Result<HtmlExportResult, AppError> {
        let (html, inlined, missing) = Self::render_html(title, markdown, assets_root, fonts)?;
        // 把正文里指向本地文件的 <a href="..."> 附件链接换成 data: URL（带 download 属性），
        // 这样导出的单个 .html 仍是 self-contained 的：换台机器/发给别人也能点开下载附件。
        // CSS 模板里只有 `a {}` 选择器、没有真实 <a> 元素，所以直接在整段 HTML 上跑也安全。
        let (html, att_inlined, att_missing) = inline_attachments(&html, assets_root);
        std::fs::write(target_path, html)?;

        Ok(HtmlExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_inlined: inlined,
            images_missing: missing,
            attachments_inlined: att_inlined,
            attachments_missing: att_missing,
        })
    }

    /// 把前端渲染好的 body HTML 套上 CSS 模板，并内嵌其中的本地图片。
    ///
    /// 返回 `(完整 html, 内嵌图片数, 缺失图片数)`。Word 导出（走系统转换器那条）
    /// 也复用它，两边拿到的是同一份 HTML，样式与编号表现一致。
    pub fn render_html_from_body(
        title: &str,
        body_html: &str,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> (String, usize, usize) {
        let (body, inlined, missing) = inline_images(body_html, assets_root);
        (wrap_template(title, &body, fonts), inlined, missing)
    }

    /// 把**前端已渲染好的 HTML 片段**套上 CSS 模板写成单文件 .html。
    ///
    /// 与 `export_single` 的区别在于内容从哪来：那条把 markdown 交给 pulldown-cmark
    /// 重新渲染，看不到只活在编辑器 DOM 里的东西 —— 标题自动编号是 ProseMirror 的
    /// widget decoration，不写进 doc / .md，于是导出的 HTML 里编号全没了
    /// （用户反馈"导出 html、word 时无编号"）。本方法直接收编辑器真实 DOM，
    /// 编号 / callout / 分栏 / mermaid SVG 一并保留，做到"导出 = 屏幕所见"。
    ///
    /// 传入的 `body_html` 应当已经过 `inline_assets` 处理（前端打印管线的既有步骤），
    /// 这里仍再跑一次附件内嵌兜底 —— 重复内嵌是幂等的（已是 data: 的会被跳过）。
    pub fn export_single_from_html(
        title: &str,
        body_html: &str,
        target_path: &Path,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> Result<HtmlExportResult, AppError> {
        let (html, img_inlined, img_missing) =
            Self::render_html_from_body(title, body_html, assets_root, fonts);
        let (html, att_inlined, att_missing) = inline_attachments(&html, assets_root);
        std::fs::write(target_path, html)?;

        Ok(HtmlExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_inlined: img_inlined,
            images_missing: img_missing,
            attachments_inlined: att_inlined,
            attachments_missing: att_missing,
        })
    }

    /// R-005b 把任意 HTML 片段里的本地图片 / 附件链接 inline 成 base64（自包含）。
    ///
    /// 与 `render_html` / `export_single` 的本质区别：**不经 markdown 渲染、不套 CSS 模板**，
    /// 只对传入的 HTML 原样做资源内嵌。用于「打印编辑器实时 DOM」场景：前端把编辑器
    /// 已渲染好的真实 DOM（callout / 分栏 / figure / mermaid SVG 等）序列化成 HTML 传进来，
    /// 本方法复用导出管线同款 `inline_images` + `inline_attachments`，把 `kb-asset://` 等
    /// 本地资源换成 data: URL —— 确保打印 iframe 不依赖自定义协议 / CSP / 加载时序，
    /// 资源同步可用，打印 = 所见即所得。
    ///
    /// 返回 `(html, images_inlined, attachments_inlined)`。
    pub fn inline_assets(html: &str, assets_root: &Path) -> (String, usize, usize) {
        let (html, img_inlined, _img_missing) = inline_images(html, assets_root);
        let (html, att_inlined, _att_missing) = inline_attachments(&html, assets_root);
        (html, img_inlined, att_inlined)
    }
}

/// 用一个最简模板包住 body：
/// - 中文字体 fallback 链
/// - 代码块 / 表格 / 引用基础样式
/// - 适合阅读的最大宽度 + 行距
fn wrap_template(title: &str, body: &str, fonts: Option<&ExportFonts>) -> String {
    let safe_title = html_escape(title);
    // 用户设了字体就用用户的，否则保持模板自带的通用中文链（老行为）
    let body_font = fonts
        .and_then(|f| f.body.as_deref())
        .and_then(sanitize_font_family)
        .unwrap_or_else(|| DEFAULT_BODY_FONT.to_string());
    // 标题字体是可选的一条额外声明：不设就整条不写，h1~h6 自然继承 body
    let heading_font_css = fonts
        .and_then(|f| f.heading.as_deref())
        .and_then(sanitize_font_family)
        .map(|f| format!("\n    font-family: {};", f))
        .unwrap_or_default();
    format!(
        r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{title}</title>
<style>
  :root {{
    --fg: #24292f;
    --muted: #6e7781;
    --border: #d0d7de;
    --bg-code: #f6f8fa;
    --bg-quote: #f6f8fa;
    --link: #0969da;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: {body_font};
    color: var(--fg);
    line-height: 1.7;
    max-width: 820px;
    margin: 40px auto;
    padding: 0 24px 80px;
    font-size: 16px;
  }}
  h1, h2, h3, h4, h5, h6 {{
    margin: 1.6em 0 0.6em;
    font-weight: 600;
    line-height: 1.3;{heading_font_css}
  }}
  h1 {{ font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }}
  h2 {{ font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }}
  h3 {{ font-size: 1.25em; }}
  h4 {{ font-size: 1em; }}
  p {{ margin: 0.8em 0; }}
  a {{ color: var(--link); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  code {{
    font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro",
      Consolas, "Courier New", monospace;
    background: var(--bg-code);
    padding: 0.2em 0.4em;
    border-radius: 4px;
    font-size: 0.92em;
  }}
  pre {{
    background: var(--bg-code);
    padding: 14px 16px;
    border-radius: 8px;
    overflow-x: auto;
    line-height: 1.5;
  }}
  pre code {{ background: transparent; padding: 0; font-size: 0.92em; }}
  blockquote {{
    margin: 1em 0;
    padding: 0.4em 16px;
    border-left: 4px solid var(--border);
    color: var(--muted);
    background: var(--bg-quote);
  }}
  table {{
    border-collapse: collapse;
    margin: 1em 0;
    width: 100%;
    font-size: 0.95em;
  }}
  th, td {{
    border: 1px solid var(--border);
    padding: 8px 12px;
    text-align: left;
  }}
  th {{ background: var(--bg-code); font-weight: 600; }}
  img {{ max-width: 100%; height: auto; border-radius: 4px; }}
  hr {{
    border: none;
    border-top: 1px solid var(--border);
    margin: 2em 0;
  }}
  ul, ol {{ padding-left: 1.6em; }}
  li {{ margin: 0.3em 0; }}
  /* 任务列表去 marker */
  ul.task-list, ul.contains-task-list {{ list-style: none; padding-left: 1em; }}
  .footnote-ref a {{ font-size: 0.8em; vertical-align: super; }}
  /* 批注：浅黄底 + 下划虚线，鼠标悬停由 title 属性自带 tooltip */
  span[data-comment], .kb-annotation {{
    background: rgba(255, 234, 0, 0.35);
    border-bottom: 1px dashed rgba(195, 157, 0, 0.85);
    cursor: help;
    padding: 0 1px;
    border-radius: 2px;
  }}
  /* 嵌入视频 iframe（B站 / YouTube / 腾讯 / 优酷）：16:9 响应式 */
  iframe[data-embed-url] {{
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 1em 0;
    background: #000;
  }}
  /* 分栏布局（语雀/Notion 风横排多列）：编辑器里靠 app CSS 做 flex 横排，
     导出的独立 HTML 必须自带这段，否则 .tiptap-columns / .tiptap-column 退回
     默认 display:block 纵向堆叠 ——「分栏被拆开」。结构为
     <div class="tiptap-columns"><div class="tiptap-column">…</div>…</div>。 */
  .tiptap-columns, [data-columns] {{
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    gap: 16px;
    align-items: flex-start;
    width: 100%;
    margin: 12px 0;
  }}
  .tiptap-columns > .tiptap-column,
  [data-columns] > [data-column] {{
    flex: 1 1 0;
    min-width: 0;
  }}
  .tiptap-column > :first-child, [data-column] > :first-child {{ margin-top: 0; }}
  .tiptap-column > :last-child, [data-column] > :last-child {{ margin-bottom: 0; }}
</style>
</head>
<body>
<article>
<h1>{safe_title}</h1>
{body}
</article>
</body>
</html>
"##,
        title = safe_title,
        safe_title = safe_title,
        body = body,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 把 HTML 里 `<img src="...">` 的本地路径替换为 base64 data: URL
///
/// 跳过：
/// - 已是 `data:` URL
/// - `http(s)://` 外链
fn inline_images(html: &str, assets_root: &Path) -> (String, usize, usize) {
    let re = match regex::Regex::new(r#"<img\s+[^>]*src="([^"]+)"[^>]*>"#) {
        Ok(r) => r,
        Err(_) => return (html.to_string(), 0, 0),
    };

    let mut inlined = 0usize;
    let mut missing = 0usize;
    let result = re.replace_all(html, |caps: &regex::Captures| {
        let full_tag = &caps[0];
        let src = &caps[1];
        if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
            return full_tag.to_string();
        }
        match resolve_local_image(src, assets_root) {
            Some((bytes, mime)) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let new_src = format!("data:{};base64,{}", mime, b64);
                inlined += 1;
                full_tag.replace(src, &new_src)
            }
            None => {
                missing += 1;
                full_tag.to_string()
            }
        }
    });

    (result.into_owned(), inlined, missing)
}

fn resolve_local_image(url: &str, data_dir: &Path) -> Option<(Vec<u8>, String)> {
    // 统一走 asset_path::resolve_content_url：覆盖 kb-asset:// / asset:// / file:// / 裸路径
    let abs_path = resolve_content_url(url, data_dir)?;
    let bytes = std::fs::read(&abs_path).ok()?;
    let mime = guess_mime(&abs_path);
    Some((bytes, mime))
}

/// 把 HTML 里 `<a href="本地文件">…</a>` 的链接换成 `data:application/octet-stream;base64,…` +
/// `download="原文件名"`，让附件随单文件 HTML 一起走。
///
/// 跳过：`data:` / 页内锚点 `#…` / 真·外链（`http(s)://` 等，由 `resolve_content_url` 返回 `None`）。
/// 返回 `(新 html, 已内嵌附件数, 解析失败附件数)`。
fn inline_attachments(html: &str, data_dir: &Path) -> (String, usize, usize) {
    let re = match regex::Regex::new(r#"<a\s+[^>]*href="([^"]+)"[^>]*>"#) {
        Ok(r) => r,
        Err(_) => return (html.to_string(), 0, 0),
    };

    let mut inlined = 0usize;
    let mut missing = 0usize;
    let result = re.replace_all(html, |caps: &regex::Captures| {
        let full_tag = &caps[0];
        let href = &caps[1];
        if href.starts_with("data:") || href.starts_with('#') {
            return full_tag.to_string();
        }
        let abs = match resolve_content_url(href, data_dir) {
            Some(p) => p,
            None => return full_tag.to_string(), // 外链 / mailto / 锚点等，原样保留
        };
        match std::fs::read(&abs) {
            Ok(bytes) => {
                let name = abs
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "attachment".to_string());
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                inlined += 1;
                format!(
                    r#"<a href="data:application/octet-stream;base64,{}" download="{}">"#,
                    b64,
                    html_escape(&name)
                )
            }
            Err(_) => {
                missing += 1;
                full_tag.to_string()
            }
        }
    });

    (result.into_owned(), inlined, missing)
}

fn guess_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 DOM 路径**不能**经 markdown 重渲 —— 那正是编号丢失的原因。
    ///
    /// 用一段只可能来自编辑器渲染层的 HTML（编号 widget + callout）做探针：
    /// 若实现哪天偷偷改回"先转 markdown 再渲染"，这些结构会被打平，测试就会挂。
    #[test]
    fn render_html_from_body_preserves_rendered_dom() {
        let body = r#"<div class="tiptap"><h1><span class="kb-hnum">1</span>研发与制造脱节</h1><div class="kb-callout">提示</div></div>"#;
        let (html, _inlined, _missing) =
            HtmlExportService::render_html_from_body("标题", body, Path::new("/nonexistent"), None);

        // 编号 widget 必须原样保留（用户反馈的核心诉求）
        assert!(
            html.contains(r#"<span class="kb-hnum">1</span>"#),
            "标题编号应原样保留，实际：{html}"
        );
        // 自定义节点也不该被打平成普通段落
        assert!(html.contains(r#"class="kb-callout""#), "callout 结构应保留");
        // 套了模板：有 <html> 骨架和标题
        assert!(html.contains("<html"), "应套上完整 HTML 模板");
        assert!(html.contains("标题"), "模板应带上笔记标题");
    }

    /// 对照组：走 markdown 重渲的老路径确实看不到编号（这就是 bug 的成因）。
    /// 锁住这个差异，避免有人误以为两条路等价而把新路径删掉。
    #[test]
    fn markdown_path_cannot_see_heading_numbers() {
        // markdown 源码里根本没有编号 —— 编号只存在于编辑器 DOM
        let (html, _i, _m) = HtmlExportService::render_html(
            "标题",
            "# 研发与制造脱节",
            Path::new("/nonexistent"),
            None,
        )
        .unwrap();
        assert!(
            !html.contains("kb-hnum"),
            "markdown 路径不可能产出编号，这正是需要前端 DOM 路径的原因"
        );
    }

    /// 不传字体 = 老行为：模板自带的通用中文链，且不给标题额外加 font-family
    #[test]
    fn template_without_fonts_keeps_default() {
        let (html, _i, _m) =
            HtmlExportService::render_html("标题", "# 一级标题", Path::new("/nonexistent"), None)
                .unwrap();
        assert!(
            html.contains("Microsoft YaHei"),
            "未指定字体时应保留模板自带的中文 fallback 链"
        );
        // h1~h6 块里不该出现 font-family（标题继承 body）
        let heading_block = html
            .split("h1, h2, h3, h4, h5, h6 {")
            .nth(1)
            .and_then(|s| s.split('}').next())
            .unwrap_or_default();
        assert!(
            !heading_block.contains("font-family"),
            "未指定标题字体时不该写 font-family，实际：{heading_block}"
        );
    }

    /// 传了字体 → 正文与标题各自写进模板 CSS
    #[test]
    fn template_applies_user_fonts() {
        let fonts = ExportFonts {
            body: Some(r#""霞鹜文楷", serif"#.into()),
            heading: Some(r#""方正小标宋", serif"#.into()),
        };
        let (html, _i, _m) = HtmlExportService::render_html(
            "标题",
            "# 一级标题",
            Path::new("/nonexistent"),
            Some(&fonts),
        )
        .unwrap();
        assert!(html.contains(r#"font-family: "霞鹜文楷", serif;"#), "正文字体应写入 body");
        assert!(html.contains(r#"font-family: "方正小标宋", serif;"#), "标题字体应写入 h1~h6");
        assert!(
            !html.contains("Microsoft YaHei"),
            "指定了正文字体就不该再留默认链"
        );
    }

    /// 字体串是用户可手输的，导出物又常发给别人 —— 必须掐掉能越出 CSS 的字符
    #[test]
    fn sanitize_strips_css_and_html_breakouts() {
        let fonts = ExportFonts {
            body: Some(r#"宋体</style><script>alert(1)</script>"#.into()),
            heading: Some("A; } body { display: none } @import url(evil)".into()),
        };
        let (html, _i, _m) = HtmlExportService::render_html(
            "标题",
            "正文",
            Path::new("/nonexistent"),
            Some(&fonts),
        )
        .unwrap();
        assert!(!html.contains("<script"), "不得注入 script 标签：{html}");
        // 模板自己有且只有一个 </style>，注入不该再撑出第二个
        assert_eq!(
            html.matches("</style>").count(),
            1,
            "style 块不得被提前闭合"
        );
        assert!(!html.contains("@import"), "不得注入 @import");
        // 关键是**结构字符**被剔除：花括号 / 分号 / @ 一旦漏进去，一条声明就能撑成多条规则。
        // 残留的 "display: none" 文本无所谓——它只是 font-family 值里一个非法字体名，浏览器直接忽略。
        let heading_block = html
            .split("h1, h2, h3, h4, h5, h6 {")
            .nth(1)
            .and_then(|s| s.split('}').next())
            .unwrap_or_default();
        assert!(
            heading_block.contains("font-family"),
            "标题字体声明应当写进去了：{heading_block}"
        );
        assert!(
            !heading_block.contains('{') && !heading_block.contains('@'),
            "注入的花括号 / @ 必须被剔除：{heading_block}"
        );
        // 合法部分仍然保留，不是整条丢弃
        assert!(html.contains("宋体"), "无害的字体名应保留");
    }

    /// 空串 / 只有空白的字体值等同于没传，回退默认模板
    #[test]
    fn blank_fonts_fall_back_to_default() {
        let fonts = ExportFonts {
            body: Some("   ".into()),
            heading: Some(String::new()),
        };
        let (html, _i, _m) = HtmlExportService::render_html(
            "标题",
            "正文",
            Path::new("/nonexistent"),
            Some(&fonts),
        )
        .unwrap();
        assert!(html.contains("Microsoft YaHei"), "空字体值应回退默认链");
    }
}
