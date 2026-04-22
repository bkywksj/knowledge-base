//! 同步服务：导出/导入 ZIP 全量快照；WebDAV 推送/拉取
//!
//! V1/V2 设计：
//! - **全量快照**：每次导出/推送都生成完整 ZIP 包（app.db + 资产 + settings.json）
//! - **overwrite 模式**：导入时替换本地所有数据（先清空 → 再展开 ZIP）
//! - **merge 模式**：只添加 ZIP 里有、本地没有的资产；app.db 不合并（MVP 暂不实现真正合并，等同 overwrite）
//! - **密码**：WebDAV 密码 AES-256-GCM 加密后存入 SQLite app_config
//!   （密钥从 hostname + 固定 salt 派生；复制 db 到别的机器无法解密）

use std::fs;
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{SyncImportMode, SyncManifest, SyncResult, SyncScope, SyncStats};
use crate::services::crypto;
use crate::services::webdav::WebDavClient;

const MANIFEST_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const DB_FILE_IN_ZIP: &str = "app.db";
const SETTINGS_FILE_IN_ZIP: &str = "settings.json";

pub struct SyncService;

impl SyncService {
    // ─── 导出 ──────────────────────────────────

    /// 把全量快照流式写入任意 `Write + Seek`（文件 / 内存缓冲）。
    ///
    /// 关键点：所有资产文件通过 `std::io::copy` 从磁盘直接拷进 ZipWriter，
    /// 不再一次性 `fs::read` 整份到内存。大知识库场景下内存峰值从 "资产总大小"
    /// 降到 "单个文件缓冲 + ZipWriter 压缩窗口" 级别，可避免 Mac 侧 GB 级占用。
    pub fn build_snapshot_to_writer<W: Write + Seek>(
        writer: W,
        data_dir: &Path,
        db: &Database,
        scope: &SyncScope,
        app_version: &str,
    ) -> Result<SyncStats, AppError> {
        let mut stats = SyncStats::default();
        let mut zip = ZipWriter::new(writer);
        let opt = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        // 1. app.db —— 用 VACUUM INTO 生成干净副本（绕开 WAL），然后流式复制进 ZIP
        if scope.notes {
            let tmp_db = data_dir.join(".sync-tmp-app.db");
            let _ = fs::remove_file(&tmp_db);
            db.vacuum_into(&tmp_db)?;
            zip.start_file(DB_FILE_IN_ZIP, opt)?;
            {
                let mut f = fs::File::open(&tmp_db)?;
                std::io::copy(&mut f, &mut zip)?;
            }
            let _ = fs::remove_file(&tmp_db);

            // 统计
            stats.notes_count = db.count_notes_active()?;
            stats.folders_count = db.count_folders()?;
            stats.tags_count = db.count_tags()?;
        }

        // 2. kb_assets/images/
        if scope.images {
            let images_dir = data_dir.join(assets_dir_name());
            let (count, size) = add_dir_to_zip(
                &mut zip,
                &images_dir,
                &format!("{}/", assets_dir_name()),
                opt,
            )?;
            stats.images_count = count;
            stats.assets_size += size;
        }

        // 3. pdfs/
        if scope.pdfs {
            let pdfs_dir = data_dir.join(pdfs_dir_name());
            let (count, size) = add_dir_to_zip(
                &mut zip,
                &pdfs_dir,
                &format!("{}/", pdfs_dir_name()),
                opt,
            )?;
            stats.pdfs_count = count;
            stats.assets_size += size;
        }

        // 4. sources/
        if scope.sources {
            let sources_dir = data_dir.join(sources_dir_name());
            let (count, size) = add_dir_to_zip(
                &mut zip,
                &sources_dir,
                &format!("{}/", sources_dir_name()),
                opt,
            )?;
            stats.sources_count = count;
            stats.assets_size += size;
        }

        // 5. settings.json（通常很小，直接读）
        if scope.settings {
            let settings_file = data_dir.join(settings_file_name());
            if settings_file.exists() {
                zip.start_file(SETTINGS_FILE_IN_ZIP, opt)?;
                let mut f = fs::File::open(&settings_file)?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }

        // 6. manifest.json
        let manifest = SyncManifest {
            schema_version: MANIFEST_VERSION,
            device: hostname::get()
                .map(|h| h.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "unknown".into()),
            exported_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            app_version: app_version.to_string(),
            scope: scope.clone(),
            stats: stats.clone(),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)?;
        zip.start_file(MANIFEST_FILE, opt)?;
        zip.write_all(manifest_json.as_bytes())?;

        zip.finish()?;
        Ok(stats)
    }

    /// 导出到本地文件（流式写盘，不占用对等内存）
    pub fn export_to_file(
        data_dir: &Path,
        db: &Database,
        scope: &SyncScope,
        app_version: &str,
        target_path: &Path,
    ) -> Result<SyncResult, AppError> {
        let file = fs::File::create(target_path)?;
        let writer = BufWriter::new(file);
        let stats = Self::build_snapshot_to_writer(writer, data_dir, db, scope, app_version)?;
        Ok(SyncResult {
            stats,
            finished_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        })
    }

    // ─── 导入 ──────────────────────────────────

    /// 从任意 `Read + Seek`（本地文件 / 内存游标）流式展开快照，避免把整个
    /// ZIP 载入内存。ZipArchive 需要 Seek，因此下载场景要先落盘到临时文件。
    pub fn apply_snapshot_from_reader<R: Read + Seek>(
        data_dir: &Path,
        db_path: &Path,
        reader: R,
        mode: SyncImportMode,
    ) -> Result<SyncManifest, AppError> {
        let mut archive = ZipArchive::new(reader)
            .map_err(|e| AppError::Custom(format!("解析 ZIP 失败: {}", e)))?;

        // 读取 manifest
        let manifest: SyncManifest = {
            let mut file = archive
                .by_name(MANIFEST_FILE)
                .map_err(|_| AppError::Custom("ZIP 缺少 manifest.json，不是合法的同步包".into()))?;
            let mut s = String::new();
            file.read_to_string(&mut s)?;
            serde_json::from_str(&s)?
        };

        if manifest.schema_version > MANIFEST_VERSION {
            return Err(AppError::Custom(format!(
                "同步包版本 {} 高于当前应用支持的 {}, 请升级应用",
                manifest.schema_version, MANIFEST_VERSION
            )));
        }

        // overwrite 模式：替换 app.db 前先清掉资产目录
        if matches!(mode, SyncImportMode::Overwrite) {
            if manifest.scope.images {
                let d = data_dir.join(assets_dir_name());
                if d.exists() {
                    let _ = fs::remove_dir_all(&d);
                }
                fs::create_dir_all(&d)?;
            }
            if manifest.scope.pdfs {
                let d = data_dir.join(pdfs_dir_name());
                if d.exists() {
                    let _ = fs::remove_dir_all(&d);
                }
                fs::create_dir_all(&d)?;
            }
            if manifest.scope.sources {
                let d = data_dir.join(sources_dir_name());
                if d.exists() {
                    let _ = fs::remove_dir_all(&d);
                }
                fs::create_dir_all(&d)?;
            }
        }

        // 展开 ZIP 所有文件
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| AppError::Custom(format!("读取 ZIP 条目失败: {}", e)))?;
            let name = file.name().to_string();

            if name == MANIFEST_FILE {
                continue;
            }

            let target = match name.as_str() {
                n if n == DB_FILE_IN_ZIP => {
                    // app.db 写入到传入的 db_path（可能是 dev- 前缀）
                    db_path.to_path_buf()
                }
                n if n == SETTINGS_FILE_IN_ZIP => data_dir.join(settings_file_name()),
                other => {
                    // 资产：把 ZIP 里的 "kb_assets/..." / "pdfs/..." / "sources/..." 映射到
                    // data_dir 下对应带 dev- 前缀的实际目录
                    let mapped = remap_asset_path_with_prefix(other);
                    data_dir.join(mapped)
                }
            };

            if file.is_dir() {
                fs::create_dir_all(&target)?;
                continue;
            }

            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }

