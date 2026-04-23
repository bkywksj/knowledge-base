# Knowledge Base 架构设计文档

> 本地知识库桌面应用 — 搜、链、图、AI

---

## 产品定位

**Typora 是"写一篇文档"的工具，我们要做的是"管理一千篇文档之间关系 + AI 理解你的知识"的工具。**

### 目标用户

| 用户类型 | 核心需求 | 痛点 |
|---------|---------|------|
| 开发者 | 技术笔记管理、代码片段积累 | 笔记散落各处，找不到以前写的东西 |
| 学生/研究者 | 论文阅读笔记、课程知识整理 | 笔记之间缺乏关联，无法形成知识网络 |
| 写作者 | 素材管理、灵感收集 | 碎片化想法无法串联 |
| 知识工作者 | 项目文档、会议纪要、决策记录 | 信息量大，检索困难 |

### 与 Typora 的差异

| Typora 的边界 | Knowledge Base 的能力 |
|---|---|
| 编辑单个 .md 文件 | 管理成百上千篇笔记的组织和检索 |
| 文件夹树状浏览 | 全文搜索（跨所有笔记瞬间找到内容） |
| 无链接概念 | 双向链接（笔记 A 提到笔记 B，B 自动知道被 A 引用） |
| 无标签系统 | 多维分类（标签 + 文件夹 + 链接三种组织方式并存） |
| 无知识图谱 | 可视化关系网（看到知识之间的关联） |
| 纯编辑器，无数据库 | 结构化元数据（创建时间、修改时间、标签可查询筛选） |

### 与 Obsidian 的差异

| Obsidian | Knowledge Base |
|----------|---------------|
| Electron（内存占用 200MB+） | Tauri（内存占用 ~30MB） |
| 插件生态复杂，学习成本高 | 开箱即用，核心功能内置 |
| 基于文件系统，搜索依赖索引重建 | SQLite + FTS5，毫秒级搜索 |
| 付费同步 | 本地优先，未来可自建同步 |
| 社区插件质量参差不齐 | 官方维护，功能一致性好 |
| AI 功能需要付费插件 | **AI 问答笔记内置免费，支持多模型** |

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 后端 | Rust + Tauri | 2021 edition / 2.x | 三层架构（Commands → Services → Database） |
| 前端 | React + TypeScript | 19 / 5.8 | 函数组件 + Hooks |
| UI | Ant Design + TailwindCSS | 5 / 4 | 组件库 + 原子样式 |
| 状态 | Zustand | 5 | 全局状态管理 |
| 路由 | React Router (HashRouter) | 7 | SPA 路由 |
| 数据库 | SQLite (rusqlite bundled) | 0.31 | 本地持久化 |
| 全文搜索 | SQLite FTS5 | 内置 | 全文索引 + 中文分词 |
| 编辑器 | **Tiptap** | 2.x | Markdown 所见即所得编辑 |
| 图谱可视化 | **@antv/g6** | 5.x | 知识图谱力导向图渲染 |
| AI 请求 | `reqwest` (Rust) | latest | 调用 OpenAI/Claude/Ollama API |
| AI 流式响应 | SSE 解析 | — | Rust 侧流式读取 → Tauri Event 推送前端 |
| AI 模型 | OpenAI / Claude / Ollama | — | 多模型切换，本地 Ollama 优先 |
| 应用标识 | com.agilefr.kb | — | Tauri identifier |

### 编辑器选型：Tiptap

| 对比项 | Milkdown | Tiptap | 选择理由 |
|--------|----------|--------|---------|
| 生态成熟度 | 较新，社区小 | 成熟，生态丰富 | Tiptap 插件多 |
| 自定义扩展 | 基于 ProseMirror | 基于 ProseMirror | 两者都可以 |
| `[[]]` 链接扩展 | 需要自己写 | 有 Mention 扩展可复用 | Tiptap 更省力 |
| React 集成 | @milkdown/react | @tiptap/react | 两者都好 |
| 文档质量 | 一般 | 优秀 | Tiptap 文档详尽 |
| 中文支持 | 可以 | 可以 | 两者都行 |

**结论**：选 Tiptap — Mention 扩展可复用做 `[[]]` 双向链接，生态成熟，扩展性强。

### 图谱可视化选型：@antv/g6

| 对比项 | D3.js | @antv/g6 | 选择理由 |
|--------|-------|----------|---------|
| 上手难度 | 高（底层 API） | 中（高层封装） | G6 更快出活 |
| 力导向布局 | 需要自己实现 | 内置多种布局 | G6 开箱即用 |
| 交互支持 | 需要自己写 | 内置缩放/拖拽/点击 | G6 省力 |
| 大图性能 | 一般（SVG） | 好（Canvas/WebGL） | G6 性能更优 |
| React 集成 | 无官方方案 | @antv/g6-react-node | G6 有 React 组件 |
| 中文文档 | 无 | 优秀（蚂蚁出品） | G6 文档友好 |

**结论**：选 @antv/g6 — 开箱即用的力导向布局 + 交互，Canvas 渲染性能好，中文文档完善。

---

## 功能优先级

### P0 — 核心差异（MVP 必备）

#### 1. 全文搜索引擎

- **Rust 侧**：SQLite FTS5 全文索引，毫秒级搜索
- **前端**：实时搜索框（debounce 300ms），结果高亮，Ant Design List 展示
- **数据流**：`SearchInput → invoke("search_notes") → FTS5 MATCH → snippet() 高亮 → 排序返回`
- **中文分词**：FTS5 `unicode61` tokenizer（按 Unicode 字符边界分词），满足基本中文搜索
- **验收标准**：
  - 1000 篇笔记搜索响应 < 50ms
  - 搜索结果包含标题和内容片段高亮
  - 支持中文关键词搜索
  - 空搜索框显示最近编辑的笔记

#### 2. 双向链接 + 知识图谱

- **语法**：`[[笔记名]]` 在编辑器中自动识别，Tiptap Mention 扩展实现
- **反向链接**：每篇笔记底部展示"谁引用了我"（Backlinks Panel）
- **图谱**：@antv/g6 力导向图，节点大小 = 链接数，点击跳转编辑
- **存储**：`note_links` 表记录链接关系（source_id → target_id）
- **验收标准**：
  - 输入 `[[` 触发笔记名自动补全
  - 反向链接实时更新（保存笔记后立即生效）
  - 图谱支持缩放、拖拽、节点点击
  - 孤立笔记（无链接）在图谱中显示为小节点

