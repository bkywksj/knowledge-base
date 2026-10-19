//! 孤儿素材统一扫描器
//!
//! 六类素材：images / videos / attachments / pdfs / sources / task_files
//!
//! task_files（待办附件）按 task_id 分目录，引用集来自 `task_attachments` 表，
//! 与笔记 content 无关，单独走 `scan_task_files`。
//!
//! 两种存储拓扑各自一套扫描算法：
//!
//! ## A. 平铺型（仅 images）
//! - 文件名带时间戳前缀全局唯一（如 `20260101_xxx_seq.png` / `*.enc`）
//! - 引用集 = 扫所有笔记 content 抓 token（含 trash；跳过加密笔记的密文 content）
//! - 加密笔记 note_id 集 = 整个 `images/<id>/` 目录全部保留
//! - 对应 token 的判定从旧 ImageService::scan_orphans 复用
//!
//! ## B. 按 note_id 分目录型（videos / attachments / pdfs）
//! - 目录结构：`<root>/<note_id>/<filename>`
//! - 第一层判定：目录的 `<note_id>` 不在 DB 笔记 id 集合中 → 整个目录是孤儿
//!   （reason = notePurged，对应 note 已被永久删除但素材残留）
//! - 第二层判定：目录在 DB 中但目录里的文件未被 content / source_file_path 引用 → 文件级孤儿
//!   （reason = unreferenced）
//! - 加密笔记目录跳过第二层判定（content 是密文无法 token 提取）
//!
//! ## sources 特殊处理
//! - 平铺存储：`<root>/<note_id>.<ext>`（与 PDF 不同，没有内层目录）
//! - 引用集 = `notes.source_file_path` 字段（路径形如 `sources/<id>.docx`）
//!
//! ## 安全
//! - 所有 clean 操作必须先验证路径前缀在对应 assets 子目录下
//! - 路径前缀比较前规范化分隔符（Windows `\` ↔ `/`）

use std::collections::{HashMap, HashSet};
use std::path::Path;

use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{OrphanAssetClean, OrphanAssetScan, OrphanGroup, OrphanItem};
use crate::services::attachment::AttachmentService;
use crate::services::image::ImageService;
use crate::services::pdf::PdfService;
use crate::services::source_file::SourceFileService;
use crate::services::task_attachment::TaskAttachmentService;
use crate::services::video::VideoService;

/// 单组孤儿明细上限（防止 UI 卡死 / 过大 IPC 包体）
const DISPLAY_LIMIT: usize = 500;

/// 视频常见扩展名（与 video.rs save 时支持的扩展名对齐）
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "webm", "m4v", "ogv", "mkv", "avi", "m4a"];

/// 附件常见扩展名（与 attachment.rs mime_for_ext 列表对齐，去掉视频）
const ATTACHMENT_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z", "tar", "gz", "mp3",
    "wav", "ogg", "flac", "csv", "json", "xml", "yaml", "yml",
];

/// PDF / Source 扩展名（用于 sources 平铺扫描）
const SOURCE_EXTS: &[&str] = &["pdf", "doc", "docx"];

pub struct OrphanScanService;

