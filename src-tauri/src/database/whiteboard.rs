//! 白板笔记 DAO。
//!
//! 白板不是独立的领域对象，而是 `notes` 表里 `note_type = 'whiteboard'` 的一行 ——
//! 这样文件夹 / 标签 / 回收站 / 同步 / 加密 / 双链 / 导出这些既有能力全部白拿，
//! 不必为白板再实现一遍。本文件只放"和普通笔记不一样"的那部分 SQL：
//!
//! - 建笔记时要把 `note_type` 一起写进去（普通 `create_note` 走默认值 markdown）
//! - 存画布时 `content`（Excalidraw JSON）和 `search_text`（画布里的纯文字）要一起更新，
//!   后者是 FTS 的实际索引源，见 schema v52。

use rusqlite::params;
use rusqlite::OptionalExtension;

use crate::error::AppError;
use crate::models::{note_type, Note, NoteInput};

use super::Database;

impl Database {
    /// 读白板的可搜索文字（画布上的文本，schema v52 的 `notes.search_text`）。
    ///
    /// 普通笔记这一列恒为 NULL，所以返回 Option 而不是空串 ——
    /// 调用方能区分"这是白板但画布没字"和"这压根不是白板"。
    pub fn get_note_search_text(&self, id: i64) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let v = conn
            .query_row(
                "SELECT search_text FROM notes WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(v)
    }

    /// 新建一块白板（`notes` 表里 `note_type='whiteboard'` 的一行）。
    ///
    /// 排序值沿用 `create_note` 的规则：排到所属 folder 末尾（MAX+1000），
    /// 避免和用户手动拖到第一位的笔记（sort_order=0）撞车。
    pub fn create_whiteboard(
        &self,
        input: &NoteInput,
        search_text: &str,
    ) -> Result<Note, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let normalized = crate::database::links::normalize_title(&input.title);
        let content_hash = crate::services::hash::sha256_hex(&input.content);
        let stable_uuid = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO notes
                (title, content, folder_id, title_normalized, content_hash, stable_uuid,
                 note_type, search_text, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                COALESCE(
                    (SELECT MAX(sort_order) FROM notes
                     WHERE COALESCE(folder_id, -1) = COALESCE(?3, -1) AND is_deleted = 0),
                    -1000
                ) + 1000)",
            params![
                input.title,
                input.content,
                input.folder_id,
                normalized,
                content_hash,
                stable_uuid,
                note_type::WHITEBOARD,
                search_text,
            ],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 同步 V1 pull 用：把本地笔记的类型对齐到远端 manifest 声明的类型。
    ///
    /// **不动 `updated_at`** —— 与 `sync_note_daily_state` / `sync_note_hidden_state` 一致：
    /// 这是元数据对齐，不算内容变更，冒泡时间戳会触发下一轮无谓的推拉。
    ///
    /// `search_text` 一并更新：拉下来的白板必须重建可搜索文本，否则本机搜不到画布里的字
    /// （FTS 索引的是 `COALESCE(search_text, content)`，见 schema v52）。
    /// 类型退回 markdown 时传 `None` 把它清空，让索引落回 content。
    pub fn set_note_type(
        &self,
        id: i64,
        note_type: &str,
        search_text: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET note_type = ?1, search_text = ?2 WHERE id = ?3",
            params![note_type, search_text, id],
        )?;
        Ok(())
    }

    /// 保存白板画布：同时写 `content`（Excalidraw JSON）与 `search_text`（画布里的文字）。
    ///
    /// 不动 title / folder_id —— 改标题走普通的 `update_note`，
    /// 这里只承接"画布内容变了"这一件事（前端是高频防抖保存，参数越少越不容易误伤元数据）。
    pub fn update_whiteboard_scene(
        &self,
        id: i64,
        scene_json: &str,
        search_text: &str,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let content_hash = crate::services::hash::sha256_hex(scene_json);
        let affected = conn.execute(
            "UPDATE notes SET content = ?1, search_text = ?2, content_hash = ?3,
                    updated_at = datetime('now', 'localtime')
             WHERE id = ?4 AND note_type = ?5",
            params![
                scene_json,
                search_text,
                content_hash,
                id,
                note_type::WHITEBOARD
            ],
        )?;

        if affected == 0 {
            // 分两种情况给出可诊断的错误：笔记不存在 vs 存在但不是白板
            // （后者多半是前端路由串了，直接吞掉会让画布静默存不进去）
            return Err(AppError::NotFound(format!(
                "白板 {} 不存在，或该笔记不是白板类型",
                id
            )));
        }
        Ok(())
    }
}
