//! T-S021 资产引用扫描器
//!
//! 扫描笔记 content 中的本地资产引用（markdown 图片/链接 + Obsidian wiki 嵌入），
//! 计算 sha256，upsert 到 `note_attachments` 表。同步流程靠这张表算"哪些 hash 该上传"。
//!
//! ## 引用模式
//! - markdown 图片：`![alt](path "title")`
//! - markdown 链接：`[text](path)` —— 仅当 path 看起来像本地资产（已知前缀）
//! - Obsidian wiki 嵌入：`![[file|width]]`
//!
//! ## 路径过滤
//! 只收"以已知资产前缀开头"的相对路径：
//! - `kb_assets/` / `dev-kb_assets/`（dev 实例前缀）
//! - `pdfs/` / `dev-pdfs/`
//! - `sources/` / `dev-sources/`
//!
//! 跳过：http(s):// 外链、`asset:` 协议、绝对路径、含 `..` 的路径（防穿越）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::database::Database;
use crate::error::AppError;
use crate::services::hash::sha256_hex;

/// markdown 图片正则：`![alt](path "optional title")`
fn re_md_image() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#).unwrap()
    })
}

/// markdown 链接正则：`[text](path)` —— 注意要排除前导 `!`（图片）
fn re_md_link() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // 反向断言：(?<!!) 不被 Rust regex 支持，改用普通 ([^!]|^) 前缀消歧
        // 但更简单：扫到 `![](...)` 时会先被 md_image 捕获；这里再扫一次会重复 →
        // 改在调用方对 (image, link) 两个集合做 dedup（按 raw_path）
        Regex::new(r#"\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#).unwrap()
    })
}

/// wiki 嵌入正则：`![[file]]` 或 `![[file|width]]`
fn re_wiki_embed() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"!\[\[([^\]\|]+?)(\|[^\]]*)?\]\]").unwrap())
}

/// `kb-asset://<相对路径>` 引用正则。
///
/// 前端 `TiptapEditor` 把所有本地资产（图片/视频/PDF…）的 `src` 统一改写成这个形式，通过
/// `tiptap-markdown` 的 `html: true` 原样存进 `.md` —— 实际上多数图片/视频在 `.md` 里就是
/// `<img src="kb-asset://kb_assets/images/1/x.png">` / `<video src="kb-asset://kb_assets/videos/...">`，
/// 而不是 markdown 的 `![](...)`。这条正则补上对它的识别（否则附件同步永远扫不到图片/视频）。
///
/// 捕获组 1 = 剥掉 `kb-asset://` 之后的部分（即相对 `data_dir` 的路径，如 `kb_assets/images/1/x.png`）。
/// 终止于空白 / 引号 / 反引号 / `)` / `]` / `>` / `#` / `?`（URL fragment/query 不属于路径）。
fn re_kb_asset() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"kb-asset://([^\s"'`)\]>#?]+)"#).unwrap())
}

/// 已知本地资产路径前缀（含 dev 前缀变体）
const KNOWN_PREFIXES: &[&str] = &[
    "kb_assets/",
    "dev-kb_assets/",
    "pdfs/",
    "dev-pdfs/",
    "sources/",
    "dev-sources/",
];

/// 判定一个相对路径是不是本地资产（用于过滤外链）
fn looks_like_local_asset(rel: &str) -> bool {
    // 防穿越：含 .. 的拒绝
    if rel.contains("..") {
        return false;
    }
    // 外链 / 绝对路径 / asset 协议 → 不是本地资产
    if rel.starts_with("http://")
        || rel.starts_with("https://")
        || rel.starts_with("asset:")
        || rel.starts_with('/')
        || rel.contains("://")
    {
        return false;
    }
    // Windows 绝对路径（C:\ 或 C:/）
    let bytes = rel.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return false;
    }
    // 必须以已知前缀开头
    KNOWN_PREFIXES.iter().any(|p| rel.starts_with(p))
}

