use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::{watch, Notify};

use crate::database::Database;

/// 应用全局状态，通过 tauri::State 注入到 Command 中
pub struct AppState {
    pub db: Database,
    /// 应用数据目录（用于定位图片/源文件等资产）
    pub data_dir: PathBuf,
    /// AI 生成取消信号 (conversation_id -> sender)
    pub ai_cancel: Mutex<std::collections::HashMap<i64, watch::Sender<bool>>>,
    /// 自动同步调度器唤醒信号：配置变更时 notify_one 重载
    pub sync_scheduler_notify: Arc<Notify>,
    /// 启动时 argv 里的 .md 文件路径，等前端 mount 后 take 出来
    pub pending_open_md_path: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            db,
            data_dir,
            ai_cancel: Mutex::new(std::collections::HashMap::new()),
            sync_scheduler_notify: Arc::new(Notify::new()),
            pending_open_md_path: Mutex::new(None),
        }
    }
}
