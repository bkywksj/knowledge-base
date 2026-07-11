use rusqlite::Connection;

use crate::error::AppError;

/// 当前 Schema 版本
pub const SCHEMA_VERSION: i32 = 49;

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
            26 => migrate_v26_to_v27(conn)?,
            27 => migrate_v27_to_v28(conn)?,
            28 => migrate_v28_to_v29(conn)?,
            29 => migrate_v29_to_v30(conn)?,
            30 => migrate_v30_to_v31(conn)?,
            31 => migrate_v31_to_v32(conn)?,
            32 => migrate_v32_to_v33(conn)?,
            33 => migrate_v33_to_v34(conn)?,
            34 => migrate_v34_to_v35(conn)?,
            35 => migrate_v35_to_v36(conn)?,
            36 => migrate_v36_to_v37(conn)?,
            37 => migrate_v37_to_v38(conn)?,
            38 => migrate_v38_to_v39(conn)?,
            39 => migrate_v39_to_v40(conn)?,
            40 => migrate_v40_to_v41(conn)?,
            41 => migrate_v41_to_v42(conn)?,
            42 => migrate_v42_to_v43(conn)?,
            43 => migrate_v43_to_v44(conn)?,
            44 => migrate_v44_to_v45(conn)?,
            45 => migrate_v45_to_v46(conn)?,
            46 => migrate_v46_to_v47(conn)?,
            47 => migrate_v47_to_v48(conn)?,
            48 => migrate_v48_to_v49(conn)?,
            _ => {
                return Err(AppError::Custom(format!("未知的数据库版本: {}", version)));
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
    let mut stmt =
        conn.prepare("SELECT id, content FROM notes WHERE content IS NOT NULL AND content != ''")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
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
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN remind_before_minutes INTEGER;")?;
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
    let mut stmt = conn.prepare("SELECT id, title FROM notes WHERE title_normalized IS NULL")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
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
    let mut stmt = conn.prepare("SELECT id, content FROM notes WHERE content_hash IS NULL")?;
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

/// v26 -> v27: tasks 表加 source_batch_id（AI 批量导入用，支持一键撤销整批）
///
/// 当用户用「AI 智能规划」一次生成 N 条待办时，所有同批次任务共享一个 batch_id，
/// 后续可以按 batch_id 批量删除/撤销，避免用户手动一条条清理。
/// 老数据 source_batch_id 为 NULL，自然不参与批次操作。
fn migrate_v26_to_v27(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v26 -> v27 (tasks 新增 source_batch_id)");

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "source_batch_id") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN source_batch_id TEXT;")?;
    }

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_source_batch
            ON tasks(source_batch_id)
            WHERE source_batch_id IS NOT NULL;",
    )?;

    set_version(conn, 27)?;
    Ok(())
}

/// v27 -> v28: 外部 .md 双向同步基础设施
///
/// 1. 新表 `note_url_mapping`：记录笔记里每张图的"内部 URL ↔ 原始 URL"映射
///    - 打开 .md 时：原始链接（./images/foo.png 或 https://...）→ 内部 asset.localhost URL
///      在收集替换的同时把这一对落库；
///    - 写回 .md 时：扫笔记 content 的所有 URL，命中映射就反查替换回原始 URL
///      → 原文件链接保持原样，不污染用户的图床/相对路径写法。
///    - 用户在编辑器里新插的图（不在映射表）按"复制到 <basename>.assets/"策略处理。
///    UNIQUE (note_id, internal_url) 保证同一张图不会被反复写多条。
///
/// 2. notes 表新增 `last_writeback_mtime`：上次成功写回原 .md 时该文件的 mtime（秒级时间戳）。
///    每次写回前比对：若磁盘当前 mtime ≠ 此值，说明外部编辑器（VSCode 等）改过文件，
///    弹冲突 Modal 让用户选「覆盖外部 / 保留外部 / 取消」。
fn migrate_v27_to_v28(conn: &Connection) -> Result<(), AppError> {
    log::info!(
        "数据库迁移: v27 -> v28 (外部 .md 双向同步: note_url_mapping + last_writeback_mtime)"
    );

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS note_url_mapping (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            internal_url  TEXT    NOT NULL,
            original_url  TEXT    NOT NULL,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE (note_id, internal_url)
        );

        CREATE INDEX IF NOT EXISTS idx_url_mapping_note ON note_url_mapping(note_id);
        ",
    )?;

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "last_writeback_mtime") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN last_writeback_mtime INTEGER;")?;
    }

    set_version(conn, 28)?;
    Ok(())
}

