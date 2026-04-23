//! AI 提示词模板 DAO
//!
//! 表结构见 `schema.rs` 中的 v18 -> v19 迁移。
//! 业务层约定：
//! - 列表按 `sort_order ASC, id ASC` 展示，内置在前（sort 10..70），用户自定义从 100 开始递增
//! - 删除内置模板不做 UI 入口，但 DAO 不拦截（留给未来"重置"脚本用）
//! - 更新时不动 `is_builtin` / `builtin_code`，确保内置标记不被用户改坏

use rusqlite::params;

use super::Database;
use crate::error::AppError;
use crate::models::{PromptTemplate, PromptTemplateInput};

/// 把 SQLite 行映射为 `PromptTemplate`，DAO 内复用
fn row_to_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptTemplate> {
    Ok(PromptTemplate {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        prompt: row.get(3)?,
        output_mode: row.get(4)?,
        icon: row.get(5)?,
        is_builtin: row.get::<_, i32>(6)? != 0,
        builtin_code: row.get(7)?,
        sort_order: row.get(8)?,
        enabled: row.get::<_, i32>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, title, description, prompt, output_mode, icon, is_builtin, \
     builtin_code, sort_order, enabled, created_at, updated_at";

impl Database {
    /// 列出所有提示词（按 sort_order 排序）
    ///
    /// `only_enabled=true` 时仅返回启用项，供编辑器 AI 菜单使用；
    /// 管理页需要看到禁用项用于重新启用，因此传 false。
    pub fn list_prompts(&self, only_enabled: bool) -> Result<Vec<PromptTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates {} ORDER BY sort_order ASC, id ASC",
            SELECT_COLUMNS,
            if only_enabled { "WHERE enabled = 1" } else { "" }
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_prompt)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 id 取单条
    pub fn get_prompt(&self, id: i64) -> Result<PromptTemplate, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates WHERE id = ?1",
            SELECT_COLUMNS
        );
        let prompt = conn.query_row(&sql, [id], row_to_prompt)?;
        Ok(prompt)
    }

    /// 按 builtin_code 取单条（没匹配返回 Ok(None)）
    ///
    /// 用途：兼容旧版本前端仍然传 "continue"/"summarize" 等字符串时，
    /// 后端能映射到 DB 里的内置模板。
    pub fn get_prompt_by_builtin_code(
        &self,
        code: &str,
    ) -> Result<Option<PromptTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates WHERE builtin_code = ?1",
            SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query_map([code], row_to_prompt)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// 新建用户自定义 Prompt（is_builtin=0、builtin_code=NULL）
    pub fn create_prompt(&self, input: &PromptTemplateInput) -> Result<PromptTemplate, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::Custom("标题不能为空".to_string()));
        }
        let prompt_body = input.prompt.trim();
        if prompt_body.is_empty() {
            return Err(AppError::Custom("Prompt 内容不能为空".to_string()));
        }
        let mode = input.output_mode.as_deref().unwrap_or("replace");
        validate_output_mode(mode)?;

        let conn = self.conn_lock()?;
        // sort_order 默认取 max + 10，放在最后
        let sort = match input.sort_order {
            Some(v) => v,
            None => {
                let max: i32 = conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), 0) FROM prompt_templates",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                max + 10
            }
        };
        let enabled_i = i32::from(input.enabled.unwrap_or(true));

        conn.execute(
            "INSERT INTO prompt_templates
                (title, description, prompt, output_mode, icon, is_builtin, builtin_code, sort_order, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7)",
            params![
                title,
                input.description.clone().unwrap_or_default(),
                prompt_body,
                mode,
                input.icon,
                sort,
                enabled_i,
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_prompt(id)
    }

    /// 更新 Prompt（内置模板可以改 title/description/prompt/output_mode/icon/sort/enabled，
    /// 不改 is_builtin/builtin_code）
    pub fn update_prompt(
        &self,
        id: i64,
        input: &PromptTemplateInput,
    ) -> Result<PromptTemplate, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::Custom("标题不能为空".to_string()));
        }
        let prompt_body = input.prompt.trim();
        if prompt_body.is_empty() {
            return Err(AppError::Custom("Prompt 内容不能为空".to_string()));
        }
        let mode = input.output_mode.as_deref().unwrap_or("replace");
        validate_output_mode(mode)?;

        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE prompt_templates
             SET title = ?1, description = ?2, prompt = ?3, output_mode = ?4,
                 icon = ?5, sort_order = COALESCE(?6, sort_order),
                 enabled = COALESCE(?7, enabled),
                 updated_at = datetime('now','localtime')
             WHERE id = ?8",
            params![
                title,
                input.description.clone().unwrap_or_default(),
                prompt_body,
                mode,
                input.icon,
                input.sort_order,
                input.enabled.map(i32::from),
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::Custom(format!("Prompt #{} 不存在", id)));
        }
        drop(conn);
        self.get_prompt(id)
    }

    /// 删除 Prompt
    ///
    /// 内置模板由 UI 层通过是否显示删除按钮控制；DAO 不设物理约束，
    /// 便于未来通过"重置内置模板"功能清空后重新插入。
    pub fn delete_prompt(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM prompt_templates WHERE id = ?1", [id])?;
        Ok(affected > 0)
    }

    /// 批量切换 enabled 状态（管理页"启用/禁用"开关复用）
    pub fn set_prompt_enabled(&self, id: i64, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE prompt_templates SET enabled = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![i32::from(enabled), id],
        )?;
        Ok(())
    }
}

/// 校验 output_mode 取值；非法值直接拒绝，避免脏数据写进 DB 后前端渲染异常
fn validate_output_mode(mode: &str) -> Result<(), AppError> {
    match mode {
        "replace" | "append" | "popup" => Ok(()),
        _ => Err(AppError::Custom(format!(
            "output_mode 非法：{}，只接受 replace/append/popup",
            mode
        ))),
    }
}
