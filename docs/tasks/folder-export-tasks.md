# 目录 / 笔记右键导出 —— 任务清单

> 起因：用户提出「笔记目录右键是不是可以加导出」。调研后确认 —— 后端导出能力基本齐全，
> 缺的是**入口分布严重不均**：侧边栏文件夹右键有 4 个「导入」却 0 个「导出」。
> 同时发现一个静默丢数据的真实缺陷（见 B1）。
>
> 创建于 2026-09-15

---

## 现状盘点

| 位置 | 现有导出 | 文件 |
|------|---------|------|
| 编辑器工具栏 | MD / Word / HTML / PDF（Ctrl+Shift+E） | `src/pages/notes/editor.tsx:1863` |
| 笔记列表页（行 + 批量） | MD / Word / HTML | `src/pages/notes/index.tsx:1328`、`:1553` |
| 设置页 | 全库 / 单文件夹 MD | `src/pages/settings/index.tsx:2667` |
| 白板 | PNG / SVG / .excalidraw | `src/pages/whiteboard/index.tsx:303` |
| **侧边栏文件夹右键** | ❌ 无 | `NotesPanel.tsx:1589` |
| **侧边栏笔记右键** | ❌ 无 | `NotesPanel.tsx:1470` |
| 标签 / 日记 / 搜索 / 任务面板 | ❌ 无 | — |

---

## 总表

| 编号 | 任务 | 优先级 | 成本(人日) | 状态 |
|------|------|--------|-----------|------|
| B1 | `export_notes` 支持递归子文件夹（修静默丢笔记） | P0 | 0.3 | ✅ |
| B2 | 新增合并导出 service（多篇 → 单文件 MD/HTML/Word） | P0 | 1.0 | ✅ |
| B3 | 新增 `export_folder_merged` Command + 注册 | P0 | 0.2 | ✅ |
| F1 | 抽公共导出动作模块 `src/lib/exportActions.ts` | P0 | 0.3 | ✅ |
| F2 | 文件夹导出配置弹窗 `ExportFolderModal.tsx` | P0 | 0.6 | ✅ |
| F3 | 侧边栏文件夹右键加「导出此文件夹…」 | P0 | 0.2 | ✅ |
| F4 | 侧边栏笔记右键加「导出为 MD / Word / HTML」 | P0 | 0.3 | ✅ |
| F5 | 侧边栏多选「导出选中的 N 篇…」 | P1 | 0.2 | ✅ |
| F6 | 设置页补「包含子文件夹」勾选 | P0 | 0.2 | ✅ |
| T1 | Rust 单测：合并器标题层级下推 / 代码块保护 | P0 | 0.3 | ✅ |
| P1-a | 日记面板右键：导出本月 / 本年日记 | P1 | 0.5 | ⬜ |
| P1-b | 标签面板右键：导出该标签下所有笔记 | P1 | 0.5 | ⬜ |
| P1-c | 搜索结果导出 | P1 | 0.5 | ⬜ |
| P2-a | 文件夹导出 ZIP 打包（`zip 2.2` 已在依赖） | P2 | 0.5 | ⬜ |
| P2-b | 任务面板导出 CSV（`csv 1` 已在依赖） | P2 | 0.3 | ⬜ |
| P2-c | 文件夹 PDF（合并 HTML → 一次打印，禁止循环弹框） | P2 | 0.5 | ⬜ |

第一波（P0）合计约 **3.4 人日**。

---

# 第一波：P0

## B1 —— `export_notes` 递归子文件夹

### 缺陷描述

`services/export.rs:67-76` 的 SQL 是：

```sql
SELECT ... FROM notes WHERE is_deleted = 0 AND folder_id = ?1
```

只取**直属**笔记。用户在设置页选「工作」导出，子目录「工作/周报」下的笔记会**静默丢失**，
UI 无任何提示。而「对此文件夹问 AI」用的是含子孙的口径
（`database/folders.rs:171` `collect_descendant_folder_ids`）—— 同一个"文件夹范围"
在两处语义不一致。

### 改法

