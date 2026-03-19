use std::sync::Mutex;

use tokio::sync::watch;

use crate::database::Database;

/// 应用全局状态，通过 tauri::State 注入到 Command 中
pub struct AppState {
    pub db: Database,
    /// AI 生成取消信号 (conversation_id -> sender)
    pub ai_cancel: Mutex<std::collections::HashMap<i64, watch::Sender<bool>>>,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            ai_cancel: Mutex::new(std::collections::HashMap::new()),
        }
    }
}
