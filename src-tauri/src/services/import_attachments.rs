//! T-009 OB 整库导入：附件目录扫描 + 笔记正文图片路径重写
//!
//! 流程概要：
//! 1. 扫描 vault 根下的 OB 约定附件目录（`attachments/` `assets/` `images/` `_resources/`），
//!    建一个"basename → 源文件绝对路径"的索引（仅图片扩展名）
//! 2. 对每篇导入的 .md 笔记，解析其 body 中两类图片引用：
//!    - 标准 markdown：`![alt](path)`（路径相对当前 .md / 相对 vault 根 / 绝对路径）
//!    - OB wiki 嵌入：`![[name|alt|width]]`（按 basename 全局检索）
//! 3. 找到本地源文件后，调 `ImageService::save_from_path` 复制到
//!    `kb_assets/images/<note_id>/`，再把 body 中的引用改写成 asset URL，
//!    供 Tiptap 编辑器直接渲染
//! 4. 缺失的图片记入 `RewriteResult::missing`，让前端提示用户

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use regex::Regex;
use walkdir::WalkDir;

use crate::error::AppError;
use crate::services::image::ImageService;

/// 受支持的图片扩展名（小写比对）
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
];

/// OB 约定的附件目录名（vault 根下的同层目录，不递归）
const ATTACHMENT_DIR_NAMES: &[&str] = &["attachments", "assets", "images", "_resources"];

/// vault 根下扫到的附件索引
///
/// `by_basename` 的 key 是**小写化**的 basename；多个目录里同名文件存在时，
/// **第一个找到的胜出**（与 OB 行为一致），后续的记 warn 日志
pub struct AttachmentIndex {
    pub by_basename: HashMap<String, PathBuf>,
    /// 仅给单元测试 / 日志用，运行时业务不读
    #[allow(dead_code)]
    pub total_indexed: usize,
}

impl AttachmentIndex {
    pub fn empty() -> Self {
        Self {
            by_basename: HashMap::new(),
            total_indexed: 0,
        }
    }

    /// 扫描 vault 根下约定的附件目录，仅收图片文件
    ///
    /// 仅处理直接子目录中那几个名字（attachments / assets / images / _resources）；
    /// 不在 vault 根的图片不入索引（避免把无关图片也带进来）
    pub fn build(vault_root: &Path) -> Self {
        let mut by_basename: HashMap<String, PathBuf> = HashMap::new();
        let mut total = 0usize;

        for dir_name in ATTACHMENT_DIR_NAMES {
            let dir = vault_root.join(dir_name);
            if !dir.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .unwrap_or_default();
                if !IMAGE_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let key = match path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_ascii_lowercase(),
                    None => continue,
                };
                total += 1;
                if let Some(existing) = by_basename.get(&key) {
                    log::warn!(
                        "[import-attach] 同名附件：'{}' 已索引 {}, 忽略 {}（采用先到先得策略）",
                        key,
                        existing.display(),
                        path.display()
                    );
                    continue;
                }
                by_basename.insert(key, path.to_path_buf());
            }
        }

        Self {
            by_basename,
            total_indexed: total,
        }
    }

    /// 单文件 `open_markdown_file` 场景的轻量索引
    ///
    /// 与 `build` 区别：没有 vault 概念，锚点是 .md 同级目录。
    /// 扫描范围（仅图片扩展名）：
    ///   1. note_dir **自身**：非递归（只扫直接子文件，避免误吸下层无关图片）
    ///   2. note_dir 下的 OB 约定附件子目录（`attachments/` `assets/` `images/` `_resources/`）：递归
    ///
    /// 这样能识别两种常见 OB 单文件布局：
    ///   - `xxx.md` + 同级图片散落：`note_dir/IMG.png`
    ///   - `xxx.md` + 同级 `attachments/`：`note_dir/attachments/IMG.png`（用户实测场景）
    ///
    /// 同名先到先得（与 `build` 一致）；note_dir 自身的图片优先于子目录里的同名图片。
    pub fn build_for_single_file(note_dir: &Path) -> Self {
        let mut by_basename: HashMap<String, PathBuf> = HashMap::new();
        let mut total = 0usize;

        // pass 1：note_dir 自身（非递归）
        if note_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(note_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default();
                    if !IMAGE_EXTS.contains(&ext.as_str()) {
                        continue;
                    }
                    let key = match path.file_name().and_then(|s| s.to_str()) {
                        Some(n) => n.to_ascii_lowercase(),
                        None => continue,
                    };
                    total += 1;
                    by_basename.entry(key).or_insert(path);
                }
            }
        }

        // pass 2：note_dir/<attach-dir>/**（递归，复用 build 的约定目录列表）
        for dir_name in ATTACHMENT_DIR_NAMES {
            let dir = note_dir.join(dir_name);
            if !dir.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .unwrap_or_default();
                if !IMAGE_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let key = match path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_ascii_lowercase(),
                    None => continue,
                };
                total += 1;
                if let Some(existing) = by_basename.get(&key) {
                    log::warn!(
                        "[import-single] 同名附件：'{}' 已索引 {}, 忽略 {}（先到先得）",
                        key,
                        existing.display(),
                        path.display()
                    );
                    continue;
                }
                by_basename.insert(key, path.to_path_buf());
            }
        }

        Self {
            by_basename,
            total_indexed: total,
        }
    }
}

/// 单篇笔记 body 重写结果
pub struct RewriteResult {
    pub new_body: String,
    /// 这条笔记里**新复制成功**的图片张数（每个引用都计 1，即使源文件相同）
    pub copied: usize,
    /// 缺失的图片（用户原始引用文本，去重后展示给用户）
    pub missing: Vec<String>,
    /// 每次成功替换的 `(原始 URL, 内部 asset URL)` 对
    ///
    /// 给"打开 .md → 编辑 → 写回原文件"流程用：写回时按 internal_url 反查原 URL，
    /// 保证原文件链接形态不变（用户的 ./images/foo.png / https://... 不被替换）。
    /// 单文件 open_markdown_file 会把这里的对入库到 note_url_mapping。
    pub mappings: Vec<(String, String)>,
}

