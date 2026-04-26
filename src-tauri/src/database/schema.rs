use rusqlite::Connection;

use crate::error::AppError;

/// 当前 Schema 版本
pub const SCHEMA_VERSION: i32 = 26;

/// 获取数据库版本
pub fn get_version(conn: &Connection) -> Result<i32, AppError> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(version)
}

/// 设置数据库版本
pub fn set_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    conn.pragma_update(None, "user_version", version)?;
    Ok(())
}

/// 执行数据库迁移
pub fn migrate(conn: &Connection) -> Result<(), AppError> {
    let mut version = get_version(conn)?;

    if version > SCHEMA_VERSION {
        return Err(AppError::Custom(format!(
            "数据库版本({})高于应用支持的版本({}), 请升级应用",
            version, SCHEMA_VERSION
        )));
    }

    while version < SCHEMA_VERSION {
        match version {
            0 => migrate_v0_to_v1(conn)?,
            1 => migrate_v1_to_v2(conn)?,
            2 => migrate_v2_to_v3(conn)?,
            3 => migrate_v3_to_v4(conn)?,
            4 => migrate_v4_to_v5(conn)?,
            5 => migrate_v5_to_v6(conn)?,
            6 => migrate_v6_to_v7(conn)?,
            7 => migrate_v7_to_v8(conn)?,
            8 => migrate_v8_to_v9(conn)?,
            9 => migrate_v9_to_v10(conn)?,
            10 => migrate_v10_to_v11(conn)?,
            11 => migrate_v11_to_v12(conn)?,
            12 => migrate_v12_to_v13(conn)?,
            13 => migrate_v13_to_v14(conn)?,
            14 => migrate_v14_to_v15(conn)?,
            15 => migrate_v15_to_v16(conn)?,
            16 => migrate_v16_to_v17(conn)?,
            17 => migrate_v17_to_v18(conn)?,
            18 => migrate_v18_to_v19(conn)?,
            19 => migrate_v19_to_v20(conn)?,
            20 => migrate_v20_to_v21(conn)?,
            21 => migrate_v21_to_v22(conn)?,
            22 => migrate_v22_to_v23(conn)?,
            23 => migrate_v23_to_v24(conn)?,
            24 => migrate_v24_to_v25(conn)?,
            25 => migrate_v25_to_v26(conn)?,
            _ => {
                return Err(AppError::Custom(format!(
                    "未知的数据库版本: {}",
                    version
                )));
            }
        }
        version = get_version(conn)?;
    }

    log::info!("数据库迁移完成, 当前版本: {}", version);
    Ok(())
}

/// v0 -> v1: 初始化表结构
fn migrate_v0_to_v1(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v0 -> v1");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_config (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 插入默认配置
        INSERT OR IGNORE INTO app_config (key, value) VALUES ('theme', 'light');
        INSERT OR IGNORE INTO app_config (key, value) VALUES ('language', 'zh-CN');
        INSERT OR IGNORE INTO app_config (key, value) VALUES ('sidebar_collapsed', 'false');
        ",
    )?;

    set_version(conn, 1)?;
    Ok(())
}

/// v1 -> v2: 创建 folders 表和 notes 表
fn migrate_v1_to_v2(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v1 -> v2");

    conn.execute_batch(
        "
        -- 文件夹表（树形结构）
        CREATE TABLE IF NOT EXISTS folders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            parent_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 笔记表
        CREATE TABLE IF NOT EXISTS notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '',
            folder_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            is_daily    INTEGER NOT NULL DEFAULT 0,
            daily_date  TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_notes_folder  ON notes(folder_id);
        CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_daily   ON notes(is_daily, daily_date);
        ",
    )?;

    set_version(conn, 2)?;
    Ok(())
}

/// v2 -> v3: 添加标签、双向链接、FTS5 全文搜索、回收站等功能
fn migrate_v2_to_v3(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v2 -> v3");

    conn.execute_batch(
        "
        -- 给 notes 表添加新字段
        ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE notes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE notes ADD COLUMN deleted_at TEXT;
        ALTER TABLE notes ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;

        -- 标签表
        CREATE TABLE IF NOT EXISTS tags (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            color       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 笔记-标签关联表
        CREATE TABLE IF NOT EXISTS note_tags (
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (note_id, tag_id)
        );

        -- 双向链接表
        CREATE TABLE IF NOT EXISTS note_links (
            source_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            target_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            context     TEXT,
            PRIMARY KEY (source_id, target_id)
        );

        -- FTS5 全文搜索虚拟表
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, content, content=notes, content_rowid=id,
            tokenize='unicode61'
        );

        -- FTS5 同步触发器
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
        END;

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(is_deleted, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(is_pinned, updated_at DESC) WHERE is_deleted = 0;
        CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_id);

        -- 将已有笔记数据同步到 FTS5
        INSERT INTO notes_fts(rowid, title, content) SELECT id, title, content FROM notes;
        ",
    )?;

    set_version(conn, 3)?;
    Ok(())
}

