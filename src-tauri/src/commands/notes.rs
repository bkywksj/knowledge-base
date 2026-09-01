use crate::models::{Note, NoteImageRef, NoteInput, NoteQuery, PageResult};
use crate::services::note::NoteService;
#[cfg(desktop)]
use crate::services::popout_window;
use crate::services::trash::TrashService;
use crate::state::AppState;
use tauri::{Emitter, Manager};

/// 创建笔记
#[tauri::command]
pub fn create_note(
    state: tauri::State<'_, AppState>,
    input: NoteInput,
) -> Result<Note, String> {
    NoteService::create(&state.db, &input).map_err(|e| e.to_string())
}

/// 更新笔记
///
/// 保存成功后广播 `note:updated` 全局事件，让其他打开同 id 的 webview 自动同步。
/// payload.sourceLabel 让发起方自己忽略事件（不要刷自己刚保存的内容）。
#[tauri::command]
pub fn update_note(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    id: i64,
    input: NoteInput,
) -> Result<Note, String> {
    let note = NoteService::update(&state.db, id, &input).map_err(|e| e.to_string())?;
    let _ = window.app_handle().emit(
        "note:updated",
        serde_json::json!({
            "id": id,
            "sourceLabel": window.label(),
        }),
    );
    Ok(note)
}

/// 删除笔记（软删除，移入回收站）
#[tauri::command]
pub fn delete_note(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TrashService::soft_delete(&state.db, id).map_err(|e| e.to_string())
}

/// 获取单个笔记
#[tauri::command]
pub fn get_note(state: tauri::State<'_, AppState>, id: i64) -> Result<Note, String> {
    NoteService::get(&state.db, id).map_err(|e| e.to_string())
}

/// 取一批笔记里的图片资源（AI 回答下方"溯源"挂缩略图用）。
///
/// 入参一般是 AI message references 里的笔记 id。只回带图的笔记；空结果合法。
#[tauri::command]
pub fn get_notes_images(
    state: tauri::State<'_, AppState>,
    note_ids: Vec<i64>,
) -> Result<Vec<NoteImageRef>, String> {
    NoteService::images_for_notes(&state.db, &note_ids).map_err(|e| e.to_string())
}

/// 切换笔记置顶状态
#[tauri::command]
pub fn toggle_pin(state: tauri::State<'_, AppState>, id: i64) -> Result<bool, String> {
    NoteService::toggle_pin(&state.db, id).map_err(|e| e.to_string())
}

/// 移动笔记到文件夹
#[tauri::command]
pub fn move_note_to_folder(
    state: tauri::State<'_, AppState>,
    note_id: i64,
    folder_id: Option<i64>,
) -> Result<(), String> {
    NoteService::move_to_folder(&state.db, note_id, folder_id).map_err(|e| e.to_string())
}

/// 批量重排同一 folder 内笔记的 sort_order
/// 调用方传同一 folder（或未分类组）内**全部**笔记按新顺序排列的 ID 列表
#[tauri::command]
pub fn reorder_notes(
    state: tauri::State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    NoteService::reorder(&state.db, &ordered_ids).map_err(|e| e.to_string())
}

/// 取当前筛选条件下「全部」笔记 id（不分页），按当前 sort_by 排序。
/// 拖拽排序专用：前端拿完整 id 列表后再 reorder，避免按页 reorder 导致跨页撞车。
#[tauri::command]
pub fn list_note_ids_for_reorder(
    state: tauri::State<'_, AppState>,
    query: NoteQuery,
) -> Result<Vec<i64>, String> {
    NoteService::list_ids_for_reorder(&state.db, &query).map_err(|e| e.to_string())
}

/// 批量移动笔记到文件夹；返回实际移动的条数
/// folder_id = None 表示移到根目录
#[tauri::command]
pub fn move_notes_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
    folder_id: Option<i64>,
) -> Result<usize, String> {
    NoteService::move_batch(&state.db, &ids, folder_id).map_err(|e| e.to_string())
}

/// 批量软删除（移入回收站）；返回实际删除的条数
#[tauri::command]
pub fn trash_notes_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    NoteService::trash_batch(&state.db, &ids).map_err(|e| e.to_string())
}

/// 批量给笔记追加标签（不清除原有）；返回新增的关联条数
#[tauri::command]
pub fn add_tags_to_notes_batch(
    state: tauri::State<'_, AppState>,
    note_ids: Vec<i64>,
    tag_ids: Vec<i64>,
) -> Result<usize, String> {
    NoteService::add_tags_batch(&state.db, &note_ids, &tag_ids).map_err(|e| e.to_string())
}

/// 全部移到回收站（软删）
#[tauri::command]
pub fn trash_all_notes(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    NoteService::trash_all(&state.db).map_err(|e| e.to_string())
}