impl RewriteResult {
    /// 构造一个"未改动"的结果
    fn unchanged(body: String) -> Self {
        Self {
            new_body: body,
            copied: 0,
            missing: Vec::new(),
            mappings: Vec::new(),
        }
    }
}

fn md_image_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // 标准 markdown 图片：`![alt](dest)`。
        //
        // 这里**只负责框出 `(...)` 的全部内容**，具体怎么切出 URL 交给
        // `parse_md_destination`。原实现直接用 `([^)\s]+)` 捕获 URL，等于要求
        // 路径不含空格 —— 飞书 / 语雀导出的图片文件名带空格是常态
        // （`![](images/截图 2026-08-11.png)`），regex 整条匹配不上，那个引用
        // 既不会被改写也不会计入 missing，用户端毫无提示、图静默变死链。
        //
        // 仍不支持路径里出现 `)`（与放宽前一致，markdown 本身也要求那种情况转义）。
        Regex::new(r#"!\[([^\]]*)\]\(([^)]*)\)"#).unwrap()
    })
}

/// HTML `<img src="...">` 标签（飞书 / 语雀把富文本导出成 .md 时，图片经常
/// 退化成 HTML 标签而不是 `![]()` 语法）。捕获组 1 = src 属性值。
///
/// 属性值支持双引号 / 单引号；`src` 在标签里的位置任意。
fn html_img_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?is)<img\s[^>]*?src\s*=\s*("[^"]*"|'[^']*')[^>]*>"#).unwrap())
}

/// 从 markdown 图片的 `(...)` 内容里切出真正的 URL（destination）。
///
/// 处理三种形态：
/// - `<images/a b.png>` —— CommonMark 里承载「含空格路径」的标准写法，取尖括号内部
/// - `images/a.png "标题"` —— 尾部可选 title（双引号 / 单引号 / 圆括号三种都算）
/// - `images/a b.png` —— 未转义空格的裸路径，整体保留（导出器的常见不规范写法）
///
/// 判定顺序很重要：先剥尖括号，再剥 title，剩下的**不做空格切分**，
/// 这样 `a b.png` 不会被截成 `a`。
fn parse_md_destination(inner: &str) -> &str {
    let s = inner.trim();

    // `<...>` 包裹：内部原样就是路径（含空格）
    if let Some(rest) = s.strip_prefix('<') {
        if let Some(end) = rest.find('>') {
            return rest[..end].trim();
        }
    }

    // 尾部 title：` "..."` / ` '...'` / ` (...)`
    for (open, close) in [('"', '"'), ('\'', '\''), ('(', ')')] {
        if s.ends_with(close) {
            // 从右往左找 title 的起始引号，且它前面必须是空白 —— 否则
            // `a(1).png` 这种文件名会被误当成 title
            if let Some(idx) = s[..s.len() - close.len_utf8()].rfind(open) {
                let before = s[..idx].trim_end();
                if idx > 0 && before.len() < idx && !before.is_empty() {
                    return before;
                }
            }
        }
    }

    s
}

fn ob_wiki_embed_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // OB 嵌入：`![[name]]` / `![[name|alt]]` / `![[name|alt|300]]`
        // name 不含 `|` 和 `]`
        Regex::new(r"!\[\[([^\]\|]+?)(\|[^\]]*)?\]\]").unwrap()
    })
}

/// 导入流程专用的图片落盘 helper：读源字节 → 走 `ImageService::save_bytes` 明文版本。
///
/// 不直接调 `save_from_path`，因为后者是 routed 版本（按笔记 is_encrypted 自动加密），
/// 需要 db / vault 引用，而 import 流程上下文没有 vault；又因为 import 总是给新建笔记
/// （is_encrypted = false 默认），明文落盘是正确语义。
fn copy_to_image_store(
    app_data_dir: &Path,
    note_id: i64,
    source: &Path,
) -> Result<String, AppError> {
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png");
    let data = std::fs::read(source)?;
    ImageService::save_bytes(app_data_dir, note_id, file_name, &data)
}

/// 把绝对路径转成 Tauri asset 协议 URL
///
/// Win:  http://asset.localhost/<encoded>
/// 其他: asset://localhost/<encoded>
///
/// 与前端 `convertFileSrc(absPath)` 行为一致；CSP 已在 tauri.conf.json 放行。
pub fn path_to_asset_url(abs: &Path) -> String {
    let s = abs.to_string_lossy().replace('\\', "/");
    let encoded = urlencoding::encode(&s);
    if cfg!(target_os = "windows") {
        format!("http://asset.localhost/{}", encoded)
    } else {
        format!("asset://localhost/{}", encoded)
    }
}