impl OrphanScanService {
    /// 扫描全部五类孤儿素材
    pub fn scan_all(db: &Database, app_data_dir: &Path) -> Result<OrphanAssetScan, AppError> {
        // ── 一次性预读 DB，避免 5 个扫描器各自查库 ──
        let contents = db.list_all_contents_for_orphan_scan()?;
        let source_paths = db.list_all_source_file_paths()?;

        // 全部存在的 note_id 集合（含 trash，用于"目录孤儿"判定）
        let mut note_ids: HashSet<i64> = HashSet::with_capacity(contents.len());
        // 加密笔记 note_id 集合（用于跳过 content 引用判定）
        let mut encrypted_ids: HashSet<i64> = HashSet::new();
        // 笔记内嵌引用的文件名 token 集合（小写，仅来自非加密笔记的 content）
        let mut referenced_tokens: HashSet<String> = HashSet::new();

        for (id, is_encrypted, content) in &contents {
            note_ids.insert(*id);
            if *is_encrypted {
                encrypted_ids.insert(*id);
                continue;
            }
            if let Some(c) = content {
                // 直接抓一遍：覆盖纯文本（如 markdown 链接）和 ASCII 文件名
                collect_filename_tokens(c, &mut referenced_tokens);
                // 再对 URL 解码版抓一遍：编辑器把图片路径走 convertFileSrc 后
                // 在 HTML 里是 percent-encoded（中文 → `%E6%88%AA...`），
                // 不解码 token 永远对不上磁盘上裸的 "截图.png" 名字。
                if c.contains('%') {
                    if let Ok(decoded) = urlencoding::decode(c) {
                        collect_filename_tokens(&decoded, &mut referenced_tokens);
                    }
                }
            }
        }

        // source_file_path 引用集（小写绝对路径，给 pdfs / sources 用）
        let mut referenced_source_abs: HashSet<String> = HashSet::with_capacity(source_paths.len());
        for rel in &source_paths {
            let abs = app_data_dir.join(rel);
            referenced_source_abs.insert(normalize_path_for_compare(&abs));
        }

        Ok(OrphanAssetScan {
            images: scan_flat_images(app_data_dir, &referenced_tokens, &encrypted_ids)?,
            videos: scan_per_note_dir(
                "video",
                &VideoService::videos_dir(app_data_dir),
                &note_ids,
                &encrypted_ids,
                &referenced_tokens,
                VIDEO_EXTS,
            )?,
            attachments: scan_per_note_dir(
                "attachment",
                &AttachmentService::attachments_dir(app_data_dir),
                &note_ids,
                &encrypted_ids,
                &referenced_tokens,
                ATTACHMENT_EXTS,
            )?,
            pdfs: scan_per_note_dir_by_path_ref(
                "pdf",
                &PdfService::pdfs_dir(app_data_dir),
                &note_ids,
                &encrypted_ids,
                &referenced_source_abs,
            )?,
            sources: scan_flat_sources(
                app_data_dir,
                &SourceFileService::sources_dir(app_data_dir),
                &note_ids,
                &referenced_source_abs,
            )?,
            task_files: scan_task_files(db, app_data_dir)?,
        })
    }

    /// 批量删除孤儿素材
    ///
    /// 安全策略：每条 path 必须落在对应 kind 的 assets 子目录下，否则计入 failed 不删。
    pub fn clean(app_data_dir: &Path, items: &[OrphanItem]) -> Result<OrphanAssetClean, AppError> {
        // 预先按 kind 算各自的合法根目录（小写规范化）
        let mut roots: HashMap<&'static str, String> = HashMap::new();
        roots.insert(
            "image",
            normalize_path_for_compare(&ImageService::images_dir(app_data_dir)),
        );
        roots.insert(
            "video",
            normalize_path_for_compare(&VideoService::videos_dir(app_data_dir)),
        );
        roots.insert(
            "attachment",
            normalize_path_for_compare(&AttachmentService::attachments_dir(app_data_dir)),
        );
        roots.insert(
            "pdf",
            normalize_path_for_compare(&PdfService::pdfs_dir(app_data_dir)),
        );
        roots.insert(
            "source",
            normalize_path_for_compare(&SourceFileService::sources_dir(app_data_dir)),
        );
        roots.insert(
            "task_file",
            normalize_path_for_compare(&TaskAttachmentService::root_dir(app_data_dir)),
        );

        let mut deleted = 0usize;
        let mut freed_bytes = 0u64;
        let mut failed: Vec<String> = Vec::new();

        for it in items {
            let Some(root) = roots.get(it.kind.as_str()) else {
                failed.push(format!("{}: 未知素材类型 {}", it.path, it.kind));
                continue;
            };
            let normalized = normalize_path_for_compare(Path::new(&it.path));
            if !normalized.starts_with(root.as_str()) {
                failed.push(format!("{}: 非法路径（不在 {} 目录下）", it.path, it.kind));
                continue;
            }

            let path = Path::new(&it.path);
            if !path.exists() {
                continue;
            }

            // 文件 / 目录都可能（"notePurged" 时是整个 note_id 目录）
            let metadata = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(e) => {
                    failed.push(format!("{}: {}", it.path, e));
                    continue;
                }
            };

            if metadata.is_dir() {
                let dir_size = dir_total_size(path);
                match std::fs::remove_dir_all(path) {
                    Ok(_) => {
                        deleted += 1;
                        freed_bytes += dir_size;
                    }
                    Err(e) => failed.push(format!("{}: {}", it.path, e)),
                }
            } else {
                let size = metadata.len();
                match std::fs::remove_file(path) {
                    Ok(_) => {
                        deleted += 1;
                        freed_bytes += size;
                    }
                    Err(e) => failed.push(format!("{}: {}", it.path, e)),
                }
            }
        }