/// v28 -> v29: 把笔记 content 里的素材绝对路径替换成相对协议 `kb-asset://`
///
/// 历史背景：旧版前端用 `convertFileSrc(absolute)` 直接把 `http://asset.localhost/<URL编码的绝对路径>`
/// 写进笔记 content。这导致一旦用户改变数据目录（指针文件 / KB_DATA_DIR），
/// 笔记里 src 仍指向旧位置，文件读不到 → 全裂图。
///
/// 治本方案：content 里只存 `kb-asset://<相对 data_dir 的 POSIX 路径>`，
/// 渲染时由前端 MutationObserver 实时拼当前 data_dir 解析。
///
/// 本迁移 = 一次性数据清洗：
/// 1. 正则扫每条笔记 content，匹配 `http://asset.localhost/<encoded>` 与 `asset://localhost/<encoded>`
/// 2. URL-decode 拿到原始绝对路径
/// 3. 用 `services::asset_path::abs_to_rel` 把绝对路径转相对（支持 fallback 找已知子目录段，
///    解决"绝对路径来自旧机器/旧 data_dir、当前 data_dir 不是其前缀"的场景）
/// 4. 替换为 `kb-asset://<rel>` 写回
///
/// 失败兜底：路径既不在 data_dir 下也找不到已知段名时保留原样（极少见，迁移日志会告警）。
/// 跑完后 content 里出现的 `http://asset.localhost/...` 全部应为 0；遗留的视为外链。
fn migrate_v28_to_v29(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v28 -> v29 (笔记 content 绝对资产路径 → kb-asset://)");

    use regex::Regex;

    // 匹配两种 asset 协议前缀，捕获后面的 URL 编码部分（直到引号/空格/<>/换行/反引号）
    let re = Regex::new(
        r#"(?P<scheme>(?:http://asset\.localhost/|asset://localhost/))(?P<path>[^"'\s<>`]+)"#,
    )
    .expect("正则字面量恒定，编译失败属于代码 BUG");

    let mut stmt =
        conn.prepare("SELECT id, content FROM notes WHERE content IS NOT NULL AND content != ''")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v29] 扫描 {} 条笔记里的 asset URL", rows.len());

    // 临时拿一个 dummy data_dir：abs_to_rel 在 fallback 路径里只用 known segments 切，
    // 不实际依赖 data_dir。准确 strip_prefix 走不通时 fallback 即可。
    let dummy_data_dir = std::path::Path::new("");

    let mut replaced_notes = 0usize;
    let mut replaced_urls = 0usize;
    let mut unresolved = 0usize;

    let tx = conn.unchecked_transaction()?;
    for (id, content) in &rows {
        let mut changed_in_this_note = false;
        let new_content = re.replace_all(content, |caps: &regex::Captures<'_>| -> String {
            let encoded = caps.name("path").map(|m| m.as_str()).unwrap_or("");
            let decoded = match urlencoding::decode(encoded) {
                Ok(s) => s.into_owned(),
                Err(_) => return caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string(),
            };
            let abs = std::path::Path::new(&decoded);
            match crate::services::asset_path::abs_to_rel(abs, dummy_data_dir) {
                Some(rel) => {
                    replaced_urls += 1;
                    changed_in_this_note = true;
                    format!("kb-asset://{}", rel)
                }
                None => {
                    unresolved += 1;
                    log::warn!(
                        "[v29] 笔记 {} 中 asset 路径无法解析为相对路径，保留原样: {}",
                        id,
                        decoded
                    );
                    caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
                }
            }
        });

        if changed_in_this_note {
            tx.execute(
                "UPDATE notes SET content = ?1 WHERE id = ?2",
                rusqlite::params![new_content.as_ref(), id],
            )?;
            replaced_notes += 1;
        }
    }
    tx.commit()?;

    log::info!(
        "[v29] 迁移完成：触达 {} 条笔记，替换 {} 个 asset URL，{} 个无法解析（已保留）",
        replaced_notes,
        replaced_urls,
        unresolved
    );

    set_version(conn, 29)?;
    Ok(())
}

/// v29 → v30: 待办任务一级分类
///
/// 新表 `task_categories`：用户自定义分类（彩色圆点 + 名称 + 排序）
/// `tasks.category_id`：外键，NULL = 未分类（虚拟分类）
///
/// 设计：
/// - `ON DELETE SET NULL`：删分类时任务回落到未分类，不级联删任务
/// - 不预置种子数据，让用户首次进设置页自己建（避免清理负担）
fn migrate_v29_to_v30(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v29 -> v30 (待办分类: task_categories + tasks.category_id)");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS task_categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT NOT NULL DEFAULT '#1677ff',
            icon       TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        ",
    )?;

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "category_id") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN category_id INTEGER
                REFERENCES task_categories(id) ON DELETE SET NULL;",
        )?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_category
            ON tasks(category_id) WHERE category_id IS NOT NULL;",
    )?;

    set_version(conn, 30)?;
    Ok(())
}

/// v30 -> v31: notes 加 sort_order 字段（笔记自定义排序）
///
/// 设计：
/// - INTEGER NOT NULL DEFAULT 0；越小越靠前；同 folder 内按 1000 间隔留空隙
///   留给未来插队（同 folders.sort_order 一致的模式）
/// - 初始化：每个 folder_id 分组内按 (updated_at DESC, id ASC) 给序号 *1000
///   未分类（folder_id IS NULL）的笔记按 -1 单独分组
/// - 索引 idx_notes_folder_sort 覆盖 (folder_id, sort_order)，is_deleted=0
///   的部分索引，与 idx_notes_folder / idx_notes_pinned 思路一致
fn migrate_v30_to_v31(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v30 -> v31 (notes.sort_order 自定义排序)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "sort_order") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;")?;
    }

    // 初始化已有数据：同一 folder 内按修改时间倒序分配 0/1000/2000...
    // ROW_NUMBER 在 SQLite 3.25+ 提供，rusqlite bundled 自带的版本远高于此
    conn.execute_batch(
        "
        WITH ranked AS (
            SELECT id,
                   (ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(folder_id, -1)
                        ORDER BY updated_at DESC, id ASC
                   ) - 1) * 1000 AS new_order
            FROM notes
            WHERE is_deleted = 0
        )
        UPDATE notes
        SET sort_order = (SELECT new_order FROM ranked WHERE ranked.id = notes.id)
        WHERE id IN (SELECT id FROM ranked);
        ",
    )?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_notes_folder_sort
            ON notes(folder_id, sort_order) WHERE is_deleted = 0;",
    )?;

    set_version(conn, 31)?;
    Ok(())
}