#### 3. 标签 + 智能筛选

- **语法**：`#标签` 自动提取（正则 `/#[\w\u4e00-\u9fff]+/g`）
- **存储**：`tags` + `note_tags` 多对多关系表
- **筛选**：按标签、日期范围、文件夹组合筛选
- **UI**：Ant Design Tag（彩色标签） + Select（标签筛选） + Table（结果展示）
- **验收标准**：
  - 保存笔记时自动提取并同步标签
  - 标签支持点击筛选
  - 标签云展示（按使用频率排序）
  - 删除笔记时级联清理无引用标签

### P1 — 体验优势

#### 4. AI 知识问答（核心差异化）

- **AI 问答笔记**：基于你的笔记内容回答问题（RAG 检索增强生成）
  - 用户提问 → FTS5 搜索相关笔记 → 拼接为上下文 → 发给 AI → 流式返回答案
  - 答案中自动引用来源笔记（点击可跳转）
- **AI 写作辅助**：选中笔记内容 → 续写/总结/改写/翻译
- **AI 摘要**：对长笔记自动生成摘要和关键词
- **多模型支持**：
  - OpenAI（GPT-4o / GPT-4o-mini）
  - Anthropic Claude（claude-sonnet）
  - 本地 Ollama（llama3 / qwen2 等，完全离线）
  - 自定义 API（兼容 OpenAI 格式的第三方服务）
- **对话历史**：每个笔记可关联 AI 对话，保存在 SQLite
- **隐私优先**：支持纯本地 Ollama，数据不出设备
- **验收标准**：
  - AI 回答流式显示（逐字输出）
  - 回答中包含来源笔记链接（最多 5 篇）
  - 模型切换后立即生效
  - Ollama 离线模式正常工作
  - 对话历史可查看/删除

#### 5. 每日笔记 / 快速捕获

- 全局快捷键（如 `Ctrl+Shift+N`）唤出小窗口，随手记一条想法
- 自动按日期归档（`daily_date` 字段）
- Tauri 托盘常驻 + 全局热键（tauri-plugin-global-shortcut）
- 首页显示"今日笔记"卡片

#### 6. Markdown 编辑器

- Tiptap 编辑器，所见即所得模式
- 集成双向链接语法 `[[]]`（基于 Mention 扩展）
- 集成标签语法 `#tag`（自定义 Tiptap Node）
- 工具栏：标题、加粗、列表、代码块、引用、链接
- Slash Command：输入 `/` 弹出快捷命令面板

#### 7. 多视图浏览

- 列表视图（Ant Design Table — 默认）
- 卡片视图（Card Grid — 适合浏览）
- 时间线视图（Timeline — 按日期）
- 图谱视图（Graph — 关系网络）

### P2 — 锦上添花

| 功能 | 说明 | 技术要点 |
|------|------|---------|
| 网页剪藏 | 浏览器扩展 → 发送到本地应用 | 自定义协议 `kb://clip` |
| 模板系统 | 会议记录/读书笔记/日记模板 | `note_templates` 表 |
| 导入导出 | 兼容 Obsidian vault、Typora 文件夹 | 递归读 .md，解析 YAML frontmatter |
| 版本历史 | 每次保存自动存快照 | `note_versions` 表存 diff |
| 附件管理 | 图片/PDF 统一管理 | `attachments` 表 + 文件系统存储 |
| 笔记收藏 | 常用笔记置顶/收藏 | `notes.is_pinned` 字段 |

---

## 数据库设计

### ER 关系图

```
folders 1──N notes 1──N note_tags N──1 tags
                  │
                  ├──N note_links (self-referencing)
                  ├──N note_versions
                  └──N attachments
```

### 核心表

```sql
-- ═══════════════════════════════════
-- 文件夹表（树形结构）
-- ═══════════════════════════════════
CREATE TABLE folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- 笔记表（核心实体）
-- ═══════════════════════════════════
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    folder_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    is_daily    BOOLEAN NOT NULL DEFAULT 0,
    daily_date  TEXT,                          -- YYYY-MM-DD，每日笔记专用
    is_pinned   BOOLEAN NOT NULL DEFAULT 0,    -- 收藏/置顶
    is_deleted  BOOLEAN NOT NULL DEFAULT 0,    -- 软删除（回收站）
    deleted_at  TEXT,                          -- 删除时间
    word_count  INTEGER NOT NULL DEFAULT 0,    -- 字数统计（保存时计算）
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- 全文搜索虚拟表（FTS5）
-- ═══════════════════════════════════
CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content,
    content=notes,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS5 同步触发器（保持索引与 notes 表一致）
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER notes_au AFTER UPDATE OF title, content ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

-- ═══════════════════════════════════
-- 标签表
-- ═══════════════════════════════════
CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT,                          -- 标签颜色（可选）
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- 笔记-标签关联（多对多）
-- ═══════════════════════════════════
CREATE TABLE note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

-- ═══════════════════════════════════
-- 双向链接表
-- ═══════════════════════════════════
CREATE TABLE note_links (
    source_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    context     TEXT,                          -- 链接所在的上下文片段（可选）
    PRIMARY KEY (source_id, target_id)
);

-- ═══════════════════════════════════
-- 版本历史表（P2）
-- ═══════════════════════════════════
CREATE TABLE note_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- 附件表（P2）
-- ═══════════════════════════════════
CREATE TABLE attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,                 -- 原始文件名
    filepath    TEXT NOT NULL,                 -- 存储路径（相对于 app_data）
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- 应用配置表（框架自带）
-- ═══════════════════════════════════
CREATE TABLE app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ═══════════════════════════════════
-- AI 对话表
-- ═══════════════════════════════════
CREATE TABLE ai_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER REFERENCES notes(id) ON DELETE SET NULL,  -- 关联笔记（可选）
    title       TEXT NOT NULL,                    -- 对话标题（自动取第一条问题）
    model       TEXT NOT NULL,                    -- 使用的模型（gpt-4o / claude-sonnet / ollama:llama3）
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- AI 对话消息表
-- ═══════════════════════════════════
CREATE TABLE ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,                -- user / assistant / system
    content         TEXT NOT NULL,                -- 消息内容
    source_note_ids TEXT,                         -- 引用的笔记 ID 列表（JSON 数组，如 [1,3,7]）
    token_count     INTEGER,                     -- token 使用量（可选）
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════
-- AI 模型配置表
-- ═══════════════════════════════════
CREATE TABLE ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT NOT NULL,                    -- openai / anthropic / ollama / custom
    name        TEXT NOT NULL,                    -- 显示名称
    model_id    TEXT NOT NULL,                    -- API 模型 ID（gpt-4o / claude-sonnet-4-20250514）
    api_url     TEXT NOT NULL,                    -- API 地址
    api_key     TEXT,                             -- API Key（Ollama 无需）
    is_default  INTEGER NOT NULL DEFAULT 0,       -- 是否默认模型
    is_enabled  INTEGER NOT NULL DEFAULT 1,       -- 是否启用
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

### 索引

```sql
-- 笔记查询优化
CREATE INDEX idx_notes_folder     ON notes(folder_id) WHERE is_deleted = 0;
CREATE INDEX idx_notes_daily      ON notes(is_daily, daily_date) WHERE is_deleted = 0;
CREATE INDEX idx_notes_updated    ON notes(updated_at DESC) WHERE is_deleted = 0;
CREATE INDEX idx_notes_pinned     ON notes(is_pinned, updated_at DESC) WHERE is_deleted = 0;
CREATE INDEX idx_notes_deleted    ON notes(is_deleted, deleted_at);

