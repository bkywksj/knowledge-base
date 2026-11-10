# 移动端 v4 重构 · 功能底稿（不删功能验收清单）

> 用途：`mobile-v4-redesign-tasks.md` 的 M0-2。每页动手前，把本页对应小节逐条映射到原型位置；改完逐条勾选。
> 生成：2026-11-10，由子代理逐文件通读整理，主会话抽查 8 条（占位按钮、写死版本号、今日字数口径、缺失页分流）全部属实。
> 行号以生成当天的代码为准，改动后会漂移，验收时以实际代码为准。

---

## 盘点中发现的现状问题（重构时一并处理）

这些不是「功能」，而是现有缺陷 / 空壳。重构时要么补实现，要么去掉入口，**不能原样搬过去**。

| 位置 | 问题 | 建议 |
|---|---|---|
| `MobileNotes.tsx:125` | 顶栏「⋯」空占位，没绑事件 | 新版接「文件夹长按菜单」同款面板 |
| `MobileNotes.tsx:135` | 文件夹 chip 只有静态「全部」，**没有文件夹层级**（群反馈） | M3-2 主任务 |
| `MobileNotes.tsx:35` | 只拉第 1 页 30 条，没有加载更多 | 文件夹层级 + 分页 |
| `MobileNotes.tsx:87` | 长按「删除」不二次确认 | 进回收站可撤回，保持；或加撤销 toast |
| `MobileNoteEditor.tsx:339` | 顶栏「⋮」空占位 | 新版「更多」面板 |
| `MobileNoteEditor.tsx:395` | 正文是纯 textarea | M3-3 换富文本 |
| `MobileHome.tsx:119` | 「今日字数」卡实际显示 `total_words`，副标题写「总字数」 | 改成真正的今日 / 本周字数 |
| `MobileHome.tsx:81` | 今日待办卡只取前 3 条，数量最大显示 3 | 用真实计数 |
| `MobileHome.tsx:187-198` | 快速操作「闪念」「新建」都跳 `/notes` | 新版金刚区接真实动作 |
| `MobileHome.tsx:236` | 首页待办勾选框只读 | 新版允许直接勾完成 |
| `MobileHome.tsx:112` | 头像 🦊 不可点 | 去掉或接「我的」 |
| `MobileDaily.tsx:157` | 顶栏「设置」空占位 | ✅ M3-6 已去掉 |
| `MobileDaily.tsx:267` | 选任何一天按钮都写「今天的日记」 | ✅ M3-6 改为「打开 / 开始写 M 月 D 日的日记」 |
| `MobileAi.tsx:326` | 顶栏「搜索」空占位 | 接会话搜索或去掉 |
| `MobileAi.tsx:66-91` | 4 个快捷入口只建空对话，不预填 prompt | 接提示词库 |
| `MobileAiChat.tsx:264` | 顶栏「更多」空占位 | 接会话菜单（重命名 / 删除 / 关联笔记） |
| `MobileAiChat.tsx:307 / 343` | 「附件」「语音」按钮空占位 | 附件 = 附加笔记；语音接已有 ASR 或去掉 |
| `MobileAiChat.tsx:314` | 占位文字说能「/ 调用 Prompt」，没实现 | 接提示词选择 |
| `MobileAiChat.tsx:437` | 回复是气泡，不是一轮一卡 | M3-8 换 TurnCard 结构 |
| `MobileCards.tsx:170` | 顶栏「统计」空占位 | 去掉或接统计 |
| `MobileMe.tsx:431` | 「关于」行版本号写死 v1.7.1 | 读真实版本 |
| `MobileMe.tsx:275` | 「设置」齿轮跳 `/about` | 语义不符，调整 |
| `MobileMe.tsx:370-390` | 深色模式 / 主题 / Vault 标「不可用」 | M1 主题接上后，主题与深色可开放 |
| `MobileTaskDetail.tsx:490-505` | 重复 / 分类只提示「需在桌面端」 | ✅ M3-5 第二步已在手机端实现编辑（顺带修「清除截止」「不提醒」发 null 不生效） |
| `MobileTrash.tsx:29` | 注释写的「全部还原」没实现 | 补上或删注释 |
| `quick-create/index.tsx:176/198/205` | 模板 / 语音 / 拍照只提示「待开发」 | 原型保留入口，逐个接或隐藏 |
| `quick-create/index.tsx:231` | 「新闪卡」不看功能模块开关 | 按开关显示 |
| `MobileLayout.tsx:126` | Android 返回键处理只是占位 | 根路由再按返回提示退出 |
| 全部 Mobile* 页 | 颜色写死（每文件 6~40 处），不跟 9 套主题 | M1 令牌层 |
| `/prompts` `/hidden` `/about` `/graph` `/push` `/whiteboard/:id` | 手机上直接渲染桌面页，会破版 | M3-11 |

---

#### src/components/layout/MobileLayout.tsx
- [ ] 按窗口宽度切换导航形态：手机宽度（compact）底部 Tab 栏；平板、折叠屏展开或大窗口左侧 Rail — `sizeClass !== "compact"` `MobileLayout.tsx:109`
- [ ] 两种形态共用同一棵 DOM 树，旋转 / 展开折叠屏时页面不重新挂载，数据、滚动、未保存编辑不丢 `MobileLayout.tsx:40-42` `MobileLayout.tsx:188-193`
- [ ] 主内容区纵向滚动，横向不滚动 `MobileLayout.tsx:153`
- [ ] 右下角悬浮「新建」按钮 → `/quick-create` — 手机形态且不在 /ai、/tasks 下 `MobileLayout.tsx:170-181`
- [ ] Rail 顶部「新建」按钮 → `/quick-create` — Rail 形态且不在 /ai、/tasks 下 `MobileLayout.tsx:201-208`
- [ ] 自带 FAB 的页面（/ai、/tasks 及子路由）不显示全局「新建」 `MobileLayout.tsx:102` `MobileLayout.tsx:110-112`
- [ ] 导航 5 格：前 4 格用户配置（store `mobileTabKeys`），第 5 格固定「我的」 `MobileLayout.tsx:115` `MobileLayout.tsx:119-122`
- [ ] 「我的」Tab → /settings；在 /settings、/about、/feature-toggle 下高亮 `MobileLayout.tsx:85-91`
- [ ] 点 Tab 跳到该 Tab 路径 `MobileLayout.tsx:226`
- [ ] 高亮规则：路由等于前缀或以「前缀/」开头；「/」只在完全相等时高亮 `MobileLayout.tsx:93-99` `MobileLayout.tsx:219`
- [ ] 高亮色两种：`activeColor === "accent"` 橙色（AI），其余蓝色 `MobileLayout.tsx:221-222`
- [ ] 当前 Tab 图标线条、文字加粗 `MobileLayout.tsx:241` `MobileLayout.tsx:255`
- [ ] 每格图标 + 文字，12 种图标映射 `MobileLayout.tsx:58-71` `MobileLayout.tsx:257`
- [ ] 有新版本时「我的」Tab 右上角小红点 — `mobileUpdateAvailable !== null` `MobileLayout.tsx:118` `MobileLayout.tsx:242-247`
- [ ] 启动 8 秒后静默检查更新，失败不打扰 `MobileLayout.tsx:136-141`
- [ ] Android 返回键（popstate）监听，目前占位 `MobileLayout.tsx:126-132`
- [ ] 安全区：顶部让状态栏；底部 Tab 让手势条；Rail 让左侧 `MobileLayout.tsx:150` `MobileLayout.tsx:194-198`
- [ ] Tab 点击区最小高 44px `MobileLayout.tsx:236`

