use std::path::PathBuf;
use std::sync::Mutex;

use tokio::sync::watch;

use crate::database::Database;

/// 应用全局状态，通过 tauri::State 注入到 Command 中
pub struct AppState {
    pub db: Database,
    /// 应用数据目录（用于定位图片/源文件等资产）
    pub data_dir: PathBuf,
    /// AI 生成取消信号 (conversation_id -> sender)
    pub ai_cancel: Mutex<std::collections::HashMap<i64, watch::Sender<bool>>>,
}

impl AppState {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            db,
            data_dir,
            ai_cancel: Mutex::new(std::collections::HashMap::new()),
        }
    }
}
