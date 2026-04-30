use crate::models::{Note, NoteInput, NoteQuery, PageResult};
use crate::services::note::NoteService;
use crate::services::popout_window;
use crate::services::trash::TrashService;
use crate::state::AppState;

/// 创建笔记
#[tauri::command]
pub fn create_note(
    state: tauri::State<'_, AppState>,
    input: NoteInput,
) -> Result<Note, String> {
    NoteService::create(&state.db, &input).map_err(|e| e.to_string())
}

/// 更新笔记
#[tauri::command]
pub fn update_note(
    state: tauri::State<'_, AppState>,
    id: i64,
    input: NoteInput,
) -> Result<Note, String> {
    NoteService::update(&state.db, id, &input).map_err(|e| e.to_string())
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

// ─── T-014 网页剪藏 ────────────────────────────

/// 把网页 URL 剪藏成笔记（通过 r.jina.ai 转 markdown）
///
/// `folder_id` 由前端透传：右键菜单触发时是该文件夹 id；全局入口可传当前选中文件夹
/// 或 null（落根目录）。返回新建笔记，前端可立即跳转到编辑器。
#[tauri::command]
pub async fn clip_url_to_note(
    state: tauri::State<'_, AppState>,
    url: String,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    NoteService::clip_url(&state.db, &url, folder_id)
        .await
        .map_err(|e| e.to_string())
}

/// 把指定笔记弹到独立 OS 窗口（双显示器对照 / 主副屏分屏用）
///
/// 同 note_id 已存在 pop-out 窗口则直接前置，避免重复弹。
#[tauri::command]
pub fn open_note_in_new_window(app: tauri::AppHandle, note_id: i64) -> Result<(), String> {
    popout_window::open_note(&app, note_id).map_err(|e| e.to_string())
}