/// 在 body 中重写所有图片引用为 asset URL
///
/// `note_file_dir` 用于解析 `./xxx` / `xxx.png` 之类相对当前 .md 的路径
/// `vault_root` 用于解析 `attachments/foo.png` 之类相对 vault 根的路径
/// `index` 是预建的全局 basename 索引（OB wiki / fallback）
/// `app_data_dir` 给 `ImageService` 用
pub fn rewrite_image_paths(
    body: &str,
    note_id: i64,
    note_file_dir: &Path,
    vault_root: &Path,
    index: &AttachmentIndex,
    app_data_dir: &Path,
) -> Result<RewriteResult, AppError> {
    if body.is_empty() {
        return Ok(RewriteResult::unchanged(String::new()));
    }

    let mut copied = 0usize;
    let mut missing: Vec<String> = Vec::new();
    let mut mappings: Vec<(String, String)> = Vec::new();

    // ─── pass 1：替换标准 markdown `![alt](path)` ───
    let md_re = md_image_regex();
    let after_md = md_re
        .replace_all(body, |caps: &regex::Captures| {
            let full_match = caps.get(0).unwrap().as_str().to_string();
            let alt = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            // 捕获组 2 是 `(...)` 的全部内容，需再解析出 destination
            // （剥尖括号 / 尾部 title，保留路径内部空格）
            let raw_url = parse_md_destination(caps.get(2).map(|m| m.as_str()).unwrap_or(""));
            if raw_url.is_empty() {
                return full_match;
            }

            // 内联 data URL 图片（`data:image/png;base64,...`）：解码落盘 + 改写为 asset URL。
            // 必须在 is_external_or_asset_url 之前判断（后者会把 data: 当外链跳过）。
            // 不记 mapping —— 目的就是永久消除这串超大 base64，写回 .md 时不该还原。
            if let Some((ext, bytes)) = try_decode_image_data_url(raw_url) {
                let fname = format!("inline.{}", ext);
                match ImageService::save_bytes(app_data_dir, note_id, &fname, &bytes) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        return format!("![{}]({})", alt, url);
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-attach] 笔记 {} 内联 data URL 图片落盘失败: {}",
                            note_id,
                            e
                        );
                        missing.push("data:image (内联 base64 图)".to_string());
                        return full_match;
                    }
                }
            }

            // 跳过外链 / 已经是 asset URL（重复运行幂等）
            if is_external_or_asset_url(raw_url) {
                return full_match;
            }

            let decoded = urlencoding::decode(raw_url)
                .map(|s| s.into_owned())
                .unwrap_or_else(|_| raw_url.to_string());

            // 解析候选源路径：先按当前 .md 目录，再按 vault 根，再按 basename 索引
            let resolved = resolve_local_image(&decoded, note_file_dir, vault_root, index);
            match resolved {
                Some(src) => {
                    // 导入流程：笔记是当前 import 新建的，is_encrypted 默认 false，
                    // 直接走明文 save_bytes，避开 routed 路径对 vault 的依赖
                    match copy_to_image_store(app_data_dir, note_id, &src) {
                        Ok(new_abs) => {
                            copied += 1;
                            let url = path_to_asset_url(Path::new(&new_abs));
                            // 记录映射：写回原 .md 时按 internal_url 反查，恢复用户原始链接
                            mappings.push((raw_url.to_string(), url.clone()));
                            format!("![{}]({})", alt, url)
                        }
                        Err(e) => {
                            log::warn!(
                                "[import-attach] 笔记 {} 图片复制失败 ({}): {}",
                                note_id,
                                src.display(),
                                e
                            );
                            missing.push(raw_url.to_string());
                            full_match
                        }
                    }
                }
                None => {
                    missing.push(raw_url.to_string());
                    full_match
                }
            }
        })
        .into_owned();

    // ─── pass 2：替换 OB wiki 嵌入 `![[name|alt|w]]` ───
    let wiki_re = ob_wiki_embed_regex();
    let after_wiki = wiki_re
        .replace_all(&after_md, |caps: &regex::Captures| {
            let full_match = caps.get(0).unwrap().as_str().to_string();
            let raw_name = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
            let extra = caps.get(2).map(|m| m.as_str()).unwrap_or(""); // 含前导 |

            // 仅处理图片扩展名；非图片（如 ![[some-note]] 嵌入笔记）保持原样
            if !is_image_filename(raw_name) {
                return full_match;
            }

            let key = Path::new(raw_name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(raw_name)
                .to_ascii_lowercase();

            match index.by_basename.get(&key) {
                Some(src) => {
                    match copy_to_image_store(app_data_dir, note_id, src) {
                        Ok(new_abs) => {
                            copied += 1;
                            let url = path_to_asset_url(Path::new(&new_abs));
                            // 保留 wiki 的 alt（| 之后的第一段），舍弃宽度（v1 不处理）
                            let alt_text = parse_wiki_alt(extra);
                            // wiki 嵌入也记映射：写回时把 internal URL 还原为 ![[name]] 不太靠谱，
                            // 这里只记一对到表里，用户在编辑器里把它转成普通 markdown 也能正常反查。
                            mappings.push((raw_name.to_string(), url.clone()));
                            format!("![{}]({})", alt_text, url)
                        }
                        Err(e) => {
                            log::warn!(
                                "[import-attach] 笔记 {} OB-wiki 图片复制失败 ({}): {}",
                                note_id,
                                src.display(),
                                e
                            );
                            missing.push(raw_name.to_string());
                            full_match
                        }
                    }
                }
                None => {
                    missing.push(raw_name.to_string());
                    full_match
                }
            }
        })
        .into_owned();

    // ─── pass 3：替换 HTML `<img src="...">` ───
    // 飞书 / 语雀导出富文本 .md 时，图片常退化成 HTML 标签而不是 `![]()` 语法。
    // 只换 src 属性值，标签其余属性（width / alt / style）原样保留。
    let html_re = html_img_regex();
    let after_html = html_re
        .replace_all(&after_wiki, |caps: &regex::Captures| {
            let full_match = caps.get(0).unwrap().as_str().to_string();
            let quoted = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            // 去掉外层引号（正则已保证成对）
            let raw_url = quoted
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| quoted.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(quoted)
                .trim();
            if raw_url.is_empty() {
                return full_match;
            }

            // 内联 data URL：解码落盘（与 pass 1 同策略，不记 mapping）
            if let Some((ext, bytes)) = try_decode_image_data_url(raw_url) {
                let fname = format!("inline.{}", ext);
                match ImageService::save_bytes(app_data_dir, note_id, &fname, &bytes) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        return full_match.replace(quoted, &format!("\"{}\"", url));
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-attach] 笔记 {} HTML img 内联 data URL 落盘失败: {}",
                            note_id,
                            e
                        );
                        missing.push("data:image (内联 base64 图)".to_string());
                        return full_match;
                    }
                }
            }

            // 外链 / 已是 asset URL：留给 rewrite_external_images 或幂等跳过
            if is_external_or_asset_url(raw_url) {
                return full_match;
            }

            let decoded = urlencoding::decode(raw_url)
                .map(|s| s.into_owned())
                .unwrap_or_else(|_| raw_url.to_string());

            match resolve_local_image(&decoded, note_file_dir, vault_root, index) {
                Some(src) => match copy_to_image_store(app_data_dir, note_id, &src) {
                    Ok(new_abs) => {
                        copied += 1;
                        let url = path_to_asset_url(Path::new(&new_abs));
                        mappings.push((raw_url.to_string(), url.clone()));
                        full_match.replace(quoted, &format!("\"{}\"", url))
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-attach] 笔记 {} HTML img 复制失败 ({}): {}",
                            note_id,
                            src.display(),
                            e
                        );
                        missing.push(raw_url.to_string());
                        full_match
                    }
                },
                None => {
                    missing.push(raw_url.to_string());
                    full_match
                }
            }
        })
        .into_owned();

    // missing 去重（保持插入顺序）
    let mut seen: HashMap<String, ()> = HashMap::new();
    let dedup_missing: Vec<String> = missing
        .into_iter()
        .filter(|m| seen.insert(m.clone(), ()).is_none())
        .collect();

    Ok(RewriteResult {
        new_body: after_html,
        copied,
        missing: dedup_missing,
        mappings,
    })
}

