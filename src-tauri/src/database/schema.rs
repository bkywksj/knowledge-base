use rusqlite::Connection;

use crate::error::AppError;

/// 当前 Schema 版本
pub const SCHEMA_VERSION: i32 = 7;

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