/// v31 -> v32: tasks 加 parent_task_id（子任务支持）
///
/// 设计：
/// - parent_task_id NULL → 主任务（出现在主列表）
/// - parent_task_id 非 NULL → 子任务（在主任务详情下显示）
/// - ON DELETE CASCADE：删主任务自动删所有子任务，避免孤儿
/// - 部分索引只覆盖子任务（非 NULL），节省空间
///
/// 不限制嵌套层级（DB 层允许多层），但前端 UI 默认只展示 1 层 —— 与
/// Microsoft To Do / Things 一致的"步骤"模型，足够个人使用。
fn migrate_v31_to_v32(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v31 -> v32 (tasks.parent_task_id 子任务)");

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "parent_task_id") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER
                REFERENCES tasks(id) ON DELETE CASCADE;",
        )?;
    }

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_parent
            ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;",
    )?;

    set_version(conn, 32)?;
    Ok(())
}

/// v32 -> v33: 外部 MCP server 注册表（M5-2）
///
/// 让用户可以在主应用里加任意 MCP server（GitHub / Filesystem / 高德地图…），
/// 自家 AI 对话页通过 services::mcp_client::McpClientManager 统一调用。
///
/// 字段说明：
/// - transport: 目前只支持 "stdio"（streamable-http 留给后续）
/// - command: 可执行文件路径或命令名（如 "npx" / 绝对路径）
/// - args: JSON array of strings，命令行参数
/// - env: JSON object，环境变量（OAuth token 等敏感配置走这里）
/// - enabled: 0/1，禁用时不会被 spawn
fn migrate_v32_to_v33(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v32 -> v33 (mcp_servers 外部 MCP 注册表)");

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_servers (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            transport   TEXT NOT NULL DEFAULT 'stdio',
            command     TEXT NOT NULL,
            args        TEXT NOT NULL DEFAULT '[]',
            env         TEXT NOT NULL DEFAULT '{}',
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);",
    )?;

    set_version(conn, 33)?;
    Ok(())
}

/// v33 -> v34: 闪卡 + FSRS 复习
///
/// `cards` 存卡片正反面 + FSRS 调度状态（下次到期/稳定度/难度等）。
/// `card_review_logs` 每次复习写一条历史，可用于参数优化（FSRS optimizer）和统计图表。
///
/// SRS 算法（FSRS）跑在前端 ts-fsrs，后端只负责持久化。前端复习时算出
/// 新的 (due/stability/difficulty/...) 一起传回 review_card 命令更新。
fn migrate_v33_to_v34(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v33 -> v34 (闪卡 + FSRS 复习)");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS cards (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id         INTEGER REFERENCES notes(id) ON DELETE SET NULL,
            front           TEXT NOT NULL,
            back            TEXT NOT NULL,
            deck            TEXT NOT NULL DEFAULT 'default',

            -- FSRS 调度状态（默认值对应『新卡』）
            due             TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            stability       REAL NOT NULL DEFAULT 0,
            difficulty      REAL NOT NULL DEFAULT 0,
            elapsed_days    INTEGER NOT NULL DEFAULT 0,
            scheduled_days  INTEGER NOT NULL DEFAULT 0,
            reps            INTEGER NOT NULL DEFAULT 0,
            lapses          INTEGER NOT NULL DEFAULT 0,
            -- FSRS state: 0=New, 1=Learning, 2=Review, 3=Relearning
            state           INTEGER NOT NULL DEFAULT 0,
            last_review     TEXT,

            -- 软删除（与 notes 一致的回收站语义）
            is_deleted      INTEGER NOT NULL DEFAULT 0,

            created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due) WHERE is_deleted = 0;
        CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck) WHERE is_deleted = 0;
        CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id) WHERE is_deleted = 0;

        CREATE TABLE IF NOT EXISTS card_review_logs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id             INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            -- 用户评分: 1=Again, 2=Hard, 3=Good, 4=Easy（与 ts-fsrs Rating 枚举一致）
            rating              INTEGER NOT NULL,
            state               INTEGER NOT NULL,
            due                 TEXT NOT NULL,
            stability           REAL NOT NULL,
            difficulty          REAL NOT NULL,
            elapsed_days        INTEGER NOT NULL,
            last_elapsed_days   INTEGER NOT NULL DEFAULT 0,
            scheduled_days      INTEGER NOT NULL,
            review              TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_card_logs_card ON card_review_logs(card_id);
        CREATE INDEX IF NOT EXISTS idx_card_logs_review ON card_review_logs(review);
        ",
    )?;

    set_version(conn, 34)?;
    Ok(())
}