/// v3 -> v4: AI 知识问答（模型配置、对话、消息）
fn migrate_v3_to_v4(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v3 -> v4");

    conn.execute_batch(
        "
        -- AI 模型配置表
        CREATE TABLE IF NOT EXISTS ai_models (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            provider    TEXT NOT NULL,
            api_url     TEXT NOT NULL,
            api_key     TEXT,
            model_id    TEXT NOT NULL,
            is_default  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- AI 对话表
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL DEFAULT '新对话',
            model_id    INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- AI 消息表
        CREATE TABLE IF NOT EXISTS ai_messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            references_json TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_ai_conv_updated ON ai_conversations(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_messages(conversation_id, created_at);

        -- 默认 Ollama 本地模型
        INSERT INTO ai_models (name, provider, api_url, api_key, model_id, is_default)
        VALUES ('Ollama Llama3', 'ollama', 'http://localhost:11434', NULL, 'llama3', 1);
        ",
    )?;

    set_version(conn, 4)?;
    Ok(())
}

/// v4 -> v5: 性能优化索引 + 字数统计触发器
fn migrate_v4_to_v5(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v4 -> v5");

    conn.execute_batch(
        "
        -- 笔记标题索引（加速搜索）
        CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title) WHERE is_deleted = 0;

        -- 笔记创建时间索引
        CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC) WHERE is_deleted = 0;

        -- 字数统计触发器：插入时自动计算
        CREATE TRIGGER IF NOT EXISTS notes_word_count_insert AFTER INSERT ON notes BEGIN
            UPDATE notes SET word_count = LENGTH(REPLACE(new.content, ' ', ''))
            WHERE id = new.id;
        END;

        -- 字数统计触发器：更新时自动计算
        CREATE TRIGGER IF NOT EXISTS notes_word_count_update AFTER UPDATE OF content ON notes BEGIN
            UPDATE notes SET word_count = LENGTH(REPLACE(new.content, ' ', ''))
            WHERE id = new.id;
        END;

        -- 优化现有数据字数
        UPDATE notes SET word_count = LENGTH(REPLACE(content, ' ', ''))
        WHERE word_count = 0 AND LENGTH(content) > 0;

        -- ANALYZE 更新统计信息
        ANALYZE;
        ",
    )?;

    set_version(conn, 5)?;
    Ok(())
}

/// v5 -> v6: 修复 FTS5 触发器级联导致的索引损坏
///
/// 问题根因：notes_fts_update 监听 AFTER UPDATE ON notes（全列），
/// 当 word_count 触发器更新 word_count 列时，也会触发 FTS 更新，
/// 导致 FTS 索引被反复 DELETE+INSERT，最终损坏 → "database disk image is malformed"
///
/// 修复：将 FTS 更新触发器限定为 AFTER UPDATE OF title, content
fn migrate_v5_to_v6(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v5 -> v6 (修复 FTS 触发器级联)");

    conn.execute_batch(
        "
        -- 1. 删除有问题的 FTS 更新触发器（监听全列）
        DROP TRIGGER IF EXISTS notes_fts_update;

        -- 2. 重建：只在 title 或 content 变更时触发
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE OF title, content ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;

        -- 3. 重建 FTS 索引，清除可能已损坏的数据
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
        ",
    )?;

    set_version(conn, 6)?;
    Ok(())
}

/// v6 -> v7: 笔记模板表
fn migrate_v6_to_v7(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v6 -> v7 (笔记模板)");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS note_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        -- 预置常用模板
        INSERT INTO note_templates (name, description, content) VALUES
        ('会议记录', '记录会议要点、决策和待办事项', '<h2>会议信息</h2><p><strong>日期：</strong></p><p><strong>参与人：</strong></p><p><strong>主题：</strong></p><h2>议题与讨论</h2><ol><li><p></p></li></ol><h2>决策事项</h2><ul><li><p></p></li></ul><h2>待办事项</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p></p></div></li></ul>'),
        ('读书笔记', '记录书籍要点、摘抄和感想', '<h2>书籍信息</h2><p><strong>书名：</strong></p><p><strong>作者：</strong></p><p><strong>阅读日期：</strong></p><h2>核心观点</h2><ol><li><p></p></li></ol><h2>精彩摘录</h2><blockquote><p></p></blockquote><h2>我的思考</h2><p></p>'),
        ('周报', '总结本周工作和下周计划', '<h2>本周完成</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\"><span></span></label><div><p></p></div></li></ul><h2>进行中</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p></p></div></li></ul><h2>下周计划</h2><ol><li><p></p></li></ol><h2>问题与风险</h2><p></p>'),
        ('项目文档', '记录项目背景、方案和进展', '<h2>项目概述</h2><p></p><h2>背景与目标</h2><p></p><h2>技术方案</h2><p></p><h2>里程碑</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p></p></div></li></ul><h2>参考资料</h2><ul><li><p></p></li></ul>');
        ",
    )?;

    set_version(conn, 7)?;
    Ok(())
}

