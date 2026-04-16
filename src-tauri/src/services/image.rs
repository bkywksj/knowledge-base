use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::error::AppError;

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
}