        Ok(OrphanAssetClean {
            deleted,
            freed_bytes,
            failed,
        })
    }
}

// ─── 平铺 images 扫描 ───────────────────────────────

fn scan_flat_images(
    app_data_dir: &Path,
    referenced_tokens: &HashSet<String>,
    encrypted_ids: &HashSet<i64>,
) -> Result<OrphanGroup, AppError> {
    let root = ImageService::images_dir(app_data_dir);
    if !root.exists() {
        return Ok(OrphanGroup::default());
    }
    let mut group = OrphanGroup::default();

    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        // 加密笔记：images/<note_id>/* 全部跳过（content 是密文，无法 token 比对）
        if let Some(parent_note_id) = parent_note_id_from(&root, entry.path()) {
            if encrypted_ids.contains(&parent_note_id) {
                continue;
            }
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n,
            None => continue,
        };
        if referenced_tokens.contains(&name.to_lowercase()) {
            continue;
        }

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        push_orphan(
            &mut group,
            OrphanItem {
                kind: "image".into(),
                path: entry.path().to_string_lossy().into_owned(),
                note_id: None,
                size,
                reason: "unreferenced".into(),
            },
        );
    }
    Ok(group)
}

// ─── 按 note_id 分目录扫描（videos / attachments） ─────

fn scan_per_note_dir(
    kind: &str,
    root: &Path,
    note_ids: &HashSet<i64>,
    encrypted_ids: &HashSet<i64>,
    referenced_tokens: &HashSet<String>,
    valid_exts: &[&str],
) -> Result<OrphanGroup, AppError> {
    let mut group = OrphanGroup::default();
    if !root.exists() {
        return Ok(group);
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let ftype = entry.file_type()?;
        if !ftype.is_dir() {
            // 一级子项必须是目录，散落的杂文件按文件级孤儿处理
            let path = entry.path();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            push_orphan(
                &mut group,
                OrphanItem {
                    kind: kind.into(),
                    path: path.to_string_lossy().into_owned(),
                    note_id: None,
                    size,
                    reason: "unreferenced".into(),
                },
            );
            continue;
        }

        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let parsed_id = dir_name.parse::<i64>().ok();
        let dir_path = entry.path();

        match parsed_id {
            // 目录名不是合法 note_id：当作整目录孤儿
            None => {
                let size = dir_total_size(&dir_path);
                push_orphan(
                    &mut group,
                    OrphanItem {
                        kind: kind.into(),
                        path: dir_path.to_string_lossy().into_owned(),
                        note_id: None,
                        size,
                        reason: "unreferenced".into(),
                    },
                );
            }
            // 目录名是 note_id 但 DB 里没有 → 整目录孤儿（笔记已 purge）
            Some(id) if !note_ids.contains(&id) => {
                let size = dir_total_size(&dir_path);
                push_orphan(
                    &mut group,
                    OrphanItem {
                        kind: kind.into(),
                        path: dir_path.to_string_lossy().into_owned(),
                        note_id: Some(id),
                        size,
                        reason: "notePurged".into(),
                    },
                );
            }
            // 目录在 DB → 进文件级判定
            Some(id) => {
                if encrypted_ids.contains(&id) {
                    // 加密笔记跳过文件级判定（content 是密文）
                    continue;
                }
                scan_files_in_note_dir(
                    kind,
                    id,
                    &dir_path,
                    referenced_tokens,
                    valid_exts,
                    &mut group,
                );
            }
        }
    }

    Ok(group)
}

