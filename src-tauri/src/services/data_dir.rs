//! T-013 自定义数据目录
//!
//! ## 启动期解析优先级
//!
//! 1. 环境变量 `KB_DATA_DIR`（最高优先级；CI / 命令行 / 多版本测试用）
//! 2. 便携模式：`<exe 同级>/portable.txt` 哨兵文件存在
//!    - 内容空 → `<exe 同级>/data/`
//!    - 内容是绝对路径 → 该路径
//!    - 内容是相对路径 → `<exe 同级>/<相对路径>/`
//!    （portable.zip 发行包用；带 portable.txt 一起解压即"绑死安装目录"）
//! 3. 指针文件 `<framework_app_data_dir>/data_dir.txt`（用户在 UI 改路径时写入）
//! 4. 默认 `<framework_app_data_dir>`（兼容旧用户）
//!
//! ## 设计要点
//!
//! - **指针文件本身永远在 framework 默认 app_data_dir**：因为这是 OS 提供的固定位置，
//!   只有这样换数据目录后下次启动才知道去哪找用户的自定义路径
//! - **单实例锁仍在 framework app_data_dir**：换数据目录不应突破单例约束
//! - **用户的"自定义路径"是数据存储根**（db / 资产都基于此）
//! - **重启生效**：set_pending 只写指针文件，不动当前进程的 db 连接，避免连接竞态
//! - **可选自动迁移**（T-013 完整版）：set_pending_with_migration 同时写一个 marker，
//!   下次启动时 lib.rs::setup 检测到 marker → 弹独立 splash 窗口跑迁移 → 完成后初始化 DB

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 指针文件名（位于 framework app_data_dir 内）
pub const POINTER_FILE: &str = "data_dir.txt";

/// 迁移 marker 文件名（位于 framework app_data_dir 内）
pub const MIGRATION_MARKER: &str = "migration.json";

/// 单次迁移要复制的子项（按出现顺序，db 优先确保数据完整性）
///
/// 这些路径是**相对 source_root** 的相对路径；resolver 自动 join 拼到 source/target。
const MIGRATION_ITEMS: &[&str] = &[
    // db 主文件 + WAL + SHM；非 dev
    "app.db",
    "app.db-wal",
    "app.db-shm",
    // db dev 前缀（cfg!(debug_assertions) 启动时项目会加 dev- 前缀）
    "dev-app.db",
    "dev-app.db-wal",
    "dev-app.db-shm",
    // 资产目录
    "kb_assets",
    "attachments",
    "pdfs",
    "sources",
    // dev 资产
    "dev-kb_assets",
    "dev-attachments",
    "dev-pdfs",
    "dev-sources",
];

/// 自定义路径来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataDirSource {
    /// 环境变量 KB_DATA_DIR 优先生效
    Env,
    /// exe 同级 portable.txt 哨兵（便携模式 / portable.zip 发行包）
    Portable,
    /// 指针文件 data_dir.txt 生效
    Pointer,
    /// 没有自定义；用框架默认 app_data_dir
    Default,
}

/// 数据目录解析结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDataDir {
    /// 框架默认 app_data_dir（OS 给的固定位置）
    pub default_dir: String,
    /// 当前生效的数据根目录
    pub current_dir: String,
    /// 来源
    pub source: DataDirSource,
    /// 指针文件里写的路径（可能与 current_dir 不一致，比如被 env 覆盖；为空表示无指针）
    pub pending_dir: Option<String>,
}

pub struct DataDirResolver;

