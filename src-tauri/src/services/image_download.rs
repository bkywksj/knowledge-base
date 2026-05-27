//! 远程图片下载服务（粘贴外链图片本地化）。
//!
//! Why 不在前端 fetch：WebView 的 fetch 会带 `tauri://localhost` Origin，
//! 钉钉 / 微信图床 / 知乎 / CSDN 等图床基本都查 Referer 防盗链 → 403 / 假图。
//! 走 Rust + reqwest 后可以按 host 智能注入 Referer，绕过常见防盗链。

use crate::error::AppError;
use crate::services::http_client;
use reqwest::header;

/// 桌面 Chrome UA。reqwest 默认 UA 形如 `reqwest/0.12`，部分图床直接拒服务。
const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 单张图最大 20MB。再大就别本地化了 —— 用户体验 / 磁盘 / IPC 都吃不消。
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// 单次请求超时 20s（防被恶意服务器吊在 connect 阶段）
const TIMEOUT_SECS: u64 = 20;

/// 抓远程图片字节并推断扩展名。
///
/// 返回 `(bytes, ext)`，`ext` 不带前导点（"png" / "jpg" / ...）。
pub async fn fetch_image_bytes(
    url: &str,
    referer_override: Option<&str>,
) -> Result<(Vec<u8>, String), AppError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::InvalidInput(format!(
            "不支持的 URL scheme: {}",
            url
        )));
    }

    let parsed = reqwest::Url::parse(url)
        .map_err(|e| AppError::InvalidInput(format!("URL 无效: {}", e)))?;

    let referer = match referer_override {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => smart_referer(&parsed),
    };

    let resp = http_client::shared()
        .get(url)
        .header(header::USER_AGENT, DEFAULT_UA)
        .header(header::REFERER, &referer)
        .header(header::ACCEPT, "image/*,*/*;q=0.8")
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求失败: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Custom(format!(
            "下载失败 HTTP {} (referer={})",
            resp.status(),
            referer
        )));
    }

    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;

    if bytes.len() > MAX_BYTES {
        return Err(AppError::Custom(format!(
            "图片过大: {} 字节，上限 {} MB",
            bytes.len(),
            MAX_BYTES / 1024 / 1024
        )));
    }

    // 按真实字节内容（magic number）识别格式，是判定"是不是图片"的唯一可靠依据。
    //
    // Why 不能信 Content-Type / URL 后缀：很多站点（如 shui5.cn 这类反爬 CMS）对带
    // 通用 Referer 的图片请求做防盗链，会返回 HTTP 200 + 一个 HTML 提示页/登录页。
    // 旧逻辑只要 URL 以 .jpg 结尾就放行，于是把 HTML 页面的字节当图片存成 *.jpg，
    // 前端提示"已保存"实际却是裂图。改成嗅探字节后：
    //   - 是已知图片格式 → 用嗅探出的真实扩展名（同时修正"服务器谎报扩展名"）；
    //   - 不是图片字节 → 直接判失败，让前端剥离该图并如实提示"无法访问"。
    match sniff_image_format(&bytes) {
        Some(ext) => Ok((bytes.to_vec(), ext.to_string())),
        None => Err(AppError::Custom(format!(
            "响应不是有效图片（content-type={}, {} 字节，可能是防盗链/登录页），url={}",
            content_type,
            bytes.len(),
            url
        ))),
    }
}

/// 按文件头 magic number 嗅探图片真实格式，返回不带点的扩展名。
///
/// 覆盖位图常见格式 + SVG（文本）。命中不了返回 None（调用方据此判定"非图片"）。
/// SVG 需特判 HTML 错误页：以 `<!doctype html` / `<html` 开头的一律不当图片。
fn sniff_image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    // WEBP: "RIFF"....（4 字节长度）...."WEBP"
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    // SVG 是文本格式，取头部一小段判断；务必排除 HTML 错误页
    let head_len = bytes.len().min(512);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    let lower = head.trim_start_matches('\u{feff}').trim_start().to_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        return None;
    }
    if lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        return Some("svg");
    }
    None
}

/// 按 host 关键字匹配最常见的国内图床，用对应站点的根路径作 Referer。
/// 命中不了的回退到 "图自身 origin"——很多防盗链允许同源访问。
fn smart_referer(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("").to_lowercase();
    if host.contains("dingtalk") {
        return "https://im.dingtalk.com/".into();
    }
    if host.contains("qpic.cn") || host.contains("weixin") || host.contains("mmbiz") {
        return "https://mp.weixin.qq.com/".into();
    }
    if host.contains("zhimg.com") || host.contains("zhihu.com") {
        return "https://www.zhihu.com/".into();
    }
    if host.contains("csdnimg") || host.contains("csdn.net") {
        return "https://blog.csdn.net/".into();
    }
    if host.contains("hdslb.com") || host.contains("bilibili.com") {
        return "https://www.bilibili.com/".into();
    }
    if host.contains("feishu") || host.contains("larksuite") || host.contains("lark") {
        return "https://www.feishu.cn/".into();
    }
    if host.contains("juejin") || host.contains("byteimg") {
        return "https://juejin.cn/".into();
    }
    format!("{}://{}/", url.scheme(), host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_referer_dingtalk() {
        let u = reqwest::Url::parse("https://static.dingtalk.com/x.png").unwrap();
        assert_eq!(smart_referer(&u), "https://im.dingtalk.com/");
    }

    #[test]
    fn smart_referer_weixin() {
        let u = reqwest::Url::parse("https://mmbiz.qpic.cn/x").unwrap();
        assert_eq!(smart_referer(&u), "https://mp.weixin.qq.com/");
    }

    #[test]
    fn smart_referer_fallback_origin() {
        let u = reqwest::Url::parse("https://example.com/foo.png").unwrap();
        assert_eq!(smart_referer(&u), "https://example.com/");
    }

    #[test]
    fn sniff_png_jpg_gif_bmp() {
        assert_eq!(
            sniff_image_format(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            Some("png")
        );
        assert_eq!(sniff_image_format(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some("jpg"));
        assert_eq!(sniff_image_format(b"GIF89a..."), Some("gif"));
        assert_eq!(sniff_image_format(b"BM\x00\x00\x00\x00"), Some("bmp"));
    }

    #[test]
    fn sniff_webp() {
        // RIFF + 4 字节占位 + WEBP
        let bytes = b"RIFF\x00\x00\x00\x00WEBPVP8 ";
        assert_eq!(sniff_image_format(bytes), Some("webp"));
    }

    #[test]
    fn sniff_svg_text() {
        assert_eq!(sniff_image_format(b"<svg xmlns=\"...\"></svg>"), Some("svg"));
        assert_eq!(
            sniff_image_format(b"<?xml version=\"1.0\"?><svg></svg>"),
            Some("svg")
        );
    }

    #[test]
    fn sniff_rejects_html_antileech_page() {
        // 防盗链/登录页：URL 可能以 .jpg 结尾，但字节是 HTML → 必须判非图片
        assert_eq!(
            sniff_image_format(b"<!DOCTYPE html><html><body>403</body></html>"),
            None
        );
        assert_eq!(sniff_image_format(b"<html><head></head></html>"), None);
        assert_eq!(sniff_image_format(b"not an image at all"), None);
    }
}