/// v34 -> v35: 文件夹自定义颜色
///
/// 给 `folders` 表加 `color TEXT` 列，存十六进制颜色（如 `#1677ff`）。
/// `NULL` 表示沿用默认色（由前端决定 = `token.colorPrimary`）。
fn migrate_v34_to_v35(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v34 -> v35 (folders.color 自定义颜色)");

    let cols = list_columns(conn, "folders")?;
    if !cols.iter().any(|c| c == "color") {
        conn.execute_batch("ALTER TABLE folders ADD COLUMN color TEXT;")?;
    }

    set_version(conn, 35)?;
    Ok(())
}

/// v35 -> v36: notes.stable_uuid 多端稳定标识（T-S010 同步重构）
///
/// 同步 V1 manifest 中的 `stable_id` 早期版本直接用本地 i64 主键 → 多端撞车
/// （A 的 note_id=5 和 B 的 note_id=5 各是不同笔记，同步到一起会复制错乱）。
///
/// 这里加 `notes.stable_uuid TEXT`：
/// - 现有存量笔记由本迁移一次性生成 UUID v4 回填（在单个事务里完成）
/// - DAO 在 `create_note` 时同步生成 UUID 写入
/// - 用**部分唯一索引** `WHERE stable_uuid IS NOT NULL` 保护 UNIQUE 约束，
///   兼容 NULL 行（理论上 backfill 完成后不会有 NULL，但为防御老库异常路径）
///
/// 注意：SQLite `ALTER TABLE ADD COLUMN` 不支持加 `NOT NULL`（除非有静态 DEFAULT），
/// UUID 必须 Rust 侧生成而非 SQL，所以"列允许 NULL + 单独 UNIQUE 索引"是唯一方案。
fn migrate_v35_to_v36(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v35 -> v36 (notes.stable_uuid 多端稳定标识)");

    let cols = list_columns(conn, "notes")?;
    if !cols.iter().any(|c| c == "stable_uuid") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN stable_uuid TEXT;")?;
    }

    // backfill：对 stable_uuid IS NULL 的行（幂等可重跑）生成 UUID v4
    let mut stmt = conn.prepare("SELECT id FROM notes WHERE stable_uuid IS NULL")?;
    let ids: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v36] 准备回填 {} 条笔记的 stable_uuid", ids.len());
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let uuid = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE notes SET stable_uuid = ?1 WHERE id = ?2",
            rusqlite::params![uuid, id],
        )?;
    }
    tx.commit()?;

    // 部分唯一索引：只对非 NULL 行强制唯一（NULL 行被排除，防御性的，正常路径不会出现）
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_stable_uuid
         ON notes(stable_uuid) WHERE stable_uuid IS NOT NULL;",
    )?;

    set_version(conn, 36)?;
    Ok(())
}

/// v36 -> v37: note_attachments 表（T-S020 sidecar CAS 附件同步索引）
///
/// 记录每条笔记引用了哪些本地资产文件（`kb_assets/images/...` / `pdfs/...` / `sources/...` 等），
/// 以及内容 sha256 hex —— 同步时按 hash 去重上传，远端走 CAS 平铺。
///
/// 设计取舍：**不动现有本地目录结构**，本表是 sidecar 索引；同步流程通过此表知道
/// "哪些文件要上传 / 远端哪些已经有了"。本地 markdown 引用保持原相对路径，零迁移风险。
///
/// 字段语义：
/// - `note_id`：所属笔记（CASCADE：笔记物理删除时一同清理引用）
/// - `local_rel_path`：相对 data_dir 的 POSIX 路径，例如 `kb_assets/images/abc.png`
/// - `sha256_hex`：文件内容 hash，决定远端文件名
/// - `size` / `mime`：元数据，供 UI 显示和远端 manifest 用
fn migrate_v36_to_v37(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v36 -> v37 (note_attachments 索引表 - sidecar CAS)");

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_attachments (
            note_id        INTEGER NOT NULL,
            local_rel_path TEXT NOT NULL,
            sha256_hex     TEXT NOT NULL,
            size           INTEGER NOT NULL DEFAULT 0,
            mime           TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (note_id, local_rel_path),
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_note_attachments_hash
            ON note_attachments(sha256_hex);

        CREATE INDEX IF NOT EXISTS idx_note_attachments_note
            ON note_attachments(note_id);",
    )?;

    set_version(conn, 37)?;
    Ok(())
}

/// v37 -> v38: notes.attachment_scan_at — 增量附件扫描标记
///
/// 修「同步前 push 自动跑 scan_all_active_notes 全库扫」的性能问题：
/// 之前每次 push 都对所有未删笔记跑 regex + 文件 IO + 算 hash，1 万笔记可能要十几秒。
/// 加这一列存"上次该笔记被附件扫描时的 updated_at"；下次 scan 只处理
/// `attachment_scan_at IS NULL OR attachment_scan_at < updated_at` 的笔记 → 增量。
///
/// 列允许 NULL（存量行回填 NULL → 首次 scan 仍会全库扫一遍，之后稳态只扫变更的）。
fn migrate_v37_to_v38(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v37 -> v38 (notes.attachment_scan_at 增量扫描标记)");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(notes)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "attachment_scan_at") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN attachment_scan_at TEXT;")?;
    }

    set_version(conn, 38)?;
    Ok(())
}