/// 查询笔记列表（分页）
#[tauri::command]
pub fn list_notes(
    state: tauri::State<'_, AppState>,
    query: NoteQuery,
) -> Result<PageResult<Note>, String> {
    NoteService::list(&state.db, &query).map_err(|e| e.to_string())
}

// ─── T-003 隐藏笔记 Commands ────────────────────

/// 切换笔记"隐藏"状态；返回切换后的新状态
///
/// 隐藏后主列表 / 搜索 / 反链 / 图谱 / RAG 全部不显示；取消隐藏立刻恢复可见。
#[tauri::command]
pub fn set_note_hidden(
    state: tauri::State<'_, AppState>,
    id: i64,
    hidden: bool,
) -> Result<bool, String> {
    NoteService::set_hidden(&state.db, id, hidden).map_err(|e| e.to_string())
}

/// 列出所有隐藏笔记（分页 + 可选目录过滤）—— 用于 /hidden 专用页
#[tauri::command]
pub fn list_hidden_notes(
    state: tauri::State<'_, AppState>,
    page: Option<usize>,
    page_size: Option<usize>,
    folder_id: Option<i64>,
    uncategorized: Option<bool>,
) -> Result<PageResult<Note>, String> {
    NoteService::list_hidden(&state.db, page, page_size, folder_id, uncategorized)
        .map_err(|e| e.to_string())
}

/// 返回所有"含至少一篇隐藏笔记"的 folder_id；None=未分类
#[tauri::command]
pub fn list_hidden_folder_ids(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Option<i64>>, String> {
    NoteService::list_hidden_folder_ids(&state.db).map_err(|e| e.to_string())
}

/// 列出「临时编辑」笔记（分页）—— 用于侧栏「临时文件」面板
#[tauri::command]
pub fn list_scratch_notes(
    state: tauri::State<'_, AppState>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<PageResult<Note>, String> {
    NoteService::list_scratch(&state.db, page, page_size).map_err(|e| e.to_string())
}

/// 设置 / 取消笔记的「临时编辑」标记
///
/// `scratch=false` = 转为正式笔记：立刻回到主列表 / 搜索 / 双链。
#[tauri::command]
pub fn set_note_scratch(
    state: tauri::State<'_, AppState>,
    id: i64,
    scratch: bool,
) -> Result<(), String> {
    NoteService::set_scratch(&state.db, id, scratch).map_err(|e| e.to_string())
}

// ─── T-014 网页剪藏 ────────────────────────────

/// 把网页 URL 剪藏成笔记（直连原页 → readability 提正文 → markdown）
///
/// `folder_id` 由前端透传：右键菜单触发时是该文件夹 id；全局入口可传当前选中文件夹
/// 或 null（落根目录）。返回新建笔记，前端可立即跳转到编辑器。
#[tauri::command]
pub async fn clip_url_to_note(
    state: tauri::State<'_, AppState>,
    url: String,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    // ⚠️ 用 state.data_dir（DataDirResolver 解析过的实际数据目录），
    // 不能用 app.path().app_data_dir()——那是 OS 默认目录，不跟随用户改的数据目录
    let app_data_dir = state.data_dir.clone();
    NoteService::clip_url(&state.db, &url, folder_id, &app_data_dir)
        .await
        .map_err(|e| e.to_string())
}

/// 剪藏网页并返回可插入编辑器的 HTML（不建笔记）——编辑器工具栏「插入到当前笔记」用
///
/// `note_id` 是插入目标笔记，用于把正文图片落到该笔记的附件目录下。
#[tauri::command]
pub async fn clip_url_to_html(
    state: tauri::State<'_, AppState>,
    url: String,
    note_id: i64,
) -> Result<String, String> {
    let app_data_dir = state.data_dir.clone();
    NoteService::clip_url_to_html(&state.db, &url, note_id, &app_data_dir)
        .await
        .map_err(|e| e.to_string())
}

/// 把指定笔记弹到独立 OS 窗口（双显示器对照 / 主副屏分屏用）
///
/// 同 note_id 已存在 pop-out 窗口则直接前置，避免重复弹。
/// 仅桌面端：移动端无多窗口模型，不暴露此 command（lib.rs generate_handler 也已 cfg gate）
#[cfg(desktop)]
#[tauri::command]
pub async fn open_note_in_new_window(app: tauri::AppHandle, note_id: i64) -> Result<(), String> {
    popout_window::open_note(&app, note_id).map_err(|e| e.to_string())
}

/// 把指定笔记的思维导图弹到独立 OS 窗口（纯导图视图，不带编辑器）
///
/// 同 note_id 已存在 popout-mindmap 窗口则直接前置。仅桌面端。
#[cfg(desktop)]
#[tauri::command]
pub async fn open_mindmap_in_new_window(
    app: tauri::AppHandle,
    note_id: i64,
) -> Result<(), String> {
    popout_window::open_mindmap(&app, note_id).map_err(|e| e.to_string())
}
