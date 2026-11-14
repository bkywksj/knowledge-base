//! 局域网同步（手机 ↔ 本机）Commands。仅桌面端：手机只做客户端，不开监听端口。
//! 业务逻辑在 `services::lan_sync`，这里只做参数校验和转调。

use tauri::State;

use crate::services::lan_sync::{self, LanSyncStatus};
use crate::state::AppState;

/// 当前状态（开关 / 是否在跑 / 端口 / 本机地址 / 证书指纹）
#[tauri::command]
pub async fn lan_sync_status(state: State<'_, AppState>) -> Result<LanSyncStatus, String> {
    Ok(state.lan_sync.status(&state.db).await)
}

/// 开启：保存端口和开关后起服务（并确保「本机中转」同步源存在）。
/// 先落库再启动：启动失败（端口被占）用户改过的端口也留住
#[tauri::command]
pub async fn lan_sync_enable(state: State<'_, AppState>, port: u16) -> Result<LanSyncStatus, String> {
    if port < 1024 {
        return Err("端口请用 1024 以上".into());
    }
    state.db.set_config(lan_sync::KEY_PORT, &port.to_string()).map_err(|e| e.to_string())?;
    state.db.set_config(lan_sync::KEY_ENABLED, "1").map_err(|e| e.to_string())?;
    state.lan_sync.start(&state.db, &state.data_dir).await.map_err(|e| e.to_string())?;
    Ok(state.lan_sync.status(&state.db).await)
}

/// 关闭：停服务、记开关。「本机中转」同步源保留（用户可在同步列表里自己删）
#[tauri::command]
pub async fn lan_sync_disable(state: State<'_, AppState>) -> Result<LanSyncStatus, String> {
    let _ = state.db.set_config(lan_sync::KEY_ENABLED, "0");
    state.lan_sync.stop().await;
    Ok(state.lan_sync.status(&state.db).await)
}

/// 配对二维码内容（含令牌，只给界面渲染二维码用）
#[tauri::command]
pub fn lan_sync_pairing_payload(state: State<'_, AppState>) -> Result<String, String> {
    lan_sync::pairing_payload(&state.db).map_err(|e| e.to_string())
}

/// 重新生成配对码：已配对的设备全部失效、需重新扫码。服务在跑就按新令牌重启
#[tauri::command]
pub async fn lan_sync_reset_pairing(state: State<'_, AppState>) -> Result<LanSyncStatus, String> {
    lan_sync::reset_token(&state.db).map_err(|e| e.to_string())?;
    if state.lan_sync.status(&state.db).await.running {
        state.lan_sync.start(&state.db, &state.data_dir).await.map_err(|e| e.to_string())?;
    }
    Ok(state.lan_sync.status(&state.db).await)
}
