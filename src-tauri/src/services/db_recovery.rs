//! 启动期数据库恢复：`app.db` 打不开时的自救流程。
//!
//! ## 为什么需要
//!
//! 早期 `lib.rs` 的 setup 里是 `Database::init(&path)?` —— 数据库一打不开就让 setup 返回 Err，
//! 应用直接 `exit(1)`。用户侧的表现就是"软件再也打不开了"，且**没有任何自救入口**：
//! 界面进不去，自然也没法用界面里的"从备份恢复"。
//!
//! 最容易撞上这个的场景是整库导入（V0 ZIP / WebDAV 恢复）中途失败，把 `app.db` 写成半截文件。
//! 该路径本身已经改成"临时文件 → 校验 → 备份 → 原子替换"（见 `services::sync`），
//! 但对**存量已经坏掉的用户**、以及磁盘故障 / 断电等外因，仍需要启动期兜底。
//!
//! ## 恢复策略（按顺序尝试，先保数据后保可用）
//!
//! 1. **从自动备份恢复** —— 扫 `app.db.bak-*`（导入前由 `SyncService::backup_existing_db` 保留，
//!    滚动 3 份），按时间从新到旧逐个校验，第一个能通过 `quick_check` 的就用它顶上。
//!    这是最理想的结果：用户只丢失"最后一次导入之后"的改动。
//! 2. **降级空库启动** —— 备份全都不可用（或压根没有备份）时，把损坏文件改名成
//!    `app.db.corrupt-<时间戳>` 留档（**绝不删除**，用户可能还想找人抢救），然后建一个新空库。
//!    应用能正常进界面，用户可以自己走"设置 → 导入备份"。
//!
//! 两条路都失败才向上报错（那多半是磁盘挂了 / 目录没有写权限，此时确实无能为力）。

use std::path::{Path, PathBuf};

use crate::database::Database;
use crate::error::AppError;

/// 自动备份文件名中缀，与 `services::sync::DB_BACKUP_SUFFIX` 保持一致
const BACKUP_SUFFIX: &str = ".bak-";
/// 损坏库留档时用的中缀
const CORRUPT_SUFFIX: &str = ".corrupt-";

/// 这个打开失败**该不该**走恢复流程。
///
/// 恢复流程会把库改名成 `.corrupt-*` 再用空库启动 —— 对真损坏是救命，
/// 对「应用比库旧」（[`AppError::SchemaTooNew`]）却是灾难：数据明明完好，
/// 用户却看到一个空知识库，只有一行日志说文件还在。
///
/// 触发「应用比库旧」不需要什么极端条件：本项目**每发一版 schema 都涨**
/// （v1.50.0=54 / v1.51.0=55 / v1.52.0=56），用户从 release 仓下个旧版装回去、
/// 或把数据目录同步到另一台还没升级的机器，就会撞上。
pub(crate) fn should_attempt_recovery(err: &AppError) -> bool {
    !matches!(err, AppError::SchemaTooNew { .. })
}

