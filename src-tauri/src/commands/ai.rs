use tauri::State;
use tokio::sync::watch;

use crate::models::{
    AiConversation, AiMessage, AiModel, AiModelInput, AiModelTestResult, DraftNoteRequest,
    DraftNoteResponse, Note, NoteInput, PlanFromExcelRequest, PlanFromGoalRequest,
    PlanFromGoalResponse, PlanTodayRequest, PlanTodayResponse,
};
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

/// 测试 AI 模型连通性。
///
/// 入参用 `AiModelInput` 而非 id：用户在「添加模型」Modal 还没保存时也能先点测试，
/// 避免必须先保存一次才能验证。
#[tauri::command]
pub async fn test_ai_model(input: AiModelInput) -> Result<AiModelTestResult, String> {
    AiService::test_model_connection(&input)
        .await
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

/// 批量清理对话：older_than_days = None 清空全部；= Some(N) 清理 N 天前。返回删除条数。
#[tauri::command]
pub fn delete_ai_conversations_before(
    state: State<'_, AppState>,
    older_than_days: Option<i64>,
) -> Result<usize, String> {
    state
        .db
        .delete_ai_conversations_before(older_than_days)
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

/// 设置对话挂载的笔记列表（A 方向：选 N 篇笔记 → 强制塞进对话上下文）
///
/// 注意：每次调用都是**全量覆盖**，前端需要把"完整的最新选中列表"传过来；
/// 撤销某篇只挂载就是重新发一次去掉它的列表。
#[tauri::command]
pub fn set_ai_conversation_attached_notes(
    state: State<'_, AppState>,
    conversation_id: i64,
    note_ids: Vec<i64>,
) -> Result<(), String> {
    state
        .db
        .set_conversation_attached_notes(conversation_id, &note_ids)
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
///
/// `use_skills=Some(true)` 时走 Skills 框架（T-004）：
/// - AI 可调 search_notes / get_note / list_tags / find_related / get_today_tasks
/// - 自动关闭 RAG（AI 自己调 search_notes 替代预拼 context）
/// - 仅 OpenAI 兼容协议族支持；Ollama 会返回错误
///
/// `use_skills` 省略或 false 时：走原 `chat_stream` 路径，`use_rag` 默认 true。
#[tauri::command]
pub async fn send_ai_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: i64,
    message: String,
    use_rag: Option<bool>,
    use_skills: Option<bool>,
) -> Result<(), String> {
    let use_skills = use_skills.unwrap_or(false);
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
    let result = if use_skills {
        AiService::chat_stream_with_skills(app, db, conversation_id, &message, cancel_rx).await
    } else {
        AiService::chat_stream(app, db, conversation_id, &message, use_rag, cancel_rx).await
    };

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

// ─── T-005 AI 规划今日待办 Commands ────────────

/// AI 规划今日待办
///
/// 聚合昨日/今日 daily 笔记 + 昨日未完成任务 + 今日已有任务 + 用户目标 → 喂 AI
/// → 返回 3~7 条建议（未写入）。前端展示后用户勾选/编辑才通过 `create_task` 落库。
///
/// 非流式：`response_format: json_object` 要完整响应；典型耗时 5~15 秒。
#[tauri::command]
pub async fn ai_plan_today(
    state: State<'_, AppState>,
    request: PlanTodayRequest,
) -> Result<PlanTodayResponse, String> {
    let db = &state.db;
    AiService::plan_today(db, request).await.map_err(|e| e.to_string())
}

/// 目标驱动 AI 智能规划：把一个长期目标拆成多条可执行待办 + 阶段里程碑
///
/// 与 `ai_plan_today` 区别：本方法不依赖历史笔记，按 `horizon_days` 跨度展开。
/// 返回的 `batchId` 必须由前端在批量落库时透传到每条任务的 `source_batch_id`，
/// 后续可用 `undo_task_batch(batch_id)` 一键撤销整批。
///
/// 非流式；典型耗时 10~30 秒（任务条数较多）。
#[tauri::command]
pub async fn ai_plan_from_goal(
    state: State<'_, AppState>,
    request: PlanFromGoalRequest,
) -> Result<PlanFromGoalResponse, String> {
    let db = &state.db;
    AiService::plan_from_goal(db, request)
        .await
        .map_err(|e| e.to_string())
}

/// 一键撤销某次 AI 智能规划生成的所有任务（按 source_batch_id 删除）
///
/// 返回删除的任务条数；批次不存在或已被删完时返回 0。task_links 由数据库
/// ON DELETE CASCADE 自动清理。
#[tauri::command]
pub fn undo_task_batch(state: State<'_, AppState>, batch_id: String) -> Result<usize, String> {
    state
        .db
        .delete_tasks_by_batch(&batch_id)
        .map_err(|e| e.to_string())
}

/// Excel 文件 → AI 智能规划
///
/// 用户通过 Tauri dialog 选一个 Excel/ODS 文件，传文件绝对路径过来；
/// 后端用 calamine 解析后喂给 AI，输出与 ai_plan_from_goal 相同的结构（含 batch_id）。
/// 大文件会自动截断并通过 response.warnings 返回友好提示。
#[tauri::command]
pub async fn ai_plan_from_excel(
    state: State<'_, AppState>,
    request: PlanFromExcelRequest,
) -> Result<PlanFromGoalResponse, String> {
    let db = &state.db;
    AiService::plan_from_excel(db, request)
        .await
        .map_err(|e| e.to_string())
}

// ─── T-006 AI 写笔记并归档 Commands ─────────

/// AI 生成笔记草稿 + 建议归档目录
///
/// 返回 `{title, content, folderPath, reason}`，未落库。前端在 Modal 里让
/// 用户编辑/确认后，通过现有 `folderApi` + `noteApi` 写入。
///
/// 非流式：典型耗时 5~20 秒（比 plan_today 更长，因为正文更长）。
#[tauri::command]
pub async fn ai_draft_note(
    state: State<'_, AppState>,
    request: DraftNoteRequest,
) -> Result<DraftNoteResponse, String> {
    let db = &state.db;
    AiService::draft_note(db, request)
        .await
        .map_err(|e| e.to_string())
}

/// 获取或创建笔记的"伴生 AI 对话"
///
/// 编辑器右侧抽屉用：每篇笔记有一条专属对话，懒创建（首次开抽屉才建）。
/// 如果对话还在 → 直接返回；如果对话被删了 / 没建过 → 新建并挂载本笔记。
///
/// 流程：
///   1. 读 notes.companion_conversation_id
///   2. 若有 → 验证对话还存在；存在直接返回，不存在置 None 走步骤 3
///   3. 没有 → 用默认模型建对话 + setAttachedNotes([note_id]) + 写回 notes 表
#[tauri::command]
pub fn get_or_create_companion_conversation(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<AiConversation, String> {
    let db = &state.db;

    // 1) 看现有的还在不在
    let existing = db
        .get_note_companion_conversation(note_id)
        .map_err(|e| e.to_string())?;
    if let Some(conv_id) = existing {
        if let Ok(conv) = db.get_ai_conversation(conv_id) {
            return Ok(conv);
        }
        // 对话被删了：解除关联，下面重建
        let _ = db.set_note_companion_conversation(note_id, None);
    }

    // 2) 没有就建一条新对话，标题取笔记当前标题
    let note = db
        .get_note(note_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("笔记 {} 不存在", note_id))?;
    let title = if note.title.trim().is_empty() {
        format!("笔记 #{}", note_id)
    } else {
        note.title.chars().take(40).collect::<String>()
    };
    let default_model = db
        .get_default_ai_model()
        .map_err(|e| e.to_string())?;
    let conv = db
        .create_ai_conversation(&title, default_model.id)
        .map_err(|e| e.to_string())?;
    // 自动把本笔记挂上去作为附加上下文
    db.set_conversation_attached_notes(conv.id, &[note_id])
        .map_err(|e| e.to_string())?;
    // 关联回笔记
    db.set_note_companion_conversation(note_id, Some(conv.id))
        .map_err(|e| e.to_string())?;

    // 重新拉一次拿带 attached_note_ids 的最新版本
    db.get_ai_conversation(conv.id).map_err(|e| e.to_string())
}

/// B 方向：把整个 AI 对话归档为一篇笔记
///
/// 对话内所有消息按用户/AI 顺序拼成 markdown，落库到 `notes` 表，
/// `from_ai_conversation_id` 字段记下来源以便日后双向追溯。
/// 标题：用户传 None 时取对话当前 title（"新对话"或自动总结的首问标题）。
#[tauri::command]
pub fn archive_ai_conversation_to_note(
    state: State<'_, AppState>,
    conversation_id: i64,
    title: Option<String>,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    let db = &state.db;
    let conv = db
        .get_ai_conversation(conversation_id)
        .map_err(|e| e.to_string())?;
    let messages = db
        .list_ai_messages(conversation_id)
        .map_err(|e| e.to_string())?;

    if messages.is_empty() {
        return Err("对话还没有任何消息，无法归档".to_string());
    }

    // 拼 markdown：> 元信息行 + 每轮 Q/A 块
    let mut md = String::new();
    md.push_str(&format!(
        "> 由 AI 对话归档于 {}\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    ));
    for msg in &messages {
        let label = match msg.role.as_str() {
            "user" => "## 我",
            "assistant" => "## AI",
            other => {
                // system / tool 消息归档成普通 markdown 引用块（很少见但兼容）
                md.push_str(&format!("> [{}]\n{}\n\n", other, msg.content));
                continue;
            }
        };
        md.push_str(label);
        md.push_str("\n\n");
        md.push_str(&msg.content);
        md.push_str("\n\n");
    }

    let final_title = title
        .map(|t| t.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(conv.title);

    // markdown 包成 <p>…</p> 简单 HTML 让 Tiptap 显示出来；编辑器开 Markdown 解析后会自动渲染
    let html = format!("<p>{}</p>", md.replace('\n', "<br/>"));

    let note = db
        .create_note(&NoteInput {
            title: final_title,
            content: html,
            folder_id,
        })
        .map_err(|e| e.to_string())?;
    db.set_note_from_ai_conversation(note.id, Some(conversation_id))
        .map_err(|e| e.to_string())?;

    // 重新拉一次拿带 from_ai_conversation_id 的完整 Note
    db.get_note(note.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "归档后查询笔记失败".to_string())
}