/// v7 -> v8: notes 表加 pdf_path 字段，用于关联导入的 PDF 原文件
fn migrate_v7_to_v8(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v7 -> v8 (notes.pdf_path)");

    conn.execute_batch(
        "
        -- 存相对路径 pdfs/<note_id>.pdf，拼 app_data_dir 得到绝对路径
        ALTER TABLE notes ADD COLUMN pdf_path TEXT;
        ",
    )?;

    set_version(conn, 8)?;
    Ok(())
}

/// 列出表的所有列名（用 PRAGMA table_info）
fn list_columns(conn: &Connection, table: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// v8 -> v9: 把 pdf_path 升级为通用源文件路径
///
/// - 新增 source_file_type 列，区分 pdf/docx/doc 等
/// - pdf_path 列重命名为 source_file_path（SQLite 3.25+ 支持 RENAME COLUMN）
/// - 旧 pdf_path 不为空的行回填 source_file_type='pdf'
fn migrate_v8_to_v9(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v8 -> v9 (pdf_path → source_file_path + source_file_type)");

    conn.execute_batch(
        "
        ALTER TABLE notes ADD COLUMN source_file_type TEXT;
        ALTER TABLE notes RENAME COLUMN pdf_path TO source_file_path;
        UPDATE notes SET source_file_type = 'pdf' WHERE source_file_path IS NOT NULL;
        ",
    )?;

    set_version(conn, 9)?;
    Ok(())
}

/// v9 -> v10: 自愈迁移
///
/// 修复 v9 在某些环境下未完整执行的问题（user_version 已推到 9 但列没补齐）。
/// 通过 PRAGMA table_info 探测当前列状态，缺啥补啥，幂等可重跑。
///
/// 目标终态：notes 表必有 source_file_path 与 source_file_type 两列。
fn migrate_v9_to_v10(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v9 -> v10 (自愈 source_file_path / source_file_type)");

    let cols = list_columns(conn, "notes")?;
    let has_path = cols.iter().any(|c| c == "source_file_path");
    let has_type = cols.iter().any(|c| c == "source_file_type");
    let has_pdf = cols.iter().any(|c| c == "pdf_path");

    // 处理 source_file_path
    if !has_path {
        if has_pdf {
            log::info!("[v10 自愈] RENAME COLUMN pdf_path -> source_file_path");
            conn.execute_batch("ALTER TABLE notes RENAME COLUMN pdf_path TO source_file_path;")?;
        } else {
            log::info!("[v10 自愈] ADD COLUMN source_file_path");
            conn.execute_batch("ALTER TABLE notes ADD COLUMN source_file_path TEXT;")?;
        }
    } else if has_pdf {
        // 极端情况：两列都存在，把 pdf_path 残留数据合并过去
        log::info!("[v10 自愈] 合并残留 pdf_path 数据到 source_file_path");
        conn.execute_batch(
            "UPDATE notes SET source_file_path = pdf_path
             WHERE source_file_path IS NULL AND pdf_path IS NOT NULL;",
        )?;
        // 不 DROP COLUMN pdf_path，避免触发 FTS 触发器引用问题；不影响功能
    }

    // 处理 source_file_type
    if !has_type {
        log::info!("[v10 自愈] ADD COLUMN source_file_type");
        conn.execute_batch("ALTER TABLE notes ADD COLUMN source_file_type TEXT;")?;
    }

    // 回填类型（只填还没值的行）
    conn.execute_batch(
        "UPDATE notes SET source_file_type = 'pdf'
         WHERE source_file_path IS NOT NULL AND source_file_type IS NULL;",
    )?;

    set_version(conn, 10)?;
    Ok(())
}

/// v10 -> v11: 新增同步历史表（sync_history）
fn migrate_v10_to_v11(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v10 -> v11（同步历史表）");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sync_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            direction    TEXT NOT NULL,      -- 'export' / 'import' / 'push' / 'pull'
            started_at   TEXT NOT NULL,
            finished_at  TEXT,
            success      INTEGER NOT NULL DEFAULT 0,
            error        TEXT,
            stats_json   TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_sync_history_started ON sync_history(started_at DESC);
        ",
    )?;

    set_version(conn, 11)?;
    Ok(())
}

