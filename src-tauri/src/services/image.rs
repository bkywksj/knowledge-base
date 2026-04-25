use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use walkdir::WalkDir;

/// 进程内递增计数器，保证同一毫秒内多次保存也不会冲突
static IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

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

    /// 保存字节数据到文件（用于 base64 解码后 / 外链下载后的最终落盘）
    pub fn save_bytes(
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

        // Why: 原版只用 timestamp+纳秒，Windows 系统时钟在极短间隔内可能返回相同值，
        // 多张图连续保存会互相覆盖 → 前端看起来"只进一张"。加进程内原子计数器彻底消除冲突。
        let now = chrono::Local::now();
        let seq = IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);
        let unique_name = format!(
            "{}_{:09}_{:06}.{}",
            now.format("%Y%m%d%H%M%S"),
            now.timestamp_subsec_nanos(),
            seq,
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
    /// 判定方式：图片文件名形如 `YYYYMMDDHHMMSS_<nanos>.ext`，
    /// 扫描所有笔记 content 抓出所有"带图片扩展名的 token"塞进 HashSet，
    /// 磁盘文件若名字不在 set 里则视为孤儿。
    ///
    /// **旧实现的问题**：把所有笔记 content 拼成一个 GB 级 haystack，再对磁盘上
    /// 每个图片文件名做 O(n*m) 子串匹配 `haystack.contains(name)`。笔记库大时：
    ///   - haystack 内存峰值可达数百 MB（所有正文拷贝 + `join` 再拷贝一次）
    ///   - 每次 contains() 线性扫描整个 haystack
    ///
    /// **新实现**：流式扫描 content，用手写状态机一次扫过提取所有 `<name>.<ext>` token。
    /// 判定孤儿时直接 `HashSet::contains`，O(1) 查表。
    pub fn scan_orphans(db: &Database, app_data_dir: &Path) -> Result<OrphanImageScan, AppError> {
        use std::collections::HashSet;
        const DISPLAY_LIMIT: usize = 500;

        // 1) 构建"笔记里引用的图片文件名"集合：扫 content 抓时间戳前缀的文件名 token
        let contents = db.list_all_active_contents()?;
        let mut referenced: HashSet<String> = HashSet::new();
        for c in &contents {
            collect_image_filenames(c, &mut referenced);
        }
        drop(contents); // 及早释放大字符串数组

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
            // referenced 里的文件名在 collect 时已小写化，这里也小写再比
            if referenced.contains(&name.to_lowercase()) {
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

/// 从一段笔记正文中提取所有"疑似图片文件名"并塞入 set。
///
/// 规则：识别以下扩展名的 token（忽略大小写）：`png jpg jpeg gif webp svg bmp`。
/// 找到 `.<ext>` 后向前回溯到首个分隔符（空白、`/`、`\`、`"`、`'`、`(`、`)`、`<`、`>`、`[`、`]`、`!`、`#`、`?`），
/// 得到完整文件名（不含路径）。无正则依赖，一次线性扫过。
fn collect_image_filenames(text: &str, out: &mut std::collections::HashSet<String>) {
    const EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'.' {
            i += 1;
            continue;
        }
        // 尝试匹配 `.<ext>`（后面紧跟非字母数字或到末尾）
        let ext_start = i + 1;
        let mut matched: Option<(usize, usize)> = None; // (start, end_exclusive)
        for ext in EXTS {
            let end = ext_start + ext.len();
            if end > bytes.len() {
                continue;
            }
            if &bytes[ext_start..end] != ext.as_bytes() {
                continue;
            }
            // 后一个字符必须不是字母数字，避免把 `.pngx` 错当 `.png`
            let ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
            if ok {
                matched = Some((ext_start, end));
                break;
            }
        }
        let Some((_ext_s, end)) = matched else {
            i += 1;
            continue;
        };

        // 向前回溯找到文件名起点（到首个分隔符或开头）
        let mut start = i; // i 指向 `.`
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
            ) {
                break;
            }
            start -= 1;
        }

        if start < i {
            // &lower[start..end] 是纯 ASCII 文件名（扩展名是 ASCII，文件名部分来自保存逻辑也是 ASCII）
            let token = &lower[start..end];
            // 限制长度防止把整段 token 都当文件名（比如异常数据里可能有超长 token）
            if token.len() <= 128 {
                out.insert(token.to_string());
            }
        }
        i = end;
    }
}