fn scan_files_in_note_dir(
    kind: &str,
    note_id: i64,
    note_dir: &Path,
    referenced_tokens: &HashSet<String>,
    valid_exts: &[&str],
    group: &mut OrphanGroup,
) {
    let entries = match std::fs::read_dir(note_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let Ok(ftype) = entry.file_type() else {
            continue;
        };
        if !ftype.is_file() {
            continue;
        }
        let name_os = entry.file_name();
        let name = match name_os.to_str() {
            Some(n) => n,
            None => continue,
        };
        // 仅判定该 kind 关心的扩展名（避免误删 README 之类）
        let ext = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        if let Some(ext) = ext.as_deref() {
            if !valid_exts.contains(&ext) {
                continue;
            }
        } else {
            continue;
        }
        if referenced_tokens.contains(&name.to_lowercase()) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        push_orphan(
            group,
            OrphanItem {
                kind: kind.into(),
                path: entry.path().to_string_lossy().into_owned(),
                note_id: Some(note_id),
                size,
                reason: "unreferenced".into(),
            },
        );
    }
}

// ─── PDFs：按 note_id 分目录 + 用 source_file_path 比对 ─────

fn scan_per_note_dir_by_path_ref(
    kind: &str,
    root: &Path,
    note_ids: &HashSet<i64>,
    _encrypted_ids: &HashSet<i64>,
    referenced_source_abs: &HashSet<String>,
) -> Result<OrphanGroup, AppError> {
    let mut group = OrphanGroup::default();
    if !root.exists() {
        return Ok(group);
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let ftype = entry.file_type()?;
        let path = entry.path();

        if !ftype.is_dir() {
            // 平铺杂文件：直接按文件比对
            let normalized = normalize_path_for_compare(&path);
            if !referenced_source_abs.contains(&normalized) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                push_orphan(
                    &mut group,
                    OrphanItem {
                        kind: kind.into(),
                        path: path.to_string_lossy().into_owned(),
                        note_id: None,
                        size,
                        reason: "unreferenced".into(),
                    },
                );
            }
            continue;
        }

        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let parsed_id = dir_name.parse::<i64>().ok();

        if let Some(id) = parsed_id {
            if !note_ids.contains(&id) {
                let size = dir_total_size(&path);
                push_orphan(
                    &mut group,
                    OrphanItem {
                        kind: kind.into(),
                        path: path.to_string_lossy().into_owned(),
                        note_id: Some(id),
                        size,
                        reason: "notePurged".into(),
                    },
                );
                continue;
            }
            // note 在 DB → 检查目录里每个文件是否被 source_file_path 引用
            for file_entry in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                if !file_entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = file_entry.path();
                let normalized = normalize_path_for_compare(&fp);
                if referenced_source_abs.contains(&normalized) {
                    continue;
                }
                let size = file_entry.metadata().map(|m| m.len()).unwrap_or(0);
                push_orphan(
                    &mut group,
                    OrphanItem {
                        kind: kind.into(),
                        path: fp.to_string_lossy().into_owned(),
                        note_id: Some(id),
                        size,
                        reason: "unreferenced".into(),
                    },
                );
            }
        } else {
            // 目录名不是 note_id：整目录孤儿
            let size = dir_total_size(&path);
            push_orphan(
                &mut group,
                OrphanItem {
                    kind: kind.into(),
                    path: path.to_string_lossy().into_owned(),
                    note_id: None,
                    size,
                    reason: "unreferenced".into(),
                },
            );
        }
    }
    Ok(group)
}