- `ExportService::export_notes` 增参 `recursive: bool`
- `recursive = true` → 先 `collect_descendant_folder_ids(fid)`，SQL 换成 `folder_id IN (...)`
- `commands/export.rs::export_notes` 增 `recursive: Option<bool>`，缺省 `false` 保持向后兼容
- 前端 `exportApi.exportNotes(outputDir, folderId, recursive)`

### 子任务

- [x] `services/export.rs`：`export_notes` 增 `recursive` 参数 + `IN (...)` 分支
- [x] `commands/export.rs`：透传 `recursive: Option<bool>`
- [x] `src/lib/api/index.ts`：`exportNotes` 第三参
- [x] 文件夹右键导出默认 `recursive = true`（符合直觉）

---

## B2 —— 合并导出 service（`services/export_merge.rs`）

### 为什么值得做

导出一堆散 .md 是"备份"；合并成一份带章节结构的 Word/HTML 才是"交付物"（给同事 / 打印 / 存档）。
这是目前整个应用完全没有的能力，也是**文件夹级导出相对单篇导出唯一的增量价值**。

### 设计

核心只需要一个 **markdown 合并器**，三种格式全部复用现有渲染管线：

| 格式 | 出口 | 复用 |
|------|------|------|
| Markdown | `inline_assets_base64` → 写文件 | `services/export.rs:381` |
| HTML | `HtmlExportService::render_html` + `inline_attachments` | `services/export_html.rs:89` |
| Word | `WordExportService::export_single_best_effort` | `services/export_word.rs:75` |

Word 走 `export_single_best_effort` 意味着**转换器路径（LibreOffice/Word/WPS）与原生 docx
回退自动生效**，不需要为合并场景另写一套。

### 合并规则

1. 顶部 `# {文件夹名}`，可选自动生成目录（TOC）
2. 每篇笔记一个章节标题，层级 = `##` + (该笔记所在文件夹相对导出根的深度)，最深到 `######`
3. 笔记正文内的 `#` 标题**整体下推**到章节标题之下，避免与章节结构打架
4. 下推时必须跳过**围栏代码块**内的 `#`（``` 与 ~~~，含缩进围栏），否则会改坏代码
5. 章节之间插 `---`，Word/HTML 渲染时是分隔线，阅读结构清晰
6. 排序：先按文件夹路径，再按笔记标题（与 `export_notes` 的目录结构口径一致）

### 子任务

- [x] `services/export_merge.rs`：`MergeExportResult` + `MergeFormat`
      （类型跟 `HtmlExportResult` / `WordExportResult` 一样就近放在 service 里，不进 `models/`）
- [x] `services/export_merge.rs`：查询笔记（复用 B1 的递归口径）
- [x] `services/export_merge.rs`：`build_merged_markdown()` —— 章节标题 + 层级下推 + 代码块保护
- [x] `services/export_merge.rs`：按 format 三路出口
- [x] `services/export.rs`：把 `inline_assets_base64` 提为 `pub(crate)`（另两个 helper 合并器用不到，保持私有）
- [x] `database/folders.rs`：`bfs_descendant_ids` 提为 `pub(crate)`，并让 `collect_descendant_folder_ids` 复用它（原先两份重复 BFS）
- [x] `services/mod.rs`：注册新模块

---

## B3 —— Command

```rust
#[tauri::command]
pub fn export_folder_merged(
    state, folder_id: Option<i64>, recursive: Option<bool>,
    target_path: String, format: String, fonts: Option<ExportFonts>,
) -> Result<MergeExportResult, String>
```

- [x] `commands/export.rs` 实现（Word 分支 `#[cfg(desktop)]` gate —— docx_rs 移动端编译失败）
- [x] `lib.rs` `generate_handler![]` 注册
- [x] 移动端：Command 照常注册，`MergeFormat::Word` 在 `#[cfg(not(desktop))]` 分支返回
      「移动端不支持导出 Word」友好错误（弹窗目前只在桌面侧边栏用，不需要隐藏选项）

---

## F1 —— 公共导出动作模块（`src/lib/exportActions.tsx`）

现状：单篇导出逻辑在 `pages/notes/index.tsx` 和 `pages/notes/editor.tsx` 各有一份。
侧边栏再抄一份就是第三份。

