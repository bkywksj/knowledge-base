# 任务：md 编辑器双重体验（A 临时编辑 + B 源码模式）

> 需求来源：用户提出「打开 md 时能不能不入库，直接当 md 编辑器用」。
> 讨论结论：不做全局双模式（会变成维护两套编辑器状态机），改为
> **A 临时编辑标记**（解决「库被外部文件污染」）+ **B 源码模式**（解决「别用富文本编辑器碰我的 markdown」）。

## 背景：现状已有能力（不要重复造）

| 能力 | 位置 |
|------|------|
| 外部 .md 打开 → 入库并建立关联 | `services/import.rs` `import_single_markdown` |
| 编辑保存 → 自动写回原文件 | `services/source_writeback.rs`，`update_note` 时触发 |
| 外部改动冲突检测（mtime） | 同上，返回 `WriteBackResult::Conflict` |
| 图片资产写回 `<basename>.assets/` | 同上 |
| 解除关联 | `commands/source_writeback.rs` `clear_source_md_link` |
| 首次打开的说明通知 | `src/lib/externalMdIntro.ts` |

打开链路（两个入口都走同一个 command）：
- 系统双击 / argv → `AppLayout.tsx:283` → `importApi.openMarkdownFile(path)`
- 应用内「打开 md」→ `NotesPanel.tsx:736` → 同上

---

## Wave 1：方案 B —— 源码模式（纯前端，先做）

编辑器现在是 Tiptap 所见即所得，写 markdown 源码 / 复杂 HTML / front-matter 都不顺手
（HTML 受 ProseMirror schema 白名单限制会被吞标签）。

**关键利好**：`editor.tsx:760` 的 `content` state 本身就是 markdown 字符串，
源码模式与富文本模式共用同一份 state 和保存链路，不需要第二套存储。

- [x] 编辑器顶部加「富文本 / 源码」切换（`Code2` 图标，阅读模式按钮左侧）
- [x] 源码模式渲染等宽字体 textarea（`components/editor/MarkdownSourceEditor.tsx`）
  - [x] Tab / Shift+Tab 缩进（textarea 默认会跳焦点）
  - [x] 高度自适应，滚动交给外层容器（避免双层滚动条）
  - [x] Ctrl 组合键放行，不拦 Ctrl+S
- [x] 两模式切换时内容同步 —— **零成本**：`content` state 本身就是 markdown，
      TiptapEditor 已有 `content !== current → setContent` 的同步 effect
- [x] 源码模式下保存走同一条链路（写回外部 md 自动生效）
- [x] 模式偏好持久化（localStorage `editor.sourceMode`，与 mindMapWidth 同策略）
- [x] 源码模式下富文本专属功能处理：
  - [x] 工具栏随 TiptapEditor 卸载自动消失
  - [x] 大纲排除（`effectiveOutlineVisible` 加 `!sourceMode`）——否则显示切换前的旧标题
  - [x] 打印 / 复制为 Word 给出源码模式专属提示（原提示"编辑器尚未就绪"会误导）
  - [x] 字数统计不消失：抽出 `calcTextStats(text)` 按 markdown 原文统计
- [x] 首次进入弹一次说明（`lib/sourceModeIntro.ts`）：切回富文本继续编辑会规范化 HTML

## Wave 2：方案 A —— 临时编辑标记

- [x] schema v55 → v56：`notes` 加 `is_scratch INTEGER NOT NULL DEFAULT 0` + 部分索引
- [x] `Note` 模型加 `is_scratch`（8 处 row mapper 同步；**追加到列尾**避免既有索引整体位移）
- [x] `import_single_markdown` 增加 `as_scratch` 参数
  - [x] 复用已有笔记时**只升不降**：正式笔记不会因误选"临时"被移出主列表
  - [x] `OpenMarkdownResult` 回传**实际** `is_scratch`（≠ 传入的 as_scratch）
- [x] `open_markdown_file` command 透传（`Option<bool>`，缺省 false，老调用方不受影响）
- [x] `folder_watch` 剪藏自动导入显式传 false（那是用户主动配的目录，属正式笔记）
- [x] 查询过滤 `is_scratch = 0`（跟着既有 `is_hidden = 0` 的全部过滤点走）：
  - [x] `notes.rs` `list_notes` + `list_note_ids_for_reorder`（两者口径必须一致，否则拖拽排序错位）
  - [x] `search.rs`（FTS5 + LIKE 两条路径）
  - [x] `links.rs`（双链 / 反链 / wiki 解析，7 处）
  - [x] `tags.rs`（标签视图）/ `dataview.rs`（3 处）/ `ai.rs`（RAG 检索）
- [x] DAO：`list_scratch_notes` / `get_note_scratch` / `set_note_scratch`
- [x] Service + Command：`list_scratch_notes` / `set_note_scratch`（已在 lib.rs 注册）
- [x] 前端 types / api 封装（`noteApi.listScratch` / `noteApi.setScratch`）
- [x] 打开外部 .md 时弹选择（`lib/openMdChoice.tsx`），两个入口都接上：
      `AppLayout`（系统双击 / argv）+ `NotesPanel`（应用内按钮）
- [x] 选择可「记住」（localStorage，`clearOpenMdPreference` 供设置页恢复询问）
- [x] 临时笔记可「转为正式笔记」：编辑器顶部 Alert 提示条 + MD 下拉菜单项
- [x] **「临时文件」入口**：`components/notes/ScratchFilesModal.tsx`
      —— 侧栏顶部「打开 md」按钮旁的下拉里拉起
      - 刻意**不做成笔记树里的虚拟节点**：临时笔记不属于文件夹体系（不能拖进拖出、
        不参与排序），而「未分类」那套虚拟节点在 NotesPanel 里有 13 个触点
        （拖拽落点 / 右键菜单 / 展开态持久化…），复制一遍只为"能翻到它"不划算
      - 列表显示原文件路径而非仅标题：临时文件的身份就是"某个外部 .md"
- [x] 设置页「打开外部 .md 文件的方式」：每次询问（默认）/ 加入知识库 / 临时编辑
      —— 导出 `setOpenMdPreference` 供设置页与弹窗"记住"复用

## 验证

- [x] `npx tsc --noEmit` 通过
- [x] `cargo check` 通过（唯一 warning 是既有的 `upsert_attachment_ref` dead_code）
- [x] `cargo test`：571 passed / 2 failed —— 两个都是**既有失败**，已对照 HEAD 确认
      测试代码与排序 SQL 未被本次改动触及：
      - `dataview_recent_notes_orders_by_updated_at`：`datetime('now','localtime')` 只有秒级
        精度，测试却只隔 20ms 建两条笔记，同秒内排序不确定
      - `tag_path_segments_independent_namespace`：tags 唯一约束与测试期望矛盾
- [ ] 运行时验证（未做）：
  - [ ] 源码模式改内容 → 切富文本 → 内容一致
  - [ ] 外部 md 用源码模式改 → 保存 → 原文件内容正确
  - [ ] 临时打开的 md 不出现在主列表 / 搜索 / 双链
  - [ ] 「转为正式笔记」后立刻出现在列表