// ─── sources：平铺 `<note_id>.<ext>`（与 PDF 不同的存储拓扑）─────

fn scan_flat_sources(
    _app_data_dir: &Path,
    root: &Path,
    note_ids: &HashSet<i64>,
    referenced_source_abs: &HashSet<String>,
) -> Result<OrphanGroup, AppError> {
    let mut group = OrphanGroup::default();
    if !root.exists() {
        return Ok(group);
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !SOURCE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let parsed_id = stem.parse::<i64>().ok();
        let normalized = normalize_path_for_compare(&path);

        // 优先按 source_file_path 引用判定（最严格）
        if referenced_source_abs.contains(&normalized) {
            continue;
        }

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let (note_id, reason) = match parsed_id {
            // 文件名 stem 是 note_id 但 DB 中没有 → 笔记已 purge
            Some(id) if !note_ids.contains(&id) => (Some(id), "notePurged"),
            // 文件名 stem 是 note_id 且 DB 中有 → 笔记换了源文件，旧的没清
            Some(id) => (Some(id), "unreferenced"),
            None => (None, "unreferenced"),
        };
        push_orphan(
            &mut group,
            OrphanItem {
                kind: "source".into(),
                path: path.to_string_lossy().into_owned(),
                note_id,
                size,
                reason: reason.into(),
            },
        );
    }
    Ok(group)
}

// ─── 工具函数 ───────────────────────────────────

// ─── 待办附件（task_files/<task_id>/）──────────────────

/// 目录名不是任何任务行（含软删）的 id → 整目录孤儿（reason = taskPurged）；
/// 任务还在但文件不在 `task_attachments.rel_path` 里 → 文件级孤儿。
/// 软删任务的文件保留：同步 / 复活时附件还要用。
fn scan_task_files(db: &Database, app_data_dir: &Path) -> Result<OrphanGroup, AppError> {
    let root = TaskAttachmentService::root_dir(app_data_dir);
    let mut group = OrphanGroup::default();
    if !root.exists() {
        return Ok(group);
    }
    let task_ids: HashSet<i64> = db
        .list_all_task_ids_for_orphan_scan()?
        .into_iter()
        .collect();
    let referenced: HashSet<String> = db
        .list_all_task_attachment_paths()?
        .into_iter()
        .map(|rel| normalize_path_for_compare(&app_data_dir.join(rel)))
        .collect();

    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let path = entry.path();
        let id = entry.file_name().to_string_lossy().parse::<i64>().ok();
        if !entry.file_type()?.is_dir() || id.is_none() {
            let size = if path.is_dir() {
                dir_total_size(&path)
            } else {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            };
            push_orphan(
                &mut group,
                OrphanItem {
                    kind: "task_file".into(),
                    path: path.to_string_lossy().into_owned(),
                    note_id: None,
                    size,
                    reason: "unreferenced".into(),
                },
            );
            continue;
        }
        let id = id.unwrap_or_default();
        if !task_ids.contains(&id) {
            push_orphan(
                &mut group,
                OrphanItem {
                    kind: "task_file".into(),
                    path: path.to_string_lossy().into_owned(),
                    note_id: None,
                    size: dir_total_size(&path),
                    reason: "taskPurged".into(),
                },
            );
            continue;
        }
        for f in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
            if !f.file_type().is_file() {
                continue;
            }
            if referenced.contains(&normalize_path_for_compare(f.path())) {
                continue;
            }
            push_orphan(
                &mut group,
                OrphanItem {
                    kind: "task_file".into(),
                    path: f.path().to_string_lossy().into_owned(),
                    note_id: None,
                    size: f.metadata().map(|m| m.len()).unwrap_or(0),
                    reason: "unreferenced".into(),
                },
            );
        }
    }
    Ok(group)
}

