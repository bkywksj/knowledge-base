use tauri::State;
use tokio::sync::watch;

use crate::models::{AiConversation, AiMessage, AiModel, AiModelInput};
use crate::services::ai::AiService;
use crate::state::AppState;

// ─── AI 模型 Commands ────────────────────────

/// 获取所有 AI 模型
#[tauri::command]
pub fn list_ai_models(state: State<'_, AppState>) -> Result<Vec<AiModel>, String> {
    state.db.list_ai_models().map_err(|e| e.to_string())
}

/// 创建 AI 模型
#[tauri::command]
pub fn create_ai_model(
    state: State<'_, AppState>,
    input: AiModelInput,
) -> Result<AiModel, String> {
    state.db.create_ai_model(&input).map_err(|e| e.to_string())
}

/// 更新 AI 模型
#[tauri::command]
pub fn update_ai_model(
    state: State<'_, AppState>,
    id: i64,
    input: AiModelInput,
) -> Result<AiModel, String> {
    state
        .db
        .update_ai_model(id, &input)
        .map_err(|e| e.to_string())
}

/// 删除 AI 模型
#[tauri::command]
pub fn delete_ai_model(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.db.delete_ai_model(id).map_err(|e| e.to_string())
}

/// 设置默认 AI 模型
#[tauri::command]
pub fn set_default_ai_model(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state
        .db
        .set_default_ai_model(id)
        .map_err(|e| e.to_string())
}

// ─── AI 对话 Commands ────────────────────────

/// 获取所有对话
#[tauri::command]
pub fn list_ai_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<AiConversation>, String> {
    state
        .db
        .list_ai_conversations()
        .map_err(|e| e.to_string())
}

/// 创建对话
#[tauri::command]
pub fn create_ai_conversation(
    state: State<'_, AppState>,
    title: Option<String>,
    model_id: Option<i64>,
) -> Result<AiConversation, String> {
    let title = title.unwrap_or_else(|| "新对话".to_string());
    let model_id = match model_id {
        Some(id) => id,
        None => state
            .db
            .get_default_ai_model()
            .map_err(|e| e.to_string())?
            .id,
    };
    state
        .db
        .create_ai_conversation(&title, model_id)
        .map_err(|e| e.to_string())
}

/// 删除对话
#[tauri::command]
pub fn delete_ai_conversation(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state
        .db
        .delete_ai_conversation(id)
        .map_err(|e| e.to_string())
}

/// 重命名对话
#[tauri::command]
pub fn rename_ai_conversation(
    state: State<'_, AppState>,
    id: i64,
    title: String,
) -> Result<(), String> {
    state
        .db
        .rename_ai_conversation(id, &title)
        .map_err(|e| e.to_string())
}

/// 切换对话使用的 AI 模型
#[tauri::command]
pub fn update_ai_conversation_model(
    state: State<'_, AppState>,
    id: i64,
    model_id: i64,
) -> Result<(), String> {
    state
        .db
        .update_ai_conversation_model(id, model_id)
        .map_err(|e| e.to_string())
}

// ─── AI 消息 Commands ────────────────────────

/// 获取对话消息列表
#[tauri::command]
pub fn list_ai_messages(
    state: State<'_, AppState>,
    conversation_id: i64,
) -> Result<Vec<AiMessage>, String> {
    state
        .db
        .list_ai_messages(conversation_id)
        .map_err(|e| e.to_string())
}

/// 发送消息并流式获取 AI 回复
#[tauri::command]
pub async fn send_ai_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: i64,
    message: String,
    use_rag: Option<bool>,
) -> Result<(), String> {
    let use_rag = use_rag.unwrap_or(true);

    // 创建取消信号
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut cancel_map = state
            .ai_cancel
            .lock()
            .map_err(|e| e.to_string())?;
        cancel_map.insert(conversation_id, cancel_tx);
    }

    let db = &state.db;
    let result = AiService::chat_stream(
        app,
        db,
        conversation_id,
        &message,
        use_rag,
        cancel_rx,
    )
    .await;

    // 清理取消信号
    {
        let mut cancel_map = state
            .ai_cancel
            .lock()
            .map_err(|e| e.to_string())?;
        cancel_map.remove(&conversation_id);
    }

    result.map_err(|e| e.to_string())
}

/// 取消正在生成的 AI 回复
#[tauri::command]
pub fn cancel_ai_generation(
    state: State<'_, AppState>,
    conversation_id: i64,
) -> Result<(), String> {
    let cancel_map = state
        .ai_cancel
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(tx) = cancel_map.get(&conversation_id) {
        let _ = tx.send(true);
    }
    Ok(())
}

// ─── AI 写作辅助 Commands ────────────────────

/// AI 写作辅助（续写/总结/改写/翻译等）
/// action: continue / summarize / rewrite / translate_en / translate_zh / expand / shorten
#[tauri::command]
pub async fn ai_write_assist(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    action: String,
    selected_text: String,
    context: Option<String>,
) -> Result<(), String> {
    let (cancel_tx, cancel_rx) = watch::channel(false);

    // 用固定 key -1 作为写作辅助的取消信号
    {
        let mut cancel_map = state.ai_cancel.lock().map_err(|e| e.to_string())?;
        cancel_map.insert(-1, cancel_tx);
    }

    let db = &state.db;
    let result = AiService::write_assist(
        app,
        db,
        &action,
        &selected_text,
        &context.unwrap_or_default(),
        cancel_rx,
    )
    .await;

    {
        let mut cancel_map = state.ai_cancel.lock().map_err(|e| e.to_string())?;
        cancel_map.remove(&-1);
    }

    result.map_err(|e| e.to_string())
}

/// 取消写作辅助生成
#[tauri::command]
pub fn cancel_ai_write_assist(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cancel_map = state.ai_cancel.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = cancel_map.get(&-1) {
        let _ = tx.send(true);
    }
    Ok(())
}