/// v38 -> v39: 标签树形结构支持（tags.parent_id）
///
/// 设计：parent_id INTEGER NULL，NULL 表示顶层标签。引用 tags(id) 但 SQLite ALTER 加 FK
/// 实际不会生效（且 foreign_keys 默认 OFF），所以"删父级时孩子置 NULL"的语义在 Service 层主动处理。
fn migrate_v38_to_v39(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v38 -> v39 (tags.parent_id 树形结构支持)");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(tags)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "parent_id") {
        conn.execute_batch(
            "ALTER TABLE tags ADD COLUMN parent_id INTEGER;
             CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);",
        )?;
    }

    set_version(conn, 39)?;
    Ok(())
}

/// v40 -> v41: 项目 + 甘特图（projects 表 + tasks.project_id + tasks.start_date）
///
/// 与 task_categories 的区别：
/// - task_categories 是轻量"分类"（彩色圆点 + 名字），跨项目复用
/// - projects 是更高一级的"工作流容器"，有时间维度（start/end_date）和归档状态
/// - 一个任务可以同时挂 category（横切分组）+ project（项目归属）
///
/// `start_date` 是甘特图条左端；`due_date`（已存在）是右端。
/// `ON DELETE SET NULL` 让删项目时任务回到"无项目"，不级联误删。
fn migrate_v40_to_v41(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v40 -> v41 (projects 表 + tasks.project_id / start_date)");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT,
            color       TEXT NOT NULL DEFAULT '#1677ff',
            start_date  TEXT,
            end_date    TEXT,
            archived    INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived, sort_order);
        ",
    )?;

    let task_cols = list_columns(conn, "tasks")?;
    if !task_cols.iter().any(|c| c == "project_id") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN project_id INTEGER
                REFERENCES projects(id) ON DELETE SET NULL;
             CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)
                WHERE project_id IS NOT NULL;",
        )?;
    }
    if !task_cols.iter().any(|c| c == "start_date") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN start_date TEXT;")?;
    }

    set_version(conn, 41)?;
    Ok(())
}

/// v39 -> v40: 工作流看板阶段（tasks.kanban_stage）
///
/// 与 status (0=todo/1=done) 互补——status 是"是否完成"，kanban_stage 是"看板列归属"。
/// 双向语义同步在 Service 层做：
/// - 勾完成 status=1 时把 kanban_stage 设为 'done'
/// - 拖到 done 列把 status 设为 1（含 completed_at）
/// - 拖回 todo/doing 把 status 设为 0
///
/// 初始数据：status=1 的老任务回填 'done'；其余 'todo'。
fn migrate_v39_to_v40(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v39 -> v40 (tasks.kanban_stage 工作流看板)");

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "kanban_stage") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN kanban_stage TEXT NOT NULL DEFAULT 'todo';
             CREATE INDEX IF NOT EXISTS idx_tasks_kanban_stage ON tasks(kanban_stage);",
        )?;
        // 老的已完成任务回填到 done 列
        conn.execute_batch(
            "UPDATE tasks SET kanban_stage = 'done' WHERE status = 1;",
        )?;
    }

    set_version(conn, 40)?;
    Ok(())
}

/// v41 -> v42: projects 跨端同步基础设施（stable_uuid + is_deleted 软删 + 远端状态表）
///
/// 设计与 notes 同套：UUID v4 由 Rust 侧生成（SQLite 没有内建），现有项目本次迁移
/// 一次性回填；后续 `create_project` 同步生成。`is_deleted` 用 tombstone 模式代替物理
/// 删除，让其他端能感知到"这个项目被删了"。
///
/// 新增 `sync_remote_state_project` 表：与 `sync_remote_state`（笔记用）结构对称，
/// 记录每个 (backend_id, project_id) 上次同步的 hash / updated_at / 是否已删，用来
/// 在 diff 时判断"内容是否变化"避免无意义 push。
fn migrate_v41_to_v42(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v41 -> v42 (projects 跨端同步：stable_uuid + is_deleted + sync_remote_state_project)");

    let cols = list_columns(conn, "projects")?;
    if !cols.iter().any(|c| c == "stable_uuid") {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN stable_uuid TEXT;")?;
    }
    if !cols.iter().any(|c| c == "is_deleted") {
        conn.execute_batch(
            "ALTER TABLE projects ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    // backfill：对 stable_uuid IS NULL 的项目（幂等可重跑）生成 UUID v4
    let mut stmt = conn.prepare("SELECT id FROM projects WHERE stable_uuid IS NULL")?;
    let ids: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    log::info!("[v42] 准备回填 {} 个项目的 stable_uuid", ids.len());
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let uuid = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE projects SET stable_uuid = ?1 WHERE id = ?2",
            rusqlite::params![uuid, id],
        )?;
    }
    tx.commit()?;

    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_stable_uuid
            ON projects(stable_uuid) WHERE stable_uuid IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_projects_is_deleted
            ON projects(is_deleted);

         CREATE TABLE IF NOT EXISTS sync_remote_state_project (
            backend_id        INTEGER NOT NULL,
            project_id        INTEGER NOT NULL,
            remote_path       TEXT NOT NULL,
            last_synced_hash  TEXT NOT NULL,
            last_synced_at    TEXT NOT NULL,
            last_synced_tombstone INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (backend_id, project_id)
         );",
    )?;

    set_version(conn, 42)?;
    Ok(())
}

