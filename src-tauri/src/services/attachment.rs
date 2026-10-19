//! 附件服务：PDF / Office / ZIP / 音视频等非图片非文本文件的存储。
//!
//! 与 image/pdf/source_file 并列，纯文件系统存储（不建 DB 表）：
//!   · 根目录：{app_data_dir}/{prefix}kb_assets/attachments/<note_id>/
//!   · 元数据只存在 Tiptap 节点 attrs / Markdown 链接里
//!   · 笔记永久删除时由 TrashService 统一清目录
//!
//! 设计上与 ImageService 完全对称，孤儿扫描后续再补（见 T-B 跟进项）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::error::AppError;
use crate::models::AttachmentInfo;
use crate::services::safe_filename;

/// 进程内递增计数器，保证同一毫秒内多次保存也不会冲突
static ATTACHMENT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 附件资产目录名（dev 模式加 dev- 前缀实现数据隔离）
const ASSETS_DIR_PROD: &str = "kb_assets";
const ASSETS_DIR_DEV: &str = "dev-kb_assets";
const ATTACHMENTS_DIR: &str = "attachments";

/// 安全黑名单：禁止保存的可执行 / 脚本 / 二进制系统文件
/// Why: 附件走"任意 OS 文件拖放"入口，若允许 .exe/.bat/.dll 进入知识库，
///      用户把笔记同步给别人时可能携带恶意载荷；显式 block 掉最常见的几类。
pub(crate) const BLOCKED_EXTS: &[&str] = &[
    "exe", "msi", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "sh", "app", "dmg",
    "scr", "com", "pif", "dll", "sys", "drv", "cpl", "hta", "jar", "apk", "ipa", "deb", "rpm",
];

#[inline]
fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        ASSETS_DIR_DEV
    } else {
        ASSETS_DIR_PROD
    }
}

pub struct AttachmentService;

impl AttachmentService {
    /// 附件根目录: {app_data_dir}/{prefix}kb_assets/attachments/
    pub fn attachments_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(assets_dir_name()).join(ATTACHMENTS_DIR)
    }

    /// 确保附件目录存在
    pub fn ensure_dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::attachments_dir(app_data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 从 base64 数据保存附件（前端拖放 File → readAsDataURL 后传入）
    ///
    /// 返回附件信息（绝对路径 + 原始文件名 + 字节数 + MIME）
    pub fn save_from_base64(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        base64_data: &str,
    ) -> Result<AttachmentInfo, AppError> {
        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if BLOCKED_EXTS.contains(&ext.as_str()) {
            return Err(AppError::Custom(format!(
                "出于安全考虑，禁止保存 .{} 文件为附件",
                ext
            )));
        }

        let data = STANDARD
            .decode(base64_data)
            .map_err(|e| AppError::Custom(format!("base64 解码失败: {}", e)))?;

        Self::save_bytes(app_data_dir, note_id, file_name, &data)
    }

    /// 从本地文件路径零拷贝保存（用于工具栏"插入附件"或大文件场景）
    ///
    /// 与 `save_from_base64` 相比：走 `std::fs::copy` 不经过 IPC，
    /// 避免大文件 base64 编解码导致的内存峰值 + IPC 卡顿。
    pub fn save_from_path(
        app_data_dir: &Path,
        note_id: i64,
        source_path: &str,
    ) -> Result<AttachmentInfo, AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!("文件不存在: {}", source_path)));
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment.bin");

        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // 安全黑名单：与 save_from_base64 同等校验
        if BLOCKED_EXTS.contains(&ext.as_str()) {
            return Err(AppError::Custom(format!(
                "出于安全考虑，禁止保存 .{} 文件为附件",
                ext
            )));
        }

        let note_dir = Self::attachments_dir(app_data_dir).join(note_id.to_string());
        let stem = Path::new(file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment");
        let ext_for_name = if ext.is_empty() { "bin" } else { ext.as_str() };

        // 零拷贝：safe_filename::save_unique_from_path 直接走 fs::copy，
        // 避免大附件（zip/视频）读到 RAM。同名时直接加 -N 后缀。
        let file_path =
            safe_filename::save_unique_from_path(&note_dir, stem, ext_for_name, source)?;
        ATTACHMENT_SEQ.fetch_add(1, Ordering::Relaxed);

        let size = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
        let mime = mime_for_ext(&ext).to_string();

        log::info!(
            "附件已复制: {} → {} ({} bytes)",
            source.display(),
            file_path.display(),
            size
        );
        Ok(AttachmentInfo {
            path: file_path.to_string_lossy().into_owned(),
            file_name: file_name.to_string(),
            size,
            mime,
        })
    }

    /// 保存字节数据到文件（base64 路径用，bytes 已在内存里）。
    ///
    /// 命名规则：`<原 stem>.<ext>`；冲突时加 `-1/-2/...`；
    /// `safe_filename::save_unique` 内部对 ≤64MB 同名文件做内容 dedup（节省磁盘）。
    fn save_bytes(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
    ) -> Result<AttachmentInfo, AppError> {
        let note_dir = Self::attachments_dir(app_data_dir).join(note_id.to_string());

        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let stem = Path::new(file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment");

        let file_path = safe_filename::save_unique(&note_dir, stem, ext, data)?;
        ATTACHMENT_SEQ.fetch_add(1, Ordering::Relaxed);

        let size = data.len() as u64;
        let mime = mime_for_ext(ext).to_string();

        log::info!("附件已保存: {} ({} bytes)", file_path.display(), size);
        Ok(AttachmentInfo {
            path: file_path.to_string_lossy().into_owned(),
            file_name: file_name.to_string(),
            size,
            mime,
        })
    }

    /// 删除笔记的所有附件目录
    pub fn delete_note_attachments(app_data_dir: &Path, note_id: i64) -> Result<(), AppError> {
        let note_dir = Self::attachments_dir(app_data_dir).join(note_id.to_string());
        if note_dir.exists() {
            std::fs::remove_dir_all(&note_dir)?;
            log::info!("已删除笔记 {} 的所有附件", note_id);
        }
        Ok(())
    }
}

pub(crate) fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "rar" => "application/x-rar-compressed",
        "7z" => "application/x-7z-compressed",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_ext_rejected_without_disk_io() {
        // 走纯 path 不落盘的路径：构造一个不存在的 data_dir，走到扩展名校验就会提前返回
        let fake_dir = Path::new("/nonexistent-for-test-only");
        let err = AttachmentService::save_from_base64(fake_dir, 1, "trojan.exe", "aGVsbG8=")
            .err()
            .expect("应被黑名单拦截");
        assert!(err.to_string().contains("禁止保存"));
    }
}