impl DataDirResolver {
    /// 启动早期调用：把"逻辑数据根目录"算出来
    ///
    /// 注意 `default_app_data_dir` 必须是框架的 `app.path().app_data_dir()`，
    /// 而**不是**已经被 instance-N 叠加过的实例目录。
    pub fn resolve(default_app_data_dir: &Path) -> Result<ResolvedDataDir, AppError> {
        let default_str = default_app_data_dir.to_string_lossy().to_string();

        // 1. env var 最高优先级
        if let Ok(p) = std::env::var("KB_DATA_DIR") {
            let trimmed = p.trim();
            if !trimmed.is_empty() {
                let path = PathBuf::from(trimmed);
                std::fs::create_dir_all(&path)?;
                let current = path.to_string_lossy().to_string();
                let pending = read_pointer(default_app_data_dir).ok().flatten();
                return Ok(ResolvedDataDir {
                    default_dir: default_str,
                    current_dir: current,
                    source: DataDirSource::Env,
                    pending_dir: pending,
                });
            }
        }

        // 2. 便携模式：exe 同级 portable.txt 哨兵
        //
        // 不读 AppData 里的指针文件 —— 便携模式语义就是"绑死安装目录，不碰系统目录"；
        // 把指针 surface 出来反而会让 portable.zip 用户看到陌生路径困惑。
        if let Some(p) = detect_portable_data_dir()? {
            return Ok(ResolvedDataDir {
                default_dir: default_str,
                current_dir: p.to_string_lossy().to_string(),
                source: DataDirSource::Portable,
                pending_dir: None,
            });
        }

        // 3. 指针文件
        if let Some(target) = read_pointer(default_app_data_dir)? {
            let path = PathBuf::from(&target);
            std::fs::create_dir_all(&path)?;
            return Ok(ResolvedDataDir {
                default_dir: default_str.clone(),
                current_dir: target.clone(),
                source: DataDirSource::Pointer,
                pending_dir: Some(target),
            });
        }

        // 4. 默认
        Ok(ResolvedDataDir {
            default_dir: default_str.clone(),
            current_dir: default_str,
            source: DataDirSource::Default,
            pending_dir: None,
        })
    }

    /// 用户在 UI 里"修改数据目录"时调
    /// - 仅写指针文件 + 创建目标目录
    /// - 不动当前进程的 db / 资产，避免运行时切换的连接竞态
    /// - 下次启动才生效（前端 UI 提示用户重启）
    pub fn set_pending(default_app_data_dir: &Path, new_path: &str) -> Result<(), AppError> {
        let trimmed = new_path.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput("路径不能为空".into()));
        }
        let new_path_buf = PathBuf::from(trimmed);
        if !new_path_buf.is_absolute() {
            return Err(AppError::InvalidInput(
                "请提供绝对路径（如 D:\\MyKB\\ 或 /Users/me/kb/）".into(),
            ));
        }
        // 创建目录（已存在 OK）
        std::fs::create_dir_all(&new_path_buf)?;
        // 探针：写一个临时文件测试可写
        let probe = new_path_buf.join(".kb_data_dir_writable_test");
        std::fs::write(&probe, b"ok").map_err(|e| {
            AppError::Custom(format!(
                "目标目录不可写: {} ({})",
                new_path_buf.display(),
                e
            ))
        })?;
        let _ = std::fs::remove_file(&probe);

        // 原子写指针文件：先写 .tmp 再 rename
        let pointer = default_app_data_dir.join(POINTER_FILE);
        if let Some(parent) = pointer.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = default_app_data_dir.join(format!("{}.tmp", POINTER_FILE));
        std::fs::write(&tmp, trimmed.as_bytes())?;
        // Windows 上 rename 到已存在文件会失败；先删
        if pointer.exists() {
            let _ = std::fs::remove_file(&pointer);
        }
        std::fs::rename(&tmp, &pointer)?;
        log::info!("[data_dir] 已写入新指针: {}（重启生效）", trimmed);
        Ok(())
    }

    /// 清除指针 → 下次启动恢复默认
    pub fn clear_pending(default_app_data_dir: &Path) -> Result<(), AppError> {
        let pointer = default_app_data_dir.join(POINTER_FILE);
        if pointer.exists() {
            std::fs::remove_file(&pointer)?;
            log::info!("[data_dir] 已清除指针文件，重启后回到默认目录");
        }
        Ok(())
    }
}

/// 读指针文件；不存在返回 Ok(None)；空白内容也视为 None
// ─── T-013 完整版：自动迁移 ──────────────────────────

/// 迁移 marker 状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    /// 已写入 marker，等待启动期执行
    Pending,
    /// 启动期检测到，正在执行
    InProgress,
    /// 上次中途崩溃，需要用户重试 / 放弃
    Crashed,
    /// 完成
    Done,
}