/// v42 -> v43: tasks 跨端同步基础设施（stable_uuid + is_deleted + sync_remote_state_task）
///
/// tasks 此前是物理 DELETE，跨端同步需改成软删 tombstone：把 `delete_task` 改成
/// `UPDATE is_deleted=1 + updated_at=now`，并在所有读路径加 `is_deleted=0` 过滤。
///
/// 字段范围（用户决策"全量版"）：
/// - 主任务字段全部跨端：title/desc/priority/important/status/due_date/start_date/
///   completed_at/remind_before_minutes/repeat_kind/repeat_interval/...
/// - **不跨端**：reminded_at（本地提醒去重）/ repeat_done_count（本地推进，避免双端互推）/
///   source_batch_id（本地批次标识）
/// - 子任务（parent_task_id）通过 parent_task_uuid 跨端引用
fn migrate_v42_to_v43(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v42 -> v43 (tasks 跨端同步：stable_uuid + is_deleted + sync_remote_state_task)");

    let cols = list_columns(conn, "tasks")?;
    if !cols.iter().any(|c| c == "stable_uuid") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN stable_uuid TEXT;")?;
    }
    if !cols.iter().any(|c| c == "is_deleted") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    let mut stmt = conn.prepare("SELECT id FROM tasks WHERE stable_uuid IS NULL")?;
    let ids: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    log::info!("[v43] 准备回填 {} 个任务的 stable_uuid", ids.len());
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let uuid = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE tasks SET stable_uuid = ?1 WHERE id = ?2",
            rusqlite::params![uuid, id],
        )?;
    }
    tx.commit()?;

    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_stable_uuid
            ON tasks(stable_uuid) WHERE stable_uuid IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_is_deleted
            ON tasks(is_deleted);

         CREATE TABLE IF NOT EXISTS sync_remote_state_task (
            backend_id        INTEGER NOT NULL,
            task_id           INTEGER NOT NULL,
            remote_path       TEXT NOT NULL,
            last_synced_hash  TEXT NOT NULL,
            last_synced_at    TEXT NOT NULL,
            last_synced_tombstone INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (backend_id, task_id)
         );",
    )?;

    set_version(conn, 43)?;
    Ok(())
}

/// v43 -> v44: task_categories 跨端识别（stable_uuid）
///
/// 让"用户在 A 端把分类「工作」重命名为「Work」"也能跨端识别为同一个分类。
/// 不加 is_deleted —— 分类是辅助元数据，删除时任务自动落到"未分类"（ON DELETE SET NULL），
/// 跨端只关心"存在性 + 名称变化"，不需要 tombstone。
fn migrate_v43_to_v44(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v43 -> v44 (task_categories.stable_uuid 跨端识别)");

    let cols = list_columns(conn, "task_categories")?;
    if !cols.iter().any(|c| c == "stable_uuid") {
        conn.execute_batch("ALTER TABLE task_categories ADD COLUMN stable_uuid TEXT;")?;
    }

    let mut stmt = conn.prepare("SELECT id FROM task_categories WHERE stable_uuid IS NULL")?;
    let ids: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    log::info!("[v44] 准备回填 {} 个任务分类的 stable_uuid", ids.len());
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        let uuid = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE task_categories SET stable_uuid = ?1 WHERE id = ?2",
            rusqlite::params![uuid, id],
        )?;
    }
    tx.commit()?;

    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_categories_stable_uuid
            ON task_categories(stable_uuid) WHERE stable_uuid IS NOT NULL;",
    )?;

    set_version(conn, 44)?;
    Ok(())
}

/// v44 -> v45: tags 加 sort_order（同级自定义排序）
///
/// 设计（对齐 v30→v31 notes.sort_order / folders.sort_order）：
/// - INTEGER NOT NULL DEFAULT 0；越小越靠前；同 parent 内按 1000 间隔留空隙
///   留给未来插队，避免每次拖动都全量重排
/// - 初始化：按 COALESCE(parent_id, -1) 分组，组内按 name 字母序赋 0/1000/2000…
///   (顶层标签 parent_id IS NULL 单独成一组 = -1)
/// - 索引 idx_tags_parent_sort 覆盖 (parent_id, sort_order)，加速 list_tags 排序
fn migrate_v44_to_v45(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v44 -> v45 (tags.sort_order 自定义排序)");

    let cols = list_columns(conn, "tags")?;
    if !cols.iter().any(|c| c == "sort_order") {
        conn.execute_batch("ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;")?;
    }

    // 已有数据初始化：同一 parent 内按 name COLLATE NOCASE 升序分配 0/1000/2000...
    conn.execute_batch(
        "
        WITH ranked AS (
            SELECT id,
                   (ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(parent_id, -1)
                        ORDER BY name COLLATE NOCASE ASC, id ASC
                   ) - 1) * 1000 AS new_order
            FROM tags
        )
        UPDATE tags
        SET sort_order = (SELECT new_order FROM ranked WHERE ranked.id = tags.id)
        WHERE id IN (SELECT id FROM ranked);
        ",
    )?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tags_parent_sort
            ON tags(parent_id, sort_order);",
    )?;

    set_version(conn, 45)?;
    Ok(())
}

