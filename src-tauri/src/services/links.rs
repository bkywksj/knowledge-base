use crate::database::Database;
use crate::error::AppError;
use crate::models::{GraphData, NoteLink, NoteLinkSummary, WikiLinkSuggestItem};

pub struct LinkService;

impl LinkService {
    pub fn sync_links(db: &Database, source_id: i64, target_ids: Vec<i64>) -> Result<(), AppError> {
        db.sync_note_links(source_id, target_ids)
    }

    pub fn get_backlinks(db: &Database, note_id: i64) -> Result<Vec<NoteLink>, AppError> {
        db.get_backlinks(note_id)
    }

    /// 当前笔记的链接全貌（出链 + 入链 + 断链），编辑器底部状态条用
    pub fn get_link_summary(db: &Database, note_id: i64) -> Result<NoteLinkSummary, AppError> {
        db.get_note_link_summary(note_id)
    }

    /// 从笔记正文重新解析 `[[wiki]]` 并同步出链。
    ///
    /// 相对前端那套「extractWikiLinks + findIdByTitle + syncLinks」，这条在 Rust 侧
    /// 一次完成，且与 `rebuild_note_links_from_content` 共用同一份判定（显式 ID 校验、
    /// 隐藏/删除过滤、防自引用），不会出现两处口径漂移。
    ///
    /// 日记页用它：日记同样支持 [[双链]]，但此前从没同步过出链 ——
    /// 写进日记的 [[X]] 不进 note_links，X 的反链里也看不到这篇日记。
    pub fn rebuild_links(db: &Database, note_id: i64, content: &str) -> Result<(), AppError> {
        db.rebuild_note_links_from_content(note_id, content)
    }

    pub fn find_note_id_by_title_loose(
        db: &Database,
        title: &str,
    ) -> Result<Option<i64>, AppError> {
        db.find_note_id_by_title_loose(title)
    }

    pub fn search_link_targets(
        db: &Database,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<WikiLinkSuggestItem>, AppError> {
        db.search_notes_by_title(keyword, limit)
    }

    pub fn get_graph_data(db: &Database) -> Result<GraphData, AppError> {
        db.get_graph_data()
    }
}
