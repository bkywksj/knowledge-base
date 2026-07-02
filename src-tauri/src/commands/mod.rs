pub mod ai;
pub mod app_lock;
pub mod asr;
pub mod attachment;
pub mod cards;
pub mod config;
pub mod daily;
pub mod dataview;
pub mod data_dir;
pub mod export;
pub mod folders;
pub mod hidden_pin;
pub mod image;
pub mod import;
pub mod links;
pub mod mcp;
// 移动端"检查更新"（桌面端用 tauri-plugin-updater，不需要这个）
#[cfg(mobile)]
pub mod mobile_update;
pub mod notes;
#[cfg(desktop)]
pub mod ocr;
pub mod orphan;
pub mod pdf;
pub mod projects;
pub mod prompt;
pub mod push;
pub mod search;
// 全局快捷键仅桌面端可用（移动端无此概念）
#[cfg(desktop)]
pub mod shortcut;
pub mod source_file;
pub mod source_writeback;
pub mod sync;
pub mod sync_v1;
pub mod system;
pub mod tags;
pub mod tasks;
pub mod template;
pub mod trash;
pub mod vault;
pub mod videos;