fn is_external_or_asset_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://asset.localhost/")
        || lower.starts_with("asset://")
        || lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("data:")
        || lower.starts_with("file://")
        || lower.starts_with("kb-image://")
}

/// 尝试把 `data:image/<subtype>;base64,<payload>` 解码成 `(扩展名, 字节)`。
///
/// 仅识别 `image/*` 且 base64 编码的 data URL（Notion / 飞书 / 网页剪藏导出的 .md
/// 常把图片内联成这种形式）。非 data URL / 非图片 / 非 base64 / 解码失败都返回 None，
/// 调用方据此回退到"按外链跳过"的原逻辑。
///
/// base64 payload 里可能夹换行/空白（某些导出器会折行），统一剔除后再解码。
fn try_decode_image_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    // 去掉 "data:" 前缀；rest 形如 "image/png;base64,iVBOR..."
    let rest = url.strip_prefix("data:").or_else(|| url.strip_prefix("DATA:"))?;
    let comma = rest.find(',')?;
    let (meta, payload_with_comma) = rest.split_at(comma);
    let payload = &payload_with_comma[1..]; // 跳过逗号

    let meta_lower = meta.to_ascii_lowercase();
    if !meta_lower.starts_with("image/") || !meta_lower.contains("base64") {
        return None;
    }

    // 取子类型：image/png;base64 → "png"
    let subtype = meta_lower["image/".len()..]
        .split(';')
        .next()
        .unwrap_or("png");
    let ext = match subtype {
        "jpeg" | "jpg" => "jpg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        "svg+xml" | "svg" => "svg",
        "bmp" => "bmp",
        "x-icon" | "vnd.microsoft.icon" | "ico" => "ico",
        "avif" => "avif",
        _ => "png",
    };

    // 剔除 payload 内的换行/空白后再解码
    let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((ext.to_string(), bytes))
}