fn migrate_v47_to_v48(conn: &Connection) -> Result<(), AppError> {
    // v48 原为「Rhai 脚本插件 scripts 表」，该功能已撤销（与内置 AI 文本转换重叠、
    // 价值边际）。版本号**保留 48 不回退**——否则装过 dev v48 的库会「版本高于应用」报错。
    // 空迁移即可：装过旧 dev 版的库里残留的 scripts 表无害（不再被任何代码引用），新库不建表。
    log::info!("数据库迁移: v47 -> v48 (脚本插件已撤销，空迁移占位)");

    set_version(conn, 48)?;
    Ok(())
}

fn migrate_v46_to_v47(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v46 -> v47 (定时推送 push_jobs / push_run_logs)");

    // 定时推送独立子系统。push_jobs 存订阅本体，push_run_logs 存每次执行快照。
    // next_run_at 物化存表（而非每次算）：调度器只需 SELECT MIN(next_run_at) 即知下次该睡到几点，
    // 空闲时零计算。建 (enabled, next_run_at) 复合索引让 peek/list_due 走索引。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_jobs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            prompt          TEXT NOT NULL,
            model_id        INTEGER,
            source_kind     TEXT NOT NULL DEFAULT 'none',
            source_config   TEXT NOT NULL DEFAULT '{}',
            schedule_time   TEXT NOT NULL,
            repeat_kind     TEXT NOT NULL DEFAULT 'daily',
            repeat_weekdays TEXT,
            channels        TEXT NOT NULL DEFAULT '[\"notification\"]',
            enabled         INTEGER NOT NULL DEFAULT 1,
            last_run_at     TEXT,
            next_run_at     TEXT,
            created_at      DATETIME DEFAULT (datetime('now','localtime')),
            updated_at      DATETIME DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_push_jobs_next ON push_jobs(enabled, next_run_at);
        CREATE TABLE IF NOT EXISTS push_run_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id      INTEGER NOT NULL,
            run_at      TEXT NOT NULL,
            status      TEXT NOT NULL,
            item_count  INTEGER NOT NULL DEFAULT 0,
            payload     TEXT,
            error       TEXT,
            FOREIGN KEY(job_id) REFERENCES push_jobs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_push_run_logs_job ON push_run_logs(job_id, run_at);",
    )?;

    set_version(conn, 47)?;
    Ok(())
}

fn migrate_v45_to_v46(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v45 -> v46 (ai_conversations.scope_folder_id 文件夹范围问答)");

    // scope_folder_id：对话级 RAG 范围限定。
    // NULL = 全库检索（默认旧行为）；有值 = RAG 只在该文件夹及其所有子孙文件夹内检索。
    // 存文件夹 id 而非展开后的 id 列表：文件夹结构/笔记归属变化后范围能自动跟上。
    let cols = list_columns(conn, "ai_conversations")?;
    if !cols.iter().any(|c| c == "scope_folder_id") {
        conn.execute_batch(
            "ALTER TABLE ai_conversations ADD COLUMN scope_folder_id INTEGER;",
        )?;
    }

    set_version(conn, 46)?;
    Ok(())
}

/// 把 content 里所有 `kb-asset://` URL 中的**裸空白**（空格 / Tab）percent-encode。
///
/// 返回 `(新内容, 是否有改动)`。幂等：URL 里没有裸空白（本就干净或已编码）时原样返回。
///
/// 背景见 `migrate_v48_to_v49` 文档。这里抽成纯函数便于单测（无 DB 依赖）。
///
/// 正则从 `kb-asset://` 起，吃到 URL 边界（引号 / 反引号 / `)` / `]` / `<>` / 换行）为止。
/// **故意不排除 `\s`** —— 正是要把中间的裸空格捕进来再编码。边界字符覆盖两种承载形态：
/// markdown 链接 `[txt](kb-asset://…)`（止于 `)`）与 HTML `<img src="kb-asset://…">`（止于 `"`）。
fn encode_kb_asset_whitespace(content: &str) -> (String, bool) {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"kb-asset://[^"'`)\]<>\r\n]*"#)
            .expect("正则字面量恒定，编译失败属于代码 BUG")
    });

    let mut changed = false;
    let new = re.replace_all(content, |caps: &regex::Captures<'_>| -> String {
        let m = caps.get(0).map(|x| x.as_str()).unwrap_or("");
        if m.contains(' ') || m.contains('\t') {
            changed = true;
            m.replace(' ', "%20").replace('\t', "%09")
        } else {
            m.to_string()
        }
    });
    (new.into_owned(), changed)
}

