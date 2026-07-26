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
use std::path::Path;

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

/// 导入前自动备份现有数据库的文件名后缀：`app.db.bak-20260727-153000`
const DB_BACKUP_SUFFIX: &str = ".bak-";
/// 滚动保留的自动备份份数（超出的删最旧）
const DB_BACKUP_KEEP: usize = 3;

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
        // 设计：ZIP 内路径**保留当前实例的 dev/prod 风格**（dev 写 dev-kb_assets/，
        // prod 写 kb_assets/），让 dev/prod 数据物理隔离不相互污染。
        // Import 端直接按 ZIP 内路径落盘，并通过 manifest.is_dev 做强一致性校验，
        // 跨 dev/prod 的导入会被拒绝（防止 dev 包污染 prod 实例反之亦然）。
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
            let (count, size) =
                add_dir_to_zip(&mut zip, &pdfs_dir, &format!("{}/", pdfs_dir_name()), opt)?;
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
            // 标记当前 build 类型，import 端做强一致性校验
            is_dev: Some(cfg!(debug_assertions)),
            // 记录库结构版本，让导入端能在替换文件**之前**判断兼容性
            // （避免导入高版本库后应用下次直接起不来）
            db_user_version: Some(crate::database::schema::SCHEMA_VERSION),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)?;
        zip.start_file(MANIFEST_FILE, opt)?;
        zip.write_all(manifest_json.as_bytes())?;

        zip.finish()?;
        Ok(stats)
    }

    /// 导出到本地文件（流式写盘，不占用对等内存）
    ///
    /// `backup_password`：T-S050 端到端加密。None = 明文 ZIP；Some(pw) = 整块 AES-256-GCM 加密
    /// （build 到临时文件 → 整体读入内存加密 → 写 target；大库 >100MB 注意内存峰值）
    pub fn export_to_file(
        data_dir: &Path,
        db: &Database,
        scope: &SyncScope,
        app_version: &str,
        target_path: &Path,
        backup_password: Option<&str>,
    ) -> Result<SyncResult, AppError> {
        let stats = match backup_password {
            None => {
                let file = fs::File::create(target_path)?;
                let writer = BufWriter::new(file);
                Self::build_snapshot_to_writer(writer, data_dir, db, scope, app_version)?
            }
            Some(pw) => {
                // 先 build 到临时文件，再加密写 target
                let tmp = data_dir.join(".sync-tmp-export.zip");
                let _ = fs::remove_file(&tmp);
                let stats = {
                    let file = fs::File::create(&tmp)?;
                    Self::build_snapshot_to_writer(
                        BufWriter::new(file),
                        data_dir,
                        db,
                        scope,
                        app_version,
                    )?
                };
                let zip_bytes = fs::read(&tmp)?;
                let _ = fs::remove_file(&tmp);
                let enc = Self::encrypt_snapshot(&zip_bytes, pw)?;
                fs::write(target_path, &enc)?;
                stats
            }
        };
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

        // 数据库结构版本前置校验（快速失败，此时还没解压任何东西、更没碰 app.db）。
        // 注意 `schema_version` 管的是 ZIP 包格式（恒为 1），跟库结构无关 —— 必须单独看这一项。
        // 老包没有该字段（None）→ 这里放行，后面用解出来的 db 文件实读 user_version 兜底。
        if let Some(v) = manifest.db_user_version {
            if v > crate::database::schema::SCHEMA_VERSION {
                return Err(AppError::Custom(format!(
                    "该备份来自更新版本的应用（数据库结构 v{}，当前应用支持 v{}）。\
                     强行导入会导致应用下次启动时无法打开数据库 —— 请先把本机应用升级到最新版本再恢复。",
                    v,
                    crate::database::schema::SCHEMA_VERSION
                )));
            }
        }

        // dev/prod 一致性校验：包里的 is_dev 必须和当前 build 匹配，
        // 防止 dev 包污染 prod 实例（资产路径前缀不同会造成无法读取的孤儿数据）。
        // is_dev 字段为 None = 老版本导出（在引入校验之前），按"宽容兼容"放行 + 日志告警。
        let current_is_dev = cfg!(debug_assertions);
        match manifest.is_dev {
            Some(zip_is_dev) if zip_is_dev != current_is_dev => {
                return Err(AppError::Custom(format!(
                    "同步包来源是 {} 实例，当前是 {} 实例，不允许跨环境导入（资产目录前缀不同会变成孤儿数据）",
                    if zip_is_dev { "dev" } else { "prod" },
                    if current_is_dev { "dev" } else { "prod" },
                )));
            }
            None => {
                log::warn!("[sync] 同步包未带 is_dev 字段（老版本导出），跳过 dev/prod 一致性校验");
            }
            _ => {}
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

        // app.db 的落地策略（本次改造核心）：
        //
        // 旧实现直接 `fs::File::create(app.db)` 就地截断再边解压边写。只要中途出任何问题
        // （ZIP 损坏 / 磁盘满 / 进程被杀 / 断电），用户的 app.db 就变成一个半截文件 →
        // 下次启动 `Database::init` 失败 → setup 返回 Err → 应用直接 exit(1)，**再也打不开**，
        // 而且没有任何备份可回滚。
        //
        // 现在改成"写临时文件 → 校验 → 备份原库 → 原子替换"：在 rename 那一刻之前，
        // 用户原来的 app.db 一个字节都没被动过，任何中途失败都只损失临时文件。
        // 用 `.sync-tmp-` 前缀命名：万一进程在替换前被杀，残留文件会被启动期的
        // `cleanup_orphan_temp_files` 自动收走，不会攒垃圾。
        let db_tmp_path = data_dir.join(".sync-tmp-import-db");
        let _ = fs::remove_file(&db_tmp_path);
        let mut db_extracted = false;

        // 展开 ZIP 所有文件
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| AppError::Custom(format!("读取 ZIP 条目失败: {}", e)))?;
            let name = file.name().to_string();

            if name == MANIFEST_FILE {
                continue;
            }

            // 安全（ZIP slip 防护）：合法导出端只会写出 app.db / settings.json /
            // <dev->kb_assets|pdfs|sources>/... 这类规整相对路径。entry 名含 `..`、
            // 以 `/` 或 `\` 开头、带 Windows 盘符或 NUL 一律视为被篡改 / 损坏的包，
            // 直接中止导入（fail-closed），绝不让下面的 `data_dir.join(name)` 把文件
            // 写到 data_dir 之外（如自启动目录、覆盖系统文件）。
            // 与 V1 `sync_v1::pull` 附件还原的路径校验同款规则，两条导入链路保持一致。
            if !is_safe_zip_entry_name(&name) {
                return Err(AppError::Custom(format!(
                    "同步包包含非法路径条目 {:?}，疑似被篡改或损坏，已中止导入",
                    name
                )));
            }

            let target = match name.as_str() {
                n if n == DB_FILE_IN_ZIP => {
                    // 先落到临时文件，校验通过后才原子替换真正的 db_path（可能是 dev- 前缀）
                    db_extracted = true;
                    db_tmp_path.clone()
                }
                n if n == SETTINGS_FILE_IN_ZIP => data_dir.join(settings_file_name()),
                other => {
                    // 资产路径在 ZIP 内已带当前实例风格的 dev/prod 前缀
                    // （由 export 端 assets_dir_name() 等决定）+ 已通过 manifest.is_dev 校验
                    // 与当前 build 一致，直接 join 到 data_dir 落盘即可。
                    // 历史上有个 BUG：这里又加一遍 dev- 前缀导致 dev-dev-kb_assets/ 双前缀目录，
                    // 已通过 export/import 路径前缀职责对齐 + manifest 校验消除。
                    data_dir.join(other)
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
            // 显式 flush + sync：copy 只保证写进了内核缓冲。后面马上要 rename 顶替真库，
            // 必须先确保字节真的落盘，否则断电时会出现"rename 已生效但内容还没写完"的空/半截库。
            if let Err(e) = std::io::copy(&mut file, &mut out).and_then(|_| {
                out.flush()?;
                out.sync_all()
            }) {
                let _ = fs::remove_file(&db_tmp_path);
                return Err(e.into());
            }
        }

        // ── app.db 原子替换（只有包里确实含 app.db 时才走）
        if db_extracted {
            if let Err(e) = Self::commit_db_replacement(db_path, &db_tmp_path) {
                // 失败时临时文件已在内部清理；用户原库**完全没被动过**，直接把错误抛给前端
                return Err(e);
            }
        }

        // 同步完成后清理失效的 WebDAV 加密密码条目
        // （从别的设备同步来的密文，用的是那台设备的 hostname 派生的 key，本机解不开）
        Self::cleanup_invalid_webdav_passwords(db_path);

        Ok(manifest)
    }

    /// 校验临时库 → 备份现有库 → 清 WAL → 原子替换。任一步失败都保证**原库不变**。
    ///
    /// 这是整条导入链路里唯一会动用户 `app.db` 的地方，顺序不能调换：
    /// 1. **先校验**：临时库能打开、`quick_check` 通过、含 `notes` 表、`user_version` 不超过本应用支持的版本。
    ///    校验不过 → 直接失败，绝不拿一个坏库去顶替好库。
    /// 2. **再备份**：现有 `app.db` 复制成 `app.db.bak-<时间戳>`，滚动保留最近
    ///    [`DB_BACKUP_KEEP`] 份。用户误点"覆盖导入"冲掉数据时，这是唯一的后悔药。
    /// 3. **清 `-wal` / `-shm`**：WAL 模式下这两个文件与 db 主文件是一套。只换 db 主文件而留下
    ///    旧 WAL，SQLite 下次打开会把旧 WAL 的页回放到新库上 → **数据库损坏**。
    ///    （正常情况 `Database::release()` 关连接时 SQLite 会自行清掉，但只有它是最后一个连接时才成立；
    ///    本项目存在 kb-mcp sidecar 也连同一个库的场景，所以必须显式删。）
    /// 4. **最后 rename**：同目录内 rename 是原子的，要么新库生效要么原库原封不动，不存在中间态。
    fn commit_db_replacement(db_path: &Path, tmp_path: &Path) -> Result<(), AppError> {
        // 1. 校验新库
        let new_version = match Self::verify_sqlite_snapshot(tmp_path) {
            Ok(v) => v,
            Err(e) => {
                let _ = fs::remove_file(tmp_path);
                return Err(e);
            }
        };
        log::info!(
            "[sync] 待导入数据库校验通过（schema v{}），准备替换 {}",
            new_version,
            db_path.display()
        );

        // 2. 备份现有库（首次导入时可能还没有库，跳过即可）
        if db_path.exists() {
            match Self::backup_existing_db(db_path) {
                Ok(bak) => log::info!("[sync] 已备份现有数据库 → {}", bak.display()),
                Err(e) => {
                    // 备份失败就**不允许**继续覆盖 —— 没有后悔药的覆盖是不可接受的
                    let _ = fs::remove_file(tmp_path);
                    return Err(AppError::Custom(format!(
                        "导入前备份现有数据库失败，已中止导入（原数据未受影响）: {}",
                        e
                    )));
                }
            }
        }

        // 3. 清理旧 WAL / SHM（见上方说明；不存在时 remove_file 报错可忽略）
        for suffix in ["-wal", "-shm"] {
            let mut p = db_path.as_os_str().to_os_string();
            p.push(suffix);
            let side = std::path::PathBuf::from(p);
            if side.exists() {
                match fs::remove_file(&side) {
                    Ok(_) => log::info!("[sync] 已清理 {}", side.display()),
                    Err(e) => {
                        let _ = fs::remove_file(tmp_path);
                        return Err(AppError::Custom(format!(
                            "清理 {} 失败，已中止导入（原数据未受影响）。\
                             常见原因：另一个进程（如 kb-mcp）正打开着数据库，请关闭后重试: {}",
                            side.display(),
                            e
                        )));
                    }
                }
            }
        }

        // 4. 原子替换
        if let Err(e) = fs::rename(tmp_path, db_path) {
            let _ = fs::remove_file(tmp_path);
            return Err(AppError::Custom(format!(
                "替换数据库文件失败，已中止导入（原数据未受影响）: {}",
                e
            )));
        }
        Ok(())
    }

    /// 校验一个待导入的 SQLite 文件是否可用，返回它的 `user_version`。
    ///
    /// 可用性判据复用 [`db_recovery::probe_sqlite`](crate::services::db_recovery::probe_sqlite)
    /// （只读打开 → 读 schema → 确认含 `notes` 表 → 实读 notes 数据页；
    /// 之所以不用 `PRAGMA quick_check`，见那边的说明 —— FTS5 表在只读连接上会误报）。
    ///
    /// 在此基础上多加一道版本闸门：`user_version` 高于本应用的
    /// [`SCHEMA_VERSION`](crate::database::schema::SCHEMA_VERSION) 就拒绝。
    /// 这是对老备份包（manifest 无 `db_user_version` 字段）和 manifest 被篡改的双重兜底 ——
    /// **以库文件里的真实值为准**。
    fn verify_sqlite_snapshot(path: &Path) -> Result<i32, AppError> {
        let version = crate::services::db_recovery::probe_sqlite(path).map_err(|e| {
            AppError::Custom(format!(
                "备份包中的数据库不可用（文件可能已损坏或不是本应用的数据库）: {}",
                e
            ))
        })?;
        if version > crate::database::schema::SCHEMA_VERSION {
            return Err(AppError::Custom(format!(
                "该备份来自更新版本的应用（数据库结构 v{}，当前应用支持 v{}）。\
                 强行导入会导致应用下次启动时无法打开数据库 —— 请先把本机应用升级到最新版本再恢复。",
                version,
                crate::database::schema::SCHEMA_VERSION
            )));
        }
        Ok(version)
    }

    /// 把现有 db 复制一份为 `<db 文件名>.bak-<yyyyMMdd-HHmmss>`，并滚动清理超出保留数的旧备份。
    ///
    /// 用**复制**而不是 rename：rename 会让 db_path 在替换前短暂不存在，若之后的步骤失败，
    /// 用户就处在"原库已经不在原位"的状态。复制则保证原库始终在原位，直到最后一步 rename 才被顶替。
    fn backup_existing_db(db_path: &Path) -> Result<std::path::PathBuf, AppError> {
        let file_name = db_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| AppError::Custom("数据库路径异常，无法生成备份名".into()))?;
        let dir = db_path
            .parent()
            .ok_or_else(|| AppError::Custom("数据库路径异常，无法定位所在目录".into()))?;

        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let backup = dir.join(format!("{}{}{}", file_name, DB_BACKUP_SUFFIX, stamp));
        fs::copy(db_path, &backup)?;

        Self::prune_old_db_backups(dir, file_name);
        Ok(backup)
    }

    /// 只保留最近 [`DB_BACKUP_KEEP`] 份备份，更旧的删掉（防止反复导入把磁盘撑满）。
    ///
    /// 时间戳格式 `%Y%m%d-%H%M%S` 保证字典序 == 时间序，直接按文件名排序即可。
    /// 清理失败只 warn：留几个多余备份远好过让导入流程失败。
    fn prune_old_db_backups(dir: &Path, db_file_name: &str) {
        let prefix = format!("{}{}", db_file_name, DB_BACKUP_SUFFIX);
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[sync] 清理旧数据库备份：读取目录失败 {}", e);
                return;
            }
        };
        let mut backups: Vec<std::path::PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect();
        if backups.len() <= DB_BACKUP_KEEP {
            return;
        }
        backups.sort();
        let drop_count = backups.len() - DB_BACKUP_KEEP;
        for old in backups.into_iter().take(drop_count) {
            match fs::remove_file(&old) {
                Ok(_) => log::info!("[sync] 清理旧数据库备份: {}", old.display()),
                Err(e) => log::warn!("[sync] 清理旧数据库备份 {} 失败: {}", old.display(), e),
            }
        }
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
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
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
            log::info!(
                "同步后已清理 {} 个失效的 WebDAV 密码条目（换设备导致）",
                removed
            );
        }
    }

    /// 从本地文件导入（流式读取，避免把整份 ZIP 载入内存）
    /// 从本地文件导入。T-S050：自动检测魔数 —— 是加密快照则必须提供 `backup_password` 解密。
    pub fn import_from_file(
        data_dir: &Path,
        db_path: &Path,
        source_path: &Path,
        mode: SyncImportMode,
        backup_password: Option<&str>,
    ) -> Result<SyncManifest, AppError> {
        if Self::file_is_encrypted_snapshot(source_path)? {
            let pw = backup_password.ok_or_else(|| {
                AppError::Custom("该备份文件已加密，请提供备份密码后再导入".into())
            })?;
            let enc_bytes = fs::read(source_path)?;
            let zip_bytes = Self::decrypt_snapshot(&enc_bytes, pw)?;
            let reader = Cursor::new(zip_bytes);
            Self::apply_snapshot_from_reader(data_dir, db_path, reader, mode)
        } else {
            let file = fs::File::open(source_path)?;
            let reader = BufReader::new(file);
            Self::apply_snapshot_from_reader(data_dir, db_path, reader, mode)
        }
    }

    /// 读文件首 8 字节判是否是加密快照（轻量探测，不读全文件）
    fn file_is_encrypted_snapshot(path: &Path) -> Result<bool, AppError> {
        let mut f = fs::File::open(path)?;
        let mut head = [0u8; 8];
        let n = f.read(&mut head)?;
        Ok(n == 8 && Self::is_encrypted_snapshot(&head))
    }

    // ─── WebDAV 云同步 ──────────────────────────

    /// 推送到 WebDAV：先把快照流式写入临时文件，再流式上传，
    /// 全程不把整份 ZIP 驻留在内存中（明文路径）。
    ///
    /// `backup_password`：T-S050 端到端加密。Some(pw) → 上传 `kb-sync-<host>.zip.enc`（密文）；
    /// None → 上传 `kb-sync-<host>.zip`（明文，向后兼容）。
    pub async fn webdav_push(
        data_dir: &Path,
        db: &Database,
        scope: &SyncScope,
        app_version: &str,
        url: &str,
        username: &str,
        password: &str,
        backup_password: Option<&str>,
    ) -> Result<SyncResult, AppError> {
        let tmp_zip = data_dir.join(".sync-tmp-upload.zip");
        let _ = fs::remove_file(&tmp_zip);

        // 1. 流式构建快照到临时文件
        let stats = {
            let file = fs::File::create(&tmp_zip)?;
            let writer = BufWriter::new(file);
            Self::build_snapshot_to_writer(writer, data_dir, db, scope, app_version)?
        };

        // 2. 决定上传内容：明文直接传临时 ZIP；加密则读 → encrypt → 写 .enc 临时文件
        let (filename, upload_path) = match backup_password {
            None => (device_zip_name(), tmp_zip.clone()),
            Some(pw) => {
                let zip_bytes = fs::read(&tmp_zip)?;
                let enc = match Self::encrypt_snapshot(&zip_bytes, pw) {
                    Ok(e) => e,
                    Err(e) => {
                        let _ = fs::remove_file(&tmp_zip);
                        return Err(e);
                    }
                };
                let tmp_enc = data_dir.join(".sync-tmp-upload.zip.enc");
                let _ = fs::remove_file(&tmp_enc);
                if let Err(e) = fs::write(&tmp_enc, &enc) {
                    let _ = fs::remove_file(&tmp_zip);
                    return Err(e.into());
                }
                let _ = fs::remove_file(&tmp_zip); // 明文 ZIP 不再需要，及时清理
                (format!("{}.enc", device_zip_name()), tmp_enc)
            }
        };

        // 3. 上传，无论成败清理临时文件
        let client = WebDavClient::new(url, username, password);
        let upload_result = client.upload_file(&filename, &upload_path).await;
        let _ = fs::remove_file(&upload_path);
        let _ = fs::remove_file(&tmp_zip); // 兜底（明文路径已删过，加密路径也删过，这里 noop）
        upload_result?;

        Ok(SyncResult {
            stats,
            finished_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        })
    }

    /// 从 WebDAV 拉取：先流式下载到临时文件，检测魔数后（必要时解密）再流式解包。
    ///
    /// `backup_password`：T-S050。提供时默认拉 `kb-sync-<host>.zip.enc`；未提供拉 `.zip`。
    /// 若下载到的是加密快照但没提供密码 → Err。`preferred_filename` 优先于默认推断。
    pub async fn webdav_pull(
        data_dir: &Path,
        db_path: &Path,
        mode: SyncImportMode,
        url: &str,
        username: &str,
        password: &str,
        preferred_filename: Option<&str>,
        backup_password: Option<&str>,
    ) -> Result<SyncManifest, AppError> {
        let client = WebDavClient::new(url, username, password);
        let filename = match preferred_filename {
            Some(s) => s.to_string(),
            None => {
                if backup_password.is_some() {
                    format!("{}.enc", device_zip_name())
                } else {
                    device_zip_name()
                }
            }
        };

        let tmp_dl = data_dir.join(".sync-tmp-pull.dl");
        let _ = fs::remove_file(&tmp_dl);

        // 1. 流式下载到临时文件
        if let Err(e) = client.download_to_file(&filename, &tmp_dl).await {
            let _ = fs::remove_file(&tmp_dl);
            return Err(e);
        }

        // 2. 检测是否加密；是则解密成明文 ZIP 临时文件
        let zip_path = match Self::file_is_encrypted_snapshot(&tmp_dl) {
            Ok(true) => {
                let pw = match backup_password {
                    Some(p) => p,
                    None => {
                        let _ = fs::remove_file(&tmp_dl);
                        return Err(AppError::Custom(
                            "云端快照已加密，请在拉取时提供备份密码".into(),
                        ));
                    }
                };
                let enc_bytes = match fs::read(&tmp_dl) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = fs::remove_file(&tmp_dl);
                        return Err(e.into());
                    }
                };
                let zip_bytes = match Self::decrypt_snapshot(&enc_bytes, pw) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = fs::remove_file(&tmp_dl);
                        return Err(e);
                    }
                };
                let tmp_zip = data_dir.join(".sync-tmp-pull.zip");
                let _ = fs::remove_file(&tmp_zip);
                if let Err(e) = fs::write(&tmp_zip, &zip_bytes) {
                    let _ = fs::remove_file(&tmp_dl);
                    return Err(e.into());
                }
                let _ = fs::remove_file(&tmp_dl);
                tmp_zip
            }
            Ok(false) => tmp_dl.clone(), // 明文，直接用下载文件
            Err(e) => {
                let _ = fs::remove_file(&tmp_dl);
                return Err(e);
            }
        };

        // 3. 流式读取并展开
        let apply_result = (|| {
            let file = fs::File::open(&zip_path)?;
            let reader = BufReader::new(file);
            Self::apply_snapshot_from_reader(data_dir, db_path, reader, mode)
        })();

        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_file(&tmp_dl);
        apply_result
    }

    /// 列出云端所有快照（多设备场景）。兼容明文 `kb-sync-*.zip` 和加密 `kb-sync-*.zip.enc`。
    /// 返回 (filename, device_name) 元组列表，按设备名排序。
    /// 调用方可从 `filename` 是否以 `.enc` 结尾判断该快照是否加密。
    pub async fn webdav_list_snapshots(
        url: &str,
        username: &str,
        password: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let client = WebDavClient::new(url, username, password);
        let files = client.list_files().await?;
        let mut snapshots: Vec<(String, String)> = files
            .into_iter()
            .filter_map(|f| {
                if !f.starts_with("kb-sync-") {
                    return None;
                }
                // 先剥 .zip.enc，再剥 .zip；都不匹配则忽略
                let device = if let Some(d) = f.strip_suffix(".zip.enc") {
                    d.trim_start_matches("kb-sync-").to_string()
                } else if let Some(d) = f.strip_suffix(".zip") {
                    d.trim_start_matches("kb-sync-").to_string()
                } else {
                    return None;
                };
                Some((f, device))
            })
            .collect();
        snapshots.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(snapshots)
    }

    /// 预览云端 manifest（不下载资产，只读 manifest.json）。
    /// 加密快照无法在不解密的情况下读 manifest → 返回明确错误，引导用户直接恢复。
    pub async fn webdav_preview(
        url: &str,
        username: &str,
        password: &str,
        filename: Option<&str>,
    ) -> Result<SyncManifest, AppError> {
        let client = WebDavClient::new(url, username, password);
        let fname = filename
            .map(|s| s.to_string())
            .unwrap_or_else(device_zip_name);
        let bytes = client.download_bytes(&fname).await?;
        if Self::is_encrypted_snapshot(&bytes) {
            return Err(AppError::Custom(
                "该快照已加密，无法预览内容清单；如需恢复请在恢复时输入备份密码".into(),
            ));
        }
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
    pub fn get_webdav_password(db: &Database, username: &str) -> Result<Option<String>, AppError> {
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

    // ─── 临时文件孤儿清理 ──────────────────────────
    //
    // 同步流程中会在 data_dir 下生成 `.sync-tmp-*` 临时文件（VACUUM 副本 / 上传 zip / 下载 zip）：
    //   - `.sync-tmp-app.db`     —— VACUUM INTO 临时副本（导出/推送）
    //   - `.sync-tmp-upload.zip` —— WebDAV 推送前的本地快照
    //   - `.sync-tmp-pull.zip`   —— WebDAV 下载落盘
    // 正常路径会在使用后清理，但应用崩溃 / kill 导致残留。本方法在启动期统一扫一遍。
    //
    // 安全保证：**严格匹配前缀 `.sync-tmp-` 且只看顶层文件**（不递归子目录），
    // 不会误删 `sources/` `pdfs/` `kb_assets/` 等业务资产，也不会动子目录里的同名文件。

    /// 扫 `data_dir` 顶层删除 `.sync-tmp-*` 残留文件，返回删除数量。
    /// 任意单个失败仅 warn，不阻塞启动。
    pub fn cleanup_orphan_temp_files(data_dir: &Path) -> usize {
        let entries = match fs::read_dir(data_dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[sync] cleanup_orphan_temp_files: 读取 {} 失败 {}", data_dir.display(), e);
                return 0;
            }
        };
        let mut removed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            // 只删顶层"文件"，绝不进子目录、绝不动目录本身
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !name.starts_with(".sync-tmp-") {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(_) => {
                    log::info!("[sync] 启动清理临时孤儿文件: {}", path.display());
                    removed += 1;
                }
                Err(e) => {
                    log::warn!("[sync] 删除孤儿临时文件 {} 失败: {}", path.display(), e);
                }
            }
        }
        removed
    }

    // ─── 快照加密（T-S050 端到端加密备份；Part 1 核心层，集成到 push/pull/export 是 Part 2） ──

    /// 用密码加密快照 ZIP 字节。
    ///
    /// 输出格式：`[MAGIC 8B][salt 16B][nonce 12B + AES-256-GCM ciphertext + tag]`
    /// （后段就是 `crypto::aead_encrypt` 的输出 = `nonce ‖ ciphertext+tag`）
    /// - salt 公开存放在文件里是安全的（Argon2 设计如此）
    /// - **整块加密**：zip 字节全部进内存（大库 >100MB 注意内存峰值；快照归档通常阶段性手动操作）
    pub fn encrypt_snapshot(zip: &[u8], password: &str) -> Result<Vec<u8>, AppError> {
        if password.is_empty() {
            return Err(AppError::Custom("备份密码不能为空".into()));
        }
        let salt = crypto::new_salt();
        let key = crypto::derive_user_key(password, &salt)?;
        let blob = crypto::aead_encrypt(&key, zip)?; // = nonce(12) ‖ ciphertext+tag
        let mut out = Vec::with_capacity(SNAPSHOT_MAGIC.len() + salt.len() + blob.len());
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&blob);
        Ok(out)
    }

    /// 解密快照文件 → ZIP 字节。密码错误 / 文件损坏 / 魔数不匹配 → Err。
    pub fn decrypt_snapshot(enc: &[u8], password: &str) -> Result<Vec<u8>, AppError> {
        let min_len = SNAPSHOT_MAGIC.len() + crypto::SALT_LEN + crypto::NONCE_LEN + 16; // +16 GCM tag
        if enc.len() < min_len {
            return Err(AppError::Custom("加密快照文件太短或已损坏".into()));
        }
        if &enc[..SNAPSHOT_MAGIC.len()] != SNAPSHOT_MAGIC {
            return Err(AppError::Custom(
                "不是合法的加密快照（魔数不匹配；可能是明文 ZIP 或损坏文件）".into(),
            ));
        }
        let salt = &enc[SNAPSHOT_MAGIC.len()..SNAPSHOT_MAGIC.len() + crypto::SALT_LEN];
        let blob = &enc[SNAPSHOT_MAGIC.len() + crypto::SALT_LEN..];
        let key = crypto::derive_user_key(password, salt)?;
        crypto::aead_decrypt(&key, blob)
            .map_err(|_| AppError::Custom("备份密码错误，或文件已损坏".into()))
    }

    /// 检查字节流是否是加密快照（看魔数头）。明文 ZIP 以 `PK\x03\x04` 开头，不会误判。
    pub fn is_encrypted_snapshot(bytes: &[u8]) -> bool {
        bytes.len() >= SNAPSHOT_MAGIC.len() && &bytes[..SNAPSHOT_MAGIC.len()] == SNAPSHOT_MAGIC
    }

    // ─── 备份密码存取（与 WebDAV 密码同机制：hostname 派生 key + AES-GCM 存 app_config）─────

    fn backup_pw_config_key() -> &'static str {
        "sync.backup_pw_enc"
    }

    /// 把备份密码加密后存入 SQLite（换设备无法解密 → 需重新填）
    pub fn save_backup_password(db: &Database, password: &str) -> Result<(), AppError> {
        if password.is_empty() {
            return Err(AppError::Custom("备份密码不能为空".into()));
        }
        let enc = crypto::encrypt(password)?;
        db.set_config(Self::backup_pw_config_key(), &enc)?;
        Ok(())
    }

    /// 从 SQLite 读备份密码密文并解密；解不开（换设备）返回 None
    pub fn get_backup_password(db: &Database) -> Result<Option<String>, AppError> {
        match db.get_config(Self::backup_pw_config_key())? {
            Some(enc) if !enc.is_empty() => crypto::decrypt(&enc).map(Some),
            _ => Ok(None),
        }
    }

    /// 删除 SQLite 中的备份密码密文（关闭加密备份时调）
    pub fn delete_backup_password(db: &Database) -> Result<(), AppError> {
        let _ = db.delete_config(Self::backup_pw_config_key())?;
        Ok(())
    }
}

