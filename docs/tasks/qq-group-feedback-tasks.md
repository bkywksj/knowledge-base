# QQ 用户群反馈 — 待修任务

> 来源：QQ 用户群讨论 2026-04-26
> 创建日期：2026-04-26

---

## 🔴 执行规则（继续任务前必读）

**每次开始某条任务前，必须先走三步：**

1. **重新评估必要性**：此刻这条任务是否仍值得做？优先级是否被新情况改变？
2. **给出实现方案**：
   - 涉及哪些文件（models / database / services / commands / types / api / pages）
   - 具体改什么、新增什么
   - 数据库 schema 是否变更（如变更需写迁移）
   - 需要哪些 Tauri Capabilities / 插件
   - 预计工作量 + 潜在风险点
3. **等待用户确认**后再开始写代码。

⛔ 禁止直接跳过以上三步动手实现。

---

## 任务列表

### 🔥 高优先级 Bug

---

#### Q-001 · 从本地 zip 导入显示成功但内容不显示

- **状态**：✅ `completed` · 已修复（commit `5b6ee21` / `6bfb8ca`，2026-04-26）
- **来源**：flyforever 04-26 09:47 / 15:02
  > "软件中选择从本地 zip 导入，显示导入成功，但是在笔记列表却没显示导入的内容"
  > 上传到坚果云的；从云端拉取同步失败 → 把云里 zip 拉到电脑 → 从电脑 zip 导入 → 显示成功，但笔记/文件夹都没显示新东西。
- **价值**：⭐⭐⭐⭐⭐  成本：低
- **核查结果（已 grep 代码确认）**：
  - 入口：`commands/sync.rs::sync_import_from_file` → `services/sync.rs::apply_snapshot_from_reader`
  - 流程：把 zip 里的 `app.db` 直接覆盖到 `db_path`；同时落 settings.json + 资产文件
  - **根因（高度怀疑）**：覆盖 SQLite 文件后，**当前进程的 `state.db`（rusqlite::Connection）仍持有旧文件描述符**。SQLite WAL 模式下尤其明显——wal/shm 也是旧的；后续 `list_notes` 走旧连接 → 看不到新数据
  - 用户重启应用后**应该**能看到（这是关键验证点）
- **建议方案（修订后）— Rust 侧 reopen Connection，不重启**：
  1. `Database` 加 `pub fn reopen(&self, db_path: &Path) -> Result<(), AppError>`
     - lock 内部 `Mutex<Connection>`
     - drop 旧 Connection（自动 close，释放文件句柄）
     - `Connection::open(db_path)` 重建
     - 重跑 PRAGMA（journal_mode=WAL、foreign_keys=ON 等）
  2. `commands/sync.rs::sync_import_from_file` 在 `apply_snapshot_from_reader` 成功后调
     `state.db.reopen(&db_path)` + `app.emit("db:reloaded", ())`
  3. 前端 `App.tsx` 全局监听 `db:reloaded`：触发 `bumpFoldersRefresh` +
     `bumpNotesRefresh` + `refreshTaskStats`，所有视图自动重拉数据
- **涉及文件**：
  - `src-tauri/src/database/mod.rs` — 加 `reopen` 方法
  - `src-tauri/src/commands/sync.rs::sync_import_from_file` — 调 reopen + emit 事件
  - `src/App.tsx` 或 `src/store/index.ts` — 全局监听 `db:reloaded`
- **工作量**：~1.5 小时
- **风险**：导入瞬间若有别的查询在跑会拿不到 lock；实际 SyncTabs 导入是用户主动点的，并发查询概率低；用 `Mutex` lock 序列化 → 安全
- **用户已确认**：✅ 采用此方案

---

#### Q-002 · 文件夹层级显示错乱 + 单击不稳定

- **状态**：`pending` · 待方案确认
- **来源**：无极 04-26 10:43（带截图）
  > "单击文件夹一会有一会没有的，文件夹对应也不对，分析文件夹创建的 2 个文件，怎么考试文件夹下也有"
- **ㅤ 04-26 11:27 补充**：
  > "文件分类上面有问题，有些文件直接在最外层显示，没有分给子文件，点击子文件夹，就会存在一会显示，一会不显示"
- **价值**：⭐⭐⭐⭐  成本：中
- **核查结果**：
  - `database/notes.rs::list_notes` 现状：`folder_id = ?` **精确匹配**，**不递归子文件夹**
  - 点击 NotesPanel 某父文件夹 → 主区只显示**直属**该父文件夹的笔记，子文件夹的笔记不出现
  - 用户感到"分析下没有自己创建的文件"是因为这两个文件实际归在「分析/考试」（子文件夹）下，点父文件夹"分析"看不到
  - "一会有一会没有"可能是用户点不同子文件夹时数据切换的视觉感受
  - **B2 根因疑似**：list_notes 精确匹配语义 vs 用户期望的递归语义