/// v48 -> v49: 修复附件链接 `kb-asset://` URL 里的裸空格
///
/// 历史 Bug：批量/工具栏插入附件时，前端把 `[📎 文件名 (大小)](kb-asset://<相对路径>)` 作为
/// **link mark** 写入。link mark 的 markdown 序列化走 prosemirror-markdown 的 `state.esc()`，
/// 它**不 percent-encode、也不转义空格**。于是文件名含空格（如 `220ml瓶型（HDPE VD钙奶富邦）.dwg`）
/// 时，落盘 `.md`/DB 里的 URL 带着**裸空格**：
///   1. 重新打开笔记 / 同步拉回时，markdown-it 按 CommonMark 解析 —— 未用 `<>` 包裹的链接目标
///      不能含空格 → 链接解析失败 → 整条以**原始文本**暴露（用户可见的坏链接）。
///   2. Rust `sync_v1::attachment_scan` 的 `re_kb_asset` 正则遇空白即截断 → 抓到的路径不完整
///      → 磁盘找不到该文件 → 该附件**永远漏同步**。
///
/// 前端已在插入时改用 `toKbAssetHref`（percent-encode）根治新数据；本迁移做**存量清洗**：
/// 把已存 content 里 `kb-asset://` URL 中的裸空格 / Tab 编码为 `%20` / `%09`。编码后：
///   - markdown 链接目标合法 → 重开正常渲染成附件链接；
///   - 消费端 `parseKbAsset`（前端）/ `url_decode`（Rust 扫描）都会解码还原 → 打开 / 同步都正常。
///
/// 顺带把改动过的笔记 `attachment_scan_at` 置空，强制下次 push 前重扫，让修好的附件被同步索引到。
/// 幂等：无裸空格的笔记不改（`encode_kb_asset_whitespace` 返回 changed=false）。
///
/// ⚠️ 已知边界：若文件名本身含 ASCII 半角括号 `)`，正则会在该 `)` 处提前截断（markdown 链接语义
/// 本就无法表达这种文件名）—— 属极少见情形，本迁移不处理，保持最小改动。
fn migrate_v48_to_v49(conn: &Connection) -> Result<(), AppError> {
    log::info!("数据库迁移: v48 -> v49 (修复附件链接 kb-asset:// URL 裸空格)");

    let mut stmt = conn
        .prepare("SELECT id, content FROM notes WHERE content IS NOT NULL AND content != ''")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    log::info!("[v49] 扫描 {} 条笔记里的 kb-asset:// URL", rows.len());

    let mut touched = 0usize;
    let tx = conn.unchecked_transaction()?;
    for (id, content) in &rows {
        let (new_content, changed) = encode_kb_asset_whitespace(content);
        if changed {
            tx.execute(
                "UPDATE notes SET content = ?1, attachment_scan_at = NULL WHERE id = ?2",
                rusqlite::params![new_content, id],
            )?;
            touched += 1;
        }
    }
    tx.commit()?;

    log::info!("[v49] 修复完成：{} 条笔记的附件链接 URL 空格已编码", touched);

    set_version(conn, 49)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v49_encodes_space_in_attachment_link() {
        let content = "前文 [📎 220ml瓶型（HDPE VD钙奶富邦）.dwg (210.8 KB)](kb-asset://kb_assets/attachments/43/220ml瓶型（HDPE VD钙奶富邦）.dwg) 后文";
        let (out, changed) = encode_kb_asset_whitespace(content);
        assert!(changed, "含裸空格应判定为有改动");
        // URL 里的空格已被编码
        assert!(
            out.contains("kb-asset://kb_assets/attachments/43/220ml瓶型（HDPE%20VD钙奶富邦）.dwg"),
            "URL 空格应编码为 %20；实际：{out}"
        );
        // 链接文本里的空格（(210.8 KB) 那处）不在 URL 内，不该被动
        assert!(out.contains("(210.8 KB)"), "链接文本不应被改动：{out}");
    }

    #[test]
    fn v49_encodes_space_in_html_img_src() {
        let content = r#"<img src="kb-asset://kb_assets/images/1/my photo.png" alt="x">"#;
        let (out, changed) = encode_kb_asset_whitespace(content);
        assert!(changed);
        assert!(out.contains(r#"kb-asset://kb_assets/images/1/my%20photo.png"#), "实际：{out}");
    }

    #[test]
    fn v49_idempotent_on_clean_url() {
        // 已编码 / 无空格 → 不改动
        let content = "![](kb-asset://kb_assets/attachments/1/a%20b.dwg) 和 <img src=\"kb-asset://kb_assets/images/2/clean.png\">";
        let (out, changed) = encode_kb_asset_whitespace(content);
        assert!(!changed, "无裸空格不应改动");
        assert_eq!(out, content);

        // 对编码结果再跑一遍（模拟迁移二次执行）仍不变
        let (out2, changed2) = encode_kb_asset_whitespace(&out);
        assert!(!changed2);
        assert_eq!(out2, out);
    }

    #[test]
    fn v49_does_not_touch_non_kb_asset_urls() {
        // 普通外链里的空格不归本迁移管（也不该动）
        let content = "[链接](https://example.com/a b) 和普通文本 有 空格";
        let (out, changed) = encode_kb_asset_whitespace(content);
        assert!(!changed);
        assert_eq!(out, content);
    }

    #[test]
    fn v49_multiple_refs_in_one_note() {
        let content = "[a](kb-asset://kb_assets/attachments/1/x y.zip) [b](kb-asset://kb_assets/attachments/1/p q.pdf)";
        let (out, changed) = encode_kb_asset_whitespace(content);
        assert!(changed);
        assert!(out.contains("x%20y.zip"), "{out}");
        assert!(out.contains("p%20q.pdf"), "{out}");
    }
}
