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

        let html = wrap_template(title, &body);
        Ok((html, inlined, missing))
    }

    /// 导出单条笔记为单文件 HTML（图片内嵌 base64 + 非图片附件内嵌为 data: 下载链接，可独立分享）
    pub fn export_single(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<HtmlExportResult, AppError> {
        let (html, inlined, missing) = Self::render_html(title, markdown, assets_root)?;
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
}

/// 用一个最简模板包住 body：
/// - 中文字体 fallback 链
/// - 代码块 / 表格 / 引用基础样式
/// - 适合阅读的最大宽度 + 行距
fn wrap_template(title: &str, body: &str) -> String {
    let safe_title = html_escape(title);
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
      "PingFang SC", "Source Han Sans SC", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif;
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
    line-height: 1.3;
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
