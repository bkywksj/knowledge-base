# KN 问题反馈 2 —— 逐条评估与改造方案

> 来源：`KN问题反馈 (1).html`（2026-07-26，含 14 张截图）
> 共 **19 条**建议，分 5 组：笔记 10 / AI 1 / MCP 2 / 待办 5 / 其他 1
> 结论：**采纳 17 条，降级采纳 1 条（白板做单机版），1 条已实现（多窗口）**

---

## 总表

| 编号 | 反馈 | 判断 | 优先级 | 成本(人日) |
|------|------|------|--------|-----------|
| N1 | 标题编号不随上级标题重新计数 | ✅ 采纳（Bug） | P0 | 0.5 |
| N2 | 编号与内容不能同步缩进 | ✅ 采纳 | P1 | 0.3 |
| N3 | 允许「重新开始编号 / 继续编号」 | ✅ 采纳（降级到列表级） | P2 | 1.5 |
| N4 | 编号与 AI 生成文档自带编号冲突 | ✅ 采纳 | P1 | 0.8 |
| N5 | 编号不能随文本一起复制/导出 | ✅ 采纳 | P1 | 1.0 |
| N6 | 大纲不显示编号 | ✅ 采纳 | P0 | 0.3 |
| N7 | 层级引线（正文 + 大纲） | ✅ 采纳 | P1 | 0.5 |
| N8 | 白板功能（参考飞书） | ⚠️ 降级采纳（单机版） | P3 | 5.0 |
| N9 | 一键应用模板格式（删空行等） | ✅ 采纳（改名"格式清洗"） | P1 | 1.5 |
| N10 | 笔记切出独立窗口对照看 | ✅ **已实现**，只补入口 | P2 | 0.3 |
| A1 | 内置智能体（SKILL/记忆/系统预设） | ✅ 分阶段采纳 | P1→P3 | 6.0 |
| M1 | MCP 增加 HTTP 端口供外部 agent 调用 | ✅ 采纳 | P2 | 2.5 |
| M2 | 自动导入指定文件夹（浏览器剪藏落地） | ✅ 采纳 | P1 | 1.5 |
| T1 | 日历显示时间区间（跨天条） | ✅ 采纳 | P1 | 1.5 |
| T2 | 日期选择器「日期/时间段」同界面 | ✅ 采纳 | P1 | 1.0 |
| T3 | 子任务支持设置时间 | ✅ 采纳（性价比最高） | P1 | 0.5 |
| T4 | 日历按标签/分类颜色区分 | ✅ 采纳 | P1 | 0.5 |
| T5 | 任务「放弃」状态 | ✅ 采纳 | P2 | 1.5 |
| O1 | 标签视图并入笔记面板（Tab 切换） | ✅ 采纳 | P2 | 1.5 |

合计约 **28 人日**（不含白板 5 人日则 23 人日）。

---

# 一、笔记模块

## 核心判断：N1–N6 是同一个根因，应一次性重构

**现状（已核实）**：标题编号是**纯 CSS counter** 实现，见 `src/styles/global.css:463-530`：

```css
:root[data-editor-heading-number="1"] .editor-content-area .tiptap h2 {
  counter-increment: kbh2;
  counter-reset: kbh3 kbh4 kbh5 kbh6;
}
:root[data-editor-heading-number="1"] .editor-content-area .tiptap h2::before {
  content: counter(kbh1) "." counter(kbh2) "\2002";
}
```

开关在 `src/store/index.ts:178 headingNumber` / `:783 editorHeadingNumber`。

CSS 伪元素的三个先天缺陷，正好对应用户的 5 条抱怨：

| 缺陷 | 对应反馈 |
|------|---------|
| `::before` 内容不进选区、不进剪贴板 | N5「编号不能复制」 |
| `::before` 是 inline 盒，换行不挂起对齐 | N2「编号与内容不能同步缩进」 |
| 编号只活在 DOM，JS 拿不到 | N6「大纲无编号」 |
| 计数规则写死在 CSS，无法条件跳过/重启 | N3「继续编号」、N4「与手写编号冲突」 |
| 导出 HTML 未带这段 CSS（`services/export_html.rs` 无 counter 规则） | 导出/打印/PDF 全部丢编号 |

### 统一方案：`HeadingNumber` ProseMirror 插件（替代 CSS counter）

新增 `src/components/editor/HeadingNumber.ts`，参照同目录已有的 `HeadingFold.ts`（同样是 Plugin + Decoration，可直接抄结构）：

