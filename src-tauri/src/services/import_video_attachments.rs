//! md 导入时的视频引用识别与落盘（与 import_attachments 对称设计）
//!
//! 与图片相比的关键差异：
//! - **不建 vault 全局索引**：视频通常很大，扫一遍 vault 把所有 mp4/mkv 入索引
//!   既慢又浪费内存。这里只按相对路径解析（相对当前 .md 目录 / 相对 vault 根 / 绝对路径）。
//! - **多一个 HTML 标签分支**：视频在 markdown 里几乎都用 `<video>` 标签嵌入，
//!   除了识别 `![](x.mp4)` 和 `![[x.mp4]]` 之外，还要扫 `<video src="x.mp4">`
//!   和 `<video><source src="x.mp4"></video>` 两种 HTML 写法。
//! - **外链下载有大小护栏**：视频外链常常几百 MB，先发 HEAD 请求看 Content-Length，
//!   超过 500MB 直接跳过并记 missing，避免一篇剪藏文章拖垮整个导入流程。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::error::AppError;
use crate::services::import_attachments::{path_to_asset_url, RewriteResult};
use crate::services::video::VideoService;

/// 受支持的视频扩展名（与前端 VIDEO_FILE_EXTS 对齐）
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"];

/// 外链视频单文件大小上限（500MB）；超过的跳过并记 missing
const MAX_REMOTE_BYTES: u64 = 500 * 1024 * 1024;

/// 外链下载超时（秒）；视频体积大、CDN 慢，比图片宽松
const REMOTE_TIMEOUT_SECS: u64 = 120;

// ─── 正则集合 ────────────────────────────────────────────────────────────

/// 标准 markdown：`![alt](url)`，与 import_attachments 里的同款；这里独立保留是
/// 因为我们要以"扩展名是不是视频"为筛选条件
fn md_image_like_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#).unwrap()
    })
}

/// OB 嵌入：`![[name]]` / `![[name|alt]]` / `![[name|alt|600]]`
fn ob_wiki_embed_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"!\[\[([^\]\|]+?)(\|[^\]]*)?\]\]").unwrap())
}

/// `<video src="..."></video>` 单标签写法（属性顺序不固定，src 不一定首位）
///
/// 用 (?is) 让 . 跨行 + 不区分大小写
fn html_video_src_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r#"(?is)<video\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>(.*?)</video>"#,
        )
        .unwrap()
    })
}

/// `<video><source src="..."></video>` 嵌套写法（取首个 source 的 src）
fn html_video_source_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r#"(?is)<video\b([^>]*)>\s*<source\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>(?:.*?)</video>"#,
        )
        .unwrap()
    })
}

// ─── 工具 ────────────────────────────────────────────────────────────────

fn is_video_filename(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| VIDEO_EXTS.contains(&s.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_external_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 已经是 Tauri asset 协议或 file:// 的 URL，跳过（幂等保护）
fn is_asset_or_file_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://asset.localhost/")
        || lower.starts_with("asset://")
        || lower.starts_with("file://")
        || lower.starts_with("data:")
}

/// 根据 `note_dir` / `vault_root` 解析本地视频路径
fn resolve_local_video(
    raw_url: &str,
    note_dir: &Path,
    vault_root: &Path,
) -> Option<PathBuf> {
    // 跳过 URL 编码：视频文件名空格 / 中文常见
    let decoded = urlencoding::decode(raw_url)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| raw_url.to_string());

    let p = Path::new(&decoded);
    if p.is_absolute() && p.is_file() {
        return Some(p.to_path_buf());
    }
    let rel_to_note = note_dir.join(&decoded);
    if rel_to_note.is_file() {
        return Some(rel_to_note);
    }
    let rel_to_vault = vault_root.join(&decoded);
    if rel_to_vault.is_file() {
        return Some(rel_to_vault);
    }
    None
}

/// 复制本地视频文件到 `kb_assets/videos/<note_id>/`，返回新绝对路径
fn copy_to_video_store(
    app_data_dir: &Path,
    note_id: i64,
    source: &Path,
) -> Result<String, AppError> {
    VideoService::save_from_path(app_data_dir, note_id, &source.to_string_lossy())
}

// ─── 公开接口 ────────────────────────────────────────────────────────────