/// URL-decode 简化版：把 `%20` 等还原为字符（笔记里的图片路径可能带 URL 转义）
fn url_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// 从笔记 content 中提取所有"本地资产相对路径"（去重，保持稳定顺序）
pub fn extract_local_refs(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // `kb-asset://<rel>` 引用 —— 放最前面，因为这是实际最常见的形式：前端给所有图片/视频/资产的 src
    // 都改写成 `kb-asset://...`，多见于 `<img src="kb-asset://...">` / `<video src="kb-asset://...">`
    // HTML 标签（被 tiptap-markdown 原样存进 .md）。捕获组 1 已是剥掉 `kb-asset://` 后的相对路径。
    for cap in re_kb_asset().captures_iter(content) {
        if let Some(p) = cap.get(1) {
            let decoded = url_decode(p.as_str());
            if looks_like_local_asset(&decoded) && seen.insert(decoded.clone()) {
                out.push(decoded);
            }
        }
    }

    // markdown 图片（[2] 是 path）—— 兼容旧 / 导入笔记里的纯 markdown 写法 `![](kb_assets/...)`
    for cap in re_md_image().captures_iter(content) {
        if let Some(p) = cap.get(2) {
            let decoded = url_decode(p.as_str());
            if looks_like_local_asset(&decoded) && seen.insert(decoded.clone()) {
                out.push(decoded);
            }
        }
    }

    // markdown 链接（注意先把已捕获的图片位置 mask 掉避免重复）
    // 简化做法：直接扫描链接；图片以 ! 开头，链接不以 ! 开头，但 re_md_link 会两都匹配。
    // 这里靠 seen 去重，保证同一 path 只入一次。
    for cap in re_md_link().captures_iter(content) {
        if let Some(p) = cap.get(2) {
            let decoded = url_decode(p.as_str());
            if looks_like_local_asset(&decoded) && seen.insert(decoded.clone()) {
                out.push(decoded);
            }
        }
    }

    // wiki 嵌入 `![[file]]` —— 形如 `kb_assets/images/xxx.png` 或裸文件名
    // 这里只收带已知前缀的完整路径形式；裸文件名（Obsidian 语义）不进 sync（语义不明）
    for cap in re_wiki_embed().captures_iter(content) {
        if let Some(p) = cap.get(1) {
            let decoded = url_decode(p.as_str().trim());
            if looks_like_local_asset(&decoded) && seen.insert(decoded.clone()) {
                out.push(decoded);
            }
        }
    }

    out
}

/// 单条引用的扫描结果（计算完 hash 后入库前的中间表示）
#[derive(Debug, Clone)]
pub struct ScannedRef {
    pub local_rel_path: String,
    pub sha256_hex: String,
    pub size: i64,
    pub mime: Option<String>,
}

/// 按相对路径计算 hash + size + mime；文件不存在/读失败返回 None
fn try_resolve(data_dir: &Path, rel: &str) -> Option<ScannedRef> {
    let abs: PathBuf = data_dir.join(rel);
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[attachment-scan] 读取失败 {} ({}), 跳过", abs.display(), e);
            return None;
        }
    };
    let size = bytes.len() as i64;
    let sha = sha256_hex_bytes(&bytes);
    let mime = mime_from_ext(rel);
    Some(ScannedRef {
        local_rel_path: rel.to_string(),
        sha256_hex: sha,
        size,
        mime,
    })
}

/// 对原始字节算 sha256 hex（services::hash::sha256_hex 是对 &str 的；这里要原始字节）
fn sha256_hex_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// 简易扩展名 → MIME 推断（只覆盖项目常见类型）
fn mime_from_ext(rel: &str) -> Option<String> {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "zip" => "application/zip",
        _ => return Some(format!("application/octet-stream")),
    };
    Some(m.to_string())
}

/// 扫描一条笔记的 content，识别本地资产引用，计算 hash 并 upsert 到 note_attachments。
///
/// 返回成功 upsert 的引用数（不存在的文件被跳过且不计入）。
pub fn scan_note(
    db: &Database,
    data_dir: &Path,
    note_id: i64,
    content: &str,
) -> Result<usize, AppError> {
    let refs = extract_local_refs(content);
    let mut count = 0usize;
    for rel in refs {
        if let Some(s) = try_resolve(data_dir, &rel) {
            db.upsert_attachment_ref(
                note_id,
                &s.local_rel_path,
                &s.sha256_hex,
                s.size,
                s.mime.as_deref(),
            )?;
            count += 1;
        }
    }
    let _ = sha256_hex; // 防止 import 未使用警告（保留接口对齐）
    Ok(count)
}