#### src/lib/mobileTabRegistry.ts
- [ ] 「功能模块 → 底部 Tab」选 4 个填前 4 格；第 5 格固定「我的」不可关 `mobileTabRegistry.ts:4-5`
- [ ] 候选：主页 `/` · 笔记 `/notes` · AI `/ai`（含 /prompts，橙色）· 待办 · 日记 · 标签 · 闪卡 · Prompt · 隐藏 · 图谱 · 搜索 · 回收站 `mobileTabRegistry.ts:36-120`
- [ ] 全部候选 key 列表（设置页选择用） `mobileTabRegistry.ts:123-125`
- [ ] 默认前 4 格：主页、笔记、AI、待办 `mobileTabRegistry.ts:128-133`
- [ ] 可配置格数固定 4 `mobileTabRegistry.ts:135`

#### src/pages/home/MobileHome.tsx

> ✅ M3-1 验收（2026-11-10）：4 张数据卡 → 一行数字条（开关照旧；今日字数改用写作趋势的今天字数；今日待办 = 今天 + 逾期真实计数；「今日更新 N」改成数字旁 +N）·
> 快速操作 → 金刚区（新建笔记直接建一篇、添加待办 /tasks?new=1、今日日记、问 AI；原「闪念」由「快速记一笔」输入条接替，真正追加到今天日记）·
> 待办速览最多 5 条 + 还有 N 项，勾选可直接完成 · 热力图 → 本周写作，点开 30 天热力图（附 30 天合计）· 最近编辑 → 横滑「继续编辑」8 篇（置顶带图钉）·
> 头像 🦊 是不可点的静态装饰，按底稿建议去掉，右上角换成「同步」入口
- [x] 进入时并发拉取：统计、最近 2 篇笔记、未完成待办、待复习闪卡、30 天写作趋势；除统计外失败回退空值 `MobileHome.tsx:64-92`
- [x] 加载失败只打 console，没有错误 / 加载中 UI（统计未到显示「—」） `MobileHome.tsx:85-87` `MobileHome.tsx:127` `MobileHome.tsx:171`
- [x] 顶部日期和星期 `MobileHome.tsx:96-98` `MobileHome.tsx:107`
- [x] 按时段问候语（夜深了 / 早上好 / 中午好 / 下午好 / 晚上好） `MobileHome.tsx:39-50` `MobileHome.tsx:109`
- [x] 右上角头像 🦊，静态 `MobileHome.tsx:112-114`
- [x] **各模块显示与否由 `mobileDashboardItems` 配置控制**（下列每项都受控） `MobileHome.tsx:54-55`
- [x] 数据卡区：手机 2×2，≥600px 一行 4 列 `MobileHome.tsx:118`
- [x] 数据卡「今日字数」→ /daily（实际显示 total_words）— `today_words` `MobileHome.tsx:119-130`
- [x] 数据卡「待复习闪卡」→ /cards，副标题「去复习 / 暂无待复习」— `due_cards` `MobileHome.tsx:132-145`
- [x] 数据卡「今日待办」→ /tasks（最多显示 3）— `today_tasks_card` `MobileHome.tsx:147-160` `MobileHome.tsx:81`
- [x] 数据卡「笔记总数」附「今日更新 N」→ /notes — `total_notes` `MobileHome.tsx:162-177`
- [x] 快速操作区 — `quick_actions`：闪念 → /notes · 新建 → /notes · 今日日记 → /daily · 问 AI → /ai `MobileHome.tsx:181-213`
- [x] 今日待办速览「今日待办 · N 项」— `today_tasks_list` `MobileHome.tsx:216-221`
- [x] 待办速览「全部 →」→ /tasks `MobileHome.tsx:222-227`
- [x] 待办为空「暂无待办，享受当下 ✨」 `MobileHome.tsx:229-233`
- [x] 待办行（最多 3）点击 → /tasks；勾选框只读 `MobileHome.tsx:236-247`
- [x] 待办行有截止时间显示时:分 `MobileHome.tsx:251-258`
- [x] 30 天写作热力图，标题旁 30 天总字数 — `heatmap` `MobileHome.tsx:267-277`
- [x] 热力图：周日开头补空、5 档、今天加圈、悬浮「日期 · N 字」、图例「少 → 多」 `MobileHome.tsx:374-435` `MobileHome.tsx:446-455`
- [x] 最近编辑区 — `recent_notes` `MobileHome.tsx:280-281`
- [x] 最近编辑「全部 →」→ /notes `MobileHome.tsx:284-289`
- [x] 最近编辑为空「还没有笔记，去新建一篇吧」 `MobileHome.tsx:291-295`
- [x] 最近笔记卡（最多 2）→ /notes/:id `MobileHome.tsx:298-301` `MobileHome.tsx:70`
- [x] 最近笔记卡：置顶 Pin / 文档图标；空标题「未命名笔记」；前 80 字预览；相对时间 `MobileHome.tsx:305-321`

#### src/pages/notes/MobileNotes.tsx