/// 数据库打不开时的恢复入口。成功返回一个可用的 [`Database`]。
///
/// ⚠️ 调用前必须先过 [`should_attempt_recovery`] —— 本函数只负责"救损坏的库"，
/// 不判断该不该救。`open_err` 只用于日志 / 留档说明。
pub fn recover_or_fresh(db_path: &Path, open_err: &AppError) -> Result<Database, AppError> {
    log::warn!(
        "[db-recovery] 开始恢复流程，目标库 {}（原始错误: {}）",
        db_path.display(),
        open_err
    );

    // ── 策略 1：从最近的可用自动备份恢复
    let backups = list_backups(db_path);
    log::info!("[db-recovery] 找到 {} 个自动备份候选", backups.len());
    for backup in &backups {
        match probe_sqlite(backup) {
            // 备份自身版本高于当前应用时**必须跳过**：拿它顶上去，init 里的迁移照样因
            // 「版本过高」失败，而 restore_from_backup 已经先把原库 quarantine 了；
            // 循环走到策略 2 再 quarantine 一次，秒级时间戳撞车会**盖掉那份原库留档**。
            // 留档的全部意义是"绝不删除，用户可能还想找人抢救"，被盖掉这承诺就没了。
            Ok(v) if v > crate::database::schema::SCHEMA_VERSION => log::warn!(
                "[db-recovery] 备份 {} 的版本({})高于当前应用({})，跳过",
                backup.display(),
                v,
                crate::database::schema::SCHEMA_VERSION
            ),
            Ok(_) => {
                log::info!("[db-recovery] 备份 {} 校验通过，尝试恢复", backup.display());
                match restore_from_backup(db_path, backup) {
                    Ok(db) => {
                        log::info!(
                            "[db-recovery] 已从备份 {} 恢复数据库，应用继续启动",
                            backup.display()
                        );
                        return Ok(db);
                    }
                    Err(e) => log::warn!(
                        "[db-recovery] 从备份 {} 恢复失败，尝试下一个: {}",
                        backup.display(),
                        e
                    ),
                }
            }
            Err(e) => log::warn!(
                "[db-recovery] 备份 {} 不可用（{}），尝试下一个",
                backup.display(),
                e
            ),
        }
    }

    // ── 策略 2：损坏库留档 + 空库启动
    log::warn!("[db-recovery] 无可用备份，改为留档损坏库并以空库启动");
    quarantine_corrupt_db(db_path)?;
    let db = Database::init(&db_path.to_string_lossy())?;
    log::warn!(
        "[db-recovery] 已用全新空库启动。原损坏文件已留档在同目录 {}*，可在设置页导入备份恢复数据",
        db_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("app.db")
    );
    Ok(db)
}

/// 列出同目录下的自动备份，**从新到旧**排序。
///
/// 时间戳格式 `%Y%m%d-%H%M%S` 保证字典序 == 时间序，逆序排即是从新到旧。
fn list_backups(db_path: &Path) -> Vec<PathBuf> {
    let (dir, file_name) = match (db_path.parent(), db_path.file_name().and_then(|s| s.to_str())) {
        (Some(d), Some(f)) => (d, f),
        _ => return Vec::new(),
    };
    let prefix = format!("{}{}", file_name, BACKUP_SUFFIX);
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[db-recovery] 读取备份目录失败: {}", e);
            return Vec::new();
        }
    };
    let mut backups: Vec<PathBuf> = entries
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
    backups.sort();
    backups.reverse(); // 新 → 旧
    backups
}

/// 判定一个 SQLite 文件是否是"能用的本应用数据库"，顺带返回它的 `user_version`。
///
/// 供两处共用：本模块的启动恢复、以及 `services::sync` 导入前对包内 `app.db` 的校验。
///
/// ## 为什么不用 `PRAGMA quick_check`
///
/// 本库带 FTS5 全文索引表（`notes_fts`）。`quick_check` / `integrity_check` 在校验 FTS5
/// 倒排索引时需要写临时数据，以**只读**方式打开的连接会直接报
/// `attempt to write a readonly database` —— 把完好的库误判成损坏。
/// 而这里又**必须**只读打开（校验备份文件时绝不能污染它、更不能给它生出 `-wal`）。
///
/// 改为逐层实读，对本场景要防的"截断 / 垃圾文件 / 页损坏"一样敏感，且不需要写权限：
/// 1. 只读打开（文件头不合法 → 直接失败）
/// 2. 读 `sqlite_master`（schema 页可读性）
/// 3. 确认含 `notes` 表（是不是本应用的库）
/// 4. `SELECT count(*) FROM notes`（真正遍历表的数据页，半截文件在这一步暴露）
pub(crate) fn probe_sqlite(path: &Path) -> Result<i32, AppError> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError::Custom(format!("打开失败: {}", e)))?;

    let has_notes: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| AppError::Custom(format!("读取表结构失败: {}", e)))?;
    if has_notes == 0 {
        return Err(AppError::Custom("不是本应用的数据库（缺 notes 表）".into()));
    }

    // 实读一遍 notes 表，触碰真实数据页
    let _: i64 = conn
        .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
        .map_err(|e| AppError::Custom(format!("读取笔记数据失败（文件可能已损坏）: {}", e)))?;

    let version: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| AppError::Custom(format!("读取数据库版本失败: {}", e)))?;
    Ok(version)
}

