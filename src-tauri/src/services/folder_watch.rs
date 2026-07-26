//! 文件夹自动导入 —— 盯住一个目录，新出现 / 被改动的 .md 自动进知识库
//!
//! 场景（用户反馈）：浏览器剪藏插件把网页存成 Markdown 落到某个文件夹，
//! 之前要手动"导入 Markdown 文件夹"才能进库，每次都得记得点一下。
//!
//! **为什么是轮询而不是 notify crate**：
//! 项目里已有两个文件/状态监听都是轮询（`lib.rs` 的 deliver watcher 与
//! db data_version watcher），再引入一套事件式监听会多出第三种范式；而 notify
//! 的平台差异坑不少（Windows 缓冲区溢出会丢事件、网络盘/映射盘不支持、
//! Linux inotify watch 数量有上限）。剪藏落地是"偶尔新增一个文件"的低频场景，
//! 几秒的轮询完全够用，还天然带防抖 —— 零新依赖、零平台差异。
//!
//! 关键细节：
//! - **等文件写完再导**：连续两轮 (size, mtime) 都没变才认为写完，
//!   否则会读到剪藏插件写了一半的文件
//! - **改动即同步**：已导入过的文件如果 mtime 变了会再导一次；
//!   `import_single_markdown` 内部按 source_file_path 去重，会复用原笔记并更新内容
//! - 失败不打断循环：单个文件出错只记日志，下一轮和其它文件照常

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::services::import::ImportService;
use crate::state::AppState;

/// 轮询间隔。剪藏是低频动作，5 秒足够及时，也不会让磁盘忙起来。
const SCAN_INTERVAL: Duration = Duration::from_secs(5);

/// 认得的扩展名（与手动导入保持一致）
const EXTS: [&str; 3] = ["md", "markdown", "txt"];

/// 配置键（存在 app_config 表，跟其它偏好一个路子）
const KEY_ENABLED: &str = "folder_watch_enabled";
const KEY_DIR: &str = "folder_watch_dir";
const KEY_TARGET_FOLDER: &str = "folder_watch_target_folder_id";
const KEY_DELETE_SOURCE: &str = "folder_watch_delete_source";

/// 一个文件的"指纹"：大小 + mtime（秒）。两轮相同 = 写完了
type Fingerprint = (u64, i64);

/// 后台循环：读配置 → 扫目录 → 导入稳定下来的新文件
pub async fn run_folder_watch_loop(app: AppHandle) {
    log::info!("[folder-watch] 调度器已启动（每 {}s 扫一次）", SCAN_INTERVAL.as_secs());
    // 上一轮看到的文件指纹：用来判断"写完了没"
    let mut last_seen: HashMap<PathBuf, Fingerprint> = HashMap::new();
    // 已经导入过的文件指纹：mtime 变了才会再导一次
    let mut imported: HashMap<PathBuf, Fingerprint> = HashMap::new();

    loop {
        tokio::time::sleep(SCAN_INTERVAL).await;
        if let Err(e) = scan_once(&app, &mut last_seen, &mut imported).await {
            log::warn!("[folder-watch] 本轮扫描失败: {}", e);
        }
    }
}