> ✅ M3-2 验收（2026-11-10）：全部笔记列表保留在根目录（置顶 / 最近分组照旧，默认排序时）· 「共 N 篇」移到区块标题 ·
> 「⋯」空占位 → 当前文件夹菜单 · 静态「全部」chip → 真正的文件夹层级（`?folder=` 与 PC 同参数，返回键回上一层，面包屑跳任意级）·
> 只拉 30 条 → 加载更多 · 长按菜单保留置顶 / 复制 ID / 删除（仍不二次确认，进回收站），新增重命名 / 移动到 / 复制 wiki 链接 · 新增左滑移动 / 删除、排序、标签页签
- [x] 进入时拉笔记列表（第 1 页 30 条），无分页 `MobileNotes.tsx:25` `MobileNotes.tsx:35-46`
- [x] 加载失败只打 console `MobileNotes.tsx:41-42`
- [x] 编辑页返回后自动刷新（`notesRefreshTick`） `MobileNotes.tsx:49-53`
- [x] 顶栏「笔记」+「共 N 篇」 `MobileNotes.tsx:112-115`
- [x] 搜索按钮 → /search `MobileNotes.tsx:118-124`
- [x] 「更多」⋯ 空占位 `MobileNotes.tsx:125-130`
- [x] 文件夹 chip 只有静态「全部 N」 `MobileNotes.tsx:135-139`
- [x] 加载中且为空「加载中...」 `MobileNotes.tsx:144-147`
- [x] 为空「还没有笔记」+「点右下 + 按钮新建第一篇」 `MobileNotes.tsx:148-155`
- [x] 「置顶」分组 — 有置顶笔记时 `MobileNotes.tsx:158-170`
- [x] 「最近」分组 — 有未置顶笔记时 `MobileNotes.tsx:172-184`
- [x] 轻点笔记 → /notes/:id `MobileNotes.tsx:165` `MobileNotes.tsx:179` `MobileNotes.tsx:232`
- [x] 长按笔记弹底部面板（滑动不误触，禁文字选择和系统长按菜单） `MobileNotes.tsx:166` `MobileNotes.tsx:180` `MobileNotes.tsx:232-239`
- [x] 笔记卡：空标题「未命名笔记」；置顶 Pin；去 HTML 后前 80 字 2 行预览；相对时间 `MobileNotes.tsx:225-229` `MobileNotes.tsx:243-254`
- [x] 面板标题 = 笔记标题，可关闭 `MobileNotes.tsx:190-195`
- [x] 长按「置顶 / 取消置顶」→ `noteApi.togglePin`，提示后刷新 `MobileNotes.tsx:61-74`
- [x] 长按「复制笔记 ID」→ 剪贴板，提示「已复制 ID：N」 `MobileNotes.tsx:75-86`
- [x] 长按「删除」（危险）→ `trashApi.softDelete`，不二次确认，提示「已移到回收站」 `MobileNotes.tsx:87-102`

#### src/pages/notes/MobileNoteEditor.tsx

> ✅ M3-3 第一步验收（2026-11-10）：正文 textarea → TiptapEditor 富文本（存储仍是 Markdown）；textarea 保留为「…」里的源码模式开关 ·
> 编辑 / 预览切换 → 编辑 / 阅读分段 · 置顶按钮挪进「…」操作格（同处新增隐藏）· 「⋮」空占位 → 「…」面板（源码模式 / 移动到 / 复制 wiki 链接 / 复制 ID / 删除）·
> 格式条：加粗 / 斜体 / 标题（一级→二级→三级→正文轮换）/ 列表 / 任务 / 双链 `[[` / 图片（真插入，旧版只插 `![]()` 文字）+ 新增高亮 / 撤销 / 重做 / 收起键盘 ·
> 问 AI 挪到顶栏 · 「已加密」徽标 → 加密笔记整页只读并提示（防止把占位内容存回去）· 新增文件夹路径（点击移动）/ 标签 / 链入数
- [x] 路由 /notes/:id 取 ID；无效显示「笔记 ID 无效」 `MobileNoteEditor.tsx:62-63` `MobileNoteEditor.tsx:281-287`
- [x] 加载笔记，失败提示「加载笔记失败: …」 `MobileNoteEditor.tsx:90-108`
- [x] 全屏覆盖，盖住 Tab 和 FAB `MobileNoteEditor.tsx:292-298`
- [x] 键盘弹出整体顶起，工具栏不被挡 `MobileNoteEditor.tsx:64` `MobileNoteEditor.tsx:296`
- [x] 返回：取消防抖、立即保存、通知列表刷新、返回 `MobileNoteEditor.tsx:161-176` `MobileNoteEditor.tsx:301-307`
- [x] 手势返回等卸载时兜底保存并通知刷新 `MobileNoteEditor.tsx:179-196`
- [x] 顶栏「编辑笔记」+ 保存状态（保存中… / 已保存 · 刚刚，2.5 秒后隐藏） `MobileNoteEditor.tsx:309-313` `MobileNoteEditor.tsx:49` `MobileNoteEditor.tsx:128-131` `MobileNoteEditor.tsx:476-489`
- [x] 编辑 / 预览切换 `MobileNoteEditor.tsx:316-326`
- [x] 置顶切换（防重复点击，失败提示） `MobileNoteEditor.tsx:198-209` `MobileNoteEditor.tsx:327-338`
- [x] 「更多」⋮ 空占位 `MobileNoteEditor.tsx:339-344`
- [x] 标题输入框（占位「无标题笔记」），输入触发自动保存 `MobileNoteEditor.tsx:350-360`
- [x] 元信息：更新日期、字数 `MobileNoteEditor.tsx:289` `MobileNoteEditor.tsx:362-367`
- [x] 「已隐藏」徽标 — `note.is_hidden` `MobileNoteEditor.tsx:368-372`
- [x] 「已加密」徽标 — `note.is_encrypted` `MobileNoteEditor.tsx:373-377`
- [x] 正文 textarea（Markdown 源码），输入触发自动保存 — 编辑模式 `MobileNoteEditor.tsx:395-407`
- [x] 预览模式 ReactMarkdown 只读渲染 `MobileNoteEditor.tsx:380-388`
- [x] 预览时正文为空「（还没有内容，切回编辑模式开始写）」 `MobileNoteEditor.tsx:389-393`
- [x] 自动保存：停 1.2 秒调 `noteApi.update`（空标题用 `resolveNoteTitle` 兜底，带原 folder_id），失败提示 `MobileNoteEditor.tsx:47` `MobileNoteEditor.tsx:110-155`
- [x] 底部 Markdown 工具栏 — 仅编辑模式 `MobileNoteEditor.tsx:412-450`
- [x] 工具栏：加粗 / 斜体 / 一级标题 / 列表 / 任务项 / 双链 `[[…]]` / 图片 `![](…)` `MobileNoteEditor.tsx:418-438`
- [x] 插入后光标归位并保持焦点、触发自动保存；按下工具按钮不失焦 `MobileNoteEditor.tsx:239-279` `MobileNoteEditor.tsx:466-467`
- [x] 「针对本笔记问 AI」：先保存，新建对话（标题「关于：笔记名前 30 字」），挂本笔记，跳 /ai-chat/:id；请求中禁用 `MobileNoteEditor.tsx:216-237` `MobileNoteEditor.tsx:440-447`

