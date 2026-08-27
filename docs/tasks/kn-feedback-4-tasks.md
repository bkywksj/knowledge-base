# KN 反馈 4 — 任务清单

> 来源：`KN反馈.html`（文档标题 KN反馈4），共 **19 条**独立诉求，含 11 张截图。
> 评估会话：2026-08-27。基线版本 v1.60.0。

## 进度总览

| 波次 | 条目 | 状态 |
|------|------|------|
| 第 1 波 · Bug 清零 | #5、#1.4.5、#1.1 | ✅ 已完成并推送 |
| 第 2 波 · 低成本高感知 | #1.7、#3.2、#1.6、#1.2 | ✅ 已完成并推送 |
| 第 3 波 · 布局（已重新切分） | 3-A / 3-B / 3-C | ⬜ 未开始 |
| 第 4 波 · 结构性能力 | #1.3、#2、#3.1、#4b | ⬜ 未开始 |

**已完成 7 / 19。**

---

## ✅ 第 1 波（已完成）

### #5 笔记标签栏在其他模块仍显示 — `22a9ee8`
根因：`AppLayout` 里 `TabBar` 全局无条件渲染，与路由无关。
修复：抽 `lib/noteWorkspaceRoute.ts` 判定，只在 `/notes`、`/notes/:id`、`/whiteboard/:id` 渲染。
- 白板必须放行（白板是 `note_type='whiteboard'` 的笔记，进入时会 replace 跳转）
- 选择「不挂载」而非组件内 early return（TabBar 注册了全局 Ctrl+W）
- 5 个单测；真机验证通过

### #1.4.5 有序列表引线穿过两位数编号 — `e1300ed`
⚠️ **二次反馈**。`7d57b08`（v1.32.0）修过一版但没修彻底。
真根因：marker 可用空间 == `padding-left`，与竖线画在 0 还是 0.5em 无关。
15px 下 `"10."`=21.2px 已压 22.5px 的 padding，`"100."`=30px 直接穿过。
修复：引线开启时 `ol { padding-left: 2.8em }`（42px，容得下四位数）。
- 否决了 CSS counter 自绘方案（读不到 `<ol start>`）
- 真机验证通过

### #1.1 长表格浮动菜单不跟随 — `695459d`
复现：40 行表格/818px 视口，滚过 ~110px 菜单 top 变负数飞出视口。
根因：① 锚点只用表格顶边 ② `window.scrollY` 恒为 0（滚的是 `.editor-body`）。
修复：抽 `lib/bubbleMenuPosition.ts`，钳制在「sticky 工具栏下沿」与「表格底边」之间；改 `position: fixed`。
- 10 个单测；真机验证通过（钉住 + 滚过后正确隐藏）

---

## ✅ 第 2 波（已完成）

### #1.2 复制粘贴后空行多 — `6b931b7`
实测原实现：3 项列表 → 每项夹 1 空行；两个空段落 → **5 个空行**。
修复：抽 `lib/plainTextClipboard.ts`，列表项/表格单元格之间单 `\n`，其余 `\n\n`，连续空行压到最多 1 个。
- 21 个单测；真机剪贴板实测通过

### #3.2 侧边栏只显示图标 + #1.6 专注模式保留标签栏 — `9955e04`
两个持久化开关（`activityBarShowLabels` / `focusModeKeepTabs`，均默认开）。
- 统一 `activityBarWidth()`，消掉 ActivityBar 与 AppLayout 各写一份 64 的双写
- #1.6 必须用 `focusModeRaw` 而非 `focusMode`（后者混入了 popout）

### #1.7 Ctrl+滚轮缩放编辑区 — `de4bd51`
抽 `lib/wheelZoomStep.ts` + `hooks/useCtrlWheelZoom.ts`。
- `{ passive: false }` 必需，否则 WebView 原生缩放叠加
- 步进累加（触控板一次轻划连发几十个事件）
- 9 个单测；真机验证通过（Ctrl+0 也未被 Tauri 拦截）

---

## ⬜ 第 3 波 · 布局（原计划 7 条合并，**已重新切分**）

> 重新切分的理由：7 条同时改 AppLayout / 编辑器顶栏 / NotesPanel / ActivityBar / TabBar，
> 出问题无法二分定位；且属视觉重设计，一次性交付则用户不喜欢就整体返工。

### 切片 3-A（各自独立，低风险）— 建议先做
- **#1.4.3 浮动工具栏**（性价比最高）
  常驻工具栏 48 个按钮、总宽 ~1720px，1388 窗口下占 2~3 行，是编辑区垂直空间最大消耗方。
  复用 `TableBubbleMenu` 已解决的三件事：portal 到 body、capture 阶段监听滚动、
  mousedown preventDefault 保选区。**注意：本条不依赖顶栏合并**，可单独交付。