/// marker 文件内容（启动期读 + 写）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationMarker {
    pub from: String,
    pub to: String,
    pub status: MigrationStatus,
    pub started_at: String,
    /// 最后一次更新（每完成一项更新；用于检测崩溃）
    pub updated_at: String,
    /// 已成功复制的项（相对路径，对应 MIGRATION_ITEMS 中条目）
    #[serde(default)]
    pub completed_items: Vec<String>,
}

/// 单次迁移进度事件（emit 给 splash 窗口）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgress {
    /// "scan" | "copy_file" | "verify" | "done" | "error"
    pub phase: String,
    /// 当前正在处理的相对路径（item 内的文件）
    pub current_file: String,
    /// 当前 item 在 MIGRATION_ITEMS 中的索引（基于实际存在的 items）
    pub item_index: usize,
    /// 实际存在的 item 总数
    pub item_total: usize,
    /// 已完成字节数（累计）
    pub bytes_done: u64,
    /// 总字节数（扫描后已知）
    pub bytes_total: u64,
    /// 一句话状态
    pub message: String,
}

/// 进度回调类型
pub type ProgressEmitter = dyn Fn(&MigrationProgress) + Send + Sync;

impl DataDirResolver {
    /// 在 set_pending 同时写一个迁移 marker
    pub fn set_pending_with_migration(
        framework_app_data_dir: &Path,
        from_dir: &Path,
        to_dir: &str,
    ) -> Result<(), AppError> {
        // 先按普通流程写指针
        Self::set_pending(framework_app_data_dir, to_dir)?;
        // 再写迁移 marker
        let marker = MigrationMarker {
            from: from_dir.to_string_lossy().into(),
            to: to_dir.to_string(),
            status: MigrationStatus::Pending,
            started_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            updated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            completed_items: Vec::new(),
        };
        write_marker(framework_app_data_dir, &marker)?;
        log::info!("[migration] 已写入 marker: {} → {}", marker.from, marker.to);
        Ok(())
    }

