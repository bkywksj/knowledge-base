//! Excel 二维数据集的数据访问层（P1-3b，schema v60）。
//!
//! 三张表：`datasets`（区域元信息）/ `dataset_fields`（列画像）/ `dataset_rows`（行数据 JSON）。
//! 表结构与设计理由见 `schema::migrate_v59_to_v60`。

use rusqlite::OptionalExtension;

use crate::error::AppError;
use crate::models::{Dataset, DatasetField, DatasetSchema};

use super::Database;

/// 写入一个数据集所需的全部内容（由 service 层从解析结果组装）
pub struct DatasetInput {
    pub source_path: String,
    pub sheet_name: String,
    pub region_index: i64,
    pub header_row: Option<i64>,
    pub source_hash: String,
    pub headers: Vec<String>,
    pub fields: Vec<DatasetField>,
    pub rows: Vec<Vec<String>>,
}

fn row_to_dataset(row: &rusqlite::Row) -> rusqlite::Result<Dataset> {
    Ok(Dataset {
        id: row.get(0)?,
        source_path: row.get(1)?,
        sheet_name: row.get(2)?,
        region_index: row.get(3)?,
        header_row: row.get(4)?,
        row_count: row.get(5)?,
        col_count: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const DATASET_COLS: &str =
    "id, source_path, sheet_name, region_index, header_row, row_count, col_count, created_at";

impl Database {
    /// 用一批数据集**整体替换**某个源文件已有的全部数据集。
    ///
    /// 为什么是"先删后建"而不是增量更新：源文件改一行都可能让区域边界、表头、
    /// 列类型全变，逐条 diff 的复杂度远高于重建，且极易留下不一致的残留。
    /// 数据集是**纯派生数据**（原文件才是事实源），重建成本可以接受。
    ///
    /// 全程一个事务：中途失败不会留下"删了旧的还没写新的"的空窗。
    pub fn replace_datasets_for_source(
        &self,
        source_path: &str,
        inputs: &[DatasetInput],
    ) -> Result<usize, AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;

        // 子表靠 ON DELETE CASCADE 跟着清（库里已开 PRAGMA foreign_keys=ON）
        tx.execute("DELETE FROM datasets WHERE source_path = ?1", [source_path])?;

        for input in inputs {
            tx.execute(
                "INSERT INTO datasets
                    (source_path, sheet_name, region_index, header_row,
                     row_count, col_count, source_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    input.source_path,
                    input.sheet_name,
                    input.region_index,
                    input.header_row,
                    input.rows.len() as i64,
                    input.headers.len() as i64,
                    input.source_hash,
                ],
            )?;
            let dataset_id = tx.last_insert_rowid();

            for f in &input.fields {
                tx.execute(
                    "INSERT INTO dataset_fields
                        (dataset_id, col_index, name, inferred_type,
                         semantic_role, completeness, distinct_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        dataset_id,
                        f.col_index,
                        f.name,
                        f.inferred_type,
                        f.semantic_role,
                        f.completeness,
                        f.distinct_count,
                    ],
                )?;
            }

            // 行存成 {"列名": "值"} 的 JSON 对象。
            // 不存"语义行文本"（对标项目那套 `行N｜列名=值` 再正则反解的做法，
            // 单元格里出现分隔符就串列）—— JSON 天然免疫。
            for (ri, row) in input.rows.iter().enumerate() {
                let obj: serde_json::Map<String, serde_json::Value> = input
                    .headers
                    .iter()
                    .enumerate()
                    .map(|(ci, name)| {
                        let v = row.get(ci).cloned().unwrap_or_default();
                        (name.clone(), serde_json::Value::String(v))
                    })
                    .collect();
                let json = serde_json::to_string(&obj)?;
                tx.execute(
                    "INSERT INTO dataset_rows (dataset_id, row_index, data_json)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![dataset_id, ri as i64, json],
                )?;
            }
        }

        tx.commit()?;
        Ok(inputs.len())
    }

    /// 列出某个源文件下的全部数据集
    pub fn list_datasets_by_source(&self, source_path: &str) -> Result<Vec<Dataset>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!(
            "SELECT {} FROM datasets WHERE source_path = ?1
             ORDER BY sheet_name, region_index",
            DATASET_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let items = stmt
            .query_map([source_path], row_to_dataset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    /// 取数据集详情（元信息 + 列画像）
    pub fn get_dataset_schema(&self, dataset_id: i64) -> Result<DatasetSchema, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = format!("SELECT {} FROM datasets WHERE id = ?1", DATASET_COLS);
        let dataset = conn
            .query_row(&sql, [dataset_id], row_to_dataset)
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("数据集 {} 不存在", dataset_id)))?;

        let mut stmt = conn.prepare(
            "SELECT col_index, name, inferred_type, semantic_role, completeness, distinct_count
             FROM dataset_fields WHERE dataset_id = ?1 ORDER BY col_index",
        )?;
        let fields = stmt
            .query_map([dataset_id], |row| {
                Ok(DatasetField {
                    col_index: row.get(0)?,
                    name: row.get(1)?,
                    inferred_type: row.get(2)?,
                    semantic_role: row.get(3)?,
                    completeness: row.get(4)?,
                    distinct_count: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(DatasetSchema { dataset, fields })
    }

    /// 分页预览数据行。
    ///
    /// 返回的是每行的 `{"列名": "值"}` JSON 字符串，由前端直接解析成表格 ——
    /// 不在 Rust 侧转成二维数组，免得列顺序在两侧各维护一份。
    pub fn preview_dataset_rows(
        &self,
        dataset_id: i64,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<String>, AppError> {
        // 上限兜住一次拉爆内存 / IPC 的情况（前端分页步长远小于此）
        let limit = limit.clamp(1, 500);
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT data_json FROM dataset_rows
             WHERE dataset_id = ?1 ORDER BY row_index LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![dataset_id, limit, offset.max(0)], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 该源文件已入库的哈希（用于判断是否需要重新解析）
    pub fn dataset_source_hash(&self, source_path: &str) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let hash = conn
            .query_row(
                "SELECT source_hash FROM datasets WHERE source_path = ?1 LIMIT 1",
                [source_path],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_ds_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        Database::init(dir.join("t.db").to_str().unwrap()).expect("init db")
    }

    fn sample(source: &str, region: i64) -> DatasetInput {
        DatasetInput {
            source_path: source.into(),
            sheet_name: "Sheet1".into(),
            region_index: region,
            header_row: Some(0),
            source_hash: "hash-v1".into(),
            headers: vec!["名称".into(), "金额".into()],
            fields: vec![
                DatasetField {
                    col_index: 0,
                    name: "名称".into(),
                    inferred_type: "text".into(),
                    semantic_role: None,
                    completeness: 1.0,
                    distinct_count: 2,
                },
                DatasetField {
                    col_index: 1,
                    name: "金额".into(),
                    inferred_type: "number".into(),
                    semantic_role: Some("measure".into()),
                    completeness: 1.0,
                    distinct_count: 2,
                },
            ],
            rows: vec![
                vec!["甲".into(), "100".into()],
                vec!["乙".into(), "200".into()],
            ],
        }
    }

    #[test]
    fn stores_and_reads_back_dataset() {
        let db = temp_db();
        let n = db
            .replace_datasets_for_source("a/b.xlsx", &[sample("a/b.xlsx", 0)])
            .unwrap();
        assert_eq!(n, 1);

        let list = db.list_datasets_by_source("a/b.xlsx").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].row_count, 2);
        assert_eq!(list[0].col_count, 2);

        let schema = db.get_dataset_schema(list[0].id).unwrap();
        assert_eq!(schema.fields.len(), 2);
        assert_eq!(schema.fields[1].inferred_type, "number");
        assert_eq!(schema.fields[1].semantic_role.as_deref(), Some("measure"));
    }

    /// 行存 JSON 对象，键是列名 —— 前端直接解析即可
    #[test]
    fn rows_are_stored_as_named_json() {
        let db = temp_db();
        db.replace_datasets_for_source("x.xlsx", &[sample("x.xlsx", 0)])
            .unwrap();
        let id = db.list_datasets_by_source("x.xlsx").unwrap()[0].id;

        let rows = db.preview_dataset_rows(id, 0, 10).unwrap();
        assert_eq!(rows.len(), 2);
        let first: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(first["名称"], "甲");
        assert_eq!(first["金额"], "100");
    }

    /// 单元格里含分隔符也不会串列 —— 这正是不用"语义行文本"的原因
    #[test]
    fn cells_with_separators_survive_roundtrip() {
        let db = temp_db();
        let mut input = sample("s.xlsx", 0);
        input.rows = vec![vec!["含｜竖线".into(), "含=等号,和逗号".into()]];
        db.replace_datasets_for_source("s.xlsx", &[input]).unwrap();
        let id = db.list_datasets_by_source("s.xlsx").unwrap()[0].id;
        let rows = db.preview_dataset_rows(id, 0, 10).unwrap();
        let v: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(v["名称"], "含｜竖线");
        assert_eq!(v["金额"], "含=等号,和逗号");
    }

    /// 重新导入 = 整体替换，不留旧数据
    #[test]
    fn replace_clears_previous_datasets() {
        let db = temp_db();
        db.replace_datasets_for_source("r.xlsx", &[sample("r.xlsx", 0), sample("r.xlsx", 1)])
            .unwrap();
        assert_eq!(db.list_datasets_by_source("r.xlsx").unwrap().len(), 2);

        // 第二次只写一个区域 → 旧的两条应被清掉
        db.replace_datasets_for_source("r.xlsx", &[sample("r.xlsx", 0)])
            .unwrap();
        let list = db.list_datasets_by_source("r.xlsx").unwrap();
        assert_eq!(list.len(), 1);

        // 子表也应跟着 CASCADE 清干净，不留孤儿行
        let conn = db.conn.lock().unwrap();
        let orphan_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dataset_rows
                 WHERE dataset_id NOT IN (SELECT id FROM datasets)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_rows, 0, "CASCADE 未清干净，留下了孤儿行");
        let orphan_fields: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dataset_fields
                 WHERE dataset_id NOT IN (SELECT id FROM datasets)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_fields, 0);
    }

    #[test]
    fn other_sources_are_not_affected() {
        let db = temp_db();
        db.replace_datasets_for_source("a.xlsx", &[sample("a.xlsx", 0)])
            .unwrap();
        db.replace_datasets_for_source("b.xlsx", &[sample("b.xlsx", 0)])
            .unwrap();
        db.replace_datasets_for_source("a.xlsx", &[]).unwrap();
        assert!(db.list_datasets_by_source("a.xlsx").unwrap().is_empty());
        assert_eq!(db.list_datasets_by_source("b.xlsx").unwrap().len(), 1);
    }

    #[test]
    fn source_hash_roundtrip() {
        let db = temp_db();
        assert_eq!(db.dataset_source_hash("h.xlsx").unwrap(), None);
        db.replace_datasets_for_source("h.xlsx", &[sample("h.xlsx", 0)])
            .unwrap();
        assert_eq!(
            db.dataset_source_hash("h.xlsx").unwrap().as_deref(),
            Some("hash-v1")
        );
    }

    #[test]
    fn preview_paginates_and_clamps_limit() {
        let db = temp_db();
        let mut input = sample("p.xlsx", 0);
        input.rows = (0..10)
            .map(|i| vec![format!("行{}", i), i.to_string()])
            .collect();
        db.replace_datasets_for_source("p.xlsx", &[input]).unwrap();
        let id = db.list_datasets_by_source("p.xlsx").unwrap()[0].id;

        let page = db.preview_dataset_rows(id, 3, 4).unwrap();
        assert_eq!(page.len(), 4);
        let v: serde_json::Value = serde_json::from_str(&page[0]).unwrap();
        assert_eq!(v["名称"], "行3");

        // limit 超上限应被夹住而不是照单全收
        assert!(db.preview_dataset_rows(id, 0, 99999).unwrap().len() <= 500);
        // 负 offset 当 0 处理，不该报错
        assert!(!db.preview_dataset_rows(id, -5, 2).unwrap().is_empty());
    }

    #[test]
    fn missing_dataset_reports_not_found() {
        let db = temp_db();
        assert!(db.get_dataset_schema(999).is_err());
    }
}