#### src/pages/quick-create/index.tsx

> ✅ M3-4 验收（2026-11-10）：内容挪进 `components/mobile/QuickCreate.tsx`，FAB 改为在当前页弹出底部面板，/quick-create 整页保留（深链用，同一组件）·
> 空白笔记 / 今日日记 / 剪藏 / 导入 / 新建任务 / 闪念捕获保留，可选「建在哪个文件夹」· 「从模板」接上模板接口 · 「新闪卡」按复习模块开关显示 ·
> 「语音笔记」「拍照扫描」只是「待开发」提示，手机端没有对应能力，入口先隐藏（做好再加回）· 「主页底部 + 按钮可呼出此页」提示文案随整页形态去掉 ·
> 新增「记一笔」（追加到今天日记）、「剪贴板内容建笔记」
- [x] 顶栏返回 + 标题「新建」 `index.tsx:140-147`
- [x] 「空白笔记」：`noteApi.create`（无标题笔记），通知刷新后 replace 进编辑页 `index.tsx:112-120` `index.tsx:157-163`
- [x] 「闪念捕获」→ /quick-capture `index.tsx:164-170`
- [x] 「从模板」：提示「移动端模板功能待开发」 `index.tsx:176-182`
- [x] 「今天的日记」：`dailyApi.getOrCreate(今天)`，replace 进编辑页 `index.tsx:122-134` `index.tsx:183-189`
- [x] 「网页剪藏」（智能徽标）：打开剪藏弹窗，自动读剪贴板的 http(s) 链接预填 `index.tsx:75-89` `index.tsx:190-197`
- [x] 剪藏弹窗：自动聚焦、回车提交、空时禁用、抓取中 loading、可取消、关闭销毁、说明文字 `index.tsx:255-275`
- [x] 提交剪藏：校验 http(s)、`noteApi.clipUrl`、刷新、提示、replace 进编辑页 `index.tsx:91-110`
- [x] 「语音笔记」：提示「待开发」 `index.tsx:198-204`
- [x] 「拍照 / 扫描」：提示「待开发」 `index.tsx:205-211`
- [x] 「导入文件」：系统文件选择（.md / .markdown / .txt） `index.tsx:49-51` `index.tsx:212-218` `index.tsx:246-252`
- [x] 导入：读文本、去扩展名作标题（空时「导入的笔记」）、create、刷新、提示、进编辑页；重置 input 允许重选同一文件 `index.tsx:53-73`
- [x] 「新建任务」→ /tasks?new=1 `index.tsx:224-230`
- [x] 「新闪卡」→ /cards（不看模块开关） `index.tsx:231-237`
- [x] 底部提示「主页底部 + 按钮可呼出此页」 `index.tsx:240-242`

#### src/pages/tasks/MobileTasks.tsx

> ✅ M3-5 第一步验收（2026-11-10）：筛选 / 分组 / 日期文案和 PC 共用 `src/lib/taskFilters.ts`（从 PC 待办页原样迁出，+7 单测）。变化处：
> 顶栏「待办」→ 标题下拉 = PC 侧栏 12 个智能筛选 + 分类（`?filter=` / `?category=`，同 PC），副标题改为「N 条未完成 · N 条紧急」·
> chip「所有 / 今日 / 本周 / 已完成」→ PC 同款分组胶囊「全部 / 逾期 / 今天 / 即将到期 / 无截止」，已完成走筛选面板「已完成」+ 全部视图底部折叠区（仍是最近 20 条）·
> 分组规则改用 PC 口径（逾期从「今日」里拆出单独成组）· 截止时间改为 PC 短文案（今天给时分 / 明天 / 周几 / MM-DD），逾期整段标红（「逾期 N 天」）·
> 新增：左滑「完成 / 删除」、行内重要 / 子任务进度 / 关联数 / 备注首行、优先级色点。其余条目（搜索、空态、长按菜单、循环任务完成本次、?new=1、二次确认删除）原样保留并逐项实测。
- [x] 进入时同时拉未完成和已完成（已完成最近 20 条），失败按空 `MobileTasks.tsx:52-66`
- [x] 带 `?new=1` 进来自动弹新建面板，随后删掉参数 `MobileTasks.tsx:74-80`
- [x] 顶栏「待办」+「今日 N 项 · 本周 N 项 · 已完成 N」 `MobileTasks.tsx:190-193`
- [x] 搜索按钮展开 / 收起搜索框（收起清空关键词） `MobileTasks.tsx:196-209`
- [x] 搜索框：本地按标题和备注过滤，不区分大小写 `MobileTasks.tsx:89-96` `MobileTasks.tsx:214-222`
- [x] 分类 chip：所有 N / ⏰ 今日 N / 📅 本周 N / ✅ 已完成 N `MobileTasks.tsx:226-248`
- [x] 分组规则：今日 = 截止 ≤ 今天 23:59:59（含逾期）；本周 = 之后 7 天内；其它 = 无截止 `MobileTasks.tsx:83-109`
- [x] 加载中「加载中...」 `MobileTasks.tsx:254-257`
- [x] 搜索无结果「没有匹配「关键词」的待办」 `MobileTasks.tsx:260-264`
- [x] 空列表「暂无待办，享受当下 ✨」+「添加第一条」 `MobileTasks.tsx:265-275`
- [x] 分组：今日 / 本周 / 其它（仅全部 chip）/ 已完成（淡化） `MobileTasks.tsx:281-321`
- [x] 任务行复选框切换完成（不触发长按） `MobileTasks.tsx:453-458`
- [x] 完成逻辑：未完成循环任务 `completeOccurrence`（提示「已完成本次，已推进到下一次」），其它 `toggleStatus` `MobileTasks.tsx:120-132`
- [x] 轻点任务 → /task-detail/:id `MobileTasks.tsx:446-448` `MobileTasks.tsx:289`
- [x] 长按任务弹面板（标题 = 任务名） `MobileTasks.tsx:446` `MobileTasks.tsx:459-464` `MobileTasks.tsx:339-344`
- [x] 长按「标记为完成 / 未完成」 `MobileTasks.tsx:157-167`
- [x] 长按「编辑详情」→ /task-detail/:id `MobileTasks.tsx:168-173`
- [x] 长按「删除」：二次确认后 `taskApi.delete` `MobileTasks.tsx:174-180` `MobileTasks.tsx:135-152`
- [x] 已完成标题删除线 `MobileTasks.tsx:465-473`
- [x] 「紧急」标签 — priority 0 `MobileTasks.tsx:476-480`
- [x] 截止时间（月/日 时:分），逾期显示「⏰ 已逾期」 `MobileTasks.tsx:442-443` `MobileTasks.tsx:481-497`
- [x] 右下角自带新建按钮 → 新建面板 `MobileTasks.tsx:327-336`
- [x] 新建成功后刷新列表 `MobileTasks.tsx:347-351`