/// 重写本地视频引用为 asset URL（同步）
///
/// 处理三种来源：
/// 1. `![alt](path.mp4)` 标准 markdown
/// 2. `![[clip.mp4|600]]` OB wiki 嵌入
/// 3. `<video src="path.mp4">` / `<video><source src="path.mp4">` HTML 标签
///
/// 外链（`https://`）由 `rewrite_external_videos` 处理；这里跳过。
pub fn rewrite_video_paths(
    body: &str,
    note_id: i64,
    note_dir: &Path,
    vault_root: &Path,
    app_data_dir: &Path,
) -> Result<RewriteResult, AppError> {
    if body.is_empty() {
        return Ok(RewriteResult {
            new_body: String::new(),
            copied: 0,
            missing: Vec::new(),
            mappings: Vec::new(),
        });
    }

    let mut copied = 0usize;
    let mut missing: Vec<String> = Vec::new();
    let mut mappings: Vec<(String, String)> = Vec::new();

    // ─── pass 1：标准 markdown `![alt](*.mp4)` ───
    let md_re = md_image_like_regex();
    let after_md = md_re
        .replace_all(body, |caps: &regex::Captures| {
            let full = caps.get(0).unwrap().as_str().to_string();
            // alt 文本对视频意义不大（HTML <video> 不支持 alt），忽略
            let raw_url = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();

            if !is_video_filename(raw_url) {
                return full; // 不是视频扩展名，让图片 pipeline 处理
            }
            if is_external_url(raw_url) || is_asset_or_file_url(raw_url) {
                return full; // 外链交给 rewrite_external_videos / 已是本地
            }

            match resolve_local_video(raw_url, note_dir, vault_root) {
                Some(src) => match copy_to_video_store(app_data_dir, note_id, &src) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        mappings.push((raw_url.to_string(), url.clone()));
                        // 序列化为 HTML <video>，编辑器内才能识别为 Video 节点；
                        // ![]() 在 tiptap-markdown 默认会被解析成 image，无法播放
                        format!(r#"<video src="{}" controls></video>"#, url)
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-video] 笔记 {} 视频复制失败 ({}): {}",
                            note_id, src.display(), e
                        );
                        missing.push(raw_url.to_string());
                        full
                    }
                },
                None => {
                    missing.push(raw_url.to_string());
                    full
                }
            }
        })
        .into_owned();

    // ─── pass 2：OB wiki `![[clip.mp4|600]]` ───
    let wiki_re = ob_wiki_embed_regex();
    let after_wiki = wiki_re
        .replace_all(&after_md, |caps: &regex::Captures| {
            let full = caps.get(0).unwrap().as_str().to_string();
            let raw_name = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();

            if !is_video_filename(raw_name) {
                return full;
            }
            match resolve_local_video(raw_name, note_dir, vault_root) {
                Some(src) => match copy_to_video_store(app_data_dir, note_id, &src) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        mappings.push((raw_name.to_string(), url.clone()));
                        format!(r#"<video src="{}" controls></video>"#, url)
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-video] 笔记 {} OB-wiki 视频复制失败 ({}): {}",
                            note_id, src.display(), e
                        );
                        missing.push(raw_name.to_string());
                        full
                    }
                },
                None => {
                    missing.push(raw_name.to_string());
                    full
                }
            }
        })
        .into_owned();

    // ─── pass 3：HTML `<video src="...">` 单标签 ───
    let html_src_re = html_video_src_regex();
    let after_html_src = html_src_re
        .replace_all(&after_wiki, |caps: &regex::Captures| {
            let full = caps.get(0).unwrap().as_str().to_string();
            let raw_url = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();

            if is_external_url(raw_url) || is_asset_or_file_url(raw_url) {
                return full;
            }

            match resolve_local_video(raw_url, note_dir, vault_root) {
                Some(src) => match copy_to_video_store(app_data_dir, note_id, &src) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        mappings.push((raw_url.to_string(), url.clone()));
                        format!(r#"<video src="{}" controls></video>"#, url)
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-video] 笔记 {} HTML 视频复制失败 ({}): {}",
                            note_id, src.display(), e
                        );
                        missing.push(raw_url.to_string());
                        full
                    }
                },
                None => {
                    missing.push(raw_url.to_string());
                    full
                }
            }
        })
        .into_owned();

    // ─── pass 4：HTML `<video><source src="..."></video>` 嵌套 ───
    let html_source_re = html_video_source_regex();
    let after_html_source = html_source_re
        .replace_all(&after_html_src, |caps: &regex::Captures| {
            let full = caps.get(0).unwrap().as_str().to_string();
            let raw_url = caps.get(3).map(|m| m.as_str()).unwrap_or("").trim();

            if is_external_url(raw_url) || is_asset_or_file_url(raw_url) {
                return full;
            }

            match resolve_local_video(raw_url, note_dir, vault_root) {
                Some(src) => match copy_to_video_store(app_data_dir, note_id, &src) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        mappings.push((raw_url.to_string(), url.clone()));
                        format!(r#"<video src="{}" controls></video>"#, url)
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-video] 笔记 {} HTML <source> 视频复制失败 ({}): {}",
                            note_id, src.display(), e
                        );
                        missing.push(raw_url.to_string());
                        full
                    }
                },
                None => {
                    missing.push(raw_url.to_string());
                    full
                }
            }
        })
        .into_owned();

    // missing 去重
    let mut seen: HashMap<String, ()> = HashMap::new();
    let dedup_missing: Vec<String> = missing
        .into_iter()
        .filter(|m| seen.insert(m.clone(), ()).is_none())
        .collect();

    Ok(RewriteResult {
        new_body: after_html_source,
        copied,
        missing: dedup_missing,
        mappings,
    })
}

