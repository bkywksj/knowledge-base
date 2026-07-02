use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::{watch, Notify};

use crate::database::Database;
use crate::services::vault::VaultState;

/// In-memory MCP client：通过 tokio::io::duplex 与同进程内的 KbServer 通信。
/// 让主应用代码也能用统一的 MCP 协议消费 27 工具，而不是直接调 services::*。
/// 使用 RoleClient 角色，handler 用 () 表示不响应 server-initiated 请求。
pub type InternalMcpClient = rmcp::service::RunningService<rmcp::RoleClient, ()>;

/// 应用全局状态，通过 tauri::State 注入到 Command 中
pub struct AppState {
    pub db: Database,
    /// 数据根目录（默认 = app_data_dir；用户改自定义目录 / KB_DATA_DIR / 便携模式后为对应路径）
    /// 资产/PDF/sources/db 都基于此路径
    pub data_dir: PathBuf,
    /// AI 生成取消信号 (conversation_id -> 该会话所有在途流式的取消发送端)。
    /// P2：用 Vec 而非单个 Sender——同一会话极端情况下可能并发多条在途生成，单 Sender 会被
    /// 后来的 insert 覆盖：①旧流的 Receiver 因 Sender 被 drop 而 select 空转吃 CPU；
    /// ②先完成者 remove 掉后来者的取消端 → 停止按钮失效。各流式命令持有自己的 Arc<Sender>
    /// 存活至结束，cancel 时对该会话所有 Sender 发信号。
    pub ai_cancel: Mutex<std::collections::HashMap<i64, Vec<Arc<watch::Sender<bool>>>>>,
    /// 自动同步调度器唤醒信号：配置变更时 notify_one 重载
    pub sync_scheduler_notify: Arc<Notify>,
    /// V1 多端同步互斥闸门：同一 backend 同时只允许一个 pull/push/双向同步在跑，
    /// 防止并发 pull 互撞 `idx_notes_stable_uuid` UNIQUE、并发 push 互相覆盖远端 manifest
    pub sync_v1_gate: crate::services::sync_v1::lock::SyncGate,
    /// 待办提醒调度器唤醒信号：用户增/改/删/snooze 任务时 notify_one，
    /// 调度器立刻重新计算"下一个最早提醒时刻"并重 sleep。
    /// 这样实现的精度 ~毫秒，且空闲时零 DB 查询（只在事件驱动 + 5min 兜底唤醒时扫）。
    pub reminder_notify: Arc<Notify>,
    /// 定时推送调度器唤醒信号：用户增/改/删/启停推送时 notify_one，
    /// 调度器立刻重算"下一个最早 next_run_at"并重 sleep。语义同 reminder_notify。
    pub push_notify: Arc<Notify>,
    /// 启动时 argv 里的 .md 文件路径，等前端 mount 后 take 出来
    pub pending_open_md_path: Mutex<Option<String>>,
    /// T-007 笔记加密保险库：内存中的主密钥（可选），锁定时清空
    pub vault: RwLock<VaultState>,
    /// In-memory MCP client（指向同进程内的 KbServer）。
    /// `Option` 是因为初始化失败不应阻断主应用启动 —— None 时 mcp_internal_* 命令会报"未就绪"。
    pub mcp_internal: Option<Arc<InternalMcpClient>>,
    /// 外部 MCP server client 缓存（M5-2）。每个用户加的 server 对应一个子进程 + client。
    /// 进程级单例：第一次访问时 spawn，后续请求复用。
    /// 仅桌面端：移动端 fork/spawn 受限，没有外部 MCP 概念
    #[cfg(desktop)]
    pub mcp_external: Arc<crate::services::mcp_client::McpClientManager>,
    /// 单实例守护锁文件句柄（保持存活以维持独占锁，进程退出时自动释放）
    _lock_file: Option<File>,
}

impl AppState {
    pub fn new(
        db: Database,
        data_dir: PathBuf,
        mcp_internal: Option<Arc<InternalMcpClient>>,
        lock_file: Option<File>,
    ) -> Self {
        Self {
            db,
            data_dir,
            ai_cancel: Mutex::new(std::collections::HashMap::new()),
            sync_scheduler_notify: Arc::new(Notify::new()),
            sync_v1_gate: crate::services::sync_v1::lock::SyncGate::new(),
            reminder_notify: Arc::new(Notify::new()),
            push_notify: Arc::new(Notify::new()),
            pending_open_md_path: Mutex::new(None),
            vault: RwLock::new(VaultState::default()),
            mcp_internal,
            #[cfg(desktop)]
            mcp_external: Arc::new(crate::services::mcp_client::McpClientManager::new()),
            _lock_file: lock_file,
        }
    }
}