/// T-S050: 加密快照文件的魔数头（8 字节）
///
/// 用来识别"这是加密包"，与明文 ZIP（`PK\x03\x04` 开头）区分。
/// 后缀 `\0` 占位 + 版本位，未来格式变更时可用首字节区分。
const SNAPSHOT_MAGIC: &[u8; 8] = b"KBSNCv1\0";

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

fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev-kb_assets"
    } else {
        "kb_assets"
    }
}
fn pdfs_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev-pdfs"
    } else {
        "pdfs"
    }
}
fn sources_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev-sources"
    } else {
        "sources"
    }
}
fn settings_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev-settings.json"
    } else {
        "settings.json"
    }
}

/// ZIP entry 名安全校验：防 ZIP slip（路径遍历 / 绝对路径写穿 data_dir）。
///
/// 合法同步包的 entry 名只会是 `app.db` / `settings.json` / `<dev->kb_assets/...`
/// 这类规整相对路径（ZIP 内分隔符为 `/`）。下列情形一律判为不安全：
/// - 空名
/// - 绝对路径（以 `/` 或 `\` 开头）
/// - 父目录穿越（任意位置含 `..`）
/// - Windows 盘符（含 `:\` 或 `:/`，如 `C:\` / `C:/`）
/// - 含 NUL 字节
///
/// 规则与 V1 `sync_v1::pull` 附件还原的路径校验保持一致，保证两条导入链路同样 fail-closed。
fn is_safe_zip_entry_name(name: &str) -> bool {
    !(name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains("..")
        || name.contains(":\\")
        || name.contains(":/")
        || name.contains('\0'))
}

