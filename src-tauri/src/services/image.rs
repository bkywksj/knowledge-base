use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{OrphanImageClean, OrphanImageScan};

/// 图片资产目录名（dev 模式加 dev- 前缀实现数据隔离）
const ASSETS_DIR_PROD: &str = "kb_assets";
const ASSETS_DIR_DEV: &str = "dev-kb_assets";
const IMAGES_DIR: &str = "images";

#[inline]
fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) { ASSETS_DIR_DEV } else { ASSETS_DIR_PROD }
}

pub struct ImageService;

impl ImageService {
    /// 获取图片根目录: {app_data_dir}/{prefix}kb_assets/images/
    pub fn images_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(assets_dir_name()).join(IMAGES_DIR)
    }

    /// 确保图片目录存在
    pub fn ensure_dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::images_dir(app_data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 从 base64 数据保存图片（用于粘贴/拖放）
    ///
    /// 返回保存后的绝对路径
    pub fn save_from_base64(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        base64_data: &str,
    ) -> Result<String, AppError> {
        let data = STANDARD
            .decode(base64_data)
            .map_err(|e| AppError::Custom(format!("base64 解码失败: {}", e)))?;

        Self::save_bytes(app_data_dir, note_id, file_name, &data)
    }

    /// 从本地文件路径复制图片（用于工具栏插入）
    ///
    /// 返回保存后的绝对路径
    pub fn save_from_path(
        app_data_dir: &Path,
        note_id: i64,
        source_path: &str,
    ) -> Result<String, AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!("文件不存在: {}", source_path)));
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.png");

        let data = std::fs::read(source)?;
        Self::save_bytes(app_data_dir, note_id, file_name, &data)
    }

    /// 保存字节数据到文件
    fn save_bytes(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
    ) -> Result<String, AppError> {
        let note_dir = Self::images_dir(app_data_dir).join(note_id.to_string());
        std::fs::create_dir_all(&note_dir)?;

        // 从原始文件名提取扩展名
        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");

        // 用时间戳 + 纳秒生成唯一文件名
        let now = chrono::Local::now();
        let unique_name = format!(
            "{}_{:09}.{}",
            now.format("%Y%m%d%H%M%S"),
            now.timestamp_subsec_nanos(),
            ext
        );

        let file_path = note_dir.join(&unique_name);
        std::fs::write(&file_path, data)?;

        log::info!("图片已保存: {}", file_path.display());
        Ok(file_path.to_string_lossy().into_owned())
    }

    /// 删除笔记的所有图片
    pub fn delete_note_images(app_data_dir: &Path, note_id: i64) -> Result<(), AppError> {
        let note_dir = Self::images_dir(app_data_dir).join(note_id.to_string());
        if note_dir.exists() {
            std::fs::remove_dir_all(&note_dir)?;
            log::info!("已删除笔记 {} 的所有图片", note_id);
        }
        Ok(())
    }

    /// 扫描孤儿图片（只扫不删）
    ///
    /// 判定方式：遍历所有活跃笔记 content 拼成 haystack，
    /// 图片目录下每个文件若其唯一文件名在 haystack 中未出现 → 视为孤儿。
    /// 唯一名包含时间戳+纳秒，冲突概率可忽略。
    pub fn scan_orphans(db: &Database, app_data_dir: &Path) -> Result<OrphanImageScan, AppError> {
        const DISPLAY_LIMIT: usize = 500;

        // 1) 收集所有笔记正文拼一个大串
        let contents = db.list_all_active_contents()?;
        let haystack: String = contents.join("\n");

        // 2) 遍历图片目录
        let images_root = Self::images_dir(app_data_dir);
        if !images_root.exists() {
            return Ok(OrphanImageScan {
                count: 0,
                total_bytes: 0,
                paths: Vec::new(),
                truncated: false,
            });
        }

        let mut count = 0usize;
        let mut total_bytes = 0u64;
        let mut paths: Vec<String> = Vec::new();
        let mut truncated = false;

        for entry in WalkDir::new(&images_root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let name = match entry.file_name().to_str() {
                Some(n) => n,
                None => continue,
            };
            if haystack.contains(name) {
                continue;
            }
            // 是孤儿
            count += 1;
            if let Ok(md) = entry.metadata() {
                total_bytes += md.len();
            }
            if paths.len() < DISPLAY_LIMIT {
                paths.push(entry.path().to_string_lossy().into_owned());
            } else {
                truncated = true;
            }
        }

        Ok(OrphanImageScan {
            count,
            total_bytes,
            paths,
            truncated,
        })
    }

    /// 删除指定路径列表的孤儿图片
    ///
    /// 为安全起见，仅允许删除 images 目录下的文件（路径前缀校验）。
    pub fn clean_orphans(
        app_data_dir: &Path,
        paths: &[String],
    ) -> Result<OrphanImageClean, AppError> {
        let images_root = Self::images_dir(app_data_dir);
        let images_root_str = images_root.to_string_lossy().to_string();
        let mut deleted = 0usize;
        let mut freed_bytes = 0u64;
        let mut failed: Vec<String> = Vec::new();

        for p in paths {
            // 安全校验：路径必须在 images 目录下
            if !p.starts_with(&images_root_str) {
                failed.push(format!("{}: 非法路径（不在 images 目录下）", p));
                continue;
            }
            let path = Path::new(p);
            if !path.exists() {
                // 已不存在，忽略
                continue;
            }
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            match std::fs::remove_file(path) {
                Ok(_) => {
                    deleted += 1;
                    freed_bytes += size;
                }
                Err(e) => failed.push(format!("{}: {}", p, e)),
            }
        }

        Ok(OrphanImageClean {
            deleted,
            freed_bytes,
            failed,
        })
    }
}