#### src/pages/tasks/MobileTaskDetail.tsx

> ✅ M3-5 第二步验收（2026-11-10）：换 v4 样式（MNavBar + 分组列表，抽屉 / 弹窗全部换成底部面板，新增通用 `components/mobile/MSheet.tsx`）。变化处：
> 「重复」「分类」从「需在桌面端」改为手机上可编辑——分类按多级缩进单选（含未分类），重复 = 不重复 / 每天 / 工作日 / 每周 / 每月 / 自定义（每 N 天·周·月 + 周几），
> 结束条件（截至日期 / 次数）手机端不编辑、改规则时原样保留，改成不重复才一并清掉（`lib/taskRepeat.ts` repeatDraftFromTask / repeatDraftToUpdate，+4 单测）·
> 「分类」行原来写死「未分类」，现在显示真实分类 · 新增「重要」开关（PC 有、手机原来没有）· 提醒选项并入 PC 独有的准时 / 3 小时 / 1 周，文案按周 / 天 / 小时换算 ·
> 添加子任务的 `window.prompt` 换成 `TextPromptModal` · 截止时间改用列表同款文案（「逾期 N 天」标红）·
> 修两个旧 bug：「清除截止时间」「不提醒」原来发的是 `null`，后端当「不改」，点了没反应；现改发 `clear_due_date` / `clear_remind_before_minutes`。
- [x] ID 无效「任务 ID 无效」 `MobileTaskDetail.tsx:310-314`
- [x] 进入时加载任务和子任务；失败提示 `MobileTaskDetail.tsx:103-121`
- [x] 独立全屏路由，不挂底部 Tab `MobileTaskDetail.tsx:333-336`
- [x] 返回：立即保存、刷新全局统计、返回 `MobileTaskDetail.tsx:339-345` `MobileTaskDetail.tsx:166-174`
- [x] 顶栏「任务详情」+ 保存状态 `MobileTaskDetail.tsx:346-349` `MobileTaskDetail.tsx:683-691`
- [x] 删除：二次确认后删除、刷新统计、返回 `MobileTaskDetail.tsx:350-356` `MobileTaskDetail.tsx:289-308`
- [x] 标题旁完成勾选（循环任务完成本次） `MobileTaskDetail.tsx:364-374` `MobileTaskDetail.tsx:190-205`
- [x] 标题输入（停 1.2 秒自动保存，完成时删除线） `MobileTaskDetail.tsx:376-388` `MobileTaskDetail.tsx:151-164`
- [x] 备注输入（停 1.2 秒自动保存，空存 null） `MobileTaskDetail.tsx:389-400` `MobileTaskDetail.tsx:127-149`
- [x] 卸载时兜底保存 `MobileTaskDetail.tsx:176-188`
- [x] 附件区：缩略图全屏预览，「＋」从相册或文件选择 `MobileTaskDetail.tsx:401-404`
- [x] 附件预览弹窗（非图片附件） `MobileTaskDetail.tsx:655`
- [x] 子任务进度「子任务 · 已完成/总数」 `MobileTaskDetail.tsx:412-414`
- [x] 子任务「添加」（系统输入框） `MobileTaskDetail.tsx:415-420` `MobileTaskDetail.tsx:221-234`
- [x] 子任务为空「还没有子任务」 `MobileTaskDetail.tsx:422-425`
- [x] 子任务勾选（循环子任务完成本次，删除线） `MobileTaskDetail.tsx:435-447` `MobileTaskDetail.tsx:207-219`
- [x] 「截止时间」行 → 编辑弹窗（逾期标记） `MobileTaskDetail.tsx:458-474` `MobileTaskDetail.tsx:316-327`
- [x] 截止弹窗：日期时间输入（只填日期默认 23:59）/ 清除 / 取消 / 保存 `MobileTaskDetail.tsx:560-592`
- [x] 「提醒」行 → 抽屉 7 选项（不提醒 / 5、15、30 分钟 / 1、2 小时 / 1 天） `MobileTaskDetail.tsx:475-489` `MobileTaskDetail.tsx:596-626`
- [x] 「重复」行：显示规则，点击提示需桌面端编辑 `MobileTaskDetail.tsx:490-499`
- [x] 「分类」行：固定「未分类」，点击提示需桌面端 `MobileTaskDetail.tsx:500-505`
- [x] 「优先级」行 → 抽屉（紧急 / 普通 / 低） `MobileTaskDetail.tsx:506-517` `MobileTaskDetail.tsx:629-653`
- [x] 底部「创建于」/「完成于」 `MobileTaskDetail.tsx:522-531`
- [x] 「推迟 30 分钟」（`snooze`） `MobileTaskDetail.tsx:540-546` `MobileTaskDetail.tsx:236-248`
- [ ] 底部「完成 / 标记未完成」 `MobileTaskDetail.tsx:547-552`

#### src/components/mobile/TaskCreateSheet.tsx