/// 全库扫描：遍历所有活跃笔记（is_deleted=0），对每条调 scan_note。
///
/// **增量**：只处理 `attachment_scan_at IS NULL OR attachment_scan_at <> updated_at` 的笔记
/// （v38 起新增的标记列）—— 上次扫过且笔记没动 = 跳过。Push 前自动跑也只重扫真正变更的笔记。
/// 首次升级：`attachment_scan_at` 是 NULL → 第一次 push 仍全库扫一遍，之后稳态只扫变更。
///
/// `force_full=true` 时退化为全库扫，给设置页"重建附件索引"按钮用（用户能强制重建）。
pub fn scan_all_active_notes(db: &Database, data_dir: &Path) -> Result<usize, AppError> {
    scan_active_notes_inner(db, data_dir, false)
}

/// 强制全库重扫（清空 `attachment_scan_at` 后重扫）。给"重建附件索引"按钮用。
pub fn scan_all_active_notes_force(db: &Database, data_dir: &Path) -> Result<usize, AppError> {
    scan_active_notes_inner(db, data_dir, true)
}

fn scan_active_notes_inner(
    db: &Database,
    data_dir: &Path,
    force_full: bool,
) -> Result<usize, AppError> {
    // 选 id：增量模式只挑 scan 标记落后于 updated_at 的；force_full 拿全量
    let note_ids: Vec<i64> = {
        let conn = db.conn_lock()?;
        // P2-b：判据用 `<>`（不等）而非 `<`（落后）。pull 的 update_note_synced 会把
        // updated_at 设成远端 entry 的值，可能比本地原值旧（如 is_daily / is_hidden 元数据
        // 对齐场景）→ updated_at "回退" → 用 `<` 时 scan_at 恒 >= updated_at → 该笔记永久
        // 跳过增量扫描、附件引用变更再也扫不到。改 `<>` 后任何 updated_at 变动（变新或
        // 变旧）都触发一次重扫，扫完 mark_scanned 把 scan_at 对齐 → 下次正常跳过。
        let sql = if force_full {
            "SELECT id FROM notes WHERE is_deleted = 0"
        } else {
            "SELECT id FROM notes
             WHERE is_deleted = 0
               AND (attachment_scan_at IS NULL OR attachment_scan_at <> updated_at)"
        };
        let mut stmt = conn.prepare(sql)?;
        // 不能直接把 collect 当 block 返回值（stmt/conn 会比 collect 结果先 drop）
        let rows: Vec<i64> = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    if note_ids.is_empty() {
        return Ok(0);
    }
    log::debug!(
        "[attachment-scan] {} 条笔记待扫描（force_full={}）",
        note_ids.len(),
        force_full
    );

    let mut total = 0usize;
    for id in note_ids {
        // 单独 lock 读 content + updated_at；scan_note 内部会再 lock 写 upsert
        let row: Option<(String, String)> = {
            let conn = db.conn_lock()?;
            conn.query_row(
                "SELECT content, updated_at FROM notes WHERE id = ?1 AND is_deleted = 0",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .ok()
        };
        if let Some((content, updated_at)) = row {
            match scan_note(db, data_dir, id, &content) {
                Ok(n) => {
                    total += n;
                    // 标记本笔记已扫描到 updated_at 这个时刻；下次 update_note 把
                    // updated_at 推到更新值时，scan_at < updated_at 自动重新进入扫描集
                    if let Err(e) = mark_scanned(db, id, &updated_at) {
                        log::warn!("[attachment-scan] 标记 note#{} 扫描时间失败: {}", id, e);
                    }
                }
                Err(e) => log::warn!("[attachment-scan] 笔记 {} 扫描失败: {}", id, e),
            }
        }
    }
    Ok(total)
}

/// 把笔记的 `attachment_scan_at` 标记到 `scanned_to`（一般是该笔记当前的 `updated_at`）。
/// 不动 `updated_at`，单纯写元数据。
fn mark_scanned(db: &Database, note_id: i64, scanned_to: &str) -> Result<(), AppError> {
    let conn = db.conn_lock()?;
    conn.execute(
        "UPDATE notes SET attachment_scan_at = ?1 WHERE id = ?2",
        rusqlite::params![scanned_to, note_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_md_image() {
        let s = "![avatar](kb_assets/images/me.png) 中间文字 ![](pdfs/spec.pdf)";
        let refs = extract_local_refs(s);
        assert_eq!(refs.len(), 2);
        assert!(refs.contains(&"kb_assets/images/me.png".to_string()));
        assert!(refs.contains(&"pdfs/spec.pdf".to_string()));
    }

    #[test]
    fn extract_md_link_with_local_asset() {
        let s = "下载 [PPT 文件](sources/intro.pptx) 看看";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["sources/intro.pptx".to_string()]);
    }

    #[test]
    fn extract_wiki_embed() {
        let s = "![[kb_assets/images/wiki.jpg|400]]";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["kb_assets/images/wiki.jpg".to_string()]);
    }

    #[test]
    fn skip_http_and_asset_protocol() {
        let s = r#"
            ![](https://example.com/x.png)
            ![](http://example.com/y.jpg)
            ![](asset://localhost/z.png)
        "#;
        let refs = extract_local_refs(s);
        assert!(refs.is_empty(), "外链/asset 协议不应进入本地资产清单; got = {:?}", refs);
    }

    #[test]
    fn skip_path_traversal_and_absolute() {
        let s = "![](../secret.png) ![](/etc/passwd) ![](C:/Windows/x.dll)";
        let refs = extract_local_refs(s);
        assert!(refs.is_empty(), "穿越/绝对路径必须拒绝; got = {:?}", refs);
    }

    #[test]
    fn skip_unknown_prefix() {
        let s = "![](random_dir/x.png)";
        let refs = extract_local_refs(s);
        assert!(refs.is_empty(), "未知前缀不算本地资产");
    }

    #[test]
    fn url_decode_works() {
        let s = "![](kb_assets/images/has%20space.png)";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["kb_assets/images/has space.png".to_string()]);
    }

    // ───────── 修 Bug：识别 kb-asset:// 形式的图片/视频引用（这才是实际形式） ─────────

    #[test]
    fn extract_kb_asset_in_html_img_and_video() {
        let s = r#"
            <p>文字</p>
            <img src="kb-asset://kb_assets/images/1/photo.png" alt="x" />
            <video src="kb-asset://kb_assets/videos/3/clip.mp4" controls></video>
            <iframe src="https://player.bilibili.com/x"></iframe>
        "#;
        let refs = extract_local_refs(s);
        assert!(refs.contains(&"kb_assets/images/1/photo.png".to_string()), "got {:?}", refs);
        assert!(refs.contains(&"kb_assets/videos/3/clip.mp4".to_string()), "got {:?}", refs);
        assert_eq!(refs.len(), 2, "外链 iframe 不该被抓; got {:?}", refs);
    }

    #[test]
    fn extract_kb_asset_in_markdown_image() {
        let s = "![cover](kb-asset://kb_assets/images/x.png) 文字 ![](kb-asset://dev-pdfs/y.pdf)";
        let refs = extract_local_refs(s);
        assert!(refs.contains(&"kb_assets/images/x.png".to_string()), "got {:?}", refs);
        assert!(refs.contains(&"dev-pdfs/y.pdf".to_string()), "got {:?}", refs);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn extract_kb_asset_dedup_with_markdown_form() {
        // 同一路径既有 kb-asset:// 形式又有纯 markdown 形式（极端）→ 只入一次
        let s = "<img src=\"kb-asset://kb_assets/images/dup.png\"> ![](kb_assets/images/dup.png)";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["kb_assets/images/dup.png".to_string()]);
    }

    #[test]
    fn extract_kb_asset_enc_image() {
        let s = "<img src=\"kb-asset://kb_assets/images/1/secret.png.enc\">";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["kb_assets/images/1/secret.png.enc".to_string()]);
    }

    #[test]
    fn extract_kb_asset_url_encoded() {
        let s = "<img src=\"kb-asset://kb_assets/images/has%20space.png\">";
        let refs = extract_local_refs(s);
        assert_eq!(refs, vec!["kb_assets/images/has space.png".to_string()]);
    }

    #[test]
    fn kb_asset_with_unknown_prefix_rejected() {
        let s = "<img src=\"kb-asset://random_dir/x.png\">";
        let refs = extract_local_refs(s);
        assert!(refs.is_empty(), "未知前缀仍按白名单拒绝; got {:?}", refs);
    }

    #[test]
    fn dedup_same_path_referenced_multiple_times() {
        let s = "![](kb_assets/images/a.png) 然后 [](kb_assets/images/a.png)";
        let refs = extract_local_refs(s);
        assert_eq!(refs.len(), 1, "同一路径多次引用应只入一次");
    }

    #[test]
    fn dev_prefix_recognized() {
        let s = "![](dev-kb_assets/images/dev.png) ![](dev-pdfs/dev.pdf)";
        let refs = extract_local_refs(s);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn mime_from_ext_common_types() {
        assert_eq!(mime_from_ext("a.png"), Some("image/png".into()));
        assert_eq!(mime_from_ext("a.PNG"), Some("image/png".into()), "应大小写不敏感");
        assert_eq!(mime_from_ext("a.pdf"), Some("application/pdf".into()));
        assert_eq!(mime_from_ext("a.docx").as_deref(), Some(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ));
        assert_eq!(mime_from_ext("a.unknown"), Some("application/octet-stream".into()));
        assert_eq!(mime_from_ext("noext"), None);
    }

    /// 端到端：在临时目录建真实文件，调 scan_note 验证 hash 落库
    #[test]
    fn scan_note_e2e() {
        use crate::models::NoteInput;
        let tmp = std::env::temp_dir().join(format!(
            "kb-attach-scan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let assets_dir = tmp.join("kb_assets").join("images");
        std::fs::create_dir_all(&assets_dir).unwrap();
        std::fs::write(assets_dir.join("hello.png"), b"PNG-FAKE-BYTES").unwrap();

        let db = Database::init(":memory:").unwrap();
        let note = db
            .create_note(&NoteInput {
                title: "笔记".into(),
                content: "![hello](kb_assets/images/hello.png)".into(),
                folder_id: None,
            })
            .unwrap();

        let count = scan_note(&db, &tmp, note.id, &note.content).unwrap();
        assert_eq!(count, 1);

        let refs = db.list_attachments_for_note(note.id).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].local_rel_path, "kb_assets/images/hello.png");
        assert_eq!(refs[0].sha256_hex.len(), 64);
        assert_eq!(refs[0].size, 14);
        assert_eq!(refs[0].mime.as_deref(), Some("image/png"));

        // hash 稳定性：再扫一次 hash 不变
        let count2 = scan_note(&db, &tmp, note.id, &note.content).unwrap();
        assert_eq!(count2, 1);
        let refs2 = db.list_attachments_for_note(note.id).unwrap();
        assert_eq!(refs2[0].sha256_hex, refs[0].sha256_hex);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_note_skips_missing_files() {
        let tmp = std::env::temp_dir().join(format!(
            "kb-attach-miss-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Database::init(":memory:").unwrap();
        let nid = db
            .create_note(&crate::models::NoteInput {
                title: "T".into(),
                content: "![](kb_assets/images/不存在.png)".into(),
                folder_id: None,
            })
            .unwrap()
            .id;

        let count = scan_note(&db, &tmp, nid, "![](kb_assets/images/不存在.png)").unwrap();
        assert_eq!(count, 0, "文件不存在的引用应被跳过");
        assert!(db.list_attachments_for_note(nid).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ───────── Bug 13：增量 scan ─────────

    fn note_scan_at(db: &crate::database::Database, id: i64) -> Option<String> {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT attachment_scan_at FROM notes WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
    }

    fn note_updated_at(db: &crate::database::Database, id: i64) -> String {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT updated_at FROM notes WHERE id = ?1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    }

    #[test]
    fn incremental_scan_marks_attachment_scan_at() {
        let tmp = std::env::temp_dir().join("kb_incr_scan_test_a");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = crate::database::Database::init(":memory:").unwrap();
        let n = db
            .create_note(&crate::models::NoteInput {
                title: "x".into(),
                content: "纯文本无附件".into(),
                folder_id: None,
            })
            .unwrap();
        assert_eq!(note_scan_at(&db, n.id), None, "刚创建应是 NULL");

        let scanned = scan_all_active_notes(&db, &tmp).unwrap();
        assert_eq!(scanned, 0, "无附件 → upsert 数 0");
        let updated = note_updated_at(&db, n.id);
        assert_eq!(
            note_scan_at(&db, n.id).as_deref(),
            Some(updated.as_str()),
            "scan 完应把 scan_at 标到当前 updated_at"
        );

        // 第二次同样调用 → 没有变更 → scan_at 不变（笔记本身没动）
        scan_all_active_notes(&db, &tmp).unwrap();
        assert_eq!(note_scan_at(&db, n.id).as_deref(), Some(updated.as_str()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn note_updated_again_re_enters_scan_set() {
        let tmp = std::env::temp_dir().join("kb_incr_scan_test_b");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = crate::database::Database::init(":memory:").unwrap();
        let n = db
            .create_note(&crate::models::NoteInput {
                title: "x".into(),
                content: "v1".into(),
                folder_id: None,
            })
            .unwrap();
        scan_all_active_notes(&db, &tmp).unwrap();
        let scan1 = note_scan_at(&db, n.id);
        assert!(scan1.is_some());

        // 改 updated_at 到一个明显更晚的时间（避免同一秒内 < 不成立）
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET content = 'v2', updated_at = '2099-12-31 23:59:59' WHERE id = ?1",
                [n.id],
            )
            .unwrap();
        }

        scan_all_active_notes(&db, &tmp).unwrap();
        assert_eq!(
            note_scan_at(&db, n.id).as_deref(),
            Some("2099-12-31 23:59:59"),
            "应被重扫并把 scan_at 推到新 updated_at"
        );
        assert_ne!(scan1.as_deref(), Some("2099-12-31 23:59:59"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// P2-b：updated_at "回退"（被 pull 的 update_note_synced 设成更早的远端值，
    /// 如 is_daily / is_hidden 元数据对齐场景）也必须重新进入增量扫描集 ——
    /// 判据是 `<>` 而非 `<`。旧代码（`<`）下本测试会失败：scan_at 恒 >= 回退后的
    /// updated_at → 该笔记永久跳过增量扫描。
    #[test]
    fn updated_at_rolled_back_re_enters_scan_set() {
        let tmp = std::env::temp_dir().join("kb_incr_scan_test_rollback");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = crate::database::Database::init(":memory:").unwrap();
        let n = db
            .create_note(&crate::models::NoteInput {
                title: "x".into(),
                content: "v1".into(),
                folder_id: None,
            })
            .unwrap();
        scan_all_active_notes(&db, &tmp).unwrap();
        let scan1 = note_scan_at(&db, n.id);
        assert!(scan1.is_some());

        // 模拟 pull 的 update_note_synced：把 updated_at 设成比 scan_at 更早的值（回退）
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1",
                [n.id],
            )
            .unwrap();
        }

        scan_all_active_notes(&db, &tmp).unwrap();
        assert_eq!(
            note_scan_at(&db, n.id).as_deref(),
            Some("2000-01-01 00:00:00"),
            "updated_at 回退后也应被重扫并把 scan_at 对齐到回退值（P2-b）"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn force_full_rescans_even_when_unchanged() {
        let tmp = std::env::temp_dir().join("kb_incr_scan_test_c");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = crate::database::Database::init(":memory:").unwrap();
        let n = db
            .create_note(&crate::models::NoteInput {
                title: "x".into(),
                content: "v1".into(),
                folder_id: None,
            })
            .unwrap();
        scan_all_active_notes(&db, &tmp).unwrap();
        let scan1 = note_scan_at(&db, n.id);

        // 强制重扫——笔记没动，scan_at 仍被重写但值不变（侧证全量路径走过了 mark_scanned）
        scan_all_active_notes_force(&db, &tmp).unwrap();
        let scan2 = note_scan_at(&db, n.id);
        assert_eq!(scan1, scan2);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migration_v37_to_v38_adds_attachment_scan_at_column() {
        let db = crate::database::Database::init(":memory:").unwrap();
        let cols: Vec<String> = {
            let conn = db.conn_lock().unwrap();
            let mut stmt = conn.prepare("PRAGMA table_info(notes)").unwrap();
            let rows: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        assert!(
            cols.contains(&"attachment_scan_at".to_string()),
            "v38 后 notes 表应有 attachment_scan_at 列; got = {:?}",
            cols
        );
    }
}