    /// 启动期：读 marker；不存在返回 None
    pub fn read_migration_marker(
        framework_app_data_dir: &Path,
    ) -> Result<Option<MigrationMarker>, AppError> {
        let path = framework_app_data_dir.join(MIGRATION_MARKER);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path)?;
        let m: MigrationMarker = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Custom(format!("迁移 marker 解析失败: {}", e)))?;
        Ok(Some(m))
    }

    /// 启动期：把 marker 标为完成（迁移结束后调）
    pub fn mark_migration_done(framework_app_data_dir: &Path) -> Result<(), AppError> {
        let path = framework_app_data_dir.join(MIGRATION_MARKER);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// 启动期：取消迁移 — 删 marker + 删指针 → 下次启动回到原位置
    pub fn cancel_migration(framework_app_data_dir: &Path) -> Result<(), AppError> {
        Self::clear_pending(framework_app_data_dir)?;
        let path = framework_app_data_dir.join(MIGRATION_MARKER);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        log::info!("[migration] 已取消迁移：删除 marker + 指针");
        Ok(())
    }

    /// 启动期：执行迁移
    ///
    /// - 流式逐文件复制（rename 优先；rename 失败回退流式 copy）
    /// - 不删旧目录（保留作备份；UI 给"清理旧目录"按钮供用户事后操作）
    /// - 中途任意一步失败：返回 Err，marker 保留（下次启动用户能看到"上次崩溃"）
    /// - 全部成功后：mark_migration_done 删 marker
    pub fn run_migration(
        framework_app_data_dir: &Path,
        marker: &MigrationMarker,
        emit: &ProgressEmitter,
    ) -> Result<(), AppError> {
        let from = PathBuf::from(&marker.from);
        let to = PathBuf::from(&marker.to);
        std::fs::create_dir_all(&to)?;

        // 写 in_progress 状态
        let mut current = marker.clone();
        current.status = MigrationStatus::InProgress;
        write_marker(framework_app_data_dir, &current)?;

        // 扫描存在的 items + 总字节
        emit(&MigrationProgress {
            phase: "scan".into(),
            current_file: String::new(),
            item_index: 0,
            item_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            message: "正在统计文件大小…".into(),
        });
        let plan = scan_items(&from)?;
        let bytes_total: u64 = plan.iter().map(|p| p.size).sum();
        let item_total = plan.len();
        log::info!(
            "[migration] 扫描完成：{} 项，共 {:.2} MB",
            item_total,
            bytes_total as f64 / 1024.0 / 1024.0
        );

        let mut bytes_done = 0u64;
        for (idx, item) in plan.iter().enumerate() {
            let src = from.join(&item.rel);
            let dst = to.join(&item.rel);

            // 跳过已完成（崩溃恢复时复用进度）
            if current.completed_items.contains(&item.rel) {
                bytes_done += item.size;
                continue;
            }

            emit(&MigrationProgress {
                phase: if item.is_dir { "copy_dir" } else { "copy_file" }.into(),
                current_file: item.rel.clone(),
                item_index: idx + 1,
                item_total,
                bytes_done,
                bytes_total,
                message: format!("正在复制 {}", item.rel),
            });

            // 1) 优先 rename（同盘 O(1)）
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let rename_ok = std::fs::rename(&src, &dst).is_ok();
            if !rename_ok {
                // 2) 跨盘 fallback：流式复制
                if item.is_dir {
                    copy_dir_recursive(&src, &dst, &mut bytes_done, bytes_total, emit, &item.rel)?;
                } else {
                    copy_file_with_progress(
                        &src,
                        &dst,
                        &mut bytes_done,
                        bytes_total,
                        emit,
                        &item.rel,
                    )?;
                }
            } else {
                bytes_done += item.size;
            }

            // 标记完成 + 持久化
            current.completed_items.push(item.rel.clone());
            current.updated_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            write_marker(framework_app_data_dir, &current)?;
        }

        // 旧目录写一个 README 让用户知道可以删
        let readme = from.join("_MIGRATED_README.txt");
        let _ = std::fs::write(
            &readme,
            format!(
                "本目录的数据已于 {} 迁移到：\n{}\n\n确认新目录数据正常后，可手动删除本目录。\n（应用不会自动清理旧数据，避免误删。）\n",
                current.updated_at, current.to
            ),
        );

        // 删 marker
        Self::mark_migration_done(framework_app_data_dir)?;

        emit(&MigrationProgress {
            phase: "done".into(),
            current_file: String::new(),
            item_index: item_total,
            item_total,
            bytes_done: bytes_total,
            bytes_total,
            message: format!(
                "迁移完成：{} 项，{:.2} MB",
                item_total,
                bytes_total as f64 / 1024.0 / 1024.0
            ),
        });
        Ok(())
    }
}

/// 单个迁移项（文件或目录）的扫描结果
#[derive(Debug)]
struct PlanItem {
    rel: String,
    is_dir: bool,
    size: u64,
}

/// 扫描 source 下哪些 MIGRATION_ITEMS 存在 + 算总大小
fn scan_items(from: &Path) -> Result<Vec<PlanItem>, AppError> {
    let mut out = Vec::new();
    for &name in MIGRATION_ITEMS {
        let p = from.join(name);
        if !p.exists() {
            continue;
        }
        let is_dir = p.is_dir();
        let size = if is_dir {
            dir_size(&p)?
        } else {
            std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
        };
        out.push(PlanItem {
            rel: name.to_string(),
            is_dir,
            size,
        });
    }
    Ok(out)
}

/// 递归算目录字节数
fn dir_size(path: &Path) -> Result<u64, AppError> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            total += dir_size(&p)?;
        } else if let Ok(m) = entry.metadata() {
            total += m.len();
        }
    }
    Ok(total)
}

/// 流式复制单文件 + 64 KB 缓冲；定期 emit 进度
fn copy_file_with_progress(
    src: &Path,
    dst: &Path,
    bytes_done: &mut u64,
    bytes_total: u64,
    emit: &ProgressEmitter,
    rel: &str,
) -> Result<(), AppError> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut input = std::fs::File::open(src)?;
    let mut output = std::fs::File::create(dst)?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut last_emit_bytes = *bytes_done;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n])?;
        *bytes_done += n as u64;
        // 每 4 MB emit 一次（避免事件爆炸）
        if *bytes_done - last_emit_bytes >= 4 * 1024 * 1024 {
            emit(&MigrationProgress {
                phase: "copy_file".into(),
                current_file: rel.to_string(),
                item_index: 0,
                item_total: 0,
                bytes_done: *bytes_done,
                bytes_total,
                message: format!("复制中 {}", rel),
            });
            last_emit_bytes = *bytes_done;
        }
    }
    output.sync_all().ok();
    Ok(())
}

