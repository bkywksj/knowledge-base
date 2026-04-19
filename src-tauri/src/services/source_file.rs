//! 通用源文件服务（管理 sources/ 目录，给 Word 等非 PDF 用）
//!
//! PDF 仍走 `services::pdf`（pdfs/ 目录，向后兼容老数据），
//! 这里负责把任意源文件按 `<note_id>.<ext>` 拷贝到 sources/ 下。

use std::path::{Path, PathBuf};

use crate::error::AppError;

const SOURCES_DIR_PROD: &str = "sources";
const SOURCES_DIR_DEV: &str = "dev-sources";

#[inline]
fn sources_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        SOURCES_DIR_DEV
    } else {
        SOURCES_DIR_PROD
    }
}

pub struct SourceFileService;

impl SourceFileService {
    pub fn sources_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(sources_dir_name())
    }

    pub fn ensure_dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::sources_dir(app_data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 把源文件拷贝到 sources/<note_id>.<ext>，返回相对路径
    pub fn attach(
        app_data_dir: &Path,
        note_id: i64,
        source_path: &Path,
        file_type: &str,
    ) -> Result<String, AppError> {
        Self::ensure_dir(app_data_dir)?;
        let ext = match file_type {
            "pdf" => "pdf",
            "docx" => "docx",
            "doc" => "doc",
            other => {
                return Err(AppError::Custom(format!(
                    "不支持的文件类型: {}",
                    other
                )));
            }
        };
        let rel = format!("{}/{}.{}", sources_dir_name(), note_id, ext);
        let dst = app_data_dir.join(&rel);
        std::fs::copy(source_path, &dst)
            .map_err(|e| AppError::Custom(format!("拷贝源文件失败: {}", e)))?;
        Ok(rel)
    }

    /// 把已存在的相对路径解析为绝对路径（不存在则 None）
    pub fn resolve_absolute(app_data_dir: &Path, rel_path: &str) -> Option<PathBuf> {
        let abs = app_data_dir.join(rel_path);
        if abs.exists() {
            Some(abs)
        } else {
            None
        }
    }
}