> ✅ M3-5 第一步验收（2026-11-10）：按原型 08 屏重做成贴键盘的底部面板（白底、顶圆角 16、18px 粗体标题直接输），截止 / 优先级改为单选胶囊，选中色走主题令牌；
> 「新建待办」可见标题去掉，改为对话框 aria-label（原型无标题，抓手条 + 占位「要做什么？」已表意）；提交参数不变（`title / priority / due_date`，截止统一 23:59:59），浏览器实测「明天 + 紧急」→ `{"title":"写周报","priority":0,"due_date":"2026-11-11 23:59:59"}`。
- [x] 每次打开重置表单、锁背景滚动、120ms 后聚焦标题 `TaskCreateSheet.tsx:83-96`
- [x] 点遮罩关闭 `TaskCreateSheet.tsx:126-129`
- [x] 键盘弹出时面板顶到键盘上方 `TaskCreateSheet.tsx:75` `TaskCreateSheet.tsx:133-137`
- [x] 标题「新建待办」 `TaskCreateSheet.tsx:139-141`
- [x] 标题输入（占位「要做什么？」），Enter 提交 `TaskCreateSheet.tsx:145-154`
- [x] 截止快捷：不设 / 今天 / 明天 / 本周末（统一 23:59:59） `TaskCreateSheet.tsx:23-28` `TaskCreateSheet.tsx:50-61` `TaskCreateSheet.tsx:158-175`
- [x] 优先级：紧急 / 普通（默认）/ 低 `TaskCreateSheet.tsx:30-34` `TaskCreateSheet.tsx:178-195`
- [x] 「取消」/「添加」（空标题或保存中禁用，保存中文字「保存中…」） `TaskCreateSheet.tsx:199-213` `TaskCreateSheet.tsx:98-116`
- [x] 底部提示「分类 / 提醒 / 重复 / 子任务可在建完后进详情页设置」 `TaskCreateSheet.tsx:216-218`

#### src/pages/daily/MobileDaily.tsx

> ✅ M3-6 验收（2026-11-10）：按原型 09 屏重做。变化处：整月网格 → 周条（左右滑换周）+ 点月份 / 抓手 / 下拉展开整月（展开后可翻月），星期改为周一开头（同 PC 日期选择器）· 「有日记」从整格底色改为日期下的小点，颜色图例去掉 · 日期集合改用 `listAll` 一次拿全（仍随年月显示）·
> 顶栏「设置」空占位去掉；不是底部 Tab 时保留返回键，设成 Tab 时隐藏 · 预览从原文直出（会露出 HTML / Markdown 标记）改为时间线：`lib/dailyTimeline.ts` 认首页记一笔的 HTML、编辑器存回的 Markdown、闪念捕获的 callout 三种时间戳写法（+6 单测），其余文字作预览（最多 6 行），[[双链]] 主色标出 ·
> 底部按钮：选今天 = 卡片内「记一笔」输入（与首页同一写法，追加后时间线即时刷新）+ 右上铅笔进编辑器；选别的日子 = 「打开 / 开始写 M 月 D 日的日记」·
> 新增「M 月 N 篇」本月列表（日期 / 标题 / 字数，点行切换）· 本页不再显示全局 FAB（本月列表行尾字数会被压住，同首页 / 笔记页做法）。

- [x] 加载当月有日记的日期，切换年月重新加载 `MobileDaily.tsx:53-60` `MobileDaily.tsx:75-77`
- [x] 选中某天加载当天日记，失败按无日记 `MobileDaily.tsx:62-73` `MobileDaily.tsx:79-81`
- [x] 顶栏返回 + 标题「日记」 `MobileDaily.tsx:149-156`
- [x] 顶栏「设置」空占位 `MobileDaily.tsx:157-162`
- [x] 上个月 / 下个月（跨年） `MobileDaily.tsx:167-183` `MobileDaily.tsx:83-98`
- [x] 星期表头从周日开始 `MobileDaily.tsx:39` `MobileDaily.tsx:188-192`
- [x] 日历 6×7，含上下月日期（灰色），都能点 `MobileDaily.tsx:110-139` `MobileDaily.tsx:199-215`
- [x] 格子状态：选中 / 有日记 / 今天 / 非本月；图例 `MobileDaily.tsx:195-225`
- [x] 选中日期标题「YYYY-MM-DD 周X」，今天加「今天」标签；字数 `MobileDaily.tsx:231-243`
- [x] 加载中 / 预览最多 12 行 / 空白 / 「这一天还没有日记」 `MobileDaily.tsx:246-265`
- [x] 底部「继续编辑 / 开始记录今天的日记」→ `getOrCreate(选中日期)` → /notes/:id `MobileDaily.tsx:267-273` `MobileDaily.tsx:100-107`

#### src/pages/search/MobileSearch.tsx

> ✅ M3-7 验收（2026-11-10）：按原型 10 屏重做。变化处：顶栏返回键 → 搜索框右侧「取消」（同样返回上一页）·新增待办结果（`taskApi.search`，点进任务详情）与范围胶囊「全部 / 笔记 N / 待办 N」，全部范围下待办先露 5 条、笔记 20 条，多的「查看全部」·
> 新增筛选胶囊：时间（今天 / 最近 7 天 / 最近 30 天 / 今年，按更新时间）、文件夹（含子文件夹）、标签（多选，需同时含有）、仅标题；规则与 PC 共用 `lib/searchFilters.ts`（从 PC 搜索页原样迁出，+4 单测），筛选只作用于笔记（同 PC）·
> 新增最近搜索（与 PC 共用历史，有结果才记）· 结果行加所在文件夹路径、白板标记，日期改相对时间 · 高亮改主色浅底（暗色主题可读）·
> 进笔记定位命中：手机编辑器原来不认 `?q=`，现传给 TiptapEditor 的 initialSearch，自动展开查找条并选中第一处（查找条在手机上改为吸顶整行，不再盖住正文）·本页不显示全局 FAB。

- [x] 从 `?q=` 读初始关键词；关键词变化回写 URL（replace） `MobileSearch.tsx:29-32` `MobileSearch.tsx:73-80`
- [x] 顶栏返回 `MobileSearch.tsx:86-92`
- [x] 搜索框自动聚焦（占位「搜索笔记 / 标题 / 正文」） `MobileSearch.tsx:95-101`
- [x] 300ms 防抖调 `searchApi.search(q, 50)` `MobileSearch.tsx:25` `MobileSearch.tsx:39-70`
- [x] 清空按钮 `MobileSearch.tsx:102-110`
- [x] 空关键词提示 / 搜索中 / 无结果（出错同） `MobileSearch.tsx:116-131`
- [x] 「搜索结果 · N 篇」 `MobileSearch.tsx:134-136`
- [x] 结果卡：标题（空「未命名笔记」）、摘要、更新日期；关键词高亮 `MobileSearch.tsx:154-224`
- [x] 点结果 → /notes/:id?q=关键词 `MobileSearch.tsx:142-144`

