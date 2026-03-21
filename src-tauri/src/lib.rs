mod commands;
mod database;
mod error;
mod models;
mod services;
mod state;
mod tray;

use state::AppState;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ─── 插件注册 ───────────────────────────────
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        // ─── 应用初始化 ─────────────────────────────
        .setup(|app| {
            // 初始化数据库（存放在应用数据目录）
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("app.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            let db = database::Database::init(&db_path_str)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            log::info!("数据库初始化完成: {}", db_path_str);

            // 初始化图片存储目录
            let images_dir = services::image::ImageService::ensure_dir(&data_dir)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("图片存储目录: {}", images_dir.display());

            // 注册全局状态
            app.manage(AppState::new(db));

            // 初始化系统托盘
            tray::setup_tray(app)?;
            log::info!("系统托盘初始化完成");

            Ok(())
        })
        // ─── Command 注册 ───────────────────────────
        .invoke_handler(tauri::generate_handler![
            // 系统模块
            commands::system::greet,
            commands::system::get_system_info,
            commands::system::get_dashboard_stats,
            // 配置模块
            commands::config::get_all_config,
            commands::config::get_config,
            commands::config::set_config,
            commands::config::delete_config,
            // 笔记模块
            commands::notes::create_note,
            commands::notes::update_note,
            commands::notes::delete_note,
            commands::notes::get_note,
            commands::notes::list_notes,
            commands::notes::toggle_pin,
            commands::notes::move_note_to_folder,
            // 文件夹模块
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::list_folders,
            // 搜索模块
            commands::search::search_notes,
            // 回收站模块
            commands::trash::soft_delete_note,
            commands::trash::restore_note,
            commands::trash::permanent_delete_note,
            commands::trash::list_trash,
            commands::trash::empty_trash,
            // 每日笔记模块
            commands::daily::get_or_create_daily,
            commands::daily::list_daily_dates,
            // 标签模块
            commands::tags::create_tag,
            commands::tags::list_tags,
            commands::tags::rename_tag,
            commands::tags::delete_tag,
            commands::tags::add_tag_to_note,
            commands::tags::remove_tag_from_note,
            commands::tags::get_note_tags,
            commands::tags::list_notes_by_tag,
            // 链接模块
            commands::links::sync_note_links,
            commands::links::get_backlinks,
            commands::links::search_link_targets,
            commands::links::get_graph_data,
            // AI 模块
            commands::ai::list_ai_models,
            commands::ai::create_ai_model,
            commands::ai::update_ai_model,
            commands::ai::delete_ai_model,
            commands::ai::set_default_ai_model,
            commands::ai::list_ai_conversations,
            commands::ai::create_ai_conversation,
            commands::ai::delete_ai_conversation,
            commands::ai::rename_ai_conversation,
            commands::ai::list_ai_messages,
            commands::ai::send_ai_message,
            commands::ai::cancel_ai_generation,
            commands::ai::ai_write_assist,
            commands::ai::cancel_ai_write_assist,
            // 导入模块
            commands::import::scan_markdown_folder,
            commands::import::import_selected_files,
            // 导出模块
            commands::export::export_notes,
            commands::export::export_single_note,
            // 笔记批量操作
            commands::notes::delete_all_notes,
            // 图片模块
            commands::image::save_note_image,
            commands::image::save_note_image_from_path,
            commands::image::delete_note_images,
            commands::image::get_images_dir,
        ])
        // ─── 窗口事件处理 ─────────────────────────
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 点击关闭按钮时隐藏到托盘，而不是退出
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