fn push_orphan(group: &mut OrphanGroup, item: OrphanItem) {
    group.count += 1;
    group.total_bytes += item.size;
    if group.items.len() < DISPLAY_LIMIT {
        group.items.push(item);
    } else {
        group.truncated = true;
    }
}

fn dir_total_size(path: &Path) -> u64 {
    let mut total = 0u64;
    for e in WalkDir::new(path).into_iter().filter_map(|x| x.ok()) {
        if e.file_type().is_file() {
            total += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

/// 路径标准化（小写 + 统一分隔符），仅用于比较
fn normalize_path_for_compare(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.replace('\\', "/").to_lowercase()
}

/// 在 `images/<note_id>/file` 路径中提取 note_id（用于 images 加密笔记跳过）。
/// 不是 `<root>/<id>/...` 结构的返回 None。
fn parent_note_id_from(root: &Path, file_path: &Path) -> Option<i64> {
    let rel = file_path.strip_prefix(root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?;
    first.as_os_str().to_str()?.parse::<i64>().ok()
}

// ─── 文件名 token 提取 ───────────────────────────
//
// 与 image::collect_image_filenames 同思路，但扩展名集合扩大覆盖
// 图片 / 视频 / 附件常见格式，一次扫过 content 拿到所有文件名 token，
// 给 images / videos / attachments 三类共用同一个 referenced_tokens 集合。

const ALL_EXTS: &[&str] = &[
    // images
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", // videos
    "mp4", "mov", "webm", "m4v", "ogv", "mkv", "avi", // attachments
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z", "tar", "gz", "mp3",
    "wav", "ogg", "flac", "m4a", "csv", "json", "xml", "yaml", "yml",
];

/// 从一段 content 中提取所有"疑似素材文件名"。
///
/// 与 image::collect_image_filenames 保持一致的回溯/分隔符规则；
/// 额外识别 `.enc` 后缀（加密图片整名作为一个 token）。
pub fn collect_filename_tokens(text: &str, out: &mut HashSet<String>) {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'.' {
            i += 1;
            continue;
        }
        let ext_start = i + 1;
        let mut matched: Option<usize> = None;
        for ext in ALL_EXTS {
            let end = ext_start + ext.len();
            if end > bytes.len() {
                continue;
            }
            if &bytes[ext_start..end] != ext.as_bytes() {
                continue;
            }
            let ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
            if ok {
                matched = Some(end);
                break;
            }
        }
        let Some(mut end) = matched else {
            i += 1;
            continue;
        };

        // .enc 后缀（加密图片）
        if end + 4 <= bytes.len() && &bytes[end..end + 4] == b".enc" {
            let after = end + 4;
            let ok = after == bytes.len() || !bytes[after].is_ascii_alphanumeric();
            if ok {
                end = after;
            }
        }

        // 回溯到首个分隔符
        let mut start = i;
        while start > 0 {
            let b = bytes[start - 1];
            if matches!(
                b,
                b' ' | b'\t'
                    | b'\n'
                    | b'\r'
                    | b'/'
                    | b'\\'
                    | b'"'
                    | b'\''
                    | b'('
                    | b')'
                    | b'<'
                    | b'>'
                    | b'['
                    | b']'
                    | b'!'
                    | b'#'
                    | b'?'
                    | b'&'
                    | b'='
                    | b','
                    | b';'
                    | b':'
                    | b'%' // URL 编码起始符，防止 percent-encoded URL 把整段 path 都吞进 token
            ) {
                break;
            }
            start -= 1;
        }

        if start < i {
            let token = &lower[start..end];
            if token.len() <= 256 {
                out.insert(token.to_string());
            }
        }
        i = end;
    }
}