```
计算层（纯函数，可单测）
  computeHeadingNumbers(doc, options) -> Array<{ pos, level, text, label }>
    · 维护 level 栈 [c1..c6]，遇到 hN：c[N]++，清空 c[N+1..6]
    · 跳级容错：h1 → h3 时，中间层补 1（Word 同款行为），不再出现 "2.1.9 → 2.2.10"
    · skipManual：标题文本已匹配 /^\s*(\d+(\.\d+)*|[一二三四五六七八九十]+、|\(\d+\))/
      → 该标题不编号也不占位（N4）
    · startLevel：可配置从 H1 还是 H2 开始编号
    · format：'1.1.1' | '一、1.1' | '第1章' | '(1)'
渲染层
  Plugin + Decoration.widget(pos, side:-1, contenteditable=false, class='kb-hnum')
状态导出
  HeadingNumberKey.getState(editor.state) -> Map<pos, label>
```

一份计算结果供 **4 个消费方**复用，这是本方案的关键收益：

1. **正文渲染** — widget decoration（替代 `::before`）
2. **大纲** — `EditorOutline.tsx:46 collect()` 里按 pos 查 label，拼在 `it.text` 前（N6）
3. **复制** — `TiptapEditor.tsx:1665 clipboardTextSerializer` 已存在，在序列化 heading 时前置 label（N5）
4. **导出** — `services/export_html.rs` / `export_word.rs` / `lib/exportPdf.ts` 走同一份规则（后端需要一份等价的 Rust 实现，或前端算好后随 HTML 传下去，推荐后者）

> ⚠️ 落地前必须先做的一步：**实测复现 N1**。截图显示 `2.1.9` 之后跟着 `2.2.10`（h3 未随 h2 重置）。
> 按现有 CSS 规则这不该发生，怀疑是文档里存在 `Columns` / `Callout` / `Toggle` 等容器节点，
> 使内部标题创建了**新的 counter 实例**导致作用域断裂。改成 JS 计算后此类问题从根上消失，
> 但仍应先复现确认，避免误判掩盖别的 bug（如"列表转标题"产生的异常层级）。

### N1 编号不连续 · ✅ 采纳（P0，0.5 人日）
- 由上述插件的 level 栈天然解决；跳级用"中间层补 1"策略。
- 补 `src/components/editor/__tests__/headingNumber.test.ts`：跳级、乱序、空标题、超 6 级。

### N2 编号与内容不同步缩进 · ✅ 采纳（P1，0.3 人日）
- widget 用 `display:inline-block; min-width:  <按层级递增>; margin-left: -<同宽>`，
  配合标题 `padding-left`，实现**悬挂缩进**（编号在左，正文换行后仍与首字对齐）。
- 设置项加「编号缩进」：无 / 按层级递进（默认）/ 固定值。

### N3 重新开始编号 / 继续编号 · ✅ 采纳但降级（P2，1.5 人日）
- 截图是 Word 的右键菜单（重新开始编号 / 继续编号 / 编号与内容间距 / 编号级别）。
- **标题级 restart 需要持久化到 .md，会污染 Markdown**，这是本条唯一的难点。
  三种存法：① heading attrs + `{#restart}` 语法 ② HTML 注释 `<!-- kb:restart -->` ③ 笔记 metadata 表。
  推荐 ②（Markdown 兼容、同步无损、其他编辑器打开只是多一行注释）。
- **v1 先做有序列表的 restart/continue**（TipTap OrderedList 原生支持 `start` 属性，改造量极小），
  接到 `useEditorContextMenu.tsx` 的右键菜单里；标题级 restart 放 v2。

### N4 与 AI 生成文档的编号冲突 · ✅ 采纳（P1，0.8 人日）
- 截图里出现 `1.1.1 1.1 公司定位` —— AI 生成的正文自带"1.1"，软件又叠了一层。
- 双管齐下：
  1. 插件的 `skipManual` 选项（默认开）：标题文本已含手写编号 → 不再叠加。
  2. 编辑器工具栏加「清除标题内手写编号」批量命令（正则剥离 + 一次 transaction，可撤销）。
  3. `services/ai.rs` 里生成大纲/长文的 system_prompt 追加"标题不要自带序号"约束
     （涉及 `:2451` / `:2569` / `:3031` 几处生成型 prompt）。