            // merge 模式：资产文件已存在则跳过（app.db / settings.json 总是覆盖）
            let is_asset = name != DB_FILE_IN_ZIP && name != SETTINGS_FILE_IN_ZIP;
            if is_asset && matches!(mode, SyncImportMode::Merge) && target.exists() {
                continue;
            }

            let mut out = fs::File::create(&target)?;
            std::io::copy(&mut file, &mut out)?;
        }

        // 同步完成后清理失效的 WebDAV 加密密码条目
        // （从别的设备同步来的密文，用的是那台设备的 hostname 派生的 key，本机解不开）
        Self::cleanup_invalid_webdav_passwords(db_path);

        Ok(manifest)
    }

    /// 扫描 app_config 中所有 sync.webdav_pw_enc.* 条目，
    /// 解密失败的（换设备后无效）直接删除。失败仅 warn，不阻塞同步。
    fn cleanup_invalid_webdav_passwords(db_path: &Path) {
        let conn = match rusqlite::Connection::open(db_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("清理失效密码：打开 DB 失败 {}", e);
                return;
            }
        };
        let entries: Vec<(String, String)> = match conn
            .prepare("SELECT key, value FROM app_config WHERE key LIKE 'sync.webdav_pw_enc.%'")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
            }) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("清理失效密码：查询失败 {}", e);
                return;
            }
        };

        let mut removed = 0;
        for (key, enc) in entries {
            if crypto::decrypt(&enc).is_err() {
                if let Err(e) = conn.execute("DELETE FROM app_config WHERE key = ?1", [&key]) {
                    log::warn!("清理失效密码：删除 {} 失败 {}", key, e);
                } else {
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            log::info!("同步后已清理 {} 个失效的 WebDAV 密码条目（换设备导致）", removed);
        }
    }

    /// 从本地文件导入（流式读取，避免把整份 ZIP 载入内存）
    pub fn import_from_file(
        data_dir: &Path,
        db_path: &Path,
        source_path: &Path,
        mode: SyncImportMode,
    ) -> Result<SyncManifest, AppError> {
        let file = fs::File::open(source_path)?;
        let reader = BufReader::new(file);
        Self::apply_snapshot_from_reader(data_dir, db_path, reader, mode)
    }

    // ─── WebDAV 云同步 ──────────────────────────

    /// 推送到 WebDAV：先把快照流式写入临时文件，再流式上传，
    /// 全程不把整份 ZIP 驻留在内存中。
    pub async fn webdav_push(
        data_dir: &Path,
        db: &Database,
        scope: &SyncScope,
        app_version: &str,
        url: &str,
        username: &str,
        password: &str,
    ) -> Result<SyncResult, AppError> {
        let tmp_zip = data_dir.join(".sync-tmp-upload.zip");
        let _ = fs::remove_file(&tmp_zip);

        // 1. 流式构建快照到临时文件
        let stats = {
            let file = fs::File::create(&tmp_zip)?;
            let writer = BufWriter::new(file);
            Self::build_snapshot_to_writer(writer, data_dir, db, scope, app_version)?
        };

        // 2. 流式上传临时文件，无论成败都清理临时文件
        let filename = device_zip_name();
        let client = WebDavClient::new(url, username, password);
        let upload_result = client.upload_file(&filename, &tmp_zip).await;
        let _ = fs::remove_file(&tmp_zip);
        upload_result?;

        Ok(SyncResult {
            stats,
            finished_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        })
    }

    /// 从 WebDAV 拉取：先流式下载到临时文件，再流式解包，
    /// 避免把整份 ZIP 驻留在内存中。
    pub async fn webdav_pull(
        data_dir: &Path,
        db_path: &Path,
        mode: SyncImportMode,
        url: &str,
        username: &str,
        password: &str,
        preferred_filename: Option<&str>,
    ) -> Result<SyncManifest, AppError> {
        let client = WebDavClient::new(url, username, password);
        let filename = preferred_filename
            .map(|s| s.to_string())
            .unwrap_or_else(device_zip_name);

        let tmp_zip = data_dir.join(".sync-tmp-pull.zip");
        let _ = fs::remove_file(&tmp_zip);

        // 1. 流式下载到临时文件
        if let Err(e) = client.download_to_file(&filename, &tmp_zip).await {
            let _ = fs::remove_file(&tmp_zip);
            return Err(e);
        }

        // 2. 流式读取并展开
        let apply_result = (|| {
            let file = fs::File::open(&tmp_zip)?;
            let reader = BufReader::new(file);
            Self::apply_snapshot_from_reader(data_dir, db_path, reader, mode)
        })();

        let _ = fs::remove_file(&tmp_zip);
        apply_result
    }

    /// 列出云端所有 `kb-sync-*.zip` 快照（多设备场景）
    /// 返回 (filename, device_name) 元组列表，按设备名排序
    pub async fn webdav_list_snapshots(
        url: &str,
        username: &str,
        password: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let client = WebDavClient::new(url, username, password);
        let files = client.list_files().await?;
        let mut snapshots: Vec<(String, String)> = files
            .into_iter()
            .filter(|f| f.starts_with("kb-sync-") && f.ends_with(".zip"))
            .map(|f| {
                // kb-sync-<device>.zip → 提取 <device>
                let device = f
                    .trim_start_matches("kb-sync-")
                    .trim_end_matches(".zip")
                    .to_string();
                (f, device)
            })
            .collect();
        snapshots.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(snapshots)
    }

    /// 预览云端 manifest（不下载资产，只读 manifest.json）
    pub async fn webdav_preview(
        url: &str,
        username: &str,
        password: &str,
        filename: Option<&str>,
    ) -> Result<SyncManifest, AppError> {
        let client = WebDavClient::new(url, username, password);
        let fname = filename.map(|s| s.to_string()).unwrap_or_else(device_zip_name);
        let bytes = client.download_bytes(&fname).await?;
        let reader = Cursor::new(bytes);
        let mut archive = ZipArchive::new(reader)
            .map_err(|e| AppError::Custom(format!("解析云端 ZIP 失败: {}", e)))?;
        let mut file = archive
            .by_name(MANIFEST_FILE)
            .map_err(|_| AppError::Custom("云端 ZIP 缺少 manifest.json".into()))?;
        let mut s = String::new();
        file.read_to_string(&mut s)?;
        let m: SyncManifest = serde_json::from_str(&s)?;
        Ok(m)
    }

    // ─── 密码存取（AES-GCM 加密 + SQLite app_config） ──────────────────────

    /// 配置 key：密文按用户名后缀区分（支持多 WebDAV 账号）
    /// 最终存的键形如 `sync.webdav_pw_enc.<username>`，value 是 base64 密文
    fn pw_config_key(username: &str) -> String {
        format!("sync.webdav_pw_enc.{}", username)
    }

    /// 把 WebDAV 密码加密后存入 SQLite
    pub fn save_webdav_password(
        db: &Database,
        username: &str,
        password: &str,
    ) -> Result<(), AppError> {
        let enc = crypto::encrypt(password)?;
        db.set_config(&Self::pw_config_key(username), &enc)?;
        Ok(())
    }

    /// 从 SQLite 读 WebDAV 密文并解密
    pub fn get_webdav_password(
        db: &Database,
        username: &str,
    ) -> Result<Option<String>, AppError> {
        match db.get_config(&Self::pw_config_key(username))? {
            Some(enc) if !enc.is_empty() => crypto::decrypt(&enc).map(Some),
            _ => Ok(None),
        }
    }

    /// 删除 SQLite 中的 WebDAV 密文
    pub fn delete_webdav_password(db: &Database, username: &str) -> Result<(), AppError> {
        let _ = db.delete_config(&Self::pw_config_key(username))?;
        Ok(())
    }
}