/// v11 -> v12: 新增待办任务表 + 任务关联表
fn migrate_v11_to_v12(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v11 -> v12（待办任务）");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tasks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            description  TEXT,
            priority     INTEGER NOT NULL DEFAULT 1,  -- 0=urgent / 1=normal / 2=low
            important    INTEGER NOT NULL DEFAULT 0,  -- 0/1 艾森豪威尔重要性维度
            status       INTEGER NOT NULL DEFAULT 0,  -- 0=todo / 1=done
            due_date     TEXT,                        -- 'YYYY-MM-DD'，NULL 表示无截止
            completed_at TEXT,                        -- 完成时间（ISO）
            created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_tasks_priority  ON tasks(priority);

        -- 任务关联（多态）：一个任务可以挂多个笔记 / 路径 / URL
        CREATE TABLE IF NOT EXISTS task_links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            kind       TEXT NOT NULL,          -- 'note' / 'path' / 'url'
            target     TEXT NOT NULL,          -- note_id 字符串 / 绝对路径 / URL
            label      TEXT,                   -- 展示文案（如笔记标题）
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_task_links_task ON task_links(task_id);
        ",
    )?;

    set_version(conn, 12)?;
    Ok(())
}

/// v12 -> v13: 为 HTML → Markdown 迁移做准备
///
/// 思路：笔记存储最终要切到 Markdown，但现存 content 全是 HTML。
/// 本次迁移只做**一次性备份**，不动任何代码逻辑：
///   1. notes 表新增 content_html 字段（幂等）
///   2. 把现有 content（HTML）整段拷贝到 content_html 做兜底
///
/// 后续阶段：
///   · 阶段 2：接入 tiptap-markdown，编辑器切 MD I/O
///   · 阶段 3：批量把 content_html → Markdown 写回 content
///   · 阶段 4：清理 strip_html 等遗留逻辑
///
/// 即便后续翻车，content_html 始终保留原始 HTML，可以随时回滚。
fn migrate_v12_to_v13(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v12 -> v13 (notes 新增 content_html 备份字段)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "content_html") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN content_html TEXT;")?;
    }

    // 幂等回填：仅对尚未备份的行执行
    conn.execute_batch(
        "UPDATE notes
            SET content_html = content
          WHERE content_html IS NULL AND content IS NOT NULL;",
    )?;

    set_version(conn, 13)?;
    Ok(())
}

/// v13 -> v14: 批量把 notes.content 从 HTML 转成 Markdown
///
/// 配合前端 Tiptap 切换到 Markdown I/O 模式，数据库内容格式也从 HTML 切到 MD。
/// 依赖 v13 已经把原 HTML 备份到 content_html，本步骤可随时回滚。
///
/// 回滚 SQL（仅开发者手动执行）：
///   UPDATE notes SET content = content_html WHERE content_html IS NOT NULL;
fn migrate_v13_to_v14(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v13 -> v14 (notes.content HTML → Markdown)");

    // 1) 取出所有待转换的笔记（content 非空且未被清空的）
    let mut stmt = conn.prepare(
        "SELECT id, content FROM notes WHERE content IS NOT NULL AND content != ''",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v14] 准备转换 {} 条笔记", rows.len());

    // 2) 一次事务内批量更新
    let tx = conn.unchecked_transaction()?;
    for (id, html) in &rows {
        let md = crate::services::markdown::html_to_markdown(html);
        tx.execute(
            "UPDATE notes SET content = ?1 WHERE id = ?2",
            rusqlite::params![md, id],
        )?;
    }
    tx.commit()?;

    log::info!("[v14] 转换完成");
    set_version(conn, 14)?;
    Ok(())
}

/// v14 -> v15: 待办任务增加定时提醒字段
///
/// due_date 字段保留原名，但字符串格式从仅 'YYYY-MM-DD' 扩展为可选带时分
/// ('YYYY-MM-DD HH:MM:SS')。旧数据不迁移，继续视作全天截止。
///
/// 新增两列：
///   · remind_before_minutes：提前 N 分钟提醒，NULL = 不提醒
///   · reminded_at：上次触发提醒的时刻（ISO），用于去重
fn migrate_v14_to_v15(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v14 -> v15 (tasks 定时提醒字段)");

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "remind_before_minutes") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN remind_before_minutes INTEGER;",
        )?;
    }
    if !cols.iter().any(|c| c == "reminded_at") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN reminded_at TEXT;")?;
    }

    set_version(conn, 15)?;
    Ok(())
}