/// 用备份顶替损坏库：先把损坏文件留档，再把备份**复制**过去（保留备份本身以便重试）。
fn restore_from_backup(db_path: &Path, backup: &Path) -> Result<Database, AppError> {
    quarantine_corrupt_db(db_path)?;
    std::fs::copy(backup, db_path)?;
    // 走完整 init：会跑 PRAGMA + schema 迁移，把老备份升级到当前结构
    Database::init(&db_path.to_string_lossy())
}

/// 把损坏的 db 及其 `-wal` / `-shm` 挪到 `<name>.corrupt-<时间戳>` 留档。
///
/// **必须连 `-wal` / `-shm` 一起挪走**：WAL 三件套是一体的，只挪主文件而留下旧 WAL，
/// 新库打开时 SQLite 会把旧 WAL 的页回放上去，等于刚恢复就再次损坏。
///
/// 文件不存在时静默跳过（首次启动 / 已被挪走都属正常）。
fn quarantine_corrupt_db(db_path: &Path) -> Result<(), AppError> {
    if !db_path.exists() && !side_file(db_path, "-wal").exists() {
        return Ok(());
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = db_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Custom("数据库路径异常，无法留档".into()))?;
    let dir = db_path
        .parent()
        .ok_or_else(|| AppError::Custom("数据库路径异常，无法定位目录".into()))?;

    for suffix in ["", "-wal", "-shm"] {
        let from = side_file(db_path, suffix);
        if !from.exists() {
            continue;
        }
        let to = dir.join(format!("{}{}{}{}", file_name, CORRUPT_SUFFIX, stamp, suffix));
        match std::fs::rename(&from, &to) {
            Ok(_) => log::info!("[db-recovery] 已留档 {} → {}", from.display(), to.display()),
            Err(e) => {
                // 主文件挪不动就没法继续（新库会撞上它）；side 文件挪不动则尽力删掉
                if suffix.is_empty() {
                    return Err(AppError::Custom(format!(
                        "无法移走损坏的数据库文件 {}: {}",
                        from.display(),
                        e
                    )));
                }
                log::warn!("[db-recovery] 留档 {} 失败（尝试直接删除）: {}", from.display(), e);
                let _ = std::fs::remove_file(&from);
            }
        }
    }
    Ok(())
}

