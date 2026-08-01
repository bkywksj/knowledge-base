//! 主窗口尺寸相关 Command（仅桌面端 —— 移动端窗口由系统管理）。

/// 把主窗口恢复成"默认大小并居中"。
///
/// 为什么需要它：接了 tauri-plugin-window-state 之后，窗口的大小 / 位置 /
/// 最大化状态会被记住并在下次启动还原。好处是用户调过一次就一直保持，代价是
/// 一旦把窗口拖成很别扭的尺寸（或从多屏环境挪到单屏、外接屏拔掉），就再没有
/// 一键回到合理尺寸的路 —— 这个 Command 就是那条路。
///
/// 做三件事，缺一不可：
///   1. 先退出最大化 —— 最大化状态下 set_size 不生效（或还原后才生效，观感是"点了没反应"）
///   2. 按当前主显示器重算默认尺寸并居中
///   3. **立刻落盘**，否则用户点完不重启直接关窗口，插件会把"关闭那一刻的尺寸"
///      写回去，看起来像恢复失败
#[tauri::command]
pub fn reset_window_size(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;

        // 1. 退出最大化（本来就不是最大化时这是空操作）
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }

        // 2. 按当前主显示器重算 —— 用户可能换了屏或改了缩放，不能用启动时的值
        let monitor = window
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "取不到主显示器信息".to_string())?;
        let scale = monitor.scale_factor().max(0.1);
        let phys = monitor.size();
        let (w, h) = crate::services::window_size::default_window_size(
            phys.width as f64 / scale,
            phys.height as f64 / scale,
        );
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        window.center().map_err(|e| e.to_string())?;

        // 3. 立刻落盘。用 SIZE|POSITION|MAXIMIZED，与插件注册时的 flags 一致 ——
        //    传 all() 会顺带把 VISIBLE 写进去，而我们刻意不跟踪它（见 lib.rs 注释）。
        app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("移动端窗口由系统管理，不支持调整".to_string())
    }
}