/// 递归复制整个目录
fn copy_dir_recursive(
    src: &Path,
    dst: &Path,
    bytes_done: &mut u64,
    bytes_total: u64,
    emit: &ProgressEmitter,
    rel: &str,
) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from_path = entry.path();
        let file_name = entry.file_name();
        let to_path = dst.join(&file_name);
        if from_path.is_dir() {
            let sub_rel = format!("{}/{}", rel, file_name.to_string_lossy());
            copy_dir_recursive(
                &from_path,
                &to_path,
                bytes_done,
                bytes_total,
                emit,
                &sub_rel,
            )?;
        } else {
            let sub_rel = format!("{}/{}", rel, file_name.to_string_lossy());
            copy_file_with_progress(
                &from_path,
                &to_path,
                bytes_done,
                bytes_total,
                emit,
                &sub_rel,
            )?;
        }
    }
    Ok(())
}

/// 写 marker 文件（atomic：tmp + rename）
fn write_marker(framework_app_data_dir: &Path, marker: &MigrationMarker) -> Result<(), AppError> {
    let path = framework_app_data_dir.join(MIGRATION_MARKER);
    let tmp = framework_app_data_dir.join(format!("{}.tmp", MIGRATION_MARKER));
    let bytes = serde_json::to_vec_pretty(marker).map_err(|e| AppError::Custom(e.to_string()))?;
    std::fs::write(&tmp, bytes)?;
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn read_pointer(default_app_data_dir: &Path) -> Result<Option<String>, AppError> {
    let pointer = default_app_data_dir.join(POINTER_FILE);
    if !pointer.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&pointer)?.trim().to_string();
    if s.is_empty() {
        return Ok(None);
    }
    Ok(Some(s))
}

/// 便携模式哨兵文件名（位于 exe 同级目录）
pub const PORTABLE_SENTINEL: &str = "portable.txt";

/// 探测 exe 同级是否有 portable.txt；有则返回目标数据根目录
///
/// 失败优雅降级：current_exe 拿不到 / 无父目录 → 返回 None（不报错，回退到指针/默认）
fn detect_portable_data_dir() -> Result<Option<PathBuf>, AppError> {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let exe_dir = match exe.parent() {
        Some(d) => d.to_path_buf(),
        None => return Ok(None),
    };
    detect_portable_in(&exe_dir)
}