/// v15 -> v16: 补 note_links.source_id 索引
///
/// 原先只建了 idx_note_links_target（反向链接查询走这条），
/// 但保存笔记时 `DELETE FROM note_links WHERE source_id = ?1` 没有 source_id 单列索引可用。
/// 笔记数量大时该 DELETE 会退化为全表扫描，导致保存明显变慢。
fn migrate_v15_to_v16(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v15 -> v16 (补 note_links.source_id 索引)");

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_id);",
    )?;

    set_version(conn, 16)?;
    Ok(())
}

/// v16 -> v17: notes 新增 title_normalized 列 + 索引，解除 wiki 链接匹配的全表扫
///
/// 背景：`find_note_id_by_title_loose` 是 [[wiki-link]] 编辑器自动补全、保存时链接同步
/// 的热路径。老实现 `SELECT id, title FROM notes WHERE is_deleted = 0` 全表拉回来，
/// 再在 Rust 侧对每行 title 做 `normalize_title`（去转义 + 空白折叠 + lowercase）再比较。
/// 10k 笔记时每次调用要几十毫秒，打字时卡顿肉眼可见。
///
/// 本迁移：
/// 1) ALTER TABLE 新增 title_normalized 列（幂等）
/// 2) 用 Rust 侧 `normalize_title` 批量回填（保证和运行时比较使用同一套规则）
/// 3) 建部分索引 `idx_notes_title_normalized WHERE is_deleted = 0`
///
/// 之后 `find_note_id_by_title_loose` 直接 `WHERE title_normalized = ?`，走 O(log n) 索引。
///
/// **DAO 协议**：`create_note` / `update_note` / `get_or_create_daily` 写入时必须同步
/// 维护 `title_normalized`。老数据一次性回填后不再需要运行时 fallback。
fn migrate_v16_to_v17(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v16 -> v17 (notes.title_normalized + 索引)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "title_normalized") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN title_normalized TEXT;")?;
    }

    // 回填：仅对 title_normalized IS NULL 的行（幂等可重跑）
    let mut stmt = conn.prepare(
        "SELECT id, title FROM notes WHERE title_normalized IS NULL",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v17] 准备回填 {} 条笔记的 title_normalized", rows.len());

    let tx = conn.unchecked_transaction()?;
    for (id, title) in &rows {
        let norm = crate::database::links::normalize_title(title);
        tx.execute(
            "UPDATE notes SET title_normalized = ?1 WHERE id = ?2",
            rusqlite::params![norm, id],
        )?;
    }
    tx.commit()?;

    // 部分索引：只对活跃笔记建索引，更紧凑
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notes_title_normalized
         ON notes(title_normalized) WHERE is_deleted = 0;",
    )?;

    set_version(conn, 17)?;
    Ok(())
}

/// v17 -> v18: tasks 新增循环提醒字段
///
/// 原 v15 给任务加了"提前 N 分钟提醒 + reminded_at 去重"，只能提醒一次。
/// 本迁移补上循环规则，让待办可按"每天/每周某几天/每月/每 N 天"反复提醒。
///
/// 新增列：
///   · repeat_kind        'none'/'daily'/'weekly'/'monthly'，默认 'none'
///   · repeat_interval    每 N 个单位（默认 1）
///   · repeat_weekdays    '1,2,3,4,5'（1=Mon..7=Sun），仅 weekly 有效；NULL 表示按 interval 周
///   · repeat_until       'YYYY-MM-DD'，循环终止日期；NULL 表示无上限
///   · repeat_count       总触发次数上限（含首次）；NULL 表示无上限
///   · repeat_done_count  已触发次数，默认 0
fn migrate_v17_to_v18(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v17 -> v18 (tasks 循环提醒字段)");

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "repeat_kind") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN repeat_kind TEXT NOT NULL DEFAULT 'none';",
        )?;
    }
    if !cols.iter().any(|c| c == "repeat_interval") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN repeat_interval INTEGER NOT NULL DEFAULT 1;",
        )?;
    }
    if !cols.iter().any(|c| c == "repeat_weekdays") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN repeat_weekdays TEXT;")?;
    }
    if !cols.iter().any(|c| c == "repeat_until") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN repeat_until TEXT;")?;
    }
    if !cols.iter().any(|c| c == "repeat_count") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN repeat_count INTEGER;")?;
    }
    if !cols.iter().any(|c| c == "repeat_done_count") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN repeat_done_count INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    set_version(conn, 18)?;
    Ok(())
}