-- 链接查询优化
CREATE INDEX idx_note_links_target ON note_links(target_id);

-- 标签查询优化
CREATE INDEX idx_note_tags_tag    ON note_tags(tag_id);

-- 版本历史查询
CREATE INDEX idx_note_versions    ON note_versions(note_id, created_at DESC);

-- 附件查询
CREATE INDEX idx_attachments_note ON attachments(note_id);

-- AI 对话查询
CREATE INDEX idx_ai_conversations_note ON ai_conversations(note_id);
CREATE INDEX idx_ai_conversations_updated ON ai_conversations(updated_at DESC);
CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
```

### Schema 迁移策略

使用 `PRAGMA user_version` 管理版本，每个版本一个迁移步骤：

```
Version 0 → 1: 创建核心表（notes, folders, tags, note_tags, note_links, app_config）
                创建 FTS5 虚拟表 + 触发器
                创建索引
Version 1 → 2: 添加 notes.is_pinned, notes.is_deleted, notes.deleted_at, notes.word_count
                添加 note_links.context
                添加 tags.color
Version 2 → 3: 创建 note_versions 表
                创建 attachments 表
Version 3 → 4: 创建 ai_conversations 表
                创建 ai_messages 表
                创建 ai_models 表
                插入默认模型配置（Ollama llama3 + OpenAI gpt-4o-mini）
```

---

## Rust 后端架构

### 三层架构

```
Commands 层（IPC 入口）
├── commands/notes.rs       — 笔记 CRUD + 搜索
├── commands/tags.rs        — 标签管理
├── commands/links.rs       — 链接查询（反向链接、图谱数据）
├── commands/folders.rs     — 文件夹管理
├── commands/daily.rs       — 每日笔记
├── commands/ai.rs          — AI 对话（问答/摘要/写作辅助）
└── commands/system.rs      — 系统信息（框架自带）

Services 层（业务逻辑）
├── services/note.rs        — 笔记业务（保存时自动提取标签和链接）
├── services/search.rs      — 搜索业务（FTS5 查询 + 结果高亮）
├── services/link.rs        — 链接解析（解析 [[]] 语法，维护链接表）
├── services/tag.rs         — 标签业务（自动提取 #tag，清理孤立标签）
├── services/graph.rs       — 图谱数据（生成节点和边）
├── services/daily.rs       — 每日笔记（按日期创建/获取）
├── services/trash.rs       — 回收站（软删除、恢复、永久删除）
├── services/ai.rs          — AI 服务（RAG 检索 + API 调用 + 流式响应）
└── services/ai_provider.rs — AI 提供商抽象（OpenAI/Claude/Ollama 统一接口）

Database 层（数据访问）
├── database/mod.rs         — Database struct + 连接管理
├── database/schema.rs      — Schema 迁移（PRAGMA user_version）
├── database/notes.rs       — 笔记 DAO
├── database/tags.rs        — 标签 DAO
├── database/links.rs       — 链接 DAO
├── database/folders.rs     — 文件夹 DAO
├── database/search.rs      — FTS5 搜索 DAO
├── database/ai.rs          — AI 对话/消息 DAO
└── database/ai_models.rs   — AI 模型配置 DAO
```

### 核心数据模型 (models/)

```rust
// ─── 笔记 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
    pub is_daily: bool,
    pub daily_date: Option<String>,
    pub is_pinned: bool,
    pub tags: Vec<String>,          // 前端展示用，JOIN 查询填充
    pub word_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新笔记的入参（不含自动生成字段）
#[derive(Debug, Clone, Deserialize)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
}

/// 笔记列表查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct NoteQuery {
    pub folder_id: Option<i64>,
    pub tag: Option<String>,
    pub is_pinned: Option<bool>,
    pub keyword: Option<String>,        // 简单标题模糊搜索（非 FTS）
    pub page: Option<usize>,            // 分页页码（从 1 开始）
    pub page_size: Option<usize>,       // 每页条数（默认 20）
}

// ─── 搜索 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub note_id: i64,
    pub title: String,
    pub snippet: String,            // FTS5 snippet() 高亮片段
    pub rank: f64,                  // BM25 相关度
    pub tags: Vec<String>,
    pub updated_at: String,
}

// ─── 图谱 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: i64,
    pub title: String,
    pub tag_count: usize,
    pub link_count: usize,          // 入链 + 出链总数
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: i64,
    pub target: i64,
}

// ─── 标签 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub note_count: usize,          // 关联笔记数
}

// ─── 文件夹 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub children: Vec<Folder>,      // 树形结构（递归构建）
    pub note_count: usize,          // 直接包含的笔记数
}

// ─── 分页响应 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageResult<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