实际落地为 `.tsx`（成功弹窗含 JSX）。提供：

- `exportNoteAsMarkdown(id)` —— 单文件 .md，文件名由后端按笔记标题定
- `exportNoteAsWord(id, title, bodyHtml?)`
- `exportNoteAsHtml(id, title, bodyHtml?)`
- `exportNotesBatchAsMarkdown(ids)` —— 多选批量
- `exportFolderAsTree(folderId, name, recursive)` / `exportFolderMerged(folderId, name, recursive, format)`

含成功 Modal（路径 + "打开所在文件夹"）与统一错误提示。

> 本波**只让侧边栏走新模块**，不重构列表页/编辑器（控制改动面）。
> 新代码统一走这里，旧两处待后续单独收敛。

- [x] 新建模块，带 reveal / openPath 兜底
- [x] 侧边栏接入

---

## F2 —— 文件夹导出弹窗 `ExportFolderModal.tsx`

文件夹导出的选项比单篇多，全平铺进右键菜单会撑爆（当前文件夹菜单已 13 项）。
一个菜单项 + 一个 Ant Design Modal 更合适。

弹窗内容：

```
导出文件夹「工作」

范围    ☑ 包含子文件夹（共 N 篇笔记）
结构    ○ 保留目录结构（多个 .md 文件 + assets/）
        ○ 合并为单个文件
格式    [Markdown | Word (.docx) | HTML]（Segmented，仅合并时可选）
        ── 保留目录结构时格式固定 Markdown（后端管线所限）

                              [取消] [选择位置并导出]
```

- [x] 组件实现（Checkbox 范围 + Radio.Group 结构 + Segmented 格式）
- [x] 笔记数实时预览（复用 `folderApi.subtreeStats` 或新查）
- [x] 保留结构 → `openDialog({directory:true})` + `exportApi.exportNotes`
- [x] 合并 → `save({filters})` + `exportApi.exportFolderMerged`
- [x] 导出后 reveal 结果

---

## F3 / F4 / F5 —— 菜单入口

- [x] F3 文件夹右键：「导出此文件夹…」插在 4 个导入项**下方**同一分隔组，形成导入/导出对称
- [x] F4 笔记右键：「导出为 Markdown / Word / HTML」三项（对齐列表页口径），
      插在「复制笔记 ID」之后
- [x] F5 多选态：「导出选中的 N 篇…」放在已有 batch-move / batch-trash 同组
      （`NotesPanel.tsx:1447`）

---

## F6 —— 设置页补勾选

- [x] 文件夹下拉右侧加 `☑ 包含子文件夹`，默认勾选（未选文件夹时置灰 —— 全库导出没有"递归"概念）

---

## T1 —— 测试

- [x] `build_merged_markdown`：标题下推正确（`#` → `###`）
- [x] 围栏代码块内的 `#` 不被改动（``` 与 ~~~ 两种围栏）
- [x] 下推超过 h6 时截断到 `######`
- [x] 空文件夹 / 无笔记时返回友好错误而非空文件
- [x] 章节分隔线 `---` 前必有空行（否则被当成 setext 标题，把正文末行变成大标题）
- [x] 相对路径上溯到导出根为止 / 父链成环不死循环
- 共 10 个用例，`cargo test export_merge` 全过

---

# 后续波次（P1 / P2）

合并管线跑通后，P1 各项只是**换个笔记 id 来源**，很便宜：

- **P1-a 日记面板**：月份/年份节点右键 → 合并导出（天然按时间聚合，"导出本月日记"是刚需）
- **P1-b 标签面板**：按主题导出，与文件夹是正交的另一个维度
- **P1-c 搜索结果**：检索 → 导出，是研究型用户的完整链路
- **P2-c PDF**：⚠️ 绝不循环调打印，必须"合并成一份 HTML → 只弹一次系统打印框"

---

## 不做

| 位置 | 原因 |
|------|------|
| 回收站右键导出 | 语义矛盾，要导出应先还原 |
| 单篇 PDF 批量 | 每篇弹一次系统打印框，体验灾难（见 P2-c 的正确做法） |