- **#1.5 文件夹层级引线**
  ⚠️ 不能直接开 antd `showLine` —— `global.css:232` 当年主动关掉过，会撞回视觉错位。
  改在 `.ant-tree-indent-unit::before` 自绘。
- **#1.4.4 笔记侧栏图标合并**
  NotesPanel 顶部堆了 4 个横条，图标散在 3 处。搜索框折叠成图标能省一整行。
  ⚠️ `+ 新建笔记` 是主入口，别一起收成图标。

### 切片 3-B（必须一起，高风险）
- **#3.3 顶栏合并** + **#1.4.1 名称/面包屑/标签合一行** + **#1.4.2 顶栏按钮收纳**
  Header 48 + TabBar 38 = 两条横条，合并省 ~46px，**并顺带解决非笔记路由的标签栏语义**。
  ⚠️ 最易翻车点：窄窗口下中间槽位被两侧图标挤没。需先定最小支持窗口宽度。
  ⚠️ #1.4.2 附加条件：让「哪些按钮常驻」可配置，否则必然招来下一轮反馈。

### 切片 3-C（独立，中风险）
- **#4a AI 助手放笔记页**
  已有 `NoteAiDrawer`（右侧 440px，`mask={false}`）。用户想要的是**常驻分栏**而非浮层。
  改成可停靠面板，抄 `SidePanel` 现成的「宽度收缩 + 可拖」范式。

> 三个切片做完即等于兑现 **#3「加个简洁主题」** —— 该条的真实诉求不是配色，
> 是横条数量（参考图 1 条 vs KB 3 条）。落地为 `LAYOUT_PRESETS` 加一个「紧凑」预设，
> ~90% 复用现有开关。

---

## ⬜ 第 4 波 · 结构性能力

### #1.3 大纲拖动章节（WPS 式）
核心算法**已有**：`headingAnchor.ts:83` 的 `rangeOfFolded()` 改 `from` 起点即得完整章节区间。
- 不用引 dnd 库；delete + insert 必须同一个 transaction（一次 Ctrl+Z 可整体撤销）
- ⚠️ `collectHeadings()` 默认 `maxLevel=3` 且只收 top-level，大纲若显示更多层级会静默错位

### #2 提示词像笔记一样编辑
现状 Modal + `rows={8}` textarea。改左右分栏：主区 Prompt 正文、右侧折叠配置。
- 变量插入按钮条 + 试运行预览比高亮更值钱
- ⚠️ 别为变量高亮引 CodeMirror/Monaco（撑包体）

### #3.1 自定义主题 / CSS —— **必须先还技术债**
`themes.css` 1036 行、5 套主题各写 21~36 条规则、**196 处 `!important`**。
组件外观靠各主题各自的 `!important` 写死，不是统一读 `--kb-*`。
→ 现在开放 `custom.css`，用户覆盖变量**大部分不生效**，比不给更招骂。
- 第一步（内部）：收敛成「一份共享 antd 覆写（全用 `var(--kb-*)`）+ 5 组变量值」
- 第二步（对外）：内置主题定制面板（取色器 + 导出/导入 JSON），高级选项才给 `custom.css`
- ❌ 不采用用户提的 `config.json` 方案（会与设置页形成第二套真相源）
- ⚠️ `ThemeMode` 是字面量联合类型，得先放开成 `string`

### #4b 内置 DeepSeek Harness —— ❌ 不建议，换方案
KB 已有 agent 骨架：`skills.rs:52` 7 个工具 + `tool_schemas_with_mcp` + 完整 MCP 客户端。
**反向链路也早就通了**：`src-tauri/mcp/` 已暴露 `create_note`/`update_note`/`add_tag_to_note`
（`--enable-write` + 白名单）—— 用户想要的"能干活的 AI"已实现，只是不知道。
真正缺的：**KB 内置的 7 个工具全是只读**。
→ 补写工具（逻辑可从 kb-mcp 复用）+ 改动前 diff 预览确认。
⚠️ 必须保留「按模型能力裁剪工具集」开关 —— 32 个工具曾让本地 7B 卡几分钟。

---

## 遗留小项（等拍板）

- **复制丢列表序号**：`textBetween` 不含 marker，`1. 2. 3.` 全没了。与"已特意注入标题编号"
  自相矛盾（都是可见内容）。超出反馈范围，未动。
- **`Ctrl+Shift+C` 显式纯文本复制**：#1.2 修完后 text/plain 已是干净纯文本，判断无必要，未做。

## 验证环境备忘

- 真机自动化脚本在 scratchpad：`dpi.ps1` / `shot.ps1` / `click.ps1` / `keys.ps1` / `wheel.ps1`
- 🔴 本机显示器 **200% 缩放**，脚本必须先设 DPI 感知，否则坐标全落错
- 🔴 dev 模式下「设置不落盘」是 HMR 假象（`_settingsHydrated` 被重置），需冷启动才能验持久化