#### src/pages/ai/MobileAi.tsx
- [ ] 进入时加载对话列表和模型列表 `MobileAi.tsx:113-131`
- [ ] 顶栏「AI 助手」+ 默认模型名 / 「未配置模型服务」+「N 个对话」 `MobileAi.tsx:292-296`
- [ ] 「分享当前模型」（无模型提示；读 API Key 生成分享内容） `MobileAi.tsx:299-318` `MobileAi.tsx:532-536`
- [ ] 「导入模型」弹窗 `MobileAi.tsx:319-325` `MobileAi.tsx:538-542`
- [ ] 顶栏「搜索」空占位 `MobileAi.tsx:326-331`
- [ ] 模型 chip 横滑：点击设默认（✓ 标记） `MobileAi.tsx:342-355` `MobileAi.tsx:135-142`
- [ ] 无模型提示「请到 设置 → 模型服务 添加」 `MobileAi.tsx:337-340`
- [ ] 「+」新建模型服务 `MobileAi.tsx:357-363` `MobileAi.tsx:523-530`
- [ ] 4 个快捷入口：写作助手 / 解读笔记 / 任务规划 / 翻译润色（只建空对话） `MobileAi.tsx:66-91` `MobileAi.tsx:372-385`
- [ ] 「对话历史」+ 多选时「· 已选 N」 `MobileAi.tsx:391-394`
- [ ] 「管理 / 完成」按钮 `MobileAi.tsx:395-402`
- [ ] 管理菜单：批量选择删除 / 清理 7、30、90 天前的对话 `MobileAi.tsx:495-500` `MobileAi.tsx:259-274` `MobileAi.tsx:203-220`
- [ ] 加载中 / 空状态 `MobileAi.tsx:406-417`
- [ ] 对话卡：标题、模型名、关联笔记数、相对时间 `MobileAi.tsx:419-425` `MobileAi.tsx:592-607`
- [ ] 轻点：进对话 / 多选时切换选中 `MobileAi.tsx:428-430` `MobileAi.tsx:144-157`
- [ ] 长按：重命名 / 删除（多选时无效） `MobileAi.tsx:431-433` `MobileAi.tsx:238-253`
- [ ] 重命名弹窗（最多 100 字，Enter 提交） `MobileAi.tsx:503-521` `MobileAi.tsx:222-233`
- [ ] 多选底栏：全选 / 取消全选 / 删除 (N) `MobileAi.tsx:440-467` `MobileAi.tsx:160-200`
- [ ] 右下角「新对话」按钮（多选时隐藏） `MobileAi.tsx:473-484` `MobileAi.tsx:277-284`

#### src/pages/ai/MobileAiChat.tsx
- [ ] ID 无效「对话 ID 无效」 `MobileAiChat.tsx:224-230`
- [ ] 进入时加载对话、模型、消息，滚到底 `MobileAiChat.tsx:75-96`
- [ ] 全屏页；键盘弹出顶起输入栏 `MobileAiChat.tsx:42` `MobileAiChat.tsx:233-239`
- [ ] 监听 `ai:token` / `ai:done` / `ai:error`（只处理当前对话） `MobileAiChat.tsx:99-144`
- [ ] 顶栏返回固定跳 /ai `MobileAiChat.tsx:242-248`
- [ ] 顶栏标题 + 模型名 + 生成中状态，点击打开模型切换抽屉 `MobileAiChat.tsx:249-263`
- [ ] 顶栏「更多」空占位 `MobileAiChat.tsx:264-269`
- [ ] 空状态「开始对话吧」 `MobileAiChat.tsx:277-282`
- [ ] 用户气泡 / AI 气泡（`compactTurnText`，失败或停止补说明） `MobileAiChat.tsx:428-446`
- [ ] AI 消息「复制」+ 时间 `MobileAiChat.tsx:448-459` `MobileAiChat.tsx:217-222`
- [ ] 流式气泡（去伪工具调用残留和引用标记，闪烁光标）/ 等待动画 `MobileAiChat.tsx:286-298` `MobileAiChat.tsx:466-481`
- [ ] 「附件」空占位 `MobileAiChat.tsx:307-312`
- [ ] 输入框（占位说能「/ 调用 Prompt」，未实现）；Enter 发送 `MobileAiChat.tsx:314-325`
- [ ] 发送（同步锁防连点） `MobileAiChat.tsx:146-173` `MobileAiChat.tsx:60-65`
- [ ] 停止（生成中） / 发送（有内容） / 语音空占位（无内容） `MobileAiChat.tsx:327-350`
- [ ] 模型切换抽屉：名称、服务商 · model_id、当前标记；无模型提示手机库与桌面独立 `MobileAiChat.tsx:355-399`
- [ ] 切换模型 `updateConversationModel` `MobileAiChat.tsx:201-215`
- [ ] 抽屉「新建模型服务」→ 弹窗「保存并切换」 `MobileAiChat.tsx:400-415` `MobileAiChat.tsx:184-199`

#### src/pages/settings/MobileMe.tsx
- [ ] 进入时并行拉统计、待复习、回收站数、模型数、Prompt 数 `MobileMe.tsx:216-247`
- [ ] 头部：应用图标、「知识库」、「个人知识库 · 共 N 篇」、笔记数 / 标签数 chip `MobileMe.tsx:255-272`
- [ ] 头部「设置」齿轮 → /about `MobileMe.tsx:275-281`
- [ ] 统计卡：今日待复习 / 总字数 / 今日更新 `MobileMe.tsx:287-301`
- [ ] 学习与思考：闪卡复习（待复角标）/ 知识图谱（N 节点）/ Prompt 库（N 条） `MobileMe.tsx:308-329`
- [ ] 数据与同步：云端同步 → /sync · 导入笔记 → /quick-create · 导出 / 备份（桌面专属）· 回收站（N 项） `MobileMe.tsx:336-364`
- [ ] 外观与隐私：深色模式（不可用）· 主题与字体（桌面专属）· 隐藏笔记 PIN → /hidden · 笔记加密 Vault（桌面专属） `MobileMe.tsx:370-390`
- [ ] 功能与扩展：功能模块 → /feature-toggle · 模型服务（N 个）→ /ai · MCP 服务器（不可用） `MobileMe.tsx:396-415`
- [ ] 检查更新：状态显示、防重复、已最新清红点、有新版弹确认（版本 + 说明） `MobileMe.tsx:416-429` `MobileMe.tsx:177-210`
- [ ] 非 .apk 地址用浏览器打开；App 内下载 APK + 进度弹窗（不可关闭） `MobileMe.tsx:102-119` `MobileMe.tsx:444-468`
- [ ] 无「安装未知应用」权限：说明 + 去设置；有权限拉起安装器 `MobileMe.tsx:122-147`
- [ ] 下载 / 安装失败：可改用浏览器下载 `MobileMe.tsx:148-167`
- [ ] 「关于」行（写死 v1.7.1）→ /about `MobileMe.tsx:431-436`
- [ ] 「不可用」行统一：右侧「不可用」、无箭头、点击 info 提示 `MobileMe.tsx:571-595`

