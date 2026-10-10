//! 通用源文件服务（管理 sources/ 目录，给 Word 等非 PDF 用）
//!
//! PDF 仍走 `services::pdf`（pdfs/ 目录，向后兼容老数据），
//! 这里负责把任意源文件按 `<note_id>.<ext>` 拷贝到 sources/ 下。

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::services::safe_filename;

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

    /// 把源文件复制到 sources/ 下，**保留原文件名**，返回相对路径。
    ///
    /// 命名规则：
    ///   - 优先 `sources/<原名>.<ext>`
    ///   - 已存在 + 内容相同 → 复用旧文件（不重复落盘）
    ///   - 已存在 + 内容不同 → 加 `-1` / `-2` / ... 后缀
    ///
    /// 注意：`note_id` 现在仅用于日志/未来扩展，不再参与命名。
    /// 旧数据 `sources/123.docx` 仍可读，无需迁移。
    pub fn attach(
        app_data_dir: &Path,
        _note_id: i64,
        source_path: &Path,
        file_type: &str,
    ) -> Result<String, AppError> {
        let abs_dir = Self::ensure_dir(app_data_dir)?;
        let ext = match file_type {
            "pdf" => "pdf",
            "docx" => "docx",
            "doc" => "doc",
            // 表格类：Excel 导入把原文件留在 sources/，扩展名即 file_type
            "xlsx" => "xlsx",
            "xls" => "xls",
            "xlsm" => "xlsm",
            "xlsb" => "xlsb",
            "ods" => "ods",
            "csv" => "csv",
            "tsv" => "tsv",
            other => {
                return Err(AppError::Custom(format!("不支持的文件类型: {}", other)));
            }
        };
        // 取原文件名（不含扩展名）；缺失时回退 untitled
        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled");
        // 读源文件内容用于判重 + 写入。Word/PDF 通常 < 50MB，全量加载可接受。
        let bytes = std::fs::read(source_path)
            .map_err(|e| AppError::Custom(format!("读取源文件失败: {}", e)))?;
        let dst = safe_filename::save_unique(&abs_dir, stem, ext, &bytes)?;
        let file_name = dst
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Custom("源文件落盘路径异常".into()))?;
        Ok(format!("{}/{}", sources_dir_name(), file_name))
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