/// v18 -> v19: AI 提示词库（prompt_templates）+ 7 条内置模板
///
/// 背景：编辑器 AI 菜单原本硬编码了 7 个 action（续写/总结/改写/扩展/精简/译英/译中），
/// 用户没法加自己的 Prompt，也没法改内置文案。本迁移把模板迁移到 DB：
///   · is_builtin=1 + builtin_code=xxx 的行是内置，首次安装写入；
///   · 用户自定义模板 is_builtin=0；
///   · 菜单改为读 DB 列表，点击时走 `ai_write_assist` 的 `prompt:{id}` 分支。
///
/// 字段说明：
///   · output_mode: 'replace'（替换选区，默认） / 'append'（追加到选区末尾，续写场景） / 'popup'（仅展示，如总结）
///   · builtin_code: 和旧硬编码 action 保持一致，万一前端旧版本传入也能映射到 DB
///   · sort_order: 越小越靠前，内置占 10/20/30… 让用户插队有空间
fn migrate_v18_to_v19(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v18 -> v19 (prompt_templates + 内置模板)");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            title         TEXT NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            prompt        TEXT NOT NULL,
            output_mode   TEXT NOT NULL DEFAULT 'replace',
            icon          TEXT,
            is_builtin    INTEGER NOT NULL DEFAULT 0,
            builtin_code  TEXT UNIQUE,
            sort_order    INTEGER NOT NULL DEFAULT 0,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_templates_sort
            ON prompt_templates(sort_order, id);
        ",
    )?;

    // 内置模板（首次插入，INSERT OR IGNORE 保证再跑不覆盖用户修改）
    //
    // 所有 prompt 用 {{selection}} / {{context}} / {{title}} 三个占位符，
    // services/prompt.rs 的 render 函数会在调用 AI 前做字符串替换。
    //
    // 短模板为主，长指令保留给用户自行 fork，避免内置"太啰嗦"。
    let builtins: &[(&str, &str, &str, &str, &str, i32)] = &[
        ("续写", "根据上下文自然地续写", "你是一个写作助手。请根据下面的上下文和已有内容，自然地续写下去。只输出续写的新内容，不要重复已有内容。使用中文。\n\n【上下文】\n{{context}}\n\n【已有内容】\n{{selection}}",
         "append", "ArrowRight", 10),
        ("总结", "提炼关键信息", "你是一个写作助手。请对以下文本进行简洁的总结概括，突出关键信息和核心观点。使用中文。\n\n【原文】\n{{selection}}",
         "popup", "FileText", 20),
        ("改写", "优化表达让文本更流畅", "你是一个写作助手。请改写以下文本，使其表达更加流畅、专业。保持原意不变。只输出改写后的内容，不要解释。使用中文。\n\n【原文】\n{{selection}}",
         "replace", "RefreshCw", 30),
        ("扩展", "补充细节和论述", "你是一个写作助手。请对以下文本进行扩展，补充更多细节、论据或例子。保持原有观点不变。使用中文。\n\n【原文】\n{{selection}}",
         "replace", "Expand", 40),
        ("精简", "去掉冗余保留核心", "你是一个写作助手。请精简以下文本，保留核心信息，去除冗余表达。只输出精简后的内容。使用中文。\n\n【原文】\n{{selection}}",
         "replace", "Shrink", 50),
        ("译英", "翻译成地道英文", "你是一个翻译助手。请将以下文本翻译成地道的英文。只输出翻译结果，不要解释。\n\n【原文】\n{{selection}}",
         "replace", "Languages", 60),
        ("译中", "翻译成准确中文", "你是一个翻译助手。请将以下文本翻译成准确、通顺的中文。只输出翻译结果，不要解释。\n\n【原文】\n{{selection}}",
         "replace", "Languages", 70),
    ];

    // builtin_code 对应旧硬编码 action
    let codes = [
        "continue",
        "summarize",
        "rewrite",
        "expand",
        "shorten",
        "translate_en",
        "translate_zh",
    ];

    for (i, (title, desc, prompt, mode, icon, sort)) in builtins.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO prompt_templates
                (title, description, prompt, output_mode, icon, is_builtin, builtin_code, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
            rusqlite::params![title, desc, prompt, mode, icon, codes[i], sort],
        )?;
    }

    set_version(conn, 19)?;
    Ok(())
}

/// v19 -> v20: ai_messages 加 skill_calls_json 字段
///
/// 用途：T-004 Skills 框架下，assistant 消息里可能发生一次或多次 tool_call
/// （`search_notes` / `get_note` 等）。把每次调用（name + args + result + status）
/// 序列化成 JSON 数组存到这一列，便于：
///   1. 重开对话时重绘 SkillCall 折叠卡片
///   2. 诊断问题（AI 为啥调了这个工具、返回啥）
///
/// 为什么新增独立列而不是塞进 references_json：
///   - references_json 是纯 note id 数组（给 UI 标"引用的笔记"用）
///   - skill_calls_json 结构复杂（包含 args/result/status），语义完全不同
fn migrate_v19_to_v20(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v19 -> v20 (ai_messages.skill_calls_json)");

    let cols = list_columns(conn, "ai_messages")?;
    if !cols.iter().any(|c| c == "skill_calls_json") {
        conn.execute_batch("ALTER TABLE ai_messages ADD COLUMN skill_calls_json TEXT;")?;
    }

    set_version(conn, 20)?;
    Ok(())
}