/// 本机设备名作为云端 ZIP 文件名（同一 WebDAV 下多设备互不覆盖）
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    // ─── T-S050 快照加密 ─────────────────────────

    #[test]
    fn snapshot_encrypt_decrypt_roundtrip() {
        let zip_bytes = b"PK\x03\x04 fake zip content with some bytes \xff\x00\x42".to_vec();
        let pwd = "my-backup-pass-123";

        let enc = SyncService::encrypt_snapshot(&zip_bytes, pwd).unwrap();
        // 魔数头正确
        assert_eq!(&enc[..8], SNAPSHOT_MAGIC);
        // 密文比明文长（magic 8 + salt 16 + nonce 12 + tag 16 = 52 字节开销）
        assert_eq!(enc.len(), zip_bytes.len() + 8 + 16 + 12 + 16);
        // 是加密快照
        assert!(SyncService::is_encrypted_snapshot(&enc));
        // 明文 ZIP 不会被误判
        assert!(!SyncService::is_encrypted_snapshot(&zip_bytes));

        // 正确密码解密 → 还原原始字节
        let dec = SyncService::decrypt_snapshot(&enc, pwd).unwrap();
        assert_eq!(dec, zip_bytes);
    }

    #[test]
    fn snapshot_decrypt_wrong_password_fails() {
        let zip_bytes = b"some content".to_vec();
        let enc = SyncService::encrypt_snapshot(&zip_bytes, "right-pass").unwrap();
        let r = SyncService::decrypt_snapshot(&enc, "wrong-pass");
        assert!(r.is_err(), "错误密码必须解密失败");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("密码") || msg.contains("损坏"), "错误信息应提示密码问题: {}", msg);
    }

    #[test]
    fn snapshot_decrypt_rejects_non_encrypted() {
        // 明文 ZIP（PK 头）传给 decrypt → 魔数不匹配（字节数要 ≥ 52 才不会先走"太短"分支）
        let plain_zip =
            b"PK\x03\x04 this is a plain zip file body with enough padding bytes here to exceed 52"
                .to_vec();
        assert!(plain_zip.len() >= 52);
        let r = SyncService::decrypt_snapshot(&plain_zip, "anypass");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("魔数"), "got = {}", msg);
    }

    #[test]
    fn snapshot_decrypt_rejects_too_short() {
        let r = SyncService::decrypt_snapshot(b"KBSNCv1\0short", "p");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("太短") || msg.contains("损坏"), "got = {}", msg);
    }

    #[test]
    fn snapshot_encrypt_empty_password_rejected() {
        assert!(SyncService::encrypt_snapshot(b"data", "").is_err());
    }

    #[test]
    fn snapshot_encrypt_nondeterministic() {
        // 同样输入加密两次 → salt/nonce 随机 → 密文不同（但都能解回）
        let data = b"deterministic input";
        let e1 = SyncService::encrypt_snapshot(data, "p").unwrap();
        let e2 = SyncService::encrypt_snapshot(data, "p").unwrap();
        assert_ne!(e1, e2, "随机 salt/nonce → 密文应不同");
        assert_eq!(SyncService::decrypt_snapshot(&e1, "p").unwrap(), data);
        assert_eq!(SyncService::decrypt_snapshot(&e2, "p").unwrap(), data);
    }

    #[test]
    fn backup_password_store_roundtrip() {
        let db = Database::init(":memory:").unwrap();
        // 初始无密码
        assert_eq!(SyncService::get_backup_password(&db).unwrap(), None);
        // 存
        SyncService::save_backup_password(&db, "backup-pw-xyz").unwrap();
        assert_eq!(
            SyncService::get_backup_password(&db).unwrap(),
            Some("backup-pw-xyz".into())
        );
        // 空密码拒绝
        assert!(SyncService::save_backup_password(&db, "").is_err());
        // 删
        SyncService::delete_backup_password(&db).unwrap();
        assert_eq!(SyncService::get_backup_password(&db).unwrap(), None);
    }

    // ─── 原子导入：校验 / 备份 / WAL 清理 / 版本闸门 ─────────────────────────

    /// 造一个测试用的 data_dir，返回路径
    fn mk_tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "kb-atomic-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 用给定标题建一个真实库文件并释放句柄
    fn mk_db(path: &Path, title: &str) {
        use crate::models::NoteInput;
        let db = Database::init(&path.to_string_lossy()).unwrap();
        db.create_note(&NoteInput {
            title: title.into(),
            content: "c".into(),
            folder_id: None,
        })
        .unwrap();
        db.release().ok();
        drop(db);
    }

    /// 打包一个只含 app.db（+ manifest）的快照 ZIP
    fn mk_snapshot_zip(src_db: &Path, db_user_version: Option<i32>) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opt = SimpleFileOptions::default();
            let manifest = SyncManifest {
                schema_version: 1,
                device: "t".into(),
                exported_at: "x".into(),
                app_version: "t".into(),
                scope: SyncScope {
                    notes: true,
                    images: false,
                    pdfs: false,
                    sources: false,
                    settings: false,
                },
                stats: SyncStats::default(),
                is_dev: None, // None → 跳过 dev/prod 校验，专注测本次逻辑
                db_user_version,
            };
            zip.start_file(MANIFEST_FILE, opt).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
                .unwrap();
            zip.start_file(DB_FILE_IN_ZIP, opt).unwrap();
            let bytes = fs::read(src_db).unwrap();
            zip.write_all(&bytes).unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    fn note_titles_at(db_path: &Path) -> Vec<String> {
        let db = Database::init(&db_path.to_string_lossy()).unwrap();
        let out = {
            let conn = db.conn_lock().unwrap();
            let mut stmt = conn.prepare("SELECT title FROM notes").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        db.release().ok();
        drop(db);
        out
    }

    /// 正常导入：数据被替换 + **自动生成了 .bak 备份**
    #[test]
    fn import_replaces_db_and_creates_backup() {
        let dir = mk_tmp_dir("ok");
        let src = dir.join("src.db");
        mk_db(&src, "来自备份包");
        let zip = mk_snapshot_zip(&src, Some(crate::database::schema::SCHEMA_VERSION));

        let dest = dir.join("app.db");
        mk_db(&dest, "原有数据");

        SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&zip),
            SyncImportMode::Overwrite,
        )
        .unwrap();

        assert_eq!(note_titles_at(&dest), vec!["来自备份包".to_string()]);

        let has_backup = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("app.db.bak-"));
        assert!(has_backup, "导入前必须自动备份原库");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 包里的 app.db 是损坏文件 → 拒绝导入，且**原库完好无损**
    #[test]
    fn import_rejects_corrupt_db_and_keeps_original_intact() {
        let dir = mk_tmp_dir("corrupt");
        let dest = dir.join("app.db");
        mk_db(&dest, "宝贵的原始数据");

        // 手工造一个含垃圾 app.db 的 ZIP
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opt = SimpleFileOptions::default();
            let manifest = SyncManifest {
                schema_version: 1,
                device: "t".into(),
                exported_at: "x".into(),
                app_version: "t".into(),
                scope: SyncScope {
                    notes: true,
                    images: false,
                    pdfs: false,
                    sources: false,
                    settings: false,
                },
                stats: SyncStats::default(),
                is_dev: None,
                db_user_version: None,
            };
            zip.start_file(MANIFEST_FILE, opt).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
                .unwrap();
            zip.start_file(DB_FILE_IN_ZIP, opt).unwrap();
            zip.write_all(b"NOT-A-SQLITE-FILE-AT-ALL").unwrap();
            zip.finish().unwrap();
        }

        let res = SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&buf),
            SyncImportMode::Overwrite,
        );
        assert!(res.is_err(), "损坏的 app.db 必须被拒绝");

        // 关键断言：原库一点没坏
        assert_eq!(
            note_titles_at(&dest),
            vec!["宝贵的原始数据".to_string()],
            "导入失败后原库必须完好"
        );
        // 临时文件不应残留
        assert!(!dir.join(".sync-tmp-import-db").exists(), "临时文件应已清理");

        let _ = fs::remove_dir_all(&dir);
    }

    /// manifest 声明的 db 版本高于本应用 → 在解压前就拦下（否则导入后应用下次起不来）
    #[test]
    fn import_rejects_newer_db_version_from_manifest() {
        let dir = mk_tmp_dir("newer-manifest");
        let src = dir.join("src.db");
        mk_db(&src, "来自未来版本");
        let zip = mk_snapshot_zip(&src, Some(crate::database::schema::SCHEMA_VERSION + 5));

        let dest = dir.join("app.db");
        mk_db(&dest, "原有数据");

        let res = SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&zip),
            SyncImportMode::Overwrite,
        );
        let err = res.unwrap_err().to_string();
        assert!(
            err.contains("更新版本") && err.contains("升级"),
            "错误信息应引导用户升级应用，实际: {}",
            err
        );
        assert_eq!(
            note_titles_at(&dest),
            vec!["原有数据".to_string()],
            "被拒绝的导入不得改动原库"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 老包（manifest 无 db_user_version）但库文件本身是高版本 → 靠实读 user_version 兜底拦截
    #[test]
    fn import_rejects_newer_db_version_by_probing_file() {
        let dir = mk_tmp_dir("newer-file");
        let src = dir.join("src.db");
        mk_db(&src, "高版本库");
        // 手工把 user_version 顶到超过当前应用支持
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.pragma_update(
                None,
                "user_version",
                crate::database::schema::SCHEMA_VERSION + 7,
            )
            .unwrap();
        }
        let zip = mk_snapshot_zip(&src, None); // 老包：manifest 里没有版本字段

        let dest = dir.join("app.db");
        mk_db(&dest, "原有数据");

        let res = SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&zip),
            SyncImportMode::Overwrite,
        );
        assert!(res.is_err(), "即使 manifest 没声明版本，也要靠实读库文件拦下");
        assert_eq!(note_titles_at(&dest), vec!["原有数据".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 导入必须清掉旧的 -wal / -shm：新库配旧 WAL 会被 SQLite 回放成损坏库
    #[test]
    fn import_clears_stale_wal_and_shm() {
        let dir = mk_tmp_dir("wal");
        let src = dir.join("src.db");
        mk_db(&src, "新数据");
        let zip = mk_snapshot_zip(&src, Some(crate::database::schema::SCHEMA_VERSION));

        let dest = dir.join("app.db");
        mk_db(&dest, "旧数据");
        // 伪造遗留的 WAL 三件套（真实场景：kb-mcp 等第二个连接在开着，SQLite 关连接时没清掉）
        fs::write(dir.join("app.db-wal"), b"stale-wal-content").unwrap();
        fs::write(dir.join("app.db-shm"), b"stale-shm-content").unwrap();

        SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&zip),
            SyncImportMode::Overwrite,
        )
        .unwrap();

        assert!(!dir.join("app.db-wal").exists(), "旧 -wal 必须被清理");
        assert!(!dir.join("app.db-shm").exists(), "旧 -shm 必须被清理");
        assert_eq!(note_titles_at(&dest), vec!["新数据".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// **端到端还原 `sync_import_from_file` 的真实时序**（含 Windows 文件占用）。
    ///
    /// 上面那些用例都是直接调 `apply_snapshot_from_reader`，目标 db 文件没有任何进程打开着 ——
    /// 而线上真实路径是：应用**正开着** `app.db`（SQLite 在 Windows 上持有 mmap + 文件句柄），
    /// 走 `release()` 放开占用 → 替换文件 → `reopen()` 接回来。
    ///
    /// 这个时序是历史故障高发区（`ERROR_USER_MAPPED_FILE` 1224 / `os error 32`），
    /// 也是本次改造新增"rename 替换 + 删 -wal/-shm"后最需要确认的地方：
    /// rename 和 remove_file 在 Windows 上都会被残留句柄挡住，纯逻辑单测发现不了。
    #[test]
    fn full_import_flow_with_live_db_connection() {
        use crate::models::NoteInput;

        let dir = mk_tmp_dir("live");
        let src = dir.join("src.db");
        mk_db(&src, "备份包里的笔记");
        let zip = mk_snapshot_zip(&src, Some(crate::database::schema::SCHEMA_VERSION));

        let dest = dir.join("app.db");

        // 1) 模拟"应用正在运行"：真实 Database 打开着目标库并写入数据
        //    （写入会产生 -wal，正是替换时最容易卡住的那个文件）
        let db = Database::init(&dest.to_string_lossy()).unwrap();
        db.create_note(&NoteInput {
            title: "运行中的原始数据".into(),
            content: "x".into(),
            folder_id: None,
        })
        .unwrap();

        // 2) 与 commands::sync::sync_import_from_file 同序：先 release 放开文件占用
        db.release().unwrap();

        // 3) 导入（内部：校验 → 备份 → 删 -wal/-shm → 原子 rename）
        let manifest = SyncService::apply_snapshot_from_reader(
            &dir,
            &dest,
            Cursor::new(&zip),
            SyncImportMode::Overwrite,
        )
        .expect("在持有过 db 连接的情况下导入不应被文件占用卡住");
        assert_eq!(manifest.schema_version, 1);

        // 4) reopen 接回真实库（这一步同时会跑 schema 迁移）
        db.reopen(&dest.to_string_lossy()).unwrap();

        // 5) 连接指向的应当是替换后的新库
        let titles = {
            let conn = db.conn_lock().unwrap();
            let mut stmt = conn.prepare("SELECT title FROM notes").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            titles,
            vec!["备份包里的笔记".to_string()],
            "reopen 后应读到导入的新数据"
        );

        // 6) reopen 跑完迁移，版本应是当前版本（老备份升级路径的保证）
        let version = {
            let conn = db.conn_lock().unwrap();
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
                .unwrap()
        };
        assert_eq!(version, crate::database::schema::SCHEMA_VERSION);

        // 7) 原库已自动备份，用户有后悔药
        let backups: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("app.db.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "应恰好生成一份备份，实际: {:?}", backups);
        // 备份里装的必须是**替换前**的数据
        assert_eq!(
            note_titles_at(&dir.join(&backups[0])),
            vec!["运行中的原始数据".to_string()],
            "备份内容应是导入前的原始数据"
        );

        db.release().ok();
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 备份滚动保留：超过 DB_BACKUP_KEEP 份后删最旧的
    #[test]
    fn prunes_old_backups_keeping_latest_n() {
        let dir = mk_tmp_dir("prune");
        // 造 6 个假备份（时间戳字典序 == 时间序）
        for i in 1..=6 {
            fs::write(
                dir.join(format!("app.db.bak-2026010{}-000000", i)),
                b"x",
            )
            .unwrap();
        }
        // 干扰项：前缀相近但不匹配的文件不能被误删
        fs::write(dir.join("app.db"), b"x").unwrap();
        fs::write(dir.join("app.db.bakX-20260101-000000"), b"x").unwrap();

        SyncService::prune_old_db_backups(&dir, "app.db");

        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("app.db.bak-"))
            .collect();
        left.sort();
        assert_eq!(left.len(), DB_BACKUP_KEEP, "应只保留 {} 份", DB_BACKUP_KEEP);
        assert_eq!(
            left,
            vec![
                "app.db.bak-20260104-000000",
                "app.db.bak-20260105-000000",
                "app.db.bak-20260106-000000"
            ],
            "保留的应该是最新的几份"
        );
        assert!(dir.join("app.db").exists(), "业务库不得被误删");
        assert!(
            dir.join("app.db.bakX-20260101-000000").exists(),
            "前缀不匹配的文件不得被误删"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// T-S050 Part 2 端到端：明文导出 → 加密导出 → 加密导入还原
    #[test]
    fn export_import_encrypted_roundtrip() {
        use crate::models::NoteInput;

        // 临时 data_dir + 一个有内容的 db
        let tmp = std::env::temp_dir().join(format!(
            "kb-snap-enc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let src_db_path = tmp.join("src-app.db");
        let db = Database::init(src_db_path.to_str().unwrap()).unwrap();
        db.create_note(&NoteInput {
            title: "加密备份测试笔记".into(),
            content: "secret content xyz".into(),
            folder_id: None,
        })
        .unwrap();
        let scope = SyncScope {
            notes: true,
            images: false,
            pdfs: false,
            sources: false,
            settings: false,
        };

        // 明文导出
        let plain_zip = tmp.join("backup.zip");
        SyncService::export_to_file(&tmp, &db, &scope, "test", &plain_zip, None).unwrap();
        let plain_head = {
            let mut f = fs::File::open(&plain_zip).unwrap();
            let mut h = [0u8; 4];
            f.read_exact(&mut h).unwrap();
            h
        };
        assert_eq!(&plain_head, b"PK\x03\x04", "明文导出应是标准 ZIP");

        // 加密导出
        let enc_zip = tmp.join("backup.zip.enc");
        SyncService::export_to_file(&tmp, &db, &scope, "test", &enc_zip, Some("my-pw")).unwrap();
        let enc_head = {
            let mut f = fs::File::open(&enc_zip).unwrap();
            let mut h = [0u8; 8];
            f.read_exact(&mut h).unwrap();
            h
        };
        assert_eq!(&enc_head, SNAPSHOT_MAGIC, "加密导出应带魔数头");

        // 释放 src db 占用，准备导入到一个新的 dest db
        db.release().ok();
        drop(db);
        let dest_db_path = tmp.join("dest-app.db");
        // 先建个空 dest db（import overwrite 会替换它）
        Database::init(dest_db_path.to_str().unwrap()).unwrap().release().ok();

        // 用错误密码导入 → 失败
        let bad = SyncService::import_from_file(
            &tmp,
            &dest_db_path,
            &enc_zip,
            SyncImportMode::Overwrite,
            Some("wrong-pw"),
        );
        assert!(bad.is_err(), "错误密码导入应失败");

        // 不给密码导入加密包 → 失败
        let no_pw = SyncService::import_from_file(
            &tmp,
            &dest_db_path,
            &enc_zip,
            SyncImportMode::Overwrite,
            None,
        );
        assert!(no_pw.is_err(), "加密包未给密码应失败");

        // 正确密码导入 → 成功
        SyncService::import_from_file(
            &tmp,
            &dest_db_path,
            &enc_zip,
            SyncImportMode::Overwrite,
            Some("my-pw"),
        )
        .unwrap();
        // 验证 dest db 里有那条笔记
        let dest = Database::init(dest_db_path.to_str().unwrap()).unwrap();
        let n = {
            let conn = dest.conn_lock().unwrap();
            conn.query_row(
                "SELECT title FROM notes WHERE title = '加密备份测试笔记'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
        };
        assert_eq!(n.as_deref(), Some("加密备份测试笔记"), "导入的笔记应存在");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 临时目录内放 4 类文件：3 个 `.sync-tmp-*` 应被删，2 个业务文件必须保留。
    /// 同时放一个同名前缀的子目录 + 子目录内同名前缀文件，验证"不递归子目录"。
    #[test]
    fn cleanup_orphan_temp_files_strict_prefix_only() {
        let tmp = std::env::temp_dir().join(format!(
            "kb-sync-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();

        // 应删
        File::create(tmp.join(".sync-tmp-app.db")).unwrap();
        File::create(tmp.join(".sync-tmp-upload.zip")).unwrap();
        File::create(tmp.join(".sync-tmp-pull.zip")).unwrap();
        // 不应删（前缀近似但不完全匹配）
        File::create(tmp.join("sync-tmp-app.db")).unwrap(); // 缺前导点
        File::create(tmp.join("app.db")).unwrap(); // 业务数据库
        File::create(tmp.join("settings.json")).unwrap();
        File::create(tmp.join(".sync_tmp.bak")).unwrap(); // 下划线非连字符
        // 子目录及子目录内的同名前缀文件（不应被递归删除）
        let sub = tmp.join("pdfs");
        fs::create_dir_all(&sub).unwrap();
        File::create(sub.join(".sync-tmp-fake.zip")).unwrap();

        let removed = SyncService::cleanup_orphan_temp_files(&tmp);
        assert_eq!(removed, 3, "应只删顶层 3 个匹配文件");

        assert!(!tmp.join(".sync-tmp-app.db").exists());
        assert!(!tmp.join(".sync-tmp-upload.zip").exists());
        assert!(!tmp.join(".sync-tmp-pull.zip").exists());
        assert!(tmp.join("sync-tmp-app.db").exists(), "无点前缀不应删");
        assert!(tmp.join("app.db").exists(), "业务文件必须保留");
        assert!(tmp.join("settings.json").exists());
        assert!(tmp.join(".sync_tmp.bak").exists(), "下划线变体不应误删");
        assert!(sub.join(".sync-tmp-fake.zip").exists(), "子目录不应被递归扫描");

        // 收尾
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_returns_zero_for_nonexistent_dir() {
        let nowhere = std::path::PathBuf::from(format!(
            "{}/does-not-exist-{}",
            std::env::temp_dir().display(),
            std::process::id()
        ));
        let removed = SyncService::cleanup_orphan_temp_files(&nowhere);
        assert_eq!(removed, 0, "目录不存在时不应 panic，返回 0");
    }

    // ─── ZIP slip 路径遍历防护 ─────────────────────────

    #[test]
    fn is_safe_zip_entry_name_accepts_legit_rejects_traversal() {
        // 合法：固定名 + 规整相对资产路径（dev/prod 前缀都算合法；普通点号不误伤）
        assert!(is_safe_zip_entry_name("app.db"));
        assert!(is_safe_zip_entry_name("settings.json"));
        assert!(is_safe_zip_entry_name("kb_assets/images/abc.png"));
        assert!(is_safe_zip_entry_name("dev-kb_assets/images/中文名.png"));
        assert!(is_safe_zip_entry_name("pdfs/2026/report.pdf"));
        assert!(is_safe_zip_entry_name("sources/a.b.c.txt"));

        // 非法：父目录穿越
        assert!(!is_safe_zip_entry_name("../evil.txt"));
        assert!(!is_safe_zip_entry_name("kb_assets/../../evil.txt"));
        assert!(!is_safe_zip_entry_name("..\\evil.txt"));
        // 非法：绝对路径 / UNC
        assert!(!is_safe_zip_entry_name("/etc/passwd"));
        assert!(!is_safe_zip_entry_name("\\\\server\\share\\x"));
        // 非法：Windows 盘符
        assert!(!is_safe_zip_entry_name("C:\\Windows\\System32\\x.dll"));
        assert!(!is_safe_zip_entry_name("C:/Windows/x"));
        // 非法：空名 / NUL
        assert!(!is_safe_zip_entry_name(""));
        assert!(!is_safe_zip_entry_name("kb_assets/x\0.png"));
    }

    /// ZIP slip 端到端：含 `..` 穿越 entry 的恶意包必须被拒绝，且越界文件绝不落盘。
    #[test]
    fn import_rejects_zip_slip_entry() {
        use std::io::Cursor;
        let tmp = std::env::temp_dir().join(format!(
            "kb-zipslip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let dest_db = tmp.join("dest-app.db");
        Database::init(dest_db.to_str().unwrap())
            .unwrap()
            .release()
            .ok();

        // 构造恶意 zip：合法 manifest（is_dev=None 跳过 dev/prod 校验）+ 一个父目录穿越 entry
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opt = SimpleFileOptions::default();
            let manifest = SyncManifest {
                schema_version: 1,
                device: "t".into(),
                exported_at: "x".into(),
                app_version: "t".into(),
                scope: SyncScope {
                    notes: false,
                    images: true,
                    pdfs: false,
                    sources: false,
                    settings: false,
                },
                stats: SyncStats::default(),
                is_dev: None,
                db_user_version: None,
            };
            zip.start_file(MANIFEST_FILE, opt).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
                .unwrap();
            // 越界 entry：试图写到 data_dir 的上一级
            zip.start_file("../kb-zipslip-EVIL.txt", opt).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }

        let res = SyncService::apply_snapshot_from_reader(
            &tmp,
            &dest_db,
            Cursor::new(&buf),
            SyncImportMode::Merge,
        );
        assert!(res.is_err(), "含 ../ 穿越 entry 的包必须被拒绝导入");

        // 越界文件绝不能被写到 data_dir 之外
        let escaped = tmp.parent().unwrap().join("kb-zipslip-EVIL.txt");
        assert!(!escaped.exists(), "ZIP slip 越界文件不得落盘");

        let _ = fs::remove_dir_all(&tmp);
    }
}

fn device_zip_name() -> String {
    let device = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    // 清洗：只留字母/数字/-/_
    let safe: String = device
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("kb-sync-{}.zip", safe.to_lowercase())
}
