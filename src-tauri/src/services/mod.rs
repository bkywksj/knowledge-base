pub mod ai;
pub mod app_lock;
pub mod asr;
pub mod asset_path;
pub mod cards;
pub mod attachment;
pub mod config;
pub mod converter;
pub mod crypto;
pub mod daily;
pub mod data_dir;
// 紧急待办全屏窗口仅桌面端（移动端无多窗口概念）
#[cfg(desktop)]
pub mod emergency_window;
// Excel 解析仅桌面端：calamine 在 Android target 编译失败
// （T-M013 移动端导入改单文件模式后再决定是否引入）
#[cfg(desktop)]
pub mod excel_parser;
pub mod export;
pub mod export_html;
// Word 导出仅桌面端：docx_rs 在 Android target 编译失败
#[cfg(desktop)]
pub mod export_word;
pub mod folder;
pub mod hash;
pub mod hidden_pin;
pub mod http_client;
pub mod image;
pub mod image_download;
pub mod import;
pub mod import_attachments;
pub mod import_video_attachments;
pub mod links;
pub mod markdown;
// 外部 MCP server 子进程管理仅桌面端：rmcp transport-child-process 在桌面端 dependencies
// 移动端 fork/spawn 受限，砍掉外部 MCP，仅保留 in-memory 内置 server（kb-core）
#[cfg(desktop)]
pub mod mcp_client;
pub mod note;
#[cfg(desktop)]
pub mod ocr;
// macOS 零二进制 OCR（Apple Vision FFI）；仅 macOS 编译
#[cfg(target_os = "macos")]
pub mod mac_ocr;
pub mod orphan_scan;
pub mod pdf;
// 笔记 pop-out 窗口仅桌面端（移动端改 Modal）
#[cfg(desktop)]
pub mod popout_window;
pub mod dataview;
pub mod plugin;
pub mod project;
pub mod prompt;
pub mod push;
pub mod quick_capture;
pub mod safe_filename;
pub mod search;
// 全局快捷键仅桌面端可用
#[cfg(desktop)]
pub mod shortcut;
pub mod skills;
pub mod source_file;
pub mod source_writeback;
pub mod sync;
pub mod sync_scheduler;
pub mod sync_v1;
pub mod sync_v1_scheduler;
pub mod tag;
pub mod task_reminder;
pub mod tasks;
pub mod template;
pub mod trash;
pub mod vault;
pub mod video;
pub mod web_clip;
pub mod webdav;