### N5 编号随文本复制 / 导出 · ✅ 采纳（P1，1.0 人日）
- 复制：`clipboardTextSerializer`（`TiptapEditor.tsx:1665`）里注入 label。
- 需要区分两种目标：复制到 **Word/飞书**（要带编号的纯文本）vs 复制到 **另一篇 KN 笔记**（不应带，
  否则再次自动编号会重复）。做法：`text/plain` 带编号，`text/html`+内部 slice 不带。
- 导出：HTML / Word / PDF 三条链路统一带编号（当前全部丢失，属隐性 bug）。

### N6 大纲同步显示编号 · ✅ 采纳（P0，0.3 人日）
- `EditorOutline.tsx` 已按 `pos` 收集标题（`:46-62`），加一次 label 查表即可，零风险。

### N7 层级引线 · ✅ 采纳（P1，0.5 人日）
- 截图是 Obsidian 的有序列表引线（层级竖虚线）+ 编号自定义样式。
- 纯 CSS，无 JS：`.tiptap ul/ol > li { position: relative }` + `li::before` 画 1px 竖线，
  颜色取 `--kb-border`，只在 `data-editor-guide-line="1"` 时启用（跟随现有设置项模式）。
- 大纲同理：`.editor-outline__item` 按 level 画竖线（现在只有 `paddingLeft`，见 `:254`）。
- 顺带：编号样式自定义（`1. → (1) → ① → i.`）与 N3 的 format 选项共用配置。

### N8 白板 · ⚠️ 降级采纳（P3，5 人日）
- 飞书白板 = 无限画布 + 多人实时协作 + 画板内评论。**协作部分本项目不做**（纯本地应用，
  同步走 sync_v1 的文件级合并，做不了 CRDT 实时协作），做了也无人可协作。
- 建议实现**单机白板**：
  - 选型 **Excalidraw**（MIT，npm 可离线打包，手绘风与现有 UI 不冲突；tldraw 有商用授权限制，排除）。
  - 存储：笔记新增一种类型（`notes.note_type = 'whiteboard'`），content 存 `.excalidraw` JSON；
    走现有笔记的 CRUD / 同步 / 回收站，**不新建一套模块**。
  - 入口：新建菜单加"白板"；双链 `[[白板名]]` 可引用；导出 PNG/SVG 到笔记。
  - 风险：Excalidraw 包体积约 1.5MB（gzip 后 ~450KB），需确认对启动性能影响；建议路由级懒加载。
- 若只是想"图文并茂"，现有 Mermaid + 思维导图（`MindMapView.tsx`）已覆盖大半场景，
  建议先问清用户真实用途再投 5 人日。

### N9 一键应用模板格式 · ✅ 采纳（P1，1.5 人日）
- 现状：`services/template.rs` 只有笔记模板 CRUD + 变量渲染（`render_variables`），
  **没有"把格式规则套用到已有内容"的能力**；`useFormatPainter.ts` 是格式刷（逐段刷样式），不是批量清洗。
- 用户真实痛点是"从别处复制来的内容全是空行"，本质是**格式清洗**，不是模板：
  ```
  工具栏 → 格式规整（下拉）
    ☑ 删除连续空段落（保留 1 个）
    ☑ 合并被硬换行拆碎的段落
    ☑ 去除行首尾空格 / 全角空格
    ☑ 中英文之间加空格
    ☑ 统一标题层级（H1 唯一，其余降级）
    ☑ 清除内联样式（字号/颜色/背景）
    ☑ 清除标题内手写编号（复用 N4）
  ```
- 实现：前端纯 ProseMirror transaction（一次 `tr` 完成，Ctrl+Z 可整体撤销），
  规则勾选存 `app_config`；不落 Rust 层。
- "模板样式（字号/行高/编号格式）绑定笔记"是另一件事，成本高收益低，**本轮不做**。

### N10 笔记切出独立窗口 · ✅ 已实现（P2，0.3 人日补入口）
- **该功能已存在**：`src-tauri/src/services/popout_window.rs:24 open_note()`，
  label `popout-note-{id}`，多篇笔记可同时弹出多个窗口；
  `src/pages/notes/editor.tsx:2061` 有按钮，`:1056` 已做主窗 ↔ popout 的跨窗口保存同步。
- 说明用户**没找到入口**。补：
  1. 笔记列表右键菜单加「在新窗口打开」（`NotesPanel.tsx`）；
  2. Ctrl/Cmd + 点击笔记 = 新窗口打开；
  3. 编辑器那个按钮加文字 tooltip「在新窗口打开，可与其他笔记对照」。

---

# 二、AI 问答模块