/// v20 -> v21: notes 新增 is_hidden 字段（T-003 笔记"隐藏"标记）
///
/// 语义是"弱隐藏"：默认视图（笔记列表 / 搜索 / 反链 / 图谱 / RAG）完全看不见；
/// 但 wiki link [[...]] 点击跳转仍允许打开，保证链接不失效。
///
/// 这不是加密——数据库文件打开还是能看到内容。加密放 T-007。
///
/// 部分索引只建在"活跃笔记"上（is_deleted=0），避免回收站的 hidden 条目
/// 干扰热路径查询。
fn migrate_v20_to_v21(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v20 -> v21 (notes.is_hidden)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "is_hidden") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;")?;
    }

    // is_hidden 出现在 WHERE 条件里很频繁（所有主路径查询都加 is_hidden=0），
    // 建部分索引帮助过滤；索引只覆盖"活跃"笔记，和现有 idx_notes_pinned 的思路一致
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notes_hidden
         ON notes(is_hidden, updated_at DESC) WHERE is_deleted = 0;",
    )?;

    set_version(conn, 21)?;
    Ok(())
}

/// v21 -> v22: notes 新增 content_hash 字段 + 索引 + 存量回填
///
/// 背景：导入 Markdown 文件夹时，原实现不做去重，同一批文件反复导入会产生重复笔记。
/// 本迁移把"内容指纹"持久化到 notes.content_hash（SHA-256 十六进制串），
/// 后续扫描外部 md 时按 (title, content_hash) 做兜底匹配（source_file_path 为主判）。
///
/// DAO 协议：`create_note` / `update_note` / `update_note_content` / `get_or_create_daily`
/// 写入正文时必须同步维护 content_hash。存量笔记由本迁移一次性回填。
///
/// 部分索引只覆盖活跃笔记（is_deleted=0），和 idx_notes_pinned / idx_notes_hidden 的思路一致。
fn migrate_v21_to_v22(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v21 -> v22 (notes.content_hash)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "content_hash") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN content_hash TEXT;")?;
    }

    // 回填：仅对 content_hash IS NULL 的行（幂等可重跑）
    let mut stmt = conn
        .prepare("SELECT id, content FROM notes WHERE content_hash IS NULL")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v22] 准备回填 {} 条笔记的 content_hash", rows.len());

    let tx = conn.unchecked_transaction()?;
    for (id, content) in &rows {
        let hash = crate::services::hash::sha256_hex(content);
        tx.execute(
            "UPDATE notes SET content_hash = ?1 WHERE id = ?2",
            rusqlite::params![hash, id],
        )?;
    }
    tx.commit()?;

    // 部分索引：只对活跃笔记建索引
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notes_content_hash
         ON notes(content_hash) WHERE is_deleted = 0;",
    )?;

    set_version(conn, 22)?;
    Ok(())
}

/// v22 -> v23: 笔记加密基础字段（T-007 笔记加密保险库）
///
/// - `notes.is_encrypted` 0/1：是否处于加密态
/// - `notes.encrypted_blob` BLOB：密文全量包（nonce ‖ ciphertext ‖ tag）
/// - vault 主密码相关写 app_config：
///   - `vault.salt`       16 字节 base64（派生 key 用的盐）
///   - `vault.verifier`   加密后的常量字符串（用于解锁时校验密码对不对，不泄露 key）
///
/// 设计取舍：
/// 1. **App 层加密**（B1 方案）：密文存在现有 notes 表的新 BLOB 列里，不换 SQLCipher
/// 2. **加密笔记的 content 列保留"🔒 已加密"占位**：这样老代码读取 content 时不会看到乱码；
///    FTS5 索引到的也是这个占位，自然过滤掉加密笔记的搜索命中
/// 3. 忘记主密码 = 数据丢失（T-007 决策 ④）：verifier 不是 key，靠解密校验密码
fn migrate_v22_to_v23(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v22 -> v23 (notes 加密字段 + vault 基础)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "is_encrypted") {
        conn.execute_batch(
            "ALTER TABLE notes ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !cols.iter().any(|c| c == "encrypted_blob") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN encrypted_blob BLOB;")?;
    }

    // 部分索引，过滤/定位加密笔记的常用热路径
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notes_encrypted
         ON notes(is_encrypted) WHERE is_deleted = 0;",
    )?;

    // vault 相关配置是可选的——不预置，在首次 setup 时由代码写入

    set_version(conn, 23)?;
    Ok(())
}