fn is_image_filename(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| IMAGE_EXTS.contains(&s.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 解析 wiki 嵌入的 `|alt|w` 后缀；返回纯 alt（无宽度）
fn parse_wiki_alt(extra: &str) -> &str {
    if extra.is_empty() {
        return "";
    }
    // 去掉前导 |
    let s = extra.strip_prefix('|').unwrap_or(extra);
    // 取第一段（| 切分）；若它纯是数字（即 OB 写宽度的形式 `![[a.png|300]]`），返回空 alt
    let first = s.split('|').next().unwrap_or("");
    if first.trim().chars().all(|c| c.is_ascii_digit()) {
        ""
    } else {
        first
    }
}

/// 给定一个原始引用，依次尝试：当前 .md 目录 → vault 根 → 全局 basename 索引
fn resolve_local_image(
    raw_url: &str,
    note_file_dir: &Path,
    vault_root: &Path,
    index: &AttachmentIndex,
) -> Option<PathBuf> {
    // 绝对路径直接判定
    let p = Path::new(raw_url);
    if p.is_absolute() && p.is_file() {
        return Some(p.to_path_buf());
    }

    // 相对当前 .md 目录
    let rel_to_note = note_file_dir.join(raw_url);
    if rel_to_note.is_file() {
        return Some(rel_to_note);
    }

    // 相对 vault 根
    let rel_to_vault = vault_root.join(raw_url);
    if rel_to_vault.is_file() {
        return Some(rel_to_vault);
    }

    // 兜底：按 basename 在全局索引里查
    let basename = Path::new(raw_url)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    if let Some(key) = basename {
        if let Some(p) = index.by_basename.get(&key) {
            return Some(p.clone());
        }
    }

    None
}

// ─── 外链图片下载（导入时把 https://... 图片落盘） ───────────────────────
//
// 场景：从微信公众号 / 简书 / 网页剪藏导出的 markdown 里图片是 https:// 外链，
// 直接渲染会被对方 CDN 防盗链拦下（典型如微信 mmbiz.qpic.cn 校验 Referer）。
// 导入时把图片下载到本地 kb_assets/images/<note_id>/ 后改写为 asset URL，
// 离线可见 + 永久持有。
//
// 单独提供一个 async 函数，与同步的 `rewrite_image_paths`（处理本地相对路径）
// 串联使用：先跑同步版处理本地文件，再跑这个 async 版处理外链。

/// 一条待下载的外链图片引用在原文里的形态 —— 决定下载成功后怎么把它写回去。
enum ExternalRefKind {
    /// markdown `![alt](url)`：整段按新 URL 重建
    Markdown { alt: String },
    /// HTML `<img … src="url" …>`：只替换 src 属性值，其余属性原样保留
    Html { full: String, quoted: String },
}

/// 单独处理 body 中所有 http(s):// 图片引用。
///
/// 覆盖 markdown `![alt](url)` 与 HTML `<img src="url">` 两种写法 —— 飞书 / 语雀
/// 导出的 .md 里两者都会出现，只认 markdown 会让 HTML 那批外链图永远留在原站，
/// 离线或对方防盗链时就是一片裂图。
///
/// 为已经是 asset URL 的引用做幂等保护；下载失败的引用保留原样并记入 missing。
/// 执行顺序：从后往前替换字符串，避免位置漂移。
pub async fn rewrite_external_images(
    body: &str,
    note_id: i64,
    app_data_dir: &Path,
) -> Result<RewriteResult, AppError> {
    if body.is_empty() {
        return Ok(RewriteResult::unchanged(String::new()));
    }

    /// 这个 URL 是否是需要下载的真外链（排除已本地化的 asset 形态）
    fn is_downloadable(url: &str) -> bool {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("http://asset.localhost/") || lower.starts_with("asset://") {
            return false;
        }
        lower.starts_with("http://") || lower.starts_with("https://")
    }

    // (start, end, kind, url) — 仅收集真正的 http(s):// 外链
    let mut matches: Vec<(usize, usize, ExternalRefKind, String)> = Vec::new();

    for caps in md_image_regex().captures_iter(body) {
        let m = caps.get(0).unwrap();
        let alt = caps.get(1).map(|x| x.as_str()).unwrap_or("").to_string();
        let raw_url =
            parse_md_destination(caps.get(2).map(|x| x.as_str()).unwrap_or("")).to_string();
        if is_downloadable(&raw_url) {
            matches.push((m.start(), m.end(), ExternalRefKind::Markdown { alt }, raw_url));
        }
    }

    for caps in html_img_regex().captures_iter(body) {
        let m = caps.get(0).unwrap();
        let quoted = caps.get(1).map(|x| x.as_str()).unwrap_or("").to_string();
        let raw_url = quoted
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| quoted.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
            .unwrap_or(&quoted)
            .trim()
            .to_string();
        if is_downloadable(&raw_url) {
            matches.push((
                m.start(),
                m.end(),
                ExternalRefKind::Html {
                    full: m.as_str().to_string(),
                    quoted,
                },
                raw_url,
            ));
        }
    }

    // 两轮扫描各自有序，合并后必须按位置重排 —— 后面的倒序替换依赖这个顺序
    matches.sort_by_key(|(start, _, _, _)| *start);

    if matches.is_empty() {
        return Ok(RewriteResult::unchanged(body.to_string()));
    }

    // 30s 超时，避免单张大图卡死整个导入流程
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Custom(format!("HTTP client 初始化失败: {}", e)))?;

    let mut copied = 0usize;
    let mut missing: Vec<String> = Vec::new();
    // 顺序下载（微信 CDN 并发请求容易触发限流；导入是后台流程，串行就够用）
    let mut replacements: Vec<Option<String>> = Vec::with_capacity(matches.len());
    for (_, _, _, url) in &matches {
        match download_external_image(&client, url).await {
            Ok((bytes, file_name)) => {
                match crate::services::image::ImageService::save_bytes(
                    app_data_dir,
                    note_id,
                    &file_name,
                    &bytes,
                ) {
                    Ok(abs) => {
                        let new_url = path_to_asset_url(Path::new(&abs));
                        replacements.push(Some(new_url));
                        copied += 1;
                    }
                    Err(e) => {
                        log::warn!(
                            "[import-external] 笔记 {} 图片落盘失败 ({}): {}",
                            note_id,
                            url,
                            e
                        );
                        replacements.push(None);
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[import-external] 笔记 {} 外链下载失败 ({}): {}",
                    note_id,
                    url,
                    e
                );
                replacements.push(None);
            }
        }
    }

    // 倒序应用替换，避免前面的替换让后面的 start/end 错位
    let mut new_body = body.to_string();
    let mut mappings: Vec<(String, String)> = Vec::new();
    for (i, repl) in replacements.iter().enumerate().rev() {
        let (start, end, kind, raw_url) = &matches[i];
        match repl {
            Some(new_url) => {
                // 按原形态回写：markdown 重建整段，HTML 只换 src 值保住其余属性
                let replacement = match kind {
                    ExternalRefKind::Markdown { alt } => format!("![{}]({})", alt, new_url),
                    ExternalRefKind::Html { full, quoted } => {
                        full.replace(quoted.as_str(), &format!("\"{}\"", new_url))
                    }
                };
                new_body.replace_range(*start..*end, &replacement);
                // 写回原 .md 时按 internal_url 反查回原始 https://... 链接
                mappings.push((raw_url.clone(), new_url.clone()));
            }
            None => {
                missing.push(raw_url.clone());
            }
        }
    }

    // missing 去重保持顺序
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

/// 下载单张外链图片，按 host 决定合适的 Referer 绕开常见防盗链。
///
/// 返回 `(字节, 文件名)`；文件名只承载扩展名，最终落盘名由 `ImageService::save_bytes`
/// 用时间戳+序号生成，不会重名。
async fn download_external_image(
    client: &reqwest::Client,
    url: &str,
) -> Result<(Vec<u8>, String), AppError> {
    // 按 host 选 Referer：微信公众号用官方域名，知乎/简书等其他平台用站点首页
    let lower = url.to_ascii_lowercase();
    let referer: Option<&str> =
        if lower.contains("mmbiz.qpic.cn") || lower.contains("weixin.qq.com") {
            Some("https://mp.weixin.qq.com/")
        } else if lower.contains("zhimg.com") || lower.contains("zhihu.com") {
            Some("https://www.zhihu.com/")
        } else if lower.contains("upload-images.jianshu.io") || lower.contains("jianshu.com") {
            Some("https://www.jianshu.com/")
        } else if lower.contains("csdnimg.cn") || lower.contains("csdn.net") {
            Some("https://blog.csdn.net/")
        } else {
            None
        };

    let mut req = client.get(url).header(
        "User-Agent",
        // 微信 CDN 对纯 reqwest UA 也比较敏感，伪装成桌面浏览器最稳
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    );
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求失败: {}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Custom(format!("HTTP {}", status.as_u16())));
    }

    // 文件名：按 Content-Type 选扩展名，找不到则按 URL path 兜底
    let ext = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase())
        .and_then(|ct| {
            if ct.contains("jpeg") || ct.contains("jpg") {
                Some("jpg")
            } else if ct.contains("png") {
                Some("png")
            } else if ct.contains("gif") {
                Some("gif")
            } else if ct.contains("webp") {
                Some("webp")
            } else if ct.contains("svg") {
                Some("svg")
            } else if ct.contains("bmp") {
                Some("bmp")
            } else {
                None
            }
        })
        .or_else(|| {
            // 退路：从 URL path 提取扩展名
            url.split('?')
                .next()
                .and_then(|p| Path::new(p).extension())
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .and_then(|e| {
                    if IMAGE_EXTS.contains(&e.as_str()) {
                        // 这里需要 'static str，做映射
                        match e.as_str() {
                            "jpg" => Some("jpg"),
                            "jpeg" => Some("jpg"),
                            "png" => Some("png"),
                            "gif" => Some("gif"),
                            "webp" => Some("webp"),
                            "svg" => Some("svg"),
                            "bmp" => Some("bmp"),
                            "avif" => Some("avif"),
                            "ico" => Some("ico"),
                            _ => None,
                        }
                    } else {
                        None
                    }
                })
        })
        .unwrap_or("png");

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;

    Ok((bytes.to_vec(), format!("external.{}", ext)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kb-import-attach-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造一个最小 vault：vault_root/attachments/foo.png + bar.png；返回 (vault, app_data)
    fn make_vault() -> (PathBuf, PathBuf) {
        let root = temp_root();
        let vault = root.join("vault");
        let app_data = root.join("app_data");
        std::fs::create_dir_all(vault.join("attachments")).unwrap();
        std::fs::create_dir_all(vault.join("images")).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        // 写 1px PNG header — 内容不重要，只要文件存在
        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\n";
        std::fs::write(vault.join("attachments/foo.png"), png_bytes).unwrap();
        std::fs::write(vault.join("attachments/bar.png"), png_bytes).unwrap();
        std::fs::write(vault.join("images/space pic.jpg"), png_bytes).unwrap();
        (vault, app_data)
    }

    #[test]
    fn build_index_collects_images_by_basename() {
        let (vault, _) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        assert_eq!(idx.total_indexed, 3);
        assert!(idx.by_basename.contains_key("foo.png"));
        assert!(idx.by_basename.contains_key("bar.png"));
        assert!(idx.by_basename.contains_key("space pic.jpg"));
    }

    #[test]
    fn rewrite_standard_md_link() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "# T\n\n![描述](attachments/foo.png)\n";
        let r = rewrite_image_paths(body, 42, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1);
        assert!(r.missing.is_empty());
        assert!(
            r.new_body.contains("asset.localhost") || r.new_body.contains("asset://localhost"),
            "应被改写成 asset URL，实际：{}",
            r.new_body
        );
        // alt 文本保留
        assert!(r.new_body.contains("![描述]"));
    }

    #[test]
    fn rewrite_obsidian_wiki_embed_with_alt_and_width() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "前文 ![[bar.png|示例图|400]] 后文";
        let r = rewrite_image_paths(body, 7, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1);
        // alt 取第一段 "示例图"，宽度 400 被丢弃
        assert!(r.new_body.contains("![示例图]"), "得到：{}", r.new_body);
    }

    #[test]
    fn rewrite_obsidian_wiki_embed_pure_width() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "![[foo.png|300]]";
        let r = rewrite_image_paths(body, 7, &vault, &vault, &idx, &app_data).unwrap();
        // 纯数字宽度 → alt 留空
        assert!(r.new_body.starts_with("![]("), "得到：{}", r.new_body);
    }

    #[test]
    fn external_urls_not_touched() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "![remote](https://cdn.example.com/x.png) ![data](data:image/png;base64,AAA)";
        let r = rewrite_image_paths(body, 1, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 0);
        assert!(r.missing.is_empty());
        assert_eq!(r.new_body, body); // 一模一样
    }

    #[test]
    fn missing_image_recorded_and_body_preserved() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "![](attachments/notexist.png)";
        let r = rewrite_image_paths(body, 1, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 0);
        assert_eq!(r.missing, vec!["attachments/notexist.png".to_string()]);
        // body 保留原引用，便于用户后续手动修
        assert_eq!(r.new_body, body);
    }

    #[test]
    fn wiki_embed_falls_back_to_basename_index() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        // 写法没带目录，OB 风格按 basename 全局查
        let body = "![[foo.png]]";
        let r = rewrite_image_paths(body, 1, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1);
        assert!(r.missing.is_empty());
    }

    #[test]
    fn idempotent_when_already_asset_url() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        // 二次跑（用户重导入同一个被改写过的笔记）不会再次复制
        let body = "![](http://asset.localhost/some/path.png)";
        let r = rewrite_image_paths(body, 1, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 0);
        assert!(r.missing.is_empty());
        assert_eq!(r.new_body, body);
    }

    /// 构造一个"单文件"目录布局：note_dir/note.md + note_dir/IMG-flat.png
    /// + note_dir/attachments/IMG-sub.png；返回 (note_dir, app_data)
    fn make_single_file_layout() -> (PathBuf, PathBuf) {
        let root = temp_root();
        let note_dir = root.join("note_dir");
        let app_data = root.join("app_data");
        std::fs::create_dir_all(note_dir.join("attachments")).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        let png: &[u8] = b"\x89PNG\r\n\x1a\n";
        // 同级散落
        std::fs::write(note_dir.join("IMG-flat.png"), png).unwrap();
        // attachments 子目录
        std::fs::write(note_dir.join("attachments/IMG-sub.png"), png).unwrap();
        (note_dir, app_data)
    }

    #[test]
    fn single_file_index_picks_up_sibling_and_attachments() {
        let (note_dir, _) = make_single_file_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        assert_eq!(idx.total_indexed, 2, "应同时扫到 flat + attachments");
        assert!(idx.by_basename.contains_key("img-flat.png"));
        assert!(idx.by_basename.contains_key("img-sub.png"));
    }

    #[test]
    fn single_file_wiki_embed_hits_attachments_subdir() {
        let (note_dir, app_data) = make_single_file_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        // OB wiki 写法 + 图片在 attachments/ 子目录 → 走 basename 索引命中
        let body = "正文 ![[IMG-sub.png]] 后文";
        let r = rewrite_image_paths(body, 99, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "应命中并复制：{}", r.new_body);
        assert!(r.missing.is_empty(), "missing 应空：{:?}", r.missing);
        assert!(
            r.new_body.contains("asset.localhost") || r.new_body.contains("asset://localhost"),
            "应改写为 asset URL：{}",
            r.new_body
        );
    }

    #[test]
    fn single_file_wiki_embed_hits_sibling_image() {
        let (note_dir, app_data) = make_single_file_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        // OB wiki 写法 + 图片就在 .md 同级 → 走 basename 索引也命中
        let body = "![[IMG-flat.png]]";
        let r = rewrite_image_paths(body, 99, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "同级图片应命中：{}", r.new_body);
        assert!(r.missing.is_empty());
    }

    #[test]
    fn single_file_index_non_recursive_for_note_dir() {
        // 验证 note_dir 自身只扫直接子文件，不递归（递归仅限附件子目录）
        let root = temp_root();
        let note_dir = root.join("nd");
        // 在 note_dir 下又建一个非约定子目录 sub_misc/，放图片
        std::fs::create_dir_all(note_dir.join("sub_misc")).unwrap();
        let png: &[u8] = b"\x89PNG\r\n\x1a\n";
        std::fs::write(note_dir.join("sub_misc/should_not_be_indexed.png"), png).unwrap();
        std::fs::write(note_dir.join("ok.png"), png).unwrap();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        assert!(idx.by_basename.contains_key("ok.png"));
        assert!(!idx.by_basename.contains_key("should_not_be_indexed.png"));
    }

    #[test]
    fn decode_data_url_png() {
        // 1x1 透明 PNG 的标准 base64
        let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYG2pY3mAAAAAElFTkSuQmCC";
        let r = try_decode_image_data_url(url);
        assert!(r.is_some(), "应能解码 1x1 png data URL");
        let (ext, bytes) = r.unwrap();
        assert_eq!(ext, "png");
        assert!(bytes.starts_with(b"\x89PNG"), "解码出的字节应是 PNG 头");
    }

    #[test]
    fn decode_data_url_rejects_non_image() {
        assert!(try_decode_image_data_url("data:text/plain;base64,aGVsbG8=").is_none());
        assert!(try_decode_image_data_url("https://x.com/a.png").is_none());
        assert!(try_decode_image_data_url("attachments/foo.png").is_none());
        // 非 base64 编码的 data URL（如 svg 文本）暂不支持
        assert!(try_decode_image_data_url("data:image/svg+xml,<svg></svg>").is_none());
    }

    #[test]
    fn rewrite_inline_data_url_image() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "前文 ![Image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYG2pY3mAAAAAElFTkSuQmCC) 后文";
        let r = rewrite_image_paths(body, 555, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "内联 base64 图应被落盘：{}", r.new_body);
        assert!(r.missing.is_empty());
        assert!(
            r.new_body.contains("asset.localhost") || r.new_body.contains("asset://localhost"),
            "应改写为 asset URL：{}",
            r.new_body
        );
        // 原始超大 base64 串应已从正文消失
        assert!(!r.new_body.contains("base64,"), "正文不应再含 base64 串");
        // alt 文本保留
        assert!(r.new_body.contains("![Image]"));
        // data URL 不记 mapping（避免写回 .md 时还原巨大 base64）
        assert!(r.mappings.is_empty(), "data URL 不应记 mapping");
    }

    /// 造一个飞书 / 语雀导出的典型布局：note.md + 同级 images/，
    /// 图片名含空格（导出器常见）。返回 (note_dir, app_data)
    fn make_feishu_layout() -> (PathBuf, PathBuf) {
        let root = temp_root();
        let note_dir = root.join("feishu");
        let app_data = root.join("app_data");
        std::fs::create_dir_all(note_dir.join("images")).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        let png: &[u8] = b"\x89PNG\r\n\x1a\n";
        std::fs::write(note_dir.join("images/plain.png"), png).unwrap();
        std::fs::write(note_dir.join("images/with space.png"), png).unwrap();
        (note_dir, app_data)
    }

    /// 回归：路径含**未编码空格**（`![](images/with space.png)`）。
    ///
    /// 旧 regex 的 URL 捕获是 `([^)\s]+)` —— 遇到空格整条匹配不上，那个引用既不被
    /// 改写也不计入 missing，用户端毫无提示、图静默变死链。飞书 / 语雀导出的图片
    /// 文件名带空格是常态，这是「导入后图片不显示」的头号成因。
    #[test]
    fn rewrite_md_path_with_unencoded_space() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        let body = "![](images/with space.png)";
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "含空格路径应被识别并复制：{}", r.new_body);
        assert!(r.missing.is_empty(), "不该记缺失：{:?}", r.missing);
        assert!(
            r.new_body.contains("asset.localhost") || r.new_body.contains("asset://localhost"),
            "应改写为 asset URL：{}",
            r.new_body
        );
    }

    /// 回归：CommonMark 承载含空格路径的标准写法 `![](<a b.png>)`
    #[test]
    fn rewrite_md_angle_bracket_destination() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        let body = "![图](<images/with space.png>)";
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "尖括号包裹应被识别：{}", r.new_body);
        assert!(r.missing.is_empty());
        assert!(!r.new_body.contains('<'), "尖括号不该残留：{}", r.new_body);
        assert!(r.new_body.contains("![图]"), "alt 应保留：{}", r.new_body);
    }

    /// 回归：HTML `<img src>` 写法（飞书 / 语雀导出富文本时图片常退化成标签）
    #[test]
    fn rewrite_html_img_tag() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        let body = r#"<img src="images/plain.png" width="600" alt="示意" />"#;
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "HTML img 应被识别：{}", r.new_body);
        assert!(r.missing.is_empty());
        assert!(
            r.new_body.contains("asset.localhost") || r.new_body.contains("asset://localhost"),
            "src 应被改写：{}",
            r.new_body
        );
        // 其余属性必须原样保留，否则宽度 / alt 会在导入后丢失
        assert!(r.new_body.contains(r#"width="600""#), "width 应保留：{}", r.new_body);
        assert!(r.new_body.contains(r#"alt="示意""#), "alt 应保留：{}", r.new_body);
    }

    /// HTML img 单引号属性 + 内联 data URL 也要能处理
    #[test]
    fn rewrite_html_img_single_quote_and_data_url() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);

        let body = "<img src='images/plain.png'>";
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "单引号属性应被识别：{}", r.new_body);

        let data = "<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYG2pY3mAAAAAElFTkSuQmCC\">";
        let r2 = rewrite_image_paths(data, 2, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r2.copied, 1, "HTML img 内联 base64 应落盘：{}", r2.new_body);
        assert!(!r2.new_body.contains("base64,"), "base64 串应从正文消失");
    }

    /// 放宽 destination 捕获后，带 title 的老写法仍要正确切出 URL（不能把 title 也吞进路径）
    #[test]
    fn md_title_still_stripped_after_relaxing_regex() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        let body = "![](images/plain.png \"这是标题\")";
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 1, "带 title 仍应命中：{}", r.new_body);
        assert!(r.missing.is_empty(), "不该把 title 当成路径的一部分：{:?}", r.missing);
    }

    /// 文件名本身含圆括号（`shot(1).png`）不能被误当成 title 而截断
    #[test]
    fn md_filename_with_parens_not_treated_as_title() {
        let root = temp_root();
        let note_dir = root.join("nd");
        let app_data = root.join("app_data");
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(note_dir.join("shot(1).png"), b"\x89PNG\r\n\x1a\n").unwrap();

        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        // 注意：`)` 会提前终止 regex，这里验证的是 parse_md_destination 不会再截一刀
        assert_eq!(parse_md_destination("shot(1).png"), "shot(1).png");
        let _ = (idx, app_data);
    }

    /// 空 destination（`![]()`）不该 panic，也不该记成缺失
    #[test]
    fn md_empty_destination_is_ignored() {
        let (note_dir, app_data) = make_feishu_layout();
        let idx = AttachmentIndex::build_for_single_file(&note_dir);
        let body = "![]()";
        let r = rewrite_image_paths(body, 1, &note_dir, &note_dir, &idx, &app_data).unwrap();
        assert_eq!(r.copied, 0);
        assert!(r.missing.is_empty(), "空引用不该记缺失：{:?}", r.missing);
        assert_eq!(r.new_body, body);
    }

    #[test]
    fn parse_destination_forms() {
        assert_eq!(parse_md_destination("a.png"), "a.png");
        assert_eq!(parse_md_destination("  a.png  "), "a.png");
        assert_eq!(parse_md_destination("images/a b.png"), "images/a b.png");
        assert_eq!(parse_md_destination("<images/a b.png>"), "images/a b.png");
        assert_eq!(parse_md_destination("a.png \"标题\""), "a.png");
        assert_eq!(parse_md_destination("a.png '标题'"), "a.png");
        assert_eq!(parse_md_destination(""), "");
    }

    #[test]
    fn missing_dedup() {
        let (vault, app_data) = make_vault();
        let idx = AttachmentIndex::build(&vault);
        let body = "![](a.png) ![](a.png) ![[b.png]] ![[b.png]]";
        let r = rewrite_image_paths(body, 1, &vault, &vault, &idx, &app_data).unwrap();
        assert_eq!(r.missing.len(), 2);
    }
}