// ─── 外链视频下载 ────────────────────────────────────────────────────────

/// 重写 body 中所有 https?:// 视频外链：HEAD 验大小 → GET 下载到本地 → 改写引用
///
/// 视频外链处理三种来源：
/// 1. `![](https://x.mp4)`（罕见但可能）
/// 2. `<video src="https://x.mp4">`
/// 3. `<video><source src="https://x.mp4"></video>`
///
/// 失败/超大跳过保留原引用并记 missing。
pub async fn rewrite_external_videos(
    body: &str,
    note_id: i64,
    app_data_dir: &Path,
) -> Result<RewriteResult, AppError> {
    if body.is_empty() {
        return Ok(RewriteResult {
            new_body: String::new(),
            copied: 0,
            missing: Vec::new(),
            mappings: Vec::new(),
        });
    }

    // 收集所有 (start, end, raw_url, kind) 三种正则的命中
    // kind 决定替换模板（md / html-src / html-source）
    enum MatchKind {
        Md,
        HtmlSrc,
        HtmlSource,
    }
    let mut matches: Vec<(usize, usize, String, MatchKind)> = Vec::new();

    // markdown ![]()
    for caps in md_image_like_regex().captures_iter(body) {
        let m = caps.get(0).unwrap();
        let raw = caps.get(2).map(|x| x.as_str()).unwrap_or("").trim().to_string();
        if !is_external_url(&raw) || !is_video_filename(&raw) {
            continue;
        }
        matches.push((m.start(), m.end(), raw, MatchKind::Md));
    }

    // <video src="">
    for caps in html_video_src_regex().captures_iter(body) {
        let m = caps.get(0).unwrap();
        let raw = caps.get(2).map(|x| x.as_str()).unwrap_or("").trim().to_string();
        if !is_external_url(&raw) {
            continue;
        }
        matches.push((m.start(), m.end(), raw, MatchKind::HtmlSrc));
    }

    // <video><source src="">
    for caps in html_video_source_regex().captures_iter(body) {
        let m = caps.get(0).unwrap();
        let raw = caps.get(3).map(|x| x.as_str()).unwrap_or("").trim().to_string();
        if !is_external_url(&raw) {
            continue;
        }
        matches.push((m.start(), m.end(), raw, MatchKind::HtmlSource));
    }

    if matches.is_empty() {
        return Ok(RewriteResult {
            new_body: body.to_string(),
            copied: 0,
            missing: Vec::new(),
            mappings: Vec::new(),
        });
    }

    // 同 URL 多处出现时去重，按位置升序后再倒序应用替换
    matches.sort_by_key(|t| t.0);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REMOTE_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Custom(format!("HTTP client 初始化失败: {}", e)))?;

    let mut copied = 0usize;
    let mut missing: Vec<String> = Vec::new();
    let mut mappings: Vec<(String, String)> = Vec::new();

    // 先按 URL 去重下载 → 缓存 (url -> Result<asset_url, ()>)，再倒序应用替换
    let mut url_cache: HashMap<String, Option<String>> = HashMap::new();
    for (_, _, url, _) in &matches {
        if url_cache.contains_key(url) {
            continue;
        }
        match download_external_video(&client, url, app_data_dir, note_id).await {
            Ok(new_url) => {
                copied += 1;
                mappings.push((url.clone(), new_url.clone()));
                url_cache.insert(url.clone(), Some(new_url));
            }
            Err(e) => {
                log::warn!(
                    "[import-video-ext] 笔记 {} 外链下载失败 ({}): {}",
                    note_id, url, e
                );
                missing.push(url.clone());
                url_cache.insert(url.clone(), None);
            }
        }
    }

    // 倒序应用替换
    let mut new_body = body.to_string();
    for (start, end, url, kind) in matches.iter().rev() {
        let Some(Some(new_url)) = url_cache.get(url) else { continue };
        // 三种来源统一转 HTML <video> —— 编辑器才能识别为 Video 节点
        // （markdown ![]() 会被 tiptap 当成 image，无法播放）
        let _ = kind;
        let replacement = format!(r#"<video src="{}" controls></video>"#, new_url);
        new_body.replace_range(*start..*end, &replacement);
    }

    // missing 去重
    let mut seen: HashMap<String, ()> = HashMap::new();
    let dedup_missing: Vec<String> = missing
        .into_iter()
        .filter(|m| seen.insert(m.clone(), ()).is_none())
        .collect();

    Ok(RewriteResult {
        new_body,
        copied,
        missing: dedup_missing,
        mappings,
    })
}

