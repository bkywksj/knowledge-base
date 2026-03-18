# Knowledge Base 架构设计文档

> 本地知识库桌面应用 — 搜、链、图

## 产品定位

**Typora 是"写一篇文档"的工具，我们要做的是"管理一千篇文档之间关系"的工具。**

与 Typora 的差异：

| Typora 的边界 | Knowledge Base 的能力 |
|---|---|
| 编辑单个 .md 文件 | 管理成百上千篇笔记的组织和检索 |
| 文件夹树状浏览 | 全文搜索（跨所有笔记瞬间找到内容） |
| 无链接概念 | 双向链接（笔记 A 提到笔记 B，B 自动知道被 A 引用） |
| 无标签系统 | 多维分类（标签 + 文件夹 + 链接三种组织方式并存） |
| 无知识图谱 | 可视化关系网（看到知识之间的关联） |
| 纯编辑器，无数据库 | 结构化元数据（创建时间、修改时间、标签可查询筛选） |

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | Rust 2021 + Tauri 2.x | 三层架构 |
| 前端 | React 19 + TypeScript 5.8 | 函数组件 + Hooks |
| UI | Ant Design 5 + TailwindCSS 4 | 组件库 + 原子样式 |
| 状态 | Zustand 5 | 全局状态管理 |
| 路由 | React Router 7 (HashRouter) | SPA 路由 |
| 数据库 | SQLite (rusqlite bundled) | 本地持久化 |
| 全文搜索 | SQLite FTS5 | 内置全文索引 |
| 编辑器 | Milkdown / Tiptap (待选型) | Markdown 编辑 |
| 图谱可视化 | @antv/g6 或 D3.js (待选型) | 知识图谱渲染 |
| 应用标识 | com.agilefr.kb | Tauri identifier |

---

## 功能优先级

### P0 — 核心差异（MVP 必备）

#### 1. 全文搜索引擎

- **Rust 侧**：SQLite FTS5 全文索引，毫秒级搜索
- **前端**：实时搜索框，结果高亮，Ant Design List 展示
- **数据流**：`SearchInput → invoke("search_notes") → FTS5 查询 → 高亮结果`

#### 2. 双向链接 + 知识图谱

- **语法**：`[[笔记名]]` 在编辑器中自动识别
- **反向链接**：每篇笔记底部展示"谁引用了我"
- **图谱**：可视化展示笔记间的关联关系
- **存储**：`note_links` 表记录链接关系（source_id → target_id）

#### 3. 标签 + 智能筛选

- **语法**：`#标签` 自动提取
- **存储**：`note_tags` 多对多关系表
- **筛选**：按标签、日期、关键词组合筛选
- **UI**：Ant Design Tag + Table + Select 组件

### P1 — 体验优势

#### 4. 每日笔记 / 快速捕获

- 全局快捷键唤出小窗口，随手记一条想法
- 自动按日期归档
- Tauri 托盘常驻 + 全局热键

#### 5. Markdown 编辑器

- 使用 Milkdown 或 Tiptap（不自己造轮子）
- 集成双向链接语法 `[[]]`
- 集成标签语法 `#tag`
- 实时预览

#### 6. 多视图浏览

- 列表视图（Ant Design Table）
- 卡片视图（Card Grid）
- 时间线视图（Timeline）
- 图谱视图（Graph）

### P2 — 锦上添花

| 功能 | 说明 | 技术要点 |
|------|------|---------|
| 网页剪藏 | 浏览器扩展 → 发送到本地应用 | 自定义协议 |
| AI 摘要 | 对长笔记自动生成摘要和关键词 | Rust 调 AI API |
| 模板系统 | 会议记录/读书笔记/日记模板 | SQLite 存模板 |
| 导入导出 | 兼容 Obsidian vault、Typora 文件夹 | 直接读 .md 文件 |
| 版本历史 | 每次保存自动存快照 | SQLite 存 diff |
| 附件管理 | 图片/PDF 统一管理 | 文件系统 + DB 存路径 |

---

## 数据库设计

### 核心表