- **建议方案**：
  1. `NoteQuery` 加 `include_descendants: Option<bool>`（默认 true）
  2. `list_notes` 当 include_descendants=true 时：
     - 用 CTE 递归查询 folder 子树所有 ID
     - WHERE folder_id IN (递归 ID 列表)
  3. 前端默认开启（点父文件夹 = 看该子树所有笔记，符合直觉）
  4. 设置页可加开关「点父文件夹是否包含子文件夹笔记」让用户选（v2 可选）
- **涉及文件**：
  - `src-tauri/src/models/mod.rs` — NoteQuery 加字段
  - `src-tauri/src/database/notes.rs::list_notes` — 加递归 CTE 分支
  - `src-tauri/src/services/note.rs` — 透传字段
  - `src/types/index.ts` — NoteQuery 加字段
  - `src/pages/notes/index.tsx` — 调用时默认 true
- **工作量**：~1 小时
- **风险**：递归 CTE 在文件夹深度很深（>20 层）时 SQLite 可能慢；大概率不会触发
- **待用户确认**：是否按"默认递归"语义改

---

### 🟡 中优先级 UX

---

#### Q-003 · 外部 .md 快捷打开后保存记录丢失

- **状态**：✅ `completed` · 首次打开弹引导 notification，告知"已加入本地库 + 编辑写回原文件"（2026-05-23）
- **来源**：安分 04-26 11:01
  > "在没有导入的前提下从本地打开的 md 文件，编辑保存后，从系统快捷菜单打开软件，没有原来的保存信息，这有点不符合直觉"
- **抓蛙师答复**：「目前设计就是这样 不会修改那个原来的文件。不过我可以改一下。确实不符合直觉」
- **核查现状**：项目最近 commit `51fee11` 已实现「**原 .md 文件双向同步**」基础设施（write_back + url_mapping），但**默认 UX 还是"临时打开"**——用户没有"自动加入数据库"的引导
- **建议方案**：
  1. 首次打开外部 .md 时弹一次 Toast「✓ 已加入本地知识库 · 编辑后会自动写回原文件 [设置默认行为]」
  2. 设置页加开关「外部 .md 默认行为」：
     - `auto_track`（推荐默认）：自动加入 DB，编辑写回原文件
     - `temp`：仅临时打开，不入库
  3. 行为已经在后端做完，本任务**只需补前端 UX**
- **工作量**：~1 小时

---

### 🔵 低优先级 / 性能

---

#### Q-004 · 笔记多了文件树卡顿

- **状态**：`pending` · 待评估
- **来源**：月亮不回来 04-26 11:43 「等笔记多了就是卡爆」
- **价值**：⭐⭐⭐  成本：低
- **核查现状**：当前 antd Tree 一次性渲染所有节点（NotesPanel）；笔记数 > 1000 时跨段帧
- **建议方案**：antd Tree 加 `virtual` 属性 + 固定高度
  - `<Tree virtual height={400} ...>` 一行配置
- **工作量**：~10 分钟
- **风险**：拖拽 + 右键菜单 + 内联编辑在 virtual 模式下要回归测试
- **待评估**：用户反馈一两次就做；现在是单一报告先记录

---

### 🟢 战略性回应（不立任务，记录定位）

#### Q-strategy-1 · 产品差异化定位
- **来源**：风飞羽 04-26 11:21~11:48 长串讨论：Ob 生态、思源平替难超越、若依架构落后
- **抓蛙师立场**：AI 架构 + 200 万行重构 ≠ 旧若依
- **建议**：写一条简短产品定位声明置顶到 B 站 + 软件 README：
  > 走「AI Native 知识库」路线：AI 链路（写作辅助 / 知识问答 / 智能规划 / 笔记↔AI 双向）是一等公民不是插件；本地优先 + 加密 + 双向同步原 .md 文件；现代 Rust + React 架构，未来开放插件 SDK
- **不立 T 任务**：写完一次发出即可

---

## 推荐处理顺序

1. **立即**：Q-001（用户已流失感受最差，最快回应）
2. **本周**：Q-002（数据视图错乱，影响用户对正确性的信任）
3. **本周**：Q-003（已答应改，且后端基础已就绪）
4. **下周**：Q-004（性能小修）
5. **顺手**：Q-strategy-1（公告 + B 站置顶）