/// 扫一轮。返回 Err 只代表这一轮没跑成（配置读不到等），循环会继续。
async fn scan_once(
    app: &AppHandle,
    last_seen: &mut HashMap<PathBuf, Fingerprint>,
    imported: &mut HashMap<PathBuf, Fingerprint>,
) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState 尚未就绪".to_string())?;

    // ── 读配置；没开启就直接返回（顺手清掉缓存，下次开启时重新判定稳定性）──
    let enabled = state
        .db
        .get_config(KEY_ENABLED)
        .ok()
        .flatten()
        .unwrap_or_default()
        == "1";
    if !enabled {
        if !last_seen.is_empty() || !imported.is_empty() {
            last_seen.clear();
            imported.clear();
        }
        return Ok(());
    }
    let dir = state
        .db
        .get_config(KEY_DIR)
        .ok()
        .flatten()
        .unwrap_or_default();
    if dir.trim().is_empty() {
        return Ok(());
    }
    let dir_path = Path::new(dir.trim());
    if !dir_path.is_dir() {
        log::warn!("[folder-watch] 监听目录不存在或不是目录: {}", dir);
        return Ok(());
    }
    let target_folder: Option<i64> = state
        .db
        .get_config(KEY_TARGET_FOLDER)
        .ok()
        .flatten()
        .and_then(|s| s.trim().parse::<i64>().ok());
    let delete_source = state
        .db
        .get_config(KEY_DELETE_SOURCE)
        .ok()
        .flatten()
        .unwrap_or_default()
        == "1";

    // ── 扫目录（只扫一层，不递归：剪藏插件都是平铺落文件）──
    let entries = std::fs::read_dir(dir_path).map_err(|e| format!("读取目录失败: {}", e))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data_dir 失败: {}", e))?;

    let mut current: HashMap<PathBuf, Fingerprint> = HashMap::new();
    let mut pending: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = crate::services::import::read_file_mtime(&path).unwrap_or(0);
        let fp: Fingerprint = (meta.len(), mtime);
        current.insert(path.clone(), fp);

        // 上一轮没见过 → 这轮先记下来，等下一轮确认稳定（可能正写到一半）
        let Some(prev) = last_seen.get(&path) else {
            continue;
        };
        if *prev != fp {
            continue; // 还在变，接着等
        }
        // 稳定了：没导过、或者内容变了才导
        match imported.get(&path) {
            Some(done) if *done == fp => {}
            _ => pending.push(path),
        }
    }

    *last_seen = current;
    // 目录里已经没有的文件从"已导入"里清掉，免得 HashMap 无限长
    imported.retain(|p, _| last_seen.contains_key(p));

    if pending.is_empty() {
        return Ok(());
    }

    // ── 逐个导入 ──
    let mut ok_count = 0usize;
    for path in pending {
        let path_str = path.to_string_lossy().to_string();
        match ImportService::import_single_markdown(&state.db, &path_str, &app_data_dir).await {
            Ok(res) => {
                // import_single_markdown 建笔记时 folder_id 固定为 None，这里再归位
                if let Some(fid) = target_folder {
                    if let Err(e) = state.db.move_note_to_folder(res.note_id, Some(fid)) {
                        log::warn!("[folder-watch] 笔记 {} 移入目标文件夹失败: {}", res.note_id, e);
                    }
                }
                ok_count += 1;
                log::info!(
                    "[folder-watch] 已导入 {} → 笔记 #{}{}",
                    path_str,
                    res.note_id,
                    if res.was_synced { "（内容已更新）" } else { "" }
                );
                if delete_source {
                    // 删源文件前先断开来源关联：否则笔记还指着一个不存在的路径，
                    // 之后保存会走"写回原文件"分支并报错
                    let _ = state.db.set_note_source_file(res.note_id, None, None);
                    if let Err(e) = std::fs::remove_file(&path) {
                        log::warn!("[folder-watch] 删除源文件失败 {}: {}", path_str, e);
                    }
                } else if let Some(fp) = last_seen.get(&path).copied() {
                    imported.insert(path.clone(), fp);
                }
            }
            Err(e) => {
                // 导入失败（空文件 / 编码坏 / 权限）：记下指纹别反复重试，
                // 等用户把文件改好（mtime 变化）再自动重来一次
                log::warn!("[folder-watch] 导入失败 {}: {}", path_str, e);
                if let Some(fp) = last_seen.get(&path).copied() {
                    imported.insert(path.clone(), fp);
                }
            }
        }
    }

    if ok_count > 0 {
        // 复用外部写入侦测那条链路：前端已经在监听它刷新列表
        let _ = app.emit("db:external-changed", ());
    }
    Ok(())
}