/// v23 → v24: T-024 同步架构 V1
///
/// 新表 `sync_backends`：用户配置的同步后端列表（可同时挂多个）
///   - `id` 自增主键
///   - `kind`：local / webdav / s3 / git
///   - `name`：用户起的名字（如"我的坚果云"）
///   - `config_json`：backend 专属配置（路径 / endpoint / bucket / 凭据等，凭据已用 vault 加密）
///   - `enabled` / `auto_sync` / `created_at`
///
/// 新表 `sync_remote_state`：每条笔记 × 每个 backend 的同步状态
///   - 唯一键 (backend_id, note_id)
///   - `last_synced_hash`：上次同步时的笔记内容 SHA-256（供 diff 用）
///   - `last_synced_ts`：上次同步成功时间（last-write-wins 的依据之一）
///   - `remote_path`：在 backend 上的相对路径（如 "notes/<uuid>.md"）
///   - `tombstone`：本地已删除标记（同步后告诉远端也删，远端确认后才能从表里移除）
///
/// 设计要点：
/// 1. **不动 notes 表本身**：所有同步元数据放独立表，未启用同步的用户零成本
/// 2. **per-backend 状态独立**：用户可以同时配 LocalPath + WebDAV + S3，互不干扰
/// 3. **soft delete 走 tombstone**：硬删笔记时同步表保留 tombstone 行，下次 sync 推出删除
fn migrate_v23_to_v24(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v23 -> v24 (T-024 同步 V1: sync_backends + sync_remote_state)");

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sync_backends (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT    NOT NULL,             -- 'local' | 'webdav' | 's3' | 'git'
            name         TEXT    NOT NULL,
            config_json  TEXT    NOT NULL DEFAULT '{}',
            enabled      INTEGER NOT NULL DEFAULT 1,
            auto_sync    INTEGER NOT NULL DEFAULT 0,
            sync_interval_min INTEGER NOT NULL DEFAULT 30,
            last_push_ts TEXT,
            last_pull_ts TEXT,
            created_at   DATETIME NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at   DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS sync_remote_state (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            backend_id         INTEGER NOT NULL,
            note_id            INTEGER NOT NULL,
            remote_path        TEXT    NOT NULL,
            last_synced_hash   TEXT    NOT NULL,
            last_synced_ts     TEXT    NOT NULL,
            tombstone          INTEGER NOT NULL DEFAULT 0,
            UNIQUE (backend_id, note_id),
            FOREIGN KEY (backend_id) REFERENCES sync_backends(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sync_remote_state_backend
            ON sync_remote_state(backend_id);
        CREATE INDEX IF NOT EXISTS idx_sync_remote_state_note
            ON sync_remote_state(note_id);
        "#,
    )?;

    set_version(conn, 24)?;
    Ok(())
}

/// v24 -> v25: AI 双向打通笔记
///   1. ai_models 加 max_context（用户可在设置页填模型上下文窗口大小，
///      默认 32000，给前端动态计算附加笔记的截断阈值用）
///   2. ai_conversations 加 attached_note_ids（JSON 数组字符串，挂在对话级，
///      整个对话共享一组附加笔记，类比 ChatGPT 项目）
///   3. notes 加 from_ai_conversation_id（归档来源追溯，给 B 方向"AI → 笔记"用）
fn migrate_v24_to_v25(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v24 -> v25");

    conn.execute_batch(
        r#"
        ALTER TABLE ai_models
            ADD COLUMN max_context INTEGER NOT NULL DEFAULT 32000;

        ALTER TABLE ai_conversations
            ADD COLUMN attached_note_ids TEXT NOT NULL DEFAULT '[]';

        ALTER TABLE notes
            ADD COLUMN from_ai_conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_notes_from_ai_conv
            ON notes(from_ai_conversation_id)
            WHERE from_ai_conversation_id IS NOT NULL;
        "#,
    )?;

    set_version(conn, 25)?;
    Ok(())
}

/// v25 -> v26: 笔记伴生 AI 对话
///
/// `companion_conversation_id` 给"在编辑器右侧抽屉里问 AI"功能用：
/// 每篇笔记懒创建一个独立 AI 对话，下次打开同笔记自动复用对话历史。
/// 删除笔记时如果对话还在，对话不会被强制删（用户可能想保留聊天记录），
/// 这里 ON DELETE SET NULL 让对话自由存在。
fn migrate_v25_to_v26(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v25 -> v26");
    conn.execute_batch(
        r#"
        ALTER TABLE notes
            ADD COLUMN companion_conversation_id INTEGER
            REFERENCES ai_conversations(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_notes_companion_conv
            ON notes(companion_conversation_id)
            WHERE companion_conversation_id IS NOT NULL;
        "#,
    )?;
    set_version(conn, 26)?;
    Ok(())
}