### A1 内置智能体：SKILL / 记忆 / 系统预设 · ✅ 分阶段采纳（共 6 人日）

**现状盘点**（三块已有其一半）：

| 能力 | 现状 | 位置 |
|------|------|------|
| SKILL（工具） | ✅ 已有：内置只读工具 + 外部 MCP 客户端 | `services/skills.rs`、`services/mcp_client.rs` |
| 提示词库 | ✅ 已有，但只用于**编辑器选中文本**，不作用于对话 | `src/pages/prompts/index.tsx`、`services/prompt.rs` |
| 系统预设（对话角色） | ❌ 无，system_prompt 全部硬编码 | `services/ai.rs:1274/1641/2451/...` |
| 记忆 | ❌ 完全没有 | — |

**阶段 1（P1，1.5 人日）— 系统预设可选**
- 复用 `prompts` 表加 `scope` 字段（`editor` / `chat` / `both`），避免新建表。
- AI 对话页顶部加「角色」下拉；选中后其内容拼进 system_prompt（在 `chat_stream_with_skills` 的
  `system_prompt` 之后追加，不覆盖工具说明，否则工具调用会崩）。
- 会话级持久化：`ai_sessions` 表加 `preset_id`，切回历史会话保持角色。

**阶段 2（P2，2 人日）— 记忆**
- 新表 `ai_memories(id, content, source_session_id, kind, enabled, created_at, stable_uuid)`。
  `kind`: `manual`(用户手写) / `extracted`(对话中自动提取)。
- 注入策略（**必须限量**，否则每轮对话都爆 token）：
  最多 20 条 / 2000 字符，超出按更新时间截断；本地小模型（Ollama）默认关闭注入
  —— 已有教训：32 个工具 schema 就让 7B 模型 prompt-eval 卡几分钟（见 `project_ai_chat_bugs` 记忆）。
- 自动提取：对话结束后异步跑一次 "从本轮提取值得长期记住的事实" ，产出候选给用户勾选入库，
  **不自动写入**（防止污染）。
- 设置页加「AI 记忆」管理面板（列表 / 启停 / 删除 / 手动添加）。

**阶段 3（P3，2.5 人日）— 智能体编排**
- 「智能体」= 系统预设 + 允许的工具集（内置 skills 白名单 + 指定 MCP server）+ 记忆开关 + 模型/温度。
- 新表 `ai_agents`，对话页可切换；相当于把上面三块打包。
- 注意：工具白名单机制 `kb-core` 已有（`read_tool_whitelist`），可复用。

> 建议顺序严格按 1→2→3，每阶段独立可用。阶段 1 用户感知最强、风险最低。

---

# 三、MCP 模块

### M1 增加 HTTP API 端口 · ✅ 采纳（P2，2.5 人日）

**现状**：`src-tauri/mcp/src/main.rs` 的 kb-mcp sidecar **只有 stdio**（`serve(stdio())`，`:143`）
+ 5 个 CLI 子命令。外部 agent 想连必须能 spawn 进程，Web 端 / 远程 agent 连不上。
依赖侧好消息：`rmcp 1.5` 已在用（`kb-core/Cargo.toml:20` server+macros），只需加 feature。

**方案**：
```
kb-core 加 feature: transport-streamable-http-server（rmcp）+ axum
kb-mcp 新增子命令: kb-mcp --db-path X serve-http --port 8765 --token <TOKEN>
主应用 设置→MCP 页加开关: 「HTTP 服务」端口 / Token / 只读或读写 / 启停
```
- **安全红线（必须全做，否则等于开后门）**：
  1. 只监听 `127.0.0.1`，绝不 `0.0.0.0`；
  2. 强制 Bearer Token（首次启用自动生成，可复制/重置）；
  3. 默认**关闭**，用户显式开启；
  4. 默认**只读**，写工具需再次显式勾选（沿用现有 `--writable` 语义）；
  5. 校验 `Origin` 头，防浏览器页面跨站直接打本地端口（DNS rebinding）；
  6. 端口占用时报错并提示换端口，不静默漂移。
- 复用现有工具白名单（`read_tool_whitelist`），HTTP 与 stdio 共用一套裁剪逻辑。
- 顺带产出：M2 的浏览器插件可以直接打这个 HTTP 端点写入（见下）。

### M2 自动导入指定文件夹 · ✅ 采纳（P1，1.5 人日）

