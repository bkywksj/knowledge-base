use std::collections::HashMap;

use rusqlite::params;

use crate::error::AppError;

use super::Database;

/// 是否是本应用的内部资源地址（`path_to_asset_url` 的产物：Windows 走
/// `http://asset.localhost/`，其他平台 `asset://localhost/`）
fn is_internal_asset_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://asset.localhost/") || lower.starts_with("asset://")
}

impl Database {
    /// 批量写入 URL 映射对（幂等：(note_id, internal_url) 重复出现时跳过）
    ///
    /// 用于 `open_markdown_file` 把原始 URL → 内部 asset URL 的替换关系登记下来，
    /// 写回 .md 时按 internal_url 反查回 original_url，保证原文件链接形态不变。
    ///
    /// `pairs` 每项是 **`(原始 URL, 内部 URL)`** —— 与 `RewriteResult::mappings` 同序，
    /// 调用方直接把改写结果传进来即可。
    pub fn insert_url_mappings(
        &self,
        note_id: i64,
        pairs: &[(String, String)],
    ) -> Result<(), AppError> {
        if pairs.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO note_url_mapping (note_id, internal_url, original_url)
                 VALUES (?1, ?2, ?3)",
            )?;
            // 🔴 曾写成 `for (internal, original)`，和所有调用方的 (原始, 内部) 顺序相反：
            // 两列存反 → 写回时一条都对不上 → 图片全被当成"新插的图"拷进 <名>.assets/，
            // 用户原 .md 里的 https / 相对路径链接被改写（2026-11-18 修）
            for (original, internal) in pairs {
                stmt.execute(params![note_id, internal, original])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 列出某笔记的所有映射，返回 `internal_url → original_url` 的 HashMap，便于反查替换
    pub fn list_url_mappings(&self, note_id: i64) -> Result<HashMap<String, String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT internal_url, original_url FROM note_url_mapping WHERE note_id = ?1",
        )?;
        let rows = stmt.query_map([note_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (mut k, mut v) = row?;
            // 兼容修复前存反的老数据：internal 列不是内部地址、original 列反而是 → 对调。
            // 只在读取时纠正、不回写库：两种形态特征互斥，判断不会误伤，也免得为
            // 一次数据修正抬 schema 版本
            if !is_internal_asset_url(&k) && is_internal_asset_url(&v) {
                std::mem::swap(&mut k, &mut v);
            }
            map.insert(k, v);
        }
        Ok(map)
    }

    /// 清空某笔记的所有 URL 映射（重新打开 .md 时先清空再重建，避免历史脏数据）
    pub fn clear_url_mappings(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM note_url_mapping WHERE note_id = ?1", [note_id])?;
        Ok(())
    }

    /// 读取笔记上次写回原 .md 时的文件 mtime（秒级 unix timestamp）
    ///
    /// None = 从未写回过。冲突检测时用：当前 fs::metadata().modified() 与此值不一致就算冲突。
    pub fn get_writeback_mtime(&self, note_id: i64) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT last_writeback_mtime FROM notes WHERE id = ?1")?;
        let mt: Option<i64> = stmt
            .query_row([note_id], |row| row.get::<_, Option<i64>>(0))
            .unwrap_or(None);
        Ok(mt)
    }

    /// 写回成功后更新 mtime（传写回完成后 fs::metadata().modified() 的秒数）
    pub fn set_writeback_mtime(&self, note_id: i64, mtime: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET last_writeback_mtime = ?1 WHERE id = ?2",
            params![mtime, note_id],
        )?;
        Ok(())
    }

    /// 清空 mtime 基线（解除外部 .md 关联时用，避免脏数据残留导致下次再次关联误判冲突）
    pub fn clear_writeback_mtime(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET last_writeback_mtime = NULL WHERE id = ?1",
            [note_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteInput;

    fn test_db(tag: &str) -> (std::path::PathBuf, Database, i64) {
        let dir = std::env::temp_dir().join(format!(
            "kb_url_mapping_{}_{}_{}",
            tag,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::init(dir.join("test.db").to_str().unwrap()).expect("init test db");
        let note = db
            .create_note(&NoteInput {
                title: "t".into(),
                content: "c".into(),
                folder_id: None,
            })
            .unwrap();
        (dir, db, note.id)
    }

    const INTERNAL: &str = "http://asset.localhost/C%3A%2Fkb%2Fimages%2F1%2Fexternal.png";
    const ORIGINAL: &str = "https://pic.example.com/a.png";

    #[test]
    fn 按原始_内部顺序写入后可按内部地址反查() {
        let (dir, db, id) = test_db("order");
        db.insert_url_mappings(id, &[(ORIGINAL.to_string(), INTERNAL.to_string())])
            .unwrap();
        let map = db.list_url_mappings(id).unwrap();
        assert_eq!(map.get(INTERNAL).map(String::as_str), Some(ORIGINAL));
        // 先关库：Windows 下 test.db 被连接占着时删不掉目录，测试会在 %TEMP% 留垃圾
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 修复前存反的老数据_读取时自动纠正() {
        let (dir, db, id) = test_db("legacy");
        // 模拟修复前的落库形态：internal 列放了原始链接、original 列放了内部地址
        db.conn_lock()
            .unwrap()
            .execute(
                "INSERT INTO note_url_mapping (note_id, internal_url, original_url) VALUES (?1, ?2, ?3)",
                params![id, ORIGINAL, INTERNAL],
            )
            .unwrap();
        let map = db.list_url_mappings(id).unwrap();
        assert_eq!(map.get(INTERNAL).map(String::as_str), Some(ORIGINAL));
        assert!(!map.contains_key(ORIGINAL));
        // 先关库：Windows 下 test.db 被连接占着时删不掉目录，测试会在 %TEMP% 留垃圾
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