```sql
-- 笔记表
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    folder_id   INTEGER REFERENCES folders(id),
    is_daily    BOOLEAN NOT NULL DEFAULT 0,
    daily_date  TEXT,                          -- YYYY-MM-DD，每日笔记专用
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 全文搜索虚拟表（FTS5）
CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content,
    content=notes,
    content_rowid=id,
    tokenize='unicode61'        -- 支持中文分词
);

-- 标签表
CREATE TABLE tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- 笔记-标签关联（多对多）
CREATE TABLE note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

-- 双向链接表
CREATE TABLE note_links (
    source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, target_id)
);

-- 文件夹表
CREATE TABLE folders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id),
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- 应用配置表（框架自带）
CREATE TABLE app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### 索引

```sql
CREATE INDEX idx_notes_folder ON notes(folder_id);
CREATE INDEX idx_notes_daily ON notes(is_daily, daily_date);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
CREATE INDEX idx_note_links_target ON note_links(target_id);
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
└── commands/system.rs      — 系统信息（框架自带）

Services 层（业务逻辑）
├── services/note.rs        — 笔记业务（保存时自动提取标签和链接）
├── services/search.rs      — 搜索业务（FTS5 查询 + 结果高亮）
├── services/link.rs        — 链接解析（解析 [[]] 语法，维护链接表）
├── services/tag.rs         — 标签业务（自动提取 #tag）
└── services/graph.rs       — 图谱数据（生成节点和边）

Database 层（数据访问）
├── database/mod.rs         — Database struct + 连接管理
├── database/schema.rs      — Schema 迁移（PRAGMA user_version）
├── database/notes.rs       — 笔记 DAO
├── database/tags.rs        — 标签 DAO
├── database/links.rs       — 链接 DAO
├── database/folders.rs     — 文件夹 DAO
└── database/search.rs      — FTS5 搜索 DAO
```

### 核心数据模型 (models/)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
    pub is_daily: bool,
    pub daily_date: Option<String>,
    pub tags: Vec<String>,          // 前端展示用
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub note_id: i64,
    pub title: String,
    pub snippet: String,            // FTS5 snippet() 高亮片段
    pub rank: f64,                  // 相关度排序
}

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
    pub link_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: i64,
    pub target: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub note_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub children: Vec<Folder>,      // 树形结构
}
```

### 关键 Command 接口

```rust
// --- 笔记 ---
#[tauri::command]
fn create_note(state: State<AppState>, title: String, content: String, folder_id: Option<i64>) -> Result<Note, String>;

#[tauri::command]
fn update_note(state: State<AppState>, id: i64, title: String, content: String) -> Result<Note, String>;

#[tauri::command]
fn delete_note(state: State<AppState>, id: i64) -> Result<(), String>;

#[tauri::command]
fn get_note(state: State<AppState>, id: i64) -> Result<Note, String>;

#[tauri::command]
fn list_notes(state: State<AppState>, folder_id: Option<i64>, tag: Option<String>) -> Result<Vec<Note>, String>;

// --- 搜索 ---
#[tauri::command]
fn search_notes(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String>;

// --- 链接 ---
#[tauri::command]
fn get_backlinks(state: State<AppState>, note_id: i64) -> Result<Vec<Note>, String>;

#[tauri::command]
fn get_graph_data(state: State<AppState>) -> Result<GraphData, String>;

// --- 标签 ---
#[tauri::command]
fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String>;

// --- 文件夹 ---
#[tauri::command]
fn list_folders(state: State<AppState>) -> Result<Vec<Folder>, String>;

#[tauri::command]
fn create_folder(state: State<AppState>, name: String, parent_id: Option<i64>) -> Result<Folder, String>;

// --- 每日笔记 ---
#[tauri::command]
fn get_or_create_daily(state: State<AppState>, date: String) -> Result<Note, String>;
```

---

## 前端架构

### 页面结构

```
src/pages/
├── home/index.tsx              — 首页（最近笔记 + 快速搜索）
├── notes/
│   ├── index.tsx               — 笔记列表（多视图切换）
│   └── [id].tsx                — 笔记编辑（Markdown 编辑器）
├── search/index.tsx            — 搜索结果页
├── graph/index.tsx             — 知识图谱可视化
├── daily/index.tsx             — 每日笔记
├── tags/index.tsx              — 标签管理
├── settings/index.tsx          — 设置页（框架自带）
└── about/index.tsx             — 关于页（框架自带）
```

### Zustand Store 设计

```typescript
// src/store/index.ts
interface AppStore {
  // 框架自带
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  toggleSidebar: () => void;

  // 知识库新增
  currentNoteId: number | null;
  setCurrentNote: (id: number | null) => void;

  searchQuery: string;
  setSearchQuery: (query: string) => void;

  viewMode: 'list' | 'card' | 'timeline';
  setViewMode: (mode: 'list' | 'card' | 'timeline') => void;
}
```