**现状**：`services/import.rs` 已有 `scan_markdown_folder()`（`:59`）和 `import_selected_files()`（`:148`），
但**只能手动触发**；Rust 侧无任何文件监听（grep `notify` 无结果）。
截图里的浏览器插件（"网页珍藏"）支持两种落地：导出本地 Markdown / 打思源的 `127.0.0.1:6806` API。

**两条路，建议都做，先 A 后 B**：

**A. 文件夹监听自动导入（本轮做，1.5 人日）**
- 新增 `services/folder_watch.rs`，用 `notify` crate（跨平台，Windows ReadDirectoryChangesW / macOS FSEvents / Linux inotify）。
- 配置：监听目录（可多个）、目标文件夹 ID、是否导入后删除源文件、文件名过滤（`*.md`）。存 `app_config`。
- **防抖 2 秒**（编辑器写文件常触发多次事件）+ 内容 hash 去重（`services/hash.rs` 已有）。
- 导入完成后 `emit` 事件让前端刷新（现有"外部写入刷新"机制可复用）。
- 边界：正在写入的半截文件（等文件大小稳定 2 个周期再读）、非 UTF-8 编码
  （`read_text_auto_encoding()` 已处理，`import.rs:30`）。

**B. HTTP 写入端点（随 M1 一起，+0.5 人日）**
- M1 的 HTTP 服务上加 REST 端点 `POST /api/notes`（title/content/tags/folder），
  让浏览器插件像连思源一样直连，省掉"落盘再导入"的中间步骤。
- 同一套 Token 鉴权，同样默认关闭。

---

# 四、待办模块

> 五条建议均来自滴答清单的成熟交互，**判断：全部采纳**。
> 好消息：数据模型基本齐了 —— `Task` 已有 `start_date`（`models/mod.rs:814`，甘特图用）
> 和 `due_date`（`:778`），子任务用 `parent_id`（`:802`）也是完整 Task，
> 所以 T1/T2/T3 **后端几乎零改动**。

### T1 日历显示时间区间（跨天条）· ✅ 采纳（P1，1.5 人日）
- 现状确证：`CalendarView.tsx:46-60` 只按 `due_date` 分桶，一个任务只落一格；颜色只按 priority（`:26`）。
- 改造：月视图从"单元格内列表"改为**周行叠加条带**：
  ```
  每周一行 → 计算该周内所有 [start_date, due_date] 有交集的任务
           → 按 lane（跑道）分配避免重叠，最多显示 3 条 + "+N 更多"
           → 跨周任务在周边界截断，左/右端画箭头表示延续
  ```
- 无 `start_date` 的任务保持现在的"截止点"渲染（与甘特图语义一致，`models/mod.rs:812` 注释已如此定义）。
- 拖拽：现有拖拽改 due_date（`:75 handleDropOnDate`）保留；跨天条支持**拖两端改区间**（v2 再做）。
- 建议同时加**周视图**（滴答的默认视图），月视图放不下时间信息。

### T2 日期选择器「日期 / 时间段」同界面 · ✅ 采纳（P1，1.0 人日）
- 截图是滴答的 Segmented 切换：日期 Tab（单日 + 时间 + 提醒 + 重复）/ 时间段 Tab（开始~结束 + 全天开关）。
- 改造 `CreateTaskModal.tsx`（52KB，已是巨型组件，建议顺手把日期区抽成
  `TaskDateTimePicker.tsx` 独立组件，Modal 与详情页共用）：
  - `Segmented` + `DatePicker` / `RangePicker`（antd 原生，含 `showTime`）；
  - 切到"时间段"→ 写 `start_date` + `due_date`；切回"日期"→ 清 `start_date`（用已有的 `clear_start_date`，`models/mod.rs:981`）；
  - 快捷项：今天 / 明天 / 本周末 / 下周（截图里的四个图标）。

### T3 子任务增加时间 · ✅ 采纳（P1，0.5 人日）— **性价比最高的一条**
- 现状：`SubtaskList.tsx` 只做 title + checkbox（`:14-16` 注释明写"只展示 title + 完成状态"），
  但子任务本身就是 `Task`，`due_date` / `remind_before_minutes` 字段**天然可用**。
- 改造：子任务行 hover 出小时钟图标 → 轻量 DatePicker（`taskApi.update` 已支持）；
  有时间的子任务在行尾显示日期徽章；到期提醒复用 `services/task_reminder.rs`（无需改后端）。
- 唯一注意：子任务是否进日历/看板视图。建议**默认不进**（避免视图爆炸），设置项可开。

