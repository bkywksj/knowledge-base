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

            // 开发/生产数据隔离：dev 模式下所有数据加 dev- 前缀，避免改坏生产数据
            // 首次启动 dev 时若检测到旧无前缀数据，自动迁移
            if cfg!(debug_assertions) {
                migrate_to_dev_prefix(&data_dir);
            }

            let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
            let db_path = data_dir.join(format!("{}app.db", prefix));
            let db_path_str = db_path.to_string_lossy().to_string();

            let db = database::Database::init(&db_path_str)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            log::info!("数据库初始化完成: {}", db_path_str);

            // 初始化图片存储目录（image service 内部会自动加 dev- 前缀）
            let images_dir = services::image::ImageService::ensure_dir(&data_dir)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("图片存储目录: {}", images_dir.display());

            // 初始化 PDF 存储目录（同样带 dev- 前缀）
            let pdfs_dir = services::pdf::PdfService::ensure_dir(&data_dir)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("PDF 存储目录: {}", pdfs_dir.display());

            // 初始化通用源文件存储目录（Word 等用）
            let sources_dir = services::source_file::SourceFileService::ensure_dir(&data_dir)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("源文件存储目录: {}", sources_dir.display());

            // 注册全局状态
            app.manage(AppState::new(db));

            // 开发模式下在窗口标题追加 [DEV] 标识，避免和生产窗口混淆
            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("本地知识库 [DEV]");
                }
            }

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
            commands::system::get_writing_trend,
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
            commands::folders::move_folder,
            commands::folders::reorder_folders,
            // 搜索模块
            commands::search::search_notes,
            // 回收站模块
            commands::trash::soft_delete_note,
            commands::trash::restore_note,
            commands::trash::permanent_delete_note,
            commands::trash::list_trash,
            commands::trash::empty_trash,
            // 每日笔记模块
            commands::daily::get_daily,
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
            commands::notes::trash_all_notes,
            // 图片模块
            commands::image::save_note_image,
            commands::image::save_note_image_from_path,
            commands::image::delete_note_images,
            commands::image::get_images_dir,
            // 模板模块
            commands::template::list_templates,
            commands::template::get_template,
            commands::template::create_template,
            commands::template::update_template,
            commands::template::delete_template,
            // PDF 模块
            commands::pdf::import_pdfs,
            commands::pdf::get_pdf_absolute_path,
            // 通用源文件 / Word 模块
            commands::source_file::get_converter_status,
            commands::source_file::convert_doc_to_docx_base64,
            commands::source_file::attach_source_file,
            commands::source_file::get_source_file_absolute_path,
            commands::source_file::read_file_as_base64,
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

/// dev 模式首次启动时，把旧的无前缀数据自动迁移到 dev- 前缀
/// （只在 cfg!(debug_assertions) 下调用；迁移失败仅记日志，不阻断启动）
#[cfg(debug_assertions)]
fn migrate_to_dev_prefix(data_dir: &std::path::Path) {
    let pairs: &[(&str, &str)] = &[
        ("app.db", "dev-app.db"),
        ("app.db-shm", "dev-app.db-shm"),
        ("app.db-wal", "dev-app.db-wal"),
        ("kb_assets", "dev-kb_assets"),
        ("settings.json", "dev-settings.json"),
    ];
    for (old, new) in pairs {
        let old_p = data_dir.join(old);
        let new_p = data_dir.join(new);
        if old_p.exists() && !new_p.exists() {
            match std::fs::rename(&old_p, &new_p) {
                Ok(_) => log::info!("[dev 迁移] {} → {}", old_p.display(), new_p.display()),
                Err(e) => log::warn!("[dev 迁移失败] {} → {}: {}", old_p.display(), new_p.display(), e),
            }
        }
    }
}

#[cfg(not(debug_assertions))]
#[allow(dead_code)]
fn migrate_to_dev_prefix(_data_dir: &std::path::Path) {}