#### src/pages/sync/MobileSync.tsx
- [ ] `/sync` 是顶层独立路由，桌面访问也渲染本组件 `Router.tsx:120-124`
- [ ] 监听 `sync_v1:progress` `MobileSync.tsx:123-137`
- [ ] 进入时加载后端列表 `MobileSync.tsx:139-153`
- [ ] 顶栏：返回 / 导入配置 / 新增 `MobileSync.tsx:393-415`
- [ ] 信息横幅（手动同步、支持 WebDAV 与 S3） `MobileSync.tsx:420-426`
- [ ] 加载中 / 空状态 `MobileSync.tsx:430-439`
- [ ] 后端卡：名称、类型、启用状态、上次推送 / 拉取、上次失败原因、进度区 `MobileSync.tsx:614-687`
- [ ] 「一键同步」（先推后拉；推送失败暂停拉取并通知；暂扣删除需确认；结果弹窗 + 系统通知） `MobileSync.tsx:690-696` `MobileSync.tsx:326-360`
- [ ] 「仅推送」/「仅拉取」 `MobileSync.tsx:700-713` `MobileSync.tsx:275-318`
- [ ] 拉取问题弹窗（最多 20 条，含加密笔记说明） `MobileSync.tsx:52-79`
- [ ] 「测试」连接（并检查远端是否有数据） `MobileSync.tsx:716-722` `MobileSync.tsx:257-273`
- [ ] 「分享」配置 / 「编辑」（密码留空不改）/ 「删除」（远端不动） `MobileSync.tsx:723-743` `MobileSync.tsx:174-209` `MobileSync.tsx:367-384`
- [ ] 同步中卡片按钮全禁用 `MobileSync.tsx:692-739`
- [ ] 新增 / 编辑弹窗：类型切换（WebDAV / S3，仅新增）、字段与必填校验、保存 `MobileSync.tsx:466-559` `MobileSync.tsx:211-255`
- [ ] 导入配置弹窗 `MobileSync.tsx:572-576`

#### src/pages/tags/MobileTags.tsx
- [ ] 加载标签（按使用次数降序） `MobileTags.tsx:58-75`
- [ ] 顶栏返回 / 新增标签（window.prompt） `MobileTags.tsx:139-153` `MobileTags.tsx:77-87`
- [ ] 标签云：加载中 / 空状态 / chip（字号随频率，点击搜 `#名称`） `MobileTags.tsx:163-184` `MobileTags.tsx:130-133`
- [ ] 标签列表：「全部 N 个标签」、颜色点、名称、笔记数 `MobileTags.tsx:191-216`
- [ ] 行内编辑区：9 色 / 清除颜色 / 删除标签（确认）/ 重命名 / 查看相关笔记 `MobileTags.tsx:217-274` `MobileTags.tsx:89-128`
- [ ] 重命名弹窗 `MobileTags.tsx:287-303`

#### src/pages/cards/MobileCards.tsx
- [ ] 加载最多 50 张待复习 `MobileCards.tsx:84-100`
- [ ] 顶栏返回 /「闪卡复习」/「FSRS · 待复习 N 张」/「统计」空占位 `MobileCards.tsx:157-175`
- [ ] 进度：已完成 / 总数、预计分钟、进度条 `MobileCards.tsx:179-195`
- [ ] 卡片点击翻面；第 N 次复习、稳定性、难度 `MobileCards.tsx:209-234`
- [ ] 4 档评分（忘了 / 困难 / 良好 / 轻松，显示下次间隔；未翻面禁用） `MobileCards.tsx:238-272`
- [ ] 评分后 FSRS 排期提交、出队 `MobileCards.tsx:105-133`
- [ ] 底部提示 / 完成或空状态 / 重新加载 `MobileCards.tsx:274-279` `MobileCards.tsx:361-372`

#### src/pages/trash/MobileTrash.tsx
- [ ] 加载第一页（最多 50） `MobileTrash.tsx:57-72`
- [ ] 顶栏返回 / 信息横幅（保留 30 天，共 N 项） `MobileTrash.tsx:151-169`
- [ ] 加载中 / 空状态 `MobileTrash.tsx:173-184`
- [ ] 「即将清理」分组（< 7 天）：标题、摘要、删除日期、剩余天数、还原、永久删除 `MobileTrash.tsx:187-203` `MobileTrash.tsx:288-314`
- [ ] 「最近删除」分组：标题、日期、剩余天数、还原 `MobileTrash.tsx:204-218` `MobileTrash.tsx:345-359`
- [ ] 普通行长按：还原 / 永久删除 `MobileTrash.tsx:333` `MobileTrash.tsx:131-143`
- [ ] 还原 / 永久删除（确认） `MobileTrash.tsx:74-102`
- [ ] 「已显示全部 N 项」/「清空回收站」（确认） `MobileTrash.tsx:219-239` `MobileTrash.tsx:104-122`

#### src/components/mobile/ActionSheet.tsx
- [ ] 打开锁背景滚动；未打开不渲染；点遮罩关闭 `ActionSheet.tsx:32-53`
- [ ] 可选标题；操作项可带图标、危险红色；点击先执行再关闭；「取消」 `ActionSheet.tsx:57-89`

#### 无移动版的路由（手机上直接渲染桌面页）
- [ ] `/prompts` → PromptsPage `Router.tsx:143` `prompts/index.tsx:103`
- [ ] `/hidden` → HiddenPage `Router.tsx:139` `hidden/index.tsx:59`
- [ ] `/about` → AboutPage `Router.tsx:148` `about/index.tsx:40`
- [ ] `/graph` → GraphPage `Router.tsx:141` `graph/index.tsx:40`
- [ ] `/push` → PushPage（MobileMe 没有入口） `Router.tsx:144` `push/index.tsx:37`
- [ ] `/whiteboard/:id` → WhiteboardPage `Router.tsx:135` `whiteboard/index.tsx:57`
- [ ] `/feature-toggle`：桌面移动共用一个组件，本身就是移动端设计稿 16 `feature-toggle/index.tsx:42-43`