// ─── 辅助函数 ─────────────────────────────────

/// 把本地目录递归加入 ZIP，prefix 是 ZIP 内的路径前缀（需以 '/' 结尾）
/// 返回 (文件数, 总字节数)
///
/// 使用 `std::io::copy` 把文件内容流式喂给 ZipWriter，不再 `fs::read` 整份读入内存。
/// 这样即便单个资产是 GB 级大文件，内存占用也只是拷贝缓冲 + ZlibEncoder 窗口。
fn add_dir_to_zip<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    local_dir: &Path,
    prefix: &str,
    opt: SimpleFileOptions,
) -> Result<(usize, u64), AppError> {
    if !local_dir.exists() {
        return Ok((0, 0));
    }
    let mut count = 0;
    let mut size = 0u64;
    for entry in walkdir::WalkDir::new(local_dir).into_iter().flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(local_dir)
            .map_err(|e| AppError::Custom(format!("路径拼接失败: {}", e)))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let zip_path = format!("{}{}", prefix, rel_str);
        zip.start_file(zip_path, opt)?;
        let mut f = fs::File::open(path)?;
        let n = std::io::copy(&mut f, zip)?;
        count += 1;
        size += n;
    }
    Ok((count, size))
}

/// 把 ZIP 里标准路径（kb_assets/... / pdfs/... / sources/...）
/// 映射回本地带 dev- 前缀的实际路径（如 dev-kb_assets/...）
fn remap_asset_path_with_prefix(zip_path: &str) -> PathBuf {
    let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
    if prefix.is_empty() {
        return PathBuf::from(zip_path);
    }
    // 把第一段目录名加前缀
    if let Some(slash) = zip_path.find('/') {
        let head = &zip_path[..slash];
        let tail = &zip_path[slash..];
        PathBuf::from(format!("{}{}{}", prefix, head, tail))
    } else {
        PathBuf::from(format!("{}{}", prefix, zip_path))
    }
}

fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) { "dev-kb_assets" } else { "kb_assets" }
}
fn pdfs_dir_name() -> &'static str {
    if cfg!(debug_assertions) { "dev-pdfs" } else { "pdfs" }
}
fn sources_dir_name() -> &'static str {
    if cfg!(debug_assertions) { "dev-sources" } else { "sources" }
}
fn settings_file_name() -> &'static str {
    if cfg!(debug_assertions) { "dev-settings.json" } else { "settings.json" }
}

/// 本机设备名作为云端 ZIP 文件名（同一 WebDAV 下多设备互不覆盖）
fn device_zip_name() -> String {
    let device = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    // 清洗：只留字母/数字/-/_
    let safe: String = device
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("kb-sync-{}.zip", safe.to_lowercase())
}