/// HEAD 验大小 → GET 下载 → 落盘 → 返回 asset URL
async fn download_external_video(
    client: &reqwest::Client,
    url: &str,
    app_data_dir: &Path,
    note_id: i64,
) -> Result<String, AppError> {
    // 1. HEAD 检查 Content-Length
    if let Ok(head) = client.head(url).send().await {
        if let Some(len_str) = head
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
        {
            if let Ok(len) = len_str.parse::<u64>() {
                if len > MAX_REMOTE_BYTES {
                    return Err(AppError::Custom(format!(
                        "视频体积 {} MB 超过外链下载上限 {} MB",
                        len / 1024 / 1024,
                        MAX_REMOTE_BYTES / 1024 / 1024
                    )));
                }
            }
        }
    }

    // 2. GET 下载
    let resp = client
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求失败: {}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Custom(format!("HTTP {}", status.as_u16())));
    }

    // 兜底再校验一次大小（HEAD 可能没返回 Content-Length，靠 GET 的 header）
    if let Some(len_str) = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
    {
        if let Ok(len) = len_str.parse::<u64>() {
            if len > MAX_REMOTE_BYTES {
                return Err(AppError::Custom(format!(
                    "视频体积 {} MB 超过外链下载上限 {} MB",
                    len / 1024 / 1024,
                    MAX_REMOTE_BYTES / 1024 / 1024
                )));
            }
        }
    }

    // 文件名扩展名：按 Content-Type 选 → URL path 兜底 → mp4 默认
    let ext = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase())
        .and_then(|ct| {
            if ct.contains("mp4") { Some("mp4") }
            else if ct.contains("webm") { Some("webm") }
            else if ct.contains("matroska") { Some("mkv") }
            else if ct.contains("quicktime") { Some("mov") }
            else if ct.contains("ogg") { Some("ogv") }
            else { None }
        })
        .or_else(|| {
            url.split('?')
                .next()
                .and_then(|p| Path::new(p).extension())
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .and_then(|e| match e.as_str() {
                    "mp4" => Some("mp4"),
                    "webm" => Some("webm"),
                    "mkv" => Some("mkv"),
                    "mov" => Some("mov"),
                    "avi" => Some("avi"),
                    "m4v" => Some("m4v"),
                    "ogv" => Some("ogv"),
                    _ => None,
                })
        })
        .unwrap_or("mp4");

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;
    if (bytes.len() as u64) > MAX_REMOTE_BYTES {
        return Err(AppError::Custom(format!(
            "视频体积 {} MB 超过外链下载上限 {} MB",
            bytes.len() / 1024 / 1024,
            MAX_REMOTE_BYTES / 1024 / 1024
        )));
    }

    let abs = VideoService::save_bytes(
        app_data_dir,
        note_id,
        &format!("external.{}", ext),
        &bytes,
    )?;
    Ok(path_to_asset_url(Path::new(&abs)))
}