/// 可测试的纯函数版：给定一个目录，检查里面的 portable.txt 并返回目标路径
fn detect_portable_in(exe_dir: &Path) -> Result<Option<PathBuf>, AppError> {
    let sentinel = exe_dir.join(PORTABLE_SENTINEL);
    if !sentinel.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&sentinel)
        .unwrap_or_default()
        .trim()
        .to_string();
    let target = if content.is_empty() {
        exe_dir.join("data")
    } else if Path::new(&content).is_absolute() {
        PathBuf::from(&content)
    } else {
        exe_dir.join(&content)
    };
    std::fs::create_dir_all(&target).map_err(|e| {
        AppError::Custom(format!(
            "便携模式目标目录创建失败 {}: {}",
            target.display(),
            e
        ))
    })?;
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app_data() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("kb_data_dir_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_default_when_no_pointer() {
        let app_data = temp_app_data();
        // 清环境变量避免污染
        std::env::remove_var("KB_DATA_DIR");
        let r = DataDirResolver::resolve(&app_data).unwrap();
        assert_eq!(r.source, DataDirSource::Default);
        assert_eq!(r.current_dir, app_data.to_string_lossy());
        assert!(r.pending_dir.is_none());
    }

    #[test]
    fn set_pending_then_resolve_uses_pointer() {
        let app_data = temp_app_data();
        let target = temp_app_data().join("custom-target");
        std::env::remove_var("KB_DATA_DIR");

        DataDirResolver::set_pending(&app_data, target.to_str().unwrap()).unwrap();
        let r = DataDirResolver::resolve(&app_data).unwrap();
        assert_eq!(r.source, DataDirSource::Pointer);
        assert_eq!(r.current_dir, target.to_string_lossy());
        assert_eq!(r.pending_dir.as_deref(), Some(target.to_str().unwrap()));
    }

    #[test]
    fn clear_pending_restores_default() {
        let app_data = temp_app_data();
        let target = temp_app_data().join("will-be-cleared");
        std::env::remove_var("KB_DATA_DIR");

        DataDirResolver::set_pending(&app_data, target.to_str().unwrap()).unwrap();
        DataDirResolver::clear_pending(&app_data).unwrap();

        let r = DataDirResolver::resolve(&app_data).unwrap();
        assert_eq!(r.source, DataDirSource::Default);
        assert!(r.pending_dir.is_none());
    }

    #[test]
    fn set_pending_rejects_relative_path() {
        let app_data = temp_app_data();
        let r = DataDirResolver::set_pending(&app_data, "relative/path");
        assert!(r.is_err());
    }

    #[test]
    fn set_pending_rejects_empty() {
        let app_data = temp_app_data();
        assert!(DataDirResolver::set_pending(&app_data, "").is_err());
        assert!(DataDirResolver::set_pending(&app_data, "   ").is_err());
    }

    // ─── Portable 模式检测测试 ───

    #[test]
    fn portable_no_sentinel_returns_none() {
        let exe_dir = temp_app_data();
        let r = detect_portable_in(&exe_dir).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn portable_empty_sentinel_uses_exe_sibling_data() {
        let exe_dir = temp_app_data();
        std::fs::write(exe_dir.join(PORTABLE_SENTINEL), b"").unwrap();
        let r = detect_portable_in(&exe_dir).unwrap();
        let target = r.expect("portable should be detected");
        assert_eq!(target, exe_dir.join("data"));
        assert!(target.exists(), "目标目录应被自动创建");
    }

    #[test]
    fn portable_sentinel_with_whitespace_treated_as_empty() {
        let exe_dir = temp_app_data();
        std::fs::write(exe_dir.join(PORTABLE_SENTINEL), b"   \n  \r\n  ").unwrap();
        let r = detect_portable_in(&exe_dir).unwrap();
        assert_eq!(r.unwrap(), exe_dir.join("data"));
    }

    #[test]
    fn portable_sentinel_with_absolute_path() {
        let exe_dir = temp_app_data();
        let custom = temp_app_data().join("portable-custom");
        std::fs::write(
            exe_dir.join(PORTABLE_SENTINEL),
            custom.to_string_lossy().as_bytes(),
        )
        .unwrap();
        let r = detect_portable_in(&exe_dir).unwrap();
        assert_eq!(r.unwrap(), custom);
        assert!(custom.exists());
    }

    #[test]
    fn portable_sentinel_with_relative_path_joined_to_exe_dir() {
        let exe_dir = temp_app_data();
        std::fs::write(exe_dir.join(PORTABLE_SENTINEL), b"my-data").unwrap();
        let r = detect_portable_in(&exe_dir).unwrap();
        assert_eq!(r.unwrap(), exe_dir.join("my-data"));
    }

    // 注意：env 变量测试单独跑（otherwise 会干扰其他测试），这里用 #[ignore] 标记，需要时手动跑
    #[test]
    #[ignore = "env var test, run with --ignored"]
    fn env_var_overrides_pointer() {
        let app_data = temp_app_data();
        let target_pointer = temp_app_data().join("from-pointer");
        let target_env = temp_app_data().join("from-env");

        DataDirResolver::set_pending(&app_data, target_pointer.to_str().unwrap()).unwrap();
        std::env::set_var("KB_DATA_DIR", target_env.to_str().unwrap());

        let r = DataDirResolver::resolve(&app_data).unwrap();
        assert_eq!(r.source, DataDirSource::Env);
        assert_eq!(r.current_dir, target_env.to_string_lossy());
        // pending_dir 仍报告指针文件里的内容（让 UI 能展示"环境变量临时覆盖了你的设置"）
        assert_eq!(
            r.pending_dir.as_deref(),
            Some(target_pointer.to_str().unwrap())
        );

        std::env::remove_var("KB_DATA_DIR");
    }
}
