use crate::database::Database;
use crate::error::AppError;
use crate::models::{GraphData, NoteLink};

pub struct LinkService;

impl LinkService {
    pub fn sync_links(
        db: &Database,
        source_id: i64,
        target_ids: Vec<i64>,
    ) -> Result<(), AppError> {
        db.sync_note_links(source_id, target_ids)
    }

    pub fn get_backlinks(db: &Database, note_id: i64) -> Result<Vec<NoteLink>, AppError> {
        db.get_backlinks(note_id)
    }

    pub fn search_link_targets(
        db: &Database,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String)>, AppError> {
        db.search_notes_by_title(keyword, limit)
    }

    pub fn get_graph_data(db: &Database) -> Result<GraphData, AppError> {
        db.get_graph_data()
    }
}