// ─── AI 对话 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub note_id: Option<i64>,
    pub title: String,
    pub model: String,
    pub message_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversationDetail {
    pub conversation: AiConversation,
    pub messages: Vec<AiMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub id: i64,
    pub role: String,           // "user" | "assistant" | "system"
    pub content: String,
    pub source_note_ids: Vec<i64>,  // 引用的笔记 ID
    pub token_count: Option<i64>,
    pub created_at: String,
}

// ─── AI 模型 ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: i64,
    pub provider: String,       // "openai" | "anthropic" | "ollama" | "custom"
    pub name: String,
    pub model_id: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub is_default: bool,
    pub is_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiModelInput {
    pub id: Option<i64>,        // None = 创建, Some = 更新
    pub provider: String,
    pub name: String,
    pub model_id: String,
    pub api_url: String,
    pub api_key: Option<String>,
}

// ─── AI 流式事件 payload ───
#[derive(Debug, Clone, Serialize)]
pub struct AiStreamChunk {
    pub conversation_id: i64,
    pub content: String,        // 增量文本片段
    pub done: bool,             // 是否完成
}
```

### 关键 Command 接口

```rust
// ═══════════════════════════════════
// 笔记 CRUD
// ═══════════════════════════════════
#[tauri::command]
fn create_note(state: State<AppState>, input: NoteInput) -> Result<Note, String>;

#[tauri::command]
fn update_note(state: State<AppState>, id: i64, input: NoteInput) -> Result<Note, String>;

#[tauri::command]
fn delete_note(state: State<AppState>, id: i64) -> Result<(), String>;
// 注：软删除 → 移入回收站，不立即物理删除

#[tauri::command]
fn get_note(state: State<AppState>, id: i64) -> Result<Note, String>;

#[tauri::command]
fn list_notes(state: State<AppState>, query: NoteQuery) -> Result<PageResult<Note>, String>;

#[tauri::command]
fn toggle_pin(state: State<AppState>, id: i64) -> Result<bool, String>;
// 返回新的 is_pinned 状态

// ═══════════════════════════════════
// 搜索
// ═══════════════════════════════════
#[tauri::command]
fn search_notes(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String>;

// ═══════════════════════════════════
// 双向链接 + 图谱
// ═══════════════════════════════════
#[tauri::command]
fn get_backlinks(state: State<AppState>, note_id: i64) -> Result<Vec<Note>, String>;

#[tauri::command]
fn get_graph_data(state: State<AppState>) -> Result<GraphData, String>;

// ═══════════════════════════════════
// 标签
// ═══════════════════════════════════
#[tauri::command]
fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String>;

#[tauri::command]
fn rename_tag(state: State<AppState>, id: i64, new_name: String) -> Result<(), String>;

#[tauri::command]
fn delete_tag(state: State<AppState>, id: i64) -> Result<(), String>;

// ═══════════════════════════════════
// 文件夹
// ═══════════════════════════════════
#[tauri::command]
fn list_folders(state: State<AppState>) -> Result<Vec<Folder>, String>;

#[tauri::command]
fn create_folder(state: State<AppState>, name: String, parent_id: Option<i64>) -> Result<Folder, String>;

#[tauri::command]
fn rename_folder(state: State<AppState>, id: i64, name: String) -> Result<(), String>;

#[tauri::command]
fn delete_folder(state: State<AppState>, id: i64) -> Result<(), String>;
// 注：文件夹下的笔记 folder_id 置 NULL，不级联删除笔记

#[tauri::command]
fn move_note_to_folder(state: State<AppState>, note_id: i64, folder_id: Option<i64>) -> Result<(), String>;

// ═══════════════════════════════════
// 每日笔记
// ═══════════════════════════════════
#[tauri::command]
fn get_or_create_daily(state: State<AppState>, date: String) -> Result<Note, String>;

// ═══════════════════════════════════
// 回收站
// ═══════════════════════════════════
#[tauri::command]
fn list_trash(state: State<AppState>) -> Result<Vec<Note>, String>;

#[tauri::command]
fn restore_note(state: State<AppState>, id: i64) -> Result<(), String>;

#[tauri::command]
fn permanent_delete(state: State<AppState>, id: i64) -> Result<(), String>;

#[tauri::command]
fn empty_trash(state: State<AppState>) -> Result<usize, String>;
// 返回删除的笔记数量

// ═══════════════════════════════════
// AI 对话
// ═══════════════════════════════════
#[tauri::command]
async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: Option<i64>,
    message: String,
    model_id: Option<i64>,
) -> Result<i64, String>;
// 发送消息并开始流式回答
// 1. 用 FTS5 搜索与 message 相关的笔记（RAG 检索，取 top 5）
// 2. 拼接系统提示词 + 笔记上下文 + 用户问题
// 3. 调用 AI API（reqwest 流式请求）
// 4. 通过 Tauri Event "ai:stream-chunk" 逐块推送到前端
// 5. 完成后发送 "ai:stream-done" 事件
// 返回 conversation_id

#[tauri::command]
fn ai_stop_generation(state: State<AppState>) -> Result<(), String>;
// 中断当前 AI 生成（通过 CancellationToken）

