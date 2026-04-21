use rusqlite::Connection;

use crate::error::AppError;

/// 当前 Schema 版本
pub const SCHEMA_VERSION: i32 = 13;

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