### API 封装

```typescript
// src/lib/api/index.ts
export const noteApi = {
  create: (title: string, content: string, folderId?: number) =>
    invoke<Note>("create_note", { title, content, folderId }),
  update: (id: number, title: string, content: string) =>
    invoke<Note>("update_note", { id, title, content }),
  delete: (id: number) => invoke<void>("delete_note", { id }),
  get: (id: number) => invoke<Note>("get_note", { id }),
  list: (folderId?: number, tag?: string) =>
    invoke<Note[]>("list_notes", { folderId, tag }),
};

export const searchApi = {
  search: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_notes", { query, limit }),
};

export const linkApi = {
  getBacklinks: (noteId: number) =>
    invoke<Note[]>("get_backlinks", { noteId }),
  getGraphData: () => invoke<GraphData>("get_graph_data"),
};

export const tagApi = {
  list: () => invoke<Tag[]>("list_tags"),
};

export const folderApi = {
  list: () => invoke<Folder[]>("list_folders"),
  create: (name: string, parentId?: number) =>
    invoke<Folder>("create_folder", { name, parentId }),
};

export const dailyApi = {
  getOrCreate: (date: string) =>
    invoke<Note>("get_or_create_daily", { date }),
};
```

### TypeScript 类型

```typescript
// src/types/index.ts
export interface Note {
  id: number;
  title: string;
  content: string;
  folder_id: number | null;
  is_daily: boolean;
  daily_date: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  note_id: number;
  title: string;
  snippet: string;
  rank: number;
}

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

export interface Tag {
  id: number;
  name: string;
  note_count: number;
}

export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  children: Folder[];
}
```

---

## 关键业务流程

### 保存笔记时自动提取标签和链接

```
用户编辑笔记 → 点击保存
  → invoke("update_note")
    → NoteService::update()
      ├── 正则提取 #tag → 更新 note_tags 表
      ├── 正则提取 [[link]] → 更新 note_links 表
      ├── 更新 notes 表内容
      └── 同步更新 FTS5 索引
```

### 全文搜索流程

```
用户输入搜索词 → debounce 300ms
  → invoke("search_notes", { query })
    → SearchService::search()
      → FTS5 MATCH 查询
      → snippet() 生成高亮片段
      → rank 排序返回
  → 前端渲染高亮结果列表
```

### 知识图谱渲染

```
打开图谱页面
  → invoke("get_graph_data")
    → GraphService::build()
      → 查询所有笔记（nodes）
      → 查询所有链接（edges）
      → 返回 GraphData
  → @antv/g6 渲染力导向图
    → 节点大小 = 链接数量
    → 点击节点 → 跳转编辑
```

---

## 开发路线

### Phase 1：基础 CRUD（1 周）

- [ ] 数据库 Schema 设计 + 迁移
- [ ] 笔记 CRUD（Command → Service → Database）
- [ ] 文件夹管理
- [ ] 笔记列表页（Ant Design Table）
- [ ] 简单 Markdown 渲染（非编辑）

### Phase 2：搜索 + 标签（1 周）

- [ ] FTS5 全文搜索
- [ ] 搜索结果高亮
- [ ] 标签自动提取
- [ ] 按标签筛选
- [ ] 搜索页面

### Phase 3：编辑器 + 链接（1-2 周）

- [ ] 集成 Milkdown/Tiptap 编辑器
- [ ] `[[]]` 双向链接语法支持
- [ ] 反向链接展示
- [ ] 链接自动补全

### Phase 4：图谱 + 每日笔记（1 周）

- [ ] 知识图谱可视化（@antv/g6）
- [ ] 每日笔记功能
- [ ] 全局快捷键快速捕获
- [ ] 托盘常驻

### Phase 5：打磨 + 发布（1 周）

- [ ] 多视图切换（列表/卡片/时间线）
- [ ] 导入 Obsidian/Typora 文件
- [ ] 性能优化
- [ ] 打包发布

---

## 额外需要的 Capabilities

当前框架已有：`core:default`, `opener:default`, `store:default`, `log:default`

知识库新增需要：

| 权限 | 用途 |
|------|------|
| `fs:default` | 导入/导出 Markdown 文件 |
| `dialog:default` | 文件选择对话框 |
| `global-shortcut:default` | 全局快捷键（快速捕获） |