#[tauri::command]
fn list_ai_conversations(
    state: State<AppState>,
    note_id: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<AiConversation>, String>;

#[tauri::command]
fn get_ai_conversation(
    state: State<AppState>,
    id: i64,
) -> Result<AiConversationDetail, String>;
// 返回对话 + 所有消息

#[tauri::command]
fn delete_ai_conversation(state: State<AppState>, id: i64) -> Result<(), String>;

// ═══════════════════════════════════
// AI 模型管理
// ═══════════════════════════════════
#[tauri::command]
fn list_ai_models(state: State<AppState>) -> Result<Vec<AiModel>, String>;

#[tauri::command]
fn save_ai_model(state: State<AppState>, model: AiModelInput) -> Result<AiModel, String>;
// 创建或更新

#[tauri::command]
fn delete_ai_model(state: State<AppState>, id: i64) -> Result<(), String>;

#[tauri::command]
fn set_default_model(state: State<AppState>, id: i64) -> Result<(), String>;

#[tauri::command]
async fn test_ai_connection(state: State<'_, AppState>, id: i64) -> Result<String, String>;
// 测试模型连接是否正常，返回模型名称

// ═══════════════════════════════════
// AI 写作辅助（笔记内操作）
// ═══════════════════════════════════
#[tauri::command]
async fn ai_summarize(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<String, String>;
// 对指定笔记生成摘要

#[tauri::command]
async fn ai_continue_writing(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
    selected_text: String,
) -> Result<(), String>;
// 基于选中文本续写，流式推送 "ai:writing-chunk"
```

### 事务管理

保存笔记时涉及多表写入，必须在事务中完成：

```rust
// services/note.rs — update 流程示意
pub fn update(db: &Database, id: i64, input: NoteInput) -> Result<Note, AppError> {
    let conn = db.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
    let tx = conn.unchecked_transaction()?;

    // 1. 更新 notes 表
    // 2. 正则提取 #tags → 同步 note_tags 表（diff 增删）
    // 3. 正则提取 [[links]] → 同步 note_links 表（diff 增删）
    // 4. 计算 word_count → 更新字段
    // 注：FTS5 由触发器自动同步，不需要手动操作

    tx.commit()?;
    // 5. 查询完整 Note（含 tags）返回
}
```

### 并发安全

```
Database {
    conn: Mutex<Connection>    // 全局唯一连接，Mutex 保护
}

AppState {
    db: Database               // tauri::State<AppState> 注入到 Command
}
```

- SQLite 单写者模型，`Mutex<Connection>` 即可保证安全
- 所有 Command 通过 `state.db.conn.lock()` 获取连接
- 持有锁的时间尽量短（操作完立即释放）
- 未来如果并发要求高，可考虑 WAL 模式 + 连接池

---

## 前端架构

### 页面结构

```
src/pages/
├── home/index.tsx              — 首页（最近笔记 + 快速搜索 + 今日笔记）
├── notes/
│   ├── index.tsx               — 笔记列表（多视图切换）
│   └── [id].tsx                — 笔记编辑（Tiptap 编辑器 + 反向链接面板）
├── search/index.tsx            — 全文搜索结果页
├── graph/index.tsx             — 知识图谱可视化
├── daily/index.tsx             — 每日笔记（日历 + 编辑器）
├── tags/index.tsx              — 标签管理（标签云 + 关联笔记）
├── ai/
│   ├── index.tsx               — AI 对话列表 + 新建对话
│   └── [id].tsx                — AI 对话详情（聊天界面）
├── trash/index.tsx             — 回收站（恢复/永久删除）
├── settings/
│   ├── index.tsx               — 通用设置
│   └── ai.tsx                  — AI 模型配置（模型列表/添加/测试连接）
└── about/index.tsx             — 关于页（框架自带）
```

### 路由设计

```typescript
// src/Router.tsx
const routes = [
  { path: "/",              element: <HomePage /> },
  { path: "/notes",         element: <NoteListPage /> },
  { path: "/notes/:id",     element: <NoteEditPage /> },
  { path: "/search",        element: <SearchPage /> },       // ?q=keyword
  { path: "/graph",         element: <GraphPage /> },
  { path: "/daily",         element: <DailyPage /> },        // ?date=2026-03-18
  { path: "/tags",          element: <TagsPage /> },
  { path: "/tags/:name",    element: <TagNotesPage /> },     // 某标签下的笔记
  { path: "/ai",            element: <AiChatListPage /> },   // AI 对话列表
  { path: "/ai/:id",        element: <AiChatPage /> },       // AI 对话详情
  { path: "/trash",         element: <TrashPage /> },
  { path: "/settings",      element: <SettingsPage /> },
  { path: "/settings/ai",   element: <AiSettingsPage /> },   // AI 模型配置
  { path: "/about",         element: <AboutPage /> },
];
```

### 组件层次

```
src/components/
├── layout/
│   ├── AppLayout.tsx           — 主布局（Sider + Header + Content）
│   └── Sidebar.tsx             — 侧边栏（导航 + 文件夹树）
├── ui/
│   └── ErrorBoundary.tsx       — 错误边界
├── editor/
│   ├── TiptapEditor.tsx        — Tiptap 编辑器主组件
│   ├── extensions/
│   │   ├── WikiLink.ts         — [[]] 双向链接扩展
│   │   └── HashTag.ts          — #tag 标签扩展
│   ├── Toolbar.tsx             — 编辑器工具栏
│   └── SlashCommand.tsx        — / 命令面板
├── note/
│   ├── NoteCard.tsx            — 笔记卡片（卡片视图）
│   ├── BacklinksPanel.tsx      — 反向链接面板
│   └── TagList.tsx             — 标签列表
├── search/
│   ├── SearchInput.tsx         — 搜索输入框（全局可用）
│   └── SearchResultItem.tsx    — 搜索结果项（高亮片段）
├── graph/
│   └── KnowledgeGraph.tsx      — @antv/g6 图谱组件
└── ai/
    ├── ChatPanel.tsx           — AI 聊天面板（消息列表 + 输入框）
    ├── ChatMessage.tsx         — 单条消息（支持 Markdown 渲染 + 来源笔记链接）
    ├── ModelSelector.tsx       — 模型切换下拉框
    ├── SourceNotes.tsx         — 引用来源笔记列表（点击跳转）
    └── WritingAssist.tsx       — 编辑器内 AI 写作辅助浮窗
```

### Zustand Store 设计

```typescript
// src/store/index.ts
interface AppStore {
  // ─── 框架自带 ───
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  toggleSidebar: () => void;

  // ─── 知识库 ───
  currentNoteId: number | null;
  setCurrentNote: (id: number | null) => void;

  searchQuery: string;
  setSearchQuery: (query: string) => void;

  viewMode: 'list' | 'card' | 'timeline' | 'graph';
  setViewMode: (mode: ViewMode) => void;

  // 文件夹树展开状态
  expandedFolderIds: number[];
  toggleFolder: (id: number) => void;
}
```

### API 封装

```typescript
// src/lib/api/index.ts
import { invoke } from "@tauri-apps/api/core";
import type {
  Note, NoteInput, NoteQuery, PageResult,
  SearchResult, GraphData, Tag, Folder
} from "@/types";

export const noteApi = {
  create: (input: NoteInput) =>
    invoke<Note>("create_note", { input }),
  update: (id: number, input: NoteInput) =>
    invoke<Note>("update_note", { id, input }),
  delete: (id: number) =>
    invoke<void>("delete_note", { id }),
  get: (id: number) =>
    invoke<Note>("get_note", { id }),
  list: (query: NoteQuery) =>
    invoke<PageResult<Note>>("list_notes", { query }),
  togglePin: (id: number) =>
    invoke<boolean>("toggle_pin", { id }),
};

export const searchApi = {
  search: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_notes", { query, limit }),
};

export const linkApi = {
  getBacklinks: (noteId: number) =>
    invoke<Note[]>("get_backlinks", { noteId }),
  getGraphData: () =>
    invoke<GraphData>("get_graph_data"),
};

export const tagApi = {
  list: () => invoke<Tag[]>("list_tags"),
  rename: (id: number, newName: string) =>
    invoke<void>("rename_tag", { id, newName }),
  delete: (id: number) =>
    invoke<void>("delete_tag", { id }),
};

export const folderApi = {
  list: () => invoke<Folder[]>("list_folders"),
  create: (name: string, parentId?: number) =>
    invoke<Folder>("create_folder", { name, parentId }),
  rename: (id: number, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  delete: (id: number) =>
    invoke<void>("delete_folder", { id }),
  moveNote: (noteId: number, folderId?: number) =>
    invoke<void>("move_note_to_folder", { noteId, folderId }),
};

export const dailyApi = {
  getOrCreate: (date: string) =>
    invoke<Note>("get_or_create_daily", { date }),
};

export const trashApi = {
  list: () => invoke<Note[]>("list_trash"),
  restore: (id: number) => invoke<void>("restore_note", { id }),
  permanentDelete: (id: number) => invoke<void>("permanent_delete", { id }),
  empty: () => invoke<number>("empty_trash"),
};

export const aiApi = {
  chat: (conversationId: number | null, message: string, modelId?: number) =>
    invoke<number>("ai_chat", { conversationId, message, modelId }),
  stopGeneration: () =>
    invoke<void>("ai_stop_generation"),
  listConversations: (noteId?: number, limit?: number) =>
    invoke<AiConversation[]>("list_ai_conversations", { noteId, limit }),
  getConversation: (id: number) =>
    invoke<AiConversationDetail>("get_ai_conversation", { id }),
  deleteConversation: (id: number) =>
    invoke<void>("delete_ai_conversation", { id }),
  summarize: (noteId: number) =>
    invoke<string>("ai_summarize", { noteId }),
  continueWriting: (noteId: number, selectedText: string) =>
    invoke<void>("ai_continue_writing", { noteId, selectedText }),
};

export const aiModelApi = {
  list: () => invoke<AiModel[]>("list_ai_models"),
  save: (model: AiModelInput) => invoke<AiModel>("save_ai_model", { model }),
  delete: (id: number) => invoke<void>("delete_ai_model", { id }),
  setDefault: (id: number) => invoke<void>("set_default_model", { id }),
  testConnection: (id: number) => invoke<string>("test_ai_connection", { id }),
};
```

### TypeScript 类型

```typescript
// src/types/index.ts

// ─── 笔记 ───
export interface Note {
  id: number;
  title: string;
  content: string;
  folder_id: number | null;
  is_daily: boolean;
  daily_date: string | null;
  is_pinned: boolean;
  tags: string[];
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface NoteInput {
  title: string;
  content: string;
  folder_id?: number | null;
}

export interface NoteQuery {
  folder_id?: number | null;
  tag?: string | null;
  is_pinned?: boolean | null;
  keyword?: string | null;
  page?: number;
  page_size?: number;
}

// ─── 分页 ───
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// ─── 搜索 ───
export interface SearchResult {
  note_id: number;
  title: string;
  snippet: string;
  rank: number;
  tags: string[];
  updated_at: string;
}

// ─── 图谱 ───
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: number;
  title: string;
  tag_count: number;
  link_count: number;
}

export interface GraphEdge {
  source: number;
  target: number;
}

// ─── 标签 ───
export interface Tag {
  id: number;
  name: string;
  color: string | null;
  note_count: number;
}

// ─── 文件夹 ───
export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  children: Folder[];
  note_count: number;
}

// ─── 视图模式 ───
export type ViewMode = 'list' | 'card' | 'timeline' | 'graph';

// ─── AI 对话 ───
export interface AiConversation {
  id: number;
  note_id: number | null;
  title: string;
  model: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface AiConversationDetail {
  conversation: AiConversation;
  messages: AiMessage[];
}

export interface AiMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  source_note_ids: number[];
  token_count: number | null;
  created_at: string;
}

// ─── AI 模型 ───
export interface AiModel {
  id: number;
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  name: string;
  model_id: string;
  api_url: string;
  api_key: string | null;
  is_default: boolean;
  is_enabled: boolean;
}

export interface AiModelInput {
  id?: number;
  provider: string;
  name: string;
  model_id: string;
  api_url: string;
  api_key?: string;
}

// ─── AI 流式事件 ───
export interface AiStreamChunk {
  conversation_id: number;
  content: string;
  done: boolean;
}
```

---

## 关键业务流程

### 1. 保存笔记（自动提取标签和链接）

```
用户编辑笔记 → 点击保存 / Ctrl+S / 自动保存(debounce 2s)
  → invoke("update_note", { id, input })
    → NoteService::update()
      [开启事务]
      ├── 1. 更新 notes 表（title, content, updated_at）
      ├── 2. 计算 word_count 并更新
      ├── 3. 正则提取 #tag → diff 当前标签 vs 已有标签
      │      ├── 新增标签：tags 表 INSERT OR IGNORE → note_tags INSERT
      │      └── 移除标签：note_tags DELETE → 清理无引用 tags
      ├── 4. 正则提取 [[link]] → 查找 target note by title
      │      ├── 目标存在：note_links INSERT OR IGNORE
      │      └── 目标不存在：忽略（不自动创建空笔记）
      │      └── 移除旧链接：diff 删除不再引用的 note_links
      [提交事务]
      ├── 5. FTS5 由触发器自动同步（无需手动操作）
      └── 6. 查询完整 Note（含 tags）返回前端
```

### 2. 全文搜索

```
用户输入搜索词 → debounce 300ms → 非空则发起搜索
  → invoke("search_notes", { query, limit: 20 })
    → SearchService::search()
      → SELECT note_id, title,
               snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32),
               bm25(notes_fts) as rank
        FROM notes_fts
        WHERE notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      → 过滤软删除笔记（JOIN notes WHERE is_deleted = 0）
      → 填充 tags 字段
  → 前端渲染：List 组件，snippet 中的 <mark> 标签高亮显示
```

### 3. 知识图谱渲染

```
打开图谱页面
  → invoke("get_graph_data")
    → GraphService::build()
      → 查询所有未删除笔记（id, title, tag_count）
      → 查询所有链接（source_id, target_id）
      → 计算每个节点的 link_count（入链 + 出链）
      → 返回 { nodes, edges }
  → @antv/g6 渲染力导向图
    → 节点大小 = Math.max(20, link_count * 5)（链接越多越大）
    → 节点颜色 = 按标签数量梯度着色
    → 点击节点 → navigate(`/notes/${id}`)
    → 悬停节点 → Tooltip 显示标题 + 标签
    → 支持缩放/拖拽/框选
```

### 4. 软删除和回收站

```
删除笔记
  → invoke("delete_note", { id })
    → UPDATE notes SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?
    → 不删除关联数据（tags, links 保留）

恢复笔记
  → invoke("restore_note", { id })
    → UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?

永久删除
  → invoke("permanent_delete", { id })
    → DELETE FROM notes WHERE id = ? (CASCADE 自动清理关联表)

清空回收站
  → invoke("empty_trash")
    → DELETE FROM notes WHERE is_deleted = 1
    → 清理孤立标签（无关联笔记的 tags）
    → 返回删除数量
```

### 5. AI 知识问答（RAG 流程）

```
用户在 AI 对话页输入问题
  → invoke("ai_chat", { conversationId, message, modelId })
    → AiService::chat()
      ├── 1. RAG 检索：用 FTS5 搜索与问题相关的笔记（top 5）
      │      SELECT note_id, title, snippet(notes_fts, 1, '', '', '...', 200)
      │      FROM notes_fts WHERE notes_fts MATCH ?
      │      ORDER BY bm25(notes_fts) LIMIT 5
      │
      ├── 2. 构建提示词：
      │      System: "你是知识库助手，基于用户的笔记内容回答问题。
      │               引用笔记时使用 [笔记标题](note://id) 格式。"
      │      Context: "以下是相关笔记内容：\n\n
      │                --- 笔记: {title1} (ID: {id1}) ---\n{content1}\n\n
      │                --- 笔记: {title2} (ID: {id2}) ---\n{content2}\n\n..."
      │      User: "{用户问题}"
      │
      ├── 3. 保存用户消息到 ai_messages 表
      │
      ├── 4. 调用 AI API（reqwest 流式请求）
      │      ├── OpenAI: POST /v1/chat/completions (stream: true)
      │      ├── Claude: POST /v1/messages (stream: true)
      │      └── Ollama: POST /api/chat (stream: true)
      │
      ├── 5. 流式推送：每收到一个 chunk
      │      → app.emit("ai:stream-chunk", AiStreamChunk { content, done: false })
      │      → 前端 listen("ai:stream-chunk") 实时追加显示
      │
      ├── 6. 完成后：
      │      → 保存完整 assistant 消息到 ai_messages（含 source_note_ids）
      │      → app.emit("ai:stream-chunk", AiStreamChunk { content: "", done: true })
      │
      └── 7. 返回 conversation_id

前端监听流式事件：
  listen("ai:stream-chunk", (event) => {
    if (event.payload.done) {
      setGenerating(false);
    } else {
      setCurrentResponse(prev => prev + event.payload.content);
    }
  });
```

### 6. 每日笔记

```
打开每日笔记页 / 点击首页"今日笔记"
  → invoke("get_or_create_daily", { date: "2026-03-18" })
    → DailyService::get_or_create()
      → SELECT * FROM notes WHERE is_daily = 1 AND daily_date = ?
      → 存在 → 返回
      → 不存在 → INSERT notes (title: "2026-03-18", is_daily: 1, daily_date: "2026-03-18")
                → 返回新创建的笔记
  → 进入编辑器界面
```

---

## 性能策略

### 搜索性能

| 场景 | 策略 |
|------|------|
| 实时搜索 | 前端 debounce 300ms，避免频繁 invoke |
| FTS5 索引 | 触发器自动维护，无需手动 rebuild |
| 结果数量 | 默认 limit 20，按需加载更多 |
| 空搜索 | 不走 FTS5，直接查最近编辑笔记（走 idx_notes_updated 索引） |

### 列表性能

| 场景 | 策略 |
|------|------|
| 分页 | PageResult 分页返回，默认 20 条/页 |
| 列表渲染 | Ant Design Table 虚拟滚动（dataSource 分页） |
| 图谱大量节点 | G6 Canvas 渲染（不用 SVG），1000 节点内流畅 |

### 编辑器性能

| 场景 | 策略 |
|------|------|
| 自动保存 | debounce 2s，用户停止输入后保存 |
| 大文档 | Tiptap 基于 ProseMirror，支持大文档（10万字级别） |
| `[[` 补全 | 前端缓存笔记标题列表，输入时本地过滤 |

### SQLite 优化

```sql
-- 启用 WAL 模式（读写并发更好，Phase 2 可开启）
PRAGMA journal_mode = WAL;

-- 启用外键约束
PRAGMA foreign_keys = ON;

-- 合理的缓存大小
PRAGMA cache_size = -8000;  -- 8MB
```

---

## 测试策略

### Rust 后端

| 层级 | 测试类型 | 工具 | 说明 |
|------|---------|------|------|
| Database 层 | 单元测试 | `cargo test` | 内存 SQLite（`:memory:`）测试 DAO |
| Service 层 | 集成测试 | `cargo test` | 测试业务逻辑（含 DB 操作） |
| Command 层 | 接口测试 | `cargo test` | 测试参数校验和错误处理 |

```rust
// 测试示例：内存数据库
#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Database {
        let db = Database::new(":memory:").unwrap();
        // run_migrations 会创建所有表
        db
    }

    #[test]
    fn test_create_and_get_note() {
        let db = setup_test_db();
        let note = db.create_note("Test", "Content", None).unwrap();
        assert_eq!(note.title, "Test");
        let fetched = db.get_note(note.id).unwrap().unwrap();
        assert_eq!(fetched.id, note.id);
    }
}
```

### React 前端

| 层级 | 测试类型 | 工具 | 说明 |
|------|---------|------|------|
| 组件 | 组件测试 | Vitest + Testing Library | 渲染和交互 |
| Store | 单元测试 | Vitest | Zustand store 逻辑 |
| API | Mock 测试 | Vitest + vi.mock | Mock invoke 调用 |

---

## 开发路线

### Phase 1：基础 CRUD（1 周）

**目标**：能创建、编辑、查看、删除笔记

- [ ] 数据库 Schema 迁移（Version 0 → 1）
- [ ] 笔记 CRUD 三层架构（Command → Service → Database）
- [ ] 文件夹 CRUD 三层架构
- [ ] 笔记列表页（Ant Design Table，支持分页）
- [ ] 简单 Markdown 渲染（react-markdown，只读预览）
- [ ] 侧边栏文件夹树

**依赖**：无（基于框架现有基础）

### Phase 2：搜索 + 标签（1 周）

**目标**：能全文搜索、按标签筛选

- [ ] FTS5 虚拟表 + 触发器
- [ ] 搜索 Command + Service + DAO
- [ ] 搜索页面（高亮结果展示）
- [ ] 标签自动提取（保存笔记时）
- [ ] 标签管理页面（标签云 + 筛选）
- [ ] 列表页多条件筛选（标签 + 文件夹 + 关键词）

**依赖**：Phase 1（需要 notes 表和基础 CRUD）

### Phase 3：编辑器 + 双向链接（1-2 周）

**目标**：所见即所得编辑，双向链接可用

- [ ] 集成 Tiptap 编辑器
- [ ] 编辑器工具栏（标题/加粗/列表/代码块）
- [ ] `[[]]` WikiLink 扩展（Mention 改造）
- [ ] `#tag` HashTag 扩展
- [ ] 反向链接面板（笔记编辑页底部）
- [ ] 链接自动提取（保存时解析 `[[]]`）
- [ ] 替换 Phase 1 的简单 Markdown 渲染

**依赖**：Phase 2（需要标签和搜索支持补全）

### Phase 4：图谱 + 每日笔记 + 回收站（1 周）

**目标**：知识图谱可视化，每日笔记，软删除

- [ ] 知识图谱页面（@antv/g6 力导向图）
- [ ] 图谱数据 Command + Service
- [ ] 每日笔记功能（get_or_create_daily）
- [ ] 全局快捷键快速捕获（tauri-plugin-global-shortcut）
- [ ] 系统托盘常驻
- [ ] 软删除 + 回收站页面

**依赖**：Phase 3（需要链接数据来渲染图谱）

### Phase 5：AI 知识问答（1-2 周）

**目标**：AI 基于你的笔记回答问题，核心差异化功能

- [ ] AI 模型配置表 + CRUD（Schema Version 3→4）
- [ ] AI 对话/消息表 + CRUD
- [ ] AI 提供商抽象层（OpenAI / Claude / Ollama 统一接口）
- [ ] RAG 检索（FTS5 搜索相关笔记 → 拼接上下文）
- [ ] 流式响应（reqwest stream → Tauri Event → 前端实时显示）
- [ ] AI 对话页面（聊天 UI + 消息列表 + 来源笔记引用）
- [ ] AI 模型设置页面（添加/编辑/测试连接/设为默认）
- [ ] 中断生成功能（CancellationToken）
- [ ] 插入默认模型配置（Ollama llama3 本地 + OpenAI gpt-4o-mini）

**依赖**：Phase 2（需要 FTS5 搜索能力做 RAG 检索）

**关键 Rust 依赖**：
- `reqwest` (features: stream) — HTTP 流式请求
- `tokio` — 异步运行时（Tauri 已内置）
- `futures` — Stream trait 处理

### Phase 6：AI 写作辅助 + 多视图 + 打磨（1-2 周）

**目标**：编辑器内 AI 辅助，体验完善，准备发布

- [ ] 编辑器内 AI 写作辅助（选中文本 → 续写/总结/改写/翻译）
- [ ] AI 摘要（一键生成笔记摘要）
- [ ] 多视图切换（列表/卡片/时间线）
- [ ] 首页改造（最近笔记 + 快速搜索 + 今日笔记 + 统计）
- [ ] 导入 Obsidian vault / Typora 文件夹
- [ ] 笔记收藏/置顶
- [ ] 性能优化（WAL 模式、列表虚拟滚动）
- [ ] 打包发布

**依赖**：Phase 5

---

## 额外需要的 Capabilities

当前框架已有：`core:default`, `opener:default`, `store:default`, `log:default`

知识库新增需要：

| 权限 | 用途 | 引入阶段 |
|------|------|---------|
| `fs:default` | 导入/导出 Markdown 文件 | Phase 5 |
| `dialog:default` | 文件选择对话框（导入） | Phase 5 |
| `global-shortcut:default` | 全局快捷键（快速捕获） | Phase 4 |
| `http:default` | AI API 网络请求（reqwest 需要） | Phase 5 |

---

## 风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|---------|
| FTS5 中文分词精度不够 | 搜索体验差 | unicode61 够用于关键词搜索；后续可引入 jieba-rs 自定义 tokenizer |
| Tiptap 集成复杂度高 | Phase 3 延期 | 先用基础配置，扩展（WikiLink/HashTag）可迭代开发 |
| G6 大量节点性能 | 图谱卡顿 | Canvas 渲染 + 节点数量限制（>500 时只显示高连接度节点） |
| SQLite 单写并发瓶颈 | 多操作阻塞 | 桌面应用并发低，Mutex 足够；后续可开 WAL |
| 软删除导致查询条件增多 | SQL 复杂度上升 | 所有列表查询默认 `WHERE is_deleted = 0`，用部分索引优化 |
| AI API 响应慢/超时 | 用户等待时间长 | 流式显示（逐字输出）+ 超时取消 + Ollama 本地模型作为备选 |
| AI API Key 泄露 | 安全风险 | API Key 存 SQLite（本地文件），不上传到任何服务器 |
| RAG 检索精度不够 | AI 回答不相关 | FTS5 BM25 排序取 top 5，后续可引入 embedding 向量检索 |
| Ollama 未安装/未启动 | 本地模型不可用 | 测试连接功能检测，给出安装引导提示 |