/// 构造 `<db_path><suffix>`（如 `app.db-wal`）。
/// 用 OsString 拼接而非 `with_extension`，避免把 `app.db` 的 `.db` 扩展名替换掉。
fn side_file(db_path: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        return db_path.to_path_buf();
    }
    let mut s = db_path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteInput;

    /// 恢复闸门：只有"真打不开/坏了"才该救；"应用比库旧"必须放行给调用方原样退出。
    ///
    /// 这是本模块最危险的一条分支 —— 判错方向的代价是把用户完好的库改名留档、
    /// 起个空库，界面上笔记归零。
    #[test]
    fn schema_too_new_must_not_trigger_recovery() {
        assert!(!should_attempt_recovery(&AppError::SchemaTooNew {
            db: 61,
            app: 60
        }));
        // 其余失败照旧走恢复
        assert!(should_attempt_recovery(&AppError::Custom(
            "file is not a database".into()
        )));
        assert!(should_attempt_recovery(&AppError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "truncated"
        ))));
    }

    /// 版本高于当前应用的**备份**要跳过，不能拿去顶替。
    ///
    /// 不跳的后果不是"白试一次"这么轻：`restore_from_backup` 会先把原库 quarantine 留档、
    /// 再把备份复制到 `app.db`，然后 init 因版本过高失败；循环走到策略 2 时又 quarantine 一次，
    /// 而留档文件名的时间戳精度只到秒 —— 同一秒内第二次留档会**盖掉第一次那份原库**。
    /// 留档存在的全部意义就是"绝不删除，用户可能还想找人抢救"，被盖掉等于这个承诺作废。
    ///
    /// 断言因此落在「留档里躺的还是不是原库的字节」，而不是「最终库空不空」
    /// 或「备份文件还在不在」—— 那些两种走法都成立，拿来当断言等于没测
    /// （这条测试第一版就是这么写的，反向验证时照样通过，白写）。
    #[test]
    fn recovery_skips_backup_newer_than_app() {
        let dir = temp_dir("skip-newer-bak");
        let db_path = dir.join("app.db");

        // 原库：损坏但带可辨认标记（真实场景里它可能只是部分损坏，仍有抢救价值）
        const ORIGINAL_MARK: &[u8] = b"ORIGINAL-DAMAGED-DB-KEEP-ME";
        std::fs::write(&db_path, ORIGINAL_MARK).unwrap();

        // 备份：文件本身完好，但来自更高版本的应用
        let bak = dir.join("app.db.bak-20990101-000000");
        make_db_with_note(&bak, "未来版本的备份");
        {
            let c = rusqlite::Connection::open(&bak).unwrap();
            crate::database::schema::set_version(&c, crate::database::schema::SCHEMA_VERSION + 1)
                .unwrap();
        }
        assert!(probe_sqlite(&bak).unwrap() > crate::database::schema::SCHEMA_VERSION);

        let db = recover_or_fresh(&db_path, &AppError::Custom("坏了".into())).unwrap();
        assert!(note_titles(&db).is_empty(), "没有可用备份，应是全新空库");
        drop(db);

        let archived: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| n.contains(CORRUPT_SUFFIX))
                    .unwrap_or(false)
            })
            .collect();
        assert!(!archived.is_empty(), "损坏的原库必须留档");
        assert!(
            archived
                .iter()
                .any(|p| std::fs::read(p).map(|b| b == ORIGINAL_MARK).unwrap_or(false)),
            "留档里必须还是原库的字节，不能被那个未来版本的备份盖掉"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "kb-dbrec-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 建一个含指定标题笔记的真实库文件，然后释放句柄
    fn make_db_with_note(path: &Path, title: &str) {
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

    fn note_titles(db: &Database) -> Vec<String> {
        let conn = db.conn_lock().unwrap();
        let mut stmt = conn.prepare("SELECT title FROM notes").unwrap();
        let v = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        v
    }

    #[test]
    fn probe_rejects_garbage_and_accepts_real_db() {
        let dir = temp_dir("probe");
        let good = dir.join("app.db");
        make_db_with_note(&good, "ok");
        assert!(probe_sqlite(&good).is_ok(), "正常库应通过校验");

        let garbage = dir.join("garbage.db");
        std::fs::write(&garbage, b"this is definitely not a sqlite file").unwrap();
        assert!(probe_sqlite(&garbage).is_err(), "垃圾文件必须被拒");

        // 合法 SQLite 但不是本应用的库（无 notes 表）
        let alien = dir.join("alien.db");
        let conn = rusqlite::Connection::open(&alien).unwrap();
        conn.execute_batch("CREATE TABLE foo(id INTEGER);").unwrap();
        drop(conn);
        assert!(probe_sqlite(&alien).is_err(), "无 notes 表的库必须被拒");

        // 返回值应是库的 user_version（正常库 = 当前 SCHEMA_VERSION）
        assert_eq!(
            probe_sqlite(&good).unwrap(),
            crate::database::schema::SCHEMA_VERSION
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 核心场景：库损坏 + 有可用备份 → 自动恢复出备份里的数据，损坏文件留档不丢
    #[test]
    fn recovers_from_latest_valid_backup() {
        let dir = temp_dir("restore");
        let db_path = dir.join("app.db");

        // 造一个备份（内容可辨识）
        let backup = dir.join("app.db.bak-20260101-000000");
        make_db_with_note(&backup, "来自备份的笔记");

        // 主库写成损坏文件
        std::fs::write(&db_path, b"corrupted-not-a-db").unwrap();
        assert!(Database::init(&db_path.to_string_lossy()).is_err() || probe_sqlite(&db_path).is_err());

        let db = recover_or_fresh(&db_path, &AppError::Custom("test".into())).unwrap();
        assert_eq!(
            note_titles(&db),
            vec!["来自备份的笔记".to_string()],
            "应恢复出备份中的数据"
        );

        // 损坏文件必须留档（不能被静默删掉）
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined, "损坏的原库必须留档保存");

        db.release().ok();
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多个备份时应挑**最新**那个
    #[test]
    fn picks_newest_backup_first() {
        let dir = temp_dir("newest");
        let db_path = dir.join("app.db");
        make_db_with_note(&dir.join("app.db.bak-20260101-000000"), "旧备份");
        make_db_with_note(&dir.join("app.db.bak-20260601-120000"), "新备份");
        std::fs::write(&db_path, b"corrupted").unwrap();

        let db = recover_or_fresh(&db_path, &AppError::Custom("test".into())).unwrap();
        assert_eq!(note_titles(&db), vec!["新备份".to_string()]);

        db.release().ok();
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 损坏备份应被跳过，落到下一个可用备份上
    #[test]
    fn skips_corrupt_backup_and_falls_back_to_older() {
        let dir = temp_dir("skip");
        let db_path = dir.join("app.db");
        make_db_with_note(&dir.join("app.db.bak-20260101-000000"), "可用的旧备份");
        // 最新的那份也是坏的
        std::fs::write(dir.join("app.db.bak-20260601-120000"), b"also-corrupt").unwrap();
        std::fs::write(&db_path, b"corrupted").unwrap();

        let db = recover_or_fresh(&db_path, &AppError::Custom("test".into())).unwrap();
        assert_eq!(note_titles(&db), vec!["可用的旧备份".to_string()]);

        db.release().ok();
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无任何备份 → 空库启动（应用可用），损坏文件留档
    #[test]
    fn falls_back_to_empty_db_and_quarantines_when_no_backup() {
        let dir = temp_dir("fresh");
        let db_path = dir.join("app.db");
        std::fs::write(&db_path, b"corrupted-no-backup").unwrap();

        let db = recover_or_fresh(&db_path, &AppError::Custom("test".into())).unwrap();
        assert!(note_titles(&db).is_empty(), "无备份时应是全新空库");

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().any(|n| n.contains(".corrupt-")),
            "损坏文件必须留档，实际目录内容: {:?}",
            names
        );

        db.release().ok();
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 留档必须把 -wal / -shm 一起挪走，否则新库会被旧 WAL 回放污染
    #[test]
    fn quarantine_moves_wal_and_shm_together() {
        let dir = temp_dir("wal");
        let db_path = dir.join("app.db");
        std::fs::write(&db_path, b"corrupt").unwrap();
        std::fs::write(side_file(&db_path, "-wal"), b"stale-wal").unwrap();
        std::fs::write(side_file(&db_path, "-shm"), b"stale-shm").unwrap();

        quarantine_corrupt_db(&db_path).unwrap();

        assert!(!db_path.exists(), "主文件应已挪走");
        assert!(!side_file(&db_path, "-wal").exists(), "-wal 必须一起挪走");
        assert!(!side_file(&db_path, "-shm").exists(), "-shm 必须一起挪走");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_is_noop_when_nothing_exists() {
        let dir = temp_dir("noop");
        let db_path = dir.join("app.db");
        assert!(quarantine_corrupt_db(&db_path).is_ok(), "首次启动不应报错");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