### T4 日历按标签/分类颜色 · ✅ 采纳（P1，0.5 人日）
- `TaskCategory` 已有 `color` 字段（`models/mod.rs:1030`），`Tag` 也有配色（`TagColorPicker.tsx`）。
- 加"配色依据"切换（优先级 / 分类 / 标签），存 `app_config`；
  `CalendarView.tsx:26 priorityColor()` 换成 `resolveTaskColor(task, mode)`，图例同步切换。
- 看板/象限视图共用同一函数，保持全局一致。

### T5 任务放弃功能 · ✅ 采纳（P2，1.5 人日）
- 截图里"纠正"被置灰 + 删除线 = 放弃态（区别于完成）。
- 现状：`status` 只有 `0=todo / 1=done`（`models/mod.rs:776`）。
- 改造清单（**这条改动面最广，注意别漏**）：
  1. `status = 2` 表示放弃；**不做 DB 迁移**（i32 字段直接可存），但要写迁移注释；
  2. `database/tasks.rs` 所有 `status = 0` / `status = 1` 的查询过滤逐一检查
     （待办列表默认排除 2；统计不计入完成率）；
  3. UI：右键/详情加「放弃」，列表灰显 + 删除线，可"恢复"；
  4. 日历/看板/象限/甘特四视图的渲染分支；
  5. **同步 V1 兼容**：老版本客户端读到 `status=2` 会当成未知值，
     需确认 `sync_v1` 的任务序列化是否透传（大概率透传，但要测），并在 CHANGELOG 提示"双端都升级后再用"；
  6. `services/task_reminder.rs` 跳过放弃任务的提醒。

---

# 五、其他

### O1 标签视图并入笔记面板 · ✅ 采纳（P2，1.5 人日）
- 现状是 Activity Bar 模式，左侧面板各自独立：
  `NotesPanel.tsx`（103KB，文件夹树）/ `TagsPanel.tsx`（26KB，标签树）/ `SearchPanel` / `DailyPanel` / `TasksPanel`。
- 用户诉求：笔记面板顶部用 Tab 切「文件夹视图 / 标签视图」，**右侧列表区不变**。
- 改造：
  1. 抽 `NotesPanel` 顶部为 `Segmented`（文件夹 / 标签），标签分支直接挂载现有 `TagsPanel` 的树部分
     （`TagsPanel` 已是独立组件，改造量主要在拆出树与工具条）；
  2. Activity Bar 移除独立的"标签"图标（或保留为快捷入口，指向同一面板的标签 Tab）；
  3. 选中标签 → 路由仍走 `?tagId=`（`src/pages/tags/index.tsx:37` 已如此），右侧页面零改动；
  4. 记住上次所选 Tab（`app_config`）。
- 风险：两个面板都很大且各有虚拟滚动/右键菜单/拖拽，**先抽公共树组件再合并**，否则容易压坏现有交互。
  建议单独开一个分支做，配 UI 回归清单。

---

# 建议实施顺序

| 波次 | 内容 | 人日 | 说明 |
|------|------|------|------|
| **第 1 波** | N1/N2/N4/N5/N6/N7（编号引擎重构 + 引线） | 3.5 | 一次重构解决 6 条，用户感知最强 |
| **第 2 波** | T3/T4/T2/T1（待办四条） | 3.5 | 后端几乎零改，先做 T3/T4 立竿见影 |
| **第 3 波** | M2（文件夹监听）+ N9（格式清洗）+ N10（入口）+ A1 阶段1（系统预设） | 4.8 | 各自独立，可并行 |
| **第 4 波** | T5（放弃态）+ O1（面板合并）+ M1（HTTP MCP）+ A1 阶段2（记忆） | 7.5 | 改动面大，需回归测试 |
| **第 5 波** | N3（重新开始编号）+ A1 阶段3（智能体）+ N8（白板） | 9.0 | 大件，视用户反馈决定是否投入 |

## 开工前必须先做的验证

1. **复现 N1**：构造 h1→h2→h3→h2→h3 的笔记，确认 h3 是否真的不重置；
   若能复现，先定位是不是被 Columns/Callout/Toggle 容器打断了 counter 作用域。
2. **确认 N8 白板的真实用途**：是画流程图（Mermaid/思维导图已够）还是要自由画布？5 人日投入前先问清。
3. **确认 M1 的调用方**：用户说"供其他 agent 调用"——是本机另一个 CLI（stdio 就够，无需 HTTP），
   还是 Web/远程 agent？若只是本机，成本可降到 0（教他配 kb-mcp stdio 即可）。
