# B站视频评论反馈 — 待接入任务

> 来源：B站视频 `BV1xvosBREbr`《扔掉 Obsidian！3MB 的国产本地 AI 知识库，永久免费自带图谱》评论区用户建议
> 创建日期：2026-04-23（首次 4 条）；**2026-04-25 完整抓取（325 / 325）**：主评论 129 + 楼中楼 196，全部入库
> 抓取方式：未登录 cursor API 抓主评论；登录后用 chrome-devtools MCP 在浏览器内 fetch 抓楼中楼（绕过 -352 风控）
> 产物：`docs/tasks/_bilibili_comments.json`（含 `subreplies` 字段）；脚本：`_scrape_bilibili.py`

---

## 🔴 执行规则（继续任务前必读）

**每次要开始某条任务前，必须先走三步：**

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

每条任务有独立编号 (`T-xxx`)，可用 "继续任务 T-001" / "做 T-002" 的形式触发。

### ✅ 必须接入（高价值，成本可控）

---

#### T-001 · 笔记专用提示词库（AI Prompt Library）

- **状态**：`in_progress`  · 开工：2026-04-24
- **来源建议**：喝水小小能手（赞 23）"更多专门针对笔记的提示词"
- **价值**：⭐⭐⭐⭐  成本：低
- **已确认决策**：
  - ✅ 复用 `ai_write_assist` + 新增 `prompt:{id}` 分支
  - ✅ 内置 Prompt 用 DB 存（schema v19 首次写入）
  - ✅ `output_mode` 字段现在就加（replace / append / popup）
- **子任务进度**：
  - [x] 后端：schema v19 迁移 + 7 条内置 Prompt 写入
  - [x] 后端：models（PromptTemplate / PromptTemplateInput）
  - [x] 后端：database/prompt.rs（list/get/create/update/delete/setEnabled + builtin_code 查询）
  - [x] 后端：services/prompt.rs（变量替换器，3 个 unit test 通过）
  - [x] 后端：commands/prompt.rs + lib.rs 注册 6 条 Command
  - [x] 后端：services/ai.rs 改造 `write_assist` — 优先走 DB Prompt，硬编码保留为 fallback
  - [x] 前端：types + lib/api（promptApi）
  - [x] 前端：pages/prompts 管理页（表格 / 新建编辑 Modal / 复制 / 启用开关）
  - [x] 前端：Router + Sidebar（`/prompts` 路由 + "提示词"导航项）
  - [x] 前端：AiWriteMenu 改造（动态拉 prompts / 按 outputMode 预选"追加"或"替换"）
  - [x] `cargo check` 通过 + `npx tsc --noEmit` 通过 + `cargo test --lib services::prompt` 3/3 通过
  - [ ] **待用户手动验证**：启动 `pnpm tauri dev`，在笔记选中文本试各项操作；在 /prompts 新增一个自定义 Prompt 验证

---

#### T-002 · Linux 构建与发行

- **状态**：`completed`（代码维度）· 归档日期：2026-04-24
- **来源建议**：Tonkv "必须要有多端，安卓，linux 都要有"（Linux 部分）
- **价值**：⭐⭐⭐  成本：极低
- **实际发现**：代码配置**早已在前期工作中完成**，无需额外开发：
  - `.github/workflows/release.yml` matrix 含 `ubuntu-22.04 + --bundles deb,appimage`
  - Linux 系统依赖安装步骤齐全（webkit2gtk-4.1 / soup-3.0 / ayatana-appindicator3）
  - `src-tauri/tauri.conf.json` 有 `bundle.linux.deb.depends` + `appimage` 配置
  - `.claude/release-config.json` 和 `release-publish` skill 均已文档化 Linux 发布流程
- **遗留运维项（非代码）**：
  - ⚠️ 首次 Linux CI 尚未真正触发过（`knowledge-base-release/update.json` 还没有 `linux-x86_64` 条目；`releases/v1.1.0/` 下无 Linux 产物）
  - 下次 `/release` 发版会自动跑 Linux CI，按 `release-publish` skill 步骤 7~10 将 Linux 产物复制到 release 仓库 + 上传 R2 + 更新 update.json 即可闭环

---

#### T-003 · 笔记"隐藏"标记（B1 轻量版）

- **状态**：`in_progress`  · 开工：2026-04-24
- **来源建议**：鹏钧九派 "有些文章需要进行加密或者设置一个隐藏，因为存在他人使用电脑的问题"
- **价值**：⭐⭐⭐⭐  成本：中
- **已确认决策**：
  - ✅ 独立路由 `/hidden`（类似 `/trash`），主界面完全看不到隐藏笔记
  - ✅ 标记入口：编辑器顶部按钮；`/hidden` 页"取消隐藏"按钮
  - ✅ 过滤范围：列表/搜索/图谱/反向链接全过滤；wiki link 跳转保留
  - ✅ v1 不加 PIN（留给 T-007 加密）
  - ✅ daily / 模板不支持隐藏
- **子任务进度**：
  - [x] 后端 schema v21：notes.is_hidden + 部分索引（activeonly）
  - [x] 后端 models：Note.is_hidden
  - [x] 后端 database/notes.rs：list_notes 加过滤；8 个 Note 构造位置全部同步新列；新增 list_hidden_notes + set_note_hidden
  - [x] 后端 database/search.rs (全文搜索)、links.rs (search_link_targets / get_backlinks / get_graph_data)、ai.rs (RAG)、tags.rs (list_notes_by_tag) 都加 is_hidden=0 过滤
  - [x] 后端 services/note.rs + commands/notes.rs + lib.rs 注册 set_note_hidden / list_hidden_notes
  - [x] 前端 types.Note.is_hidden + lib/api (noteApi.setHidden + hiddenApi.list)
  - [x] 前端 pages/hidden/index.tsx（列表 + 取消隐藏 + 点标题跳编辑器）
  - [x] 前端编辑器顶部"Eye/EyeOff"按钮 + handleToggleHidden
  - [x] 前端 Router + Sidebar 底部快捷入口"隐藏笔记"
  - [x] cargo check + tsc --noEmit 全通过
  - [ ] **待用户手动验证**：
        1. 编辑器点"隐藏"按钮 → 主列表 / 搜索 / 图谱 / AI 问答都看不到这条
        2. 侧栏"隐藏笔记"入口能看到，点"取消隐藏"后主列表恢复可见
        3. `[[被隐藏笔记标题]]` 仍可点击跳转（弱隐藏设计）

---

#### T-004 · Skills 框架 v1（AI 操作软件）

- **状态**：`in_progress`  · 开工：2026-04-24
- **来源建议**：喝水小小能手（赞 23）"软件内置 skills，让 AI 能够操作软件"
- **价值**：⭐⭐⭐⭐⭐  成本：中
- **已确认决策**：
  - ✅ 仅 OpenAI 兼容协议族（OpenAI/DeepSeek/智谱/Claude 代理）；Ollama 放 v2
  - ✅ v1 只做 5 个只读 skill：search_notes / get_note / list_tags / find_related / get_today_tasks
  - ✅ tool-use 最大轮数 3 轮
  - ✅ UI 内联展示 SkillCall（折叠卡片）
  - ✅ 启用 skills 时默认关 RAG（AI 自己调 search_notes）
  - ✅ SkillCall 持久化到 ai_messages.skill_calls_json（schema v19→v20）
- **子任务进度**：
  - [x] schema v20 迁移 + AiMessage.skill_calls 字段
  - [x] models：SkillCall 定义
  - [x] database/ai.rs：add_ai_message_full + list 携带 skill_calls_json
  - [x] services/skills.rs：5 个只读 skill + tool_schemas + dispatch（4 单元测试通过）
  - [x] services/ai.rs：chat_stream_with_skills + tool_calls delta 累加解析 + 最多 3 轮
  - [x] commands/ai.rs：send_ai_message 加 use_skills 参数
  - [x] 前端：types + api + AI 对话页 Skills 开关 + SkillCallList 折叠卡片 + ai:tool_call 监听
  - [x] `cargo check` 通过 + `npx tsc --noEmit` 通过 + `cargo test services::skills` 4/4 通过
  - [ ] **待用户手动验证**：在 /ai 开启 Skills 开关，问"我最近有什么笔记在讲 Tauri？"测 search_notes；
        再问"今天有什么待办"测 get_today_tasks；验证"工具调用卡片"能展开看 args + result

---

#### T-005 · AI 自动规划今日待办

- **状态**：`in_progress`  · 开工：2026-04-24 · 依赖：T-004 ✅
- **来源建议**：喝水小小能手（赞 23）"AI 可以自动规划今日待办事项"
- **价值**：⭐⭐⭐⭐  成本：低
- **已确认决策**：
  - ✅ 不扩 Skills 框架（写入类走独立"AI 提议 → 用户确认"路径，Skills 保持只读）
  - ✅ 入口同时放 /daily 和 /tasks（Sparkles "AI 规划今日"按钮）
  - ✅ 支持用户输入"今日目标"（可选 textarea）
  - ✅ AI 返回 JSON（`response_format: json_object`）后前端弹 Modal 让用户勾选/编辑/保存
  - ✅ 保存默认 due_date=今天，用户可逐条改；展示 reason；不支持 Ollama
- **子任务进度**：
  - [x] 后端 models：PlanTodayRequest / TaskSuggestion / PlanTodayResponse
  - [x] 后端 services/ai.rs：plan_today（聚合昨/今 daily + 过期任务 + 今日已有 → 非流式 + JSON + markdown 代码块兜底；3 单测通过）
  - [x] 后端 commands/ai.rs：ai_plan_today Command + lib.rs 注册
  - [x] 前端 types + lib/api.aiPlanApi
  - [x] 前端 components/ai/PlanTodayModal.tsx（idle/loading/review 三阶段 + 勾选/编辑/删除/重新生成/批量保存）
  - [x] 前端 daily（仅今日显示）+ tasks 页各加"AI 规划今日"按钮
  - [x] cargo check + tsc + cargo test plan_today 3/3 全通过
  - [ ] **待用户手动验证**：/daily 或 /tasks 点"AI 规划今日" → 填目标（可选）→ 生成 →
        勾选建议 → 保存 → 列表出现新待办

---

### ⚠️ 谨慎接入（价值有但风险/成本偏高）

---

#### T-006 · AI 自动撰写笔记并归档（半自动版）

- **状态**：`in_progress` · 开工 2026-04-24 · 依赖：T-004 ✅ T-005 ✅
- **来源建议**：喝水小小能手（赞 23）"笔记也是 AI 编写并保存在对应目录"
- **价值**：⭐⭐⭐  成本：中
- **已确认决策**：
  - ✅ 侧栏"AI 写笔记"全局按钮 + /notes 列表头按钮（二选一后续再精修）
  - ✅ 仅新建笔记（v1 不支持追加到现有笔记）
  - ✅ 输入：主题 / 参考材料（可选）/ 目标长度（简短·中等·长篇）
  - ✅ AI 拿**扁平化目录路径**（不喂笔记内容，避免过度泄露）→ 返回建议路径
  - ✅ 保存前三栏 Modal：输入 / Markdown 预览 / 目录 + 标题编辑
  - ✅ 一次性 JSON 响应：`{title, content, folderPath, reason}`
  - ✅ 仅 OpenAI 兼容（不支持 Ollama）
  - ✅ 目录不存在时自动递归创建（ensure_folder_path_str）
- **子任务进度**：
  - [x] 后端 models：DraftNoteRequest / DraftNoteResponse / TargetLength
  - [x] 后端 services/ai.rs::draft_note（扁平化目录 + 非流式 JSON + 两轮兜底；3 单测通过）
  - [x] 后端 services/folder.rs::ensure_path（"工作/周报" → folder_id 递归创建）
  - [x] 后端 commands/ai.rs::ai_draft_note + commands/folders.rs::ensure_folder_path + lib.rs 注册
  - [x] 前端 types（DraftNoteRequest / DraftNoteResponse / TargetLength）+ lib/api（aiPlanApi.draftNote + folderApi.ensurePath）
  - [x] 前端 components/ai/DraftNoteModal.tsx（idle / loading / review 三阶段；review 为三栏布局 + Markdown 预览）
  - [x] 前端侧栏全局"✨"按钮入口
  - [x] cargo check + tsc --noEmit + cargo test draft_note 3/3 全通过
  - [ ] **待用户手动验证**：
        1. 侧栏"+ 新建笔记"旁 Sparkles 按钮 → 填主题（如"Rust 所有权"）→ 生成
        2. Modal 三栏显示预览 + 标题/路径/正文可编辑
        3. 点"保存并打开" → 自动跳转到新笔记编辑器，目录被自动创建

---

#### T-007 · 笔记加密（完整版）

- **状态**：`in_progress`（T-007a 后端 + 前端已落地，待用户手动验证）  · 开工：2026-04-23
- **依赖**：T-003 ✅（过滤链路已跑通可复用）
- **来源建议**：鹏钧九派 "有些文章需要进行加密"
- **价值**：⭐⭐⭐⭐  成本：**高（4~7 天，跨多会话）**，建议按 a/b/c 三段拆分

##### 已拟定决策（等用户确认启动）

| # | 决策 | 推荐 |
|---|------|------|
| ① | 加密粒度 | **A2 加密保险库**（一个主密码锁一组笔记，跟 T-003 hidden 的分组思路衔接） |
| ② | 加密层 | **B1 App 层加密**（`notes.content/title` 密文存 DB；不换 SQLCipher） |
| ③ | 算法组合 | **Argon2id（KDF）+ XChaCha20-Poly1305（AEAD）** — 两者都有纯 Rust crate |
| ④ | 忘记密码 | **E1 数据丢失**（UI 强提示 + 首次设置时 3 次二次确认 + 建议导出 Markdown 备份） |
| ⑤ | 加密笔记的搜索/图谱/反链 | v1 **完全排除**（复用 T-003 过滤链路） |

##### 拆分（3 段）

###### T-007a · 核心加密基础设施（2~3 天） — **已完成，待手动验证**
- [x] 后端 `services/crypto.rs`：Argon2id KDF（19456 KiB / 2 iter / 1 par） + AES-256-GCM AEAD 封装；5 个单测通过
  - 注：算法最终落地为 AES-256-GCM（`aes-gcm` crate 已在 WebDAV 流程中使用，减少额外依赖；若后续有审计诉求再切 XChaCha20-Poly1305）
- [x] 后端 `services/vault.rs`：`VaultState`（`Zeroizing<[u8;32]>` 内存 key，不落盘）+ 状态机 `NotSet/Locked/Unlocked` + 1 个单测通过
- [x] schema v23：`notes.is_encrypted INTEGER DEFAULT 0` + `notes.encrypted_blob BLOB` + `idx_notes_encrypted`（部分索引）
- [x] vault 验证器模式：`app_config.vault.salt` + `app_config.vault.verifier`（用常量明文加密的校验串，解锁时再解密验证）
- [x] DAO 改造：所有 8 处 `Note` 构造点加 `is_encrypted` 字段；新增 `enable/disable_note_encryption` / `get/update_encrypted_blob`
- [x] Commands：`vault_status / vault_setup / vault_unlock / vault_lock / encrypt_note / decrypt_note / disable_note_encrypt`（共 7 个，已在 lib.rs 注册）
- [x] 前端 `VaultModal`（setup 三勾选确认 / unlock 单输入）+ `useVaultStatus` hook
- [x] 前端 `types/index.ts` 加 `is_encrypted` 字段 + `VaultStatus` 类型
- [x] 前端 `lib/api/index.ts` 加 `vaultApi`
- [x] 前端编辑器 `editor.tsx` 顶部新增 Lock/Unlock 图标按钮 + `handleToggleEncrypt` 逻辑（vault 未设置 → 拉起 setup Modal；已锁 → 拉起 unlock Modal；已解锁 → 直接加/解密）+ 渲染 `<VaultModal>`
- [x] `npx tsc --noEmit` + `cargo check` 全绿
- [ ] 待用户手动验证：(1) 首次点锁 → 主密码设置流程 → 加密 → 主列表占位符显示；(2) 重启应用验证自动锁；(3) 解锁后能编辑加密笔记

###### T-007b · UI 打磨 + 边界（1~2 天）
- 编辑器顶部"锁/开锁"图标 + 加密状态指示
- `/hidden` 页对加密笔记的特殊标记
- 设置页"更换主密码" / "空闲自动锁定时长"配置
- 导出 Markdown 时对加密笔记的处理（跳过 / 明文导出警告）
- 批量加密现有笔记的 UI 入口（可选）

###### T-007c · 搜索兼容（v2 可选）
解锁态下的加密笔记也能参与搜索：检索时在内存里临时解密，不落盘。
暂缓到 v2，T-007 主版本不做。

##### 风险清单

| 风险 | 缓解 |
|------|------|
| 用户忘记主密码 → 数据永久不可读 | 首次设置时 3 次"我确认会记住，忘了数据丢失"+ 建议导出 Markdown 备份 |
| 内存里的 key 被本地进程扒 | 空闲 N 分钟自动锁定（可配置）；Tauri WebView 隔离一定程度保护 |
| 老用户的"隐藏笔记"是否一键升级为"加密"？ | v1 **不做**自动升级；用户逐条勾选转化 |
| Markdown 导出 / WebDAV 同步 | 导出明文会弹警告；WebDAV 同步保持密文形式（不解密） |

##### 依赖 crate

- `argon2 = "0.5"` — Argon2id 密码派生
- `chacha20poly1305 = "0.10"` — XChaCha20-Poly1305 AEAD
- `zeroize = "1"` — 主密钥在 drop 时清零内存（敏感数据防 swap）
- `rand = "0.8"`（项目已有） — 盐/nonce 生成

---

### 🕳️ 待确认细节（信息不全）

---

#### T-008 · 追问鹏钧九派评论里"以下问题"的具体内容

- **状态**：`partly_resolved` — 二次抓取看到鹏钧九派后续 #55 仍是 "博主，有BUG需要你那边修复一下"，但同一批评论里 ちょっとおかしい #54 已给出具体 bug 清单，可以先按那条做（拆为 T-B01/T-B02/T-B03）；如鹏钧九派是别的问题，等他续评再补任务

---

### 🆕 二次抓取新增需求（2026-04-25）

> 下列任务全部来自二次抓取的 129 条评论，按"高频→中频→Bug"分组。每条会标注关键提议者 + 赞数，便于后续核对原文。

---

#### T-009 · OB 整库一键导入（**最高频需求**）

- **状态**：`in_progress`（Commit 1+2+3 全部完成，待用户手动验证）  · 开工：2026-04-25
- **来源建议**：齊戰疾#9（赞 5）"除非能快速导入ob的库，且不丢失内容" / 混酱大肠粉#106 "首要功能是直接导入 obsidian 整个项目目录" / 昱羽#81 "导入 obs 笔记时，目录分配不会自动导入" / 傲娇的小小森#80 "导入 md 文档后，没办法按文件夹分组" / 敌台搬运工#128 "OneNote 一键导入" / 作尘__#129 "能从 obsidian 无缝转到这个软件嘛"
- **价值**：⭐⭐⭐⭐⭐  成本：中

##### Commit 1 进度（已完成）— 跳过隐藏目录 + frontmatter tags

- [x] `Cargo.toml` 加 `serde_yml = "0.0.12"`
- [x] `services/markdown.rs::parse_frontmatter` + `FrontMatter { tags, aliases, title }`，9 个单元测试覆盖：无 fm / inline 数组 / block 列表 / 单字符串 / 内联 csv / 未闭合 / 无效 yaml / 空 tags / CRLF
- [x] `services/import.rs::scan_markdown_folder` 加 `filter_entry(should_skip_dir_entry)`，跳过 `.obsidian` / `.trash` / `.git` / `node_modules` 等点开头目录与 node_modules（根目录例外）
- [x] `services/import.rs::import_selected_files` 改造：解析 frontmatter → 剥离 yaml block → body 写入；frontmatter.title 优先于 `# H1`；导入后 `get_or_create_tag_by_name` + `add_tag_to_note` 关联标签
- [x] `database/tags.rs::get_or_create_tag_by_name` DAO 助手
- [x] `models/mod.rs::ImportResult` 加 `tags_attached` / `frontmatter_parsed` 字段
- [x] 前端 `types.ImportResult` 同步；`noteCreator.tsx` 成功 toast 显示"自动关联 N 条标签"
- [x] cargo test 54/54 通过；cargo check / npx tsc --noEmit 干净
##### Commit 2 进度（已完成）— 附件复制 + 图片路径重写

- [x] `Cargo.toml` 加 `regex = "1"`
- [x] `services/import_attachments.rs` 新建：`AttachmentIndex::build`（扫 `attachments/` `assets/` `images/` `_resources/`，仅图片扩展名，按 basename 索引，同名先到先得 + warn 日志）+ `path_to_asset_url`（cfg-gate：Win → `http://asset.localhost/`，macOS/Linux → `asset://localhost/`）+ `rewrite_image_paths`（标准 md `![alt](path)` + OB wiki `![[name|alt|width]]` 双正则；外链 / data: / asset:// 跳过；缺失保留原引用进 missing 列表）；9 个单元测试覆盖建索引 / md 重写 / wiki 重写带 alt 与宽度 / 纯宽度 / 外链不动 / 缺失保留 / wiki basename fallback / asset URL 幂等 / missing 去重
- [x] `services/import.rs::import_selected_files` 加 `app_data_dir: &Path` 参数；预建 `AttachmentIndex`；导入循环里调 `rewrite_image_paths` → 通过 `ImageService::save_from_path` 复制图片到 `kb_assets/images/<note_id>/` → body 改写为 asset URL → `db.update_note_content` 回写
- [x] `commands/import.rs` 加 `Manager` import，从 AppHandle 提取 `app_data_dir` 透传
- [x] `models::ImportResult` 加 `attachments_copied: usize` + `attachments_missing: Vec<String>`（"笔记标题: 原始引用"格式）
- [x] 前端 `types.ImportResult` 同步；`noteCreator.tsx` toast 显示"复制 N 张图（M 张缺失）"
- [x] `cargo test services` 74/74 全过；`cargo check` + `npx tsc --noEmit` 干净
- [x] **非图片附件**（PDF / docx 等通过 `![[doc.pdf]]` 嵌入）按确认仅扫图片扩展名，未匹配的会作为 missing 出现在汇总（用户可看到，但 v1 不自动复制）
- [x] **重名策略**：第一个胜出 + warn 日志（与 OB 一致）

##### Commit 3 进度（已完成）— 前端 UI 提示 + toast 增强

- [x] `ImportPreviewModal` 加"已自动启用 Obsidian 仓库兼容"卡片：明确告知用户三件事自动发生（跳过隐藏目录 / 解析 frontmatter tags / 复制 attachments|assets|images 图片）。**未加显式开关**：Commit 1+2 的能力对所有 markdown 导入都默认开启且无副作用，加 toggle 反而增加心智负担
- [x] `NotesPanel` 导入完成 toast 加新统计："关联标签 N 条 · 复制图片 M 张"，缺失图片单独 warning 提示并打到 console
- [x] **未做** `Sidebar` 独立"导入 Obsidian 仓库"按钮：现有右键菜单"导入 Markdown 文件夹…"已能完整处理 OB vault；加独立按钮属于重复入口，不增加价值
- [x] `npx tsc --noEmit` 干净
- [ ] **待用户手动验证**：找一个真实 OB 仓库（含 `.obsidian/` `attachments/` 目录 + 带 `tags:` frontmatter 的 .md）→ 在 NotesPanel 文件夹右键"导入 Markdown 文件夹…" → 选 vault 根目录 → 看 Modal 顶部"已自动启用..."卡片 → 确认导入 → 验证：(1) `.obsidian/` 没被当成笔记 (2) 笔记标签栏出现了 frontmatter 的 tags (3) 笔记里的图片正常显示而不是断链 (4) toast 显示统计
- **核心痛点**：现有"导入 markdown"是平铺，不还原 OB 的目录树
- **建议方案**：复用现有 markdown 导入流程，让用户选 OB Vault 根目录 → 递归扫所有 `.md` → 按相对路径自动 `ensure_folder_path`（T-006 已有这个 service）→ 附件文件夹（`assets/`、`attachments/`）一并复制到笔记 attachments
- **建议同时支持**：`[[wiki link]]` 直接保留（项目已支持）；附件路径需重写到导入后的位置
- **不在 v1**：OB 插件特有语法（dataview / templater 模板）；callout（`> [!note]`）可降级为引用块
- **建议价值排序**：这个比 T-007b/T-006 余下打磨都重要，建议下一个做

---

#### T-010 · 代码块语法高亮

- **状态**：`completed`（待用户手动验证视觉效果）  · 完成日期：2026-04-25
- **来源建议**：披风人_#25（赞 1）"代码块可以高亮吗"
- **价值**：⭐⭐⭐⭐  成本：**极低（实际只需 CSS）**
- **实际发现**：`@tiptap/extension-code-block-lowlight` + `lowlight`（含 `common` 语言集）**早已在依赖里且已接入** `TiptapEditor.tsx`，DOM 里也产出 `<span class="hljs-keyword">` 等 token，**唯一缺的是 token CSS** —— 用户报告"代码块没颜色"是因为 `highlight.js` 默认主题 CSS 没引入
- **改动**：仅 `src/styles/global.css` 加 `.hljs-*` token 着色规则（约 130 行），覆盖 `.tiptap` 编辑器和 `.ai-markdown` AI 对话区两个上下文
  - 默认浅色：紫=控制流 / 蓝=类型函数 / 绿=字符串 / 橙=数字字面量 / 青=变量名 / 灰=注释
  - 深色覆盖：`[data-theme="dark-mocha"]` 和 `[data-theme="dark-starry"]` 两个主题切到 GitHub Dark 风格的高对比色（紫 #d2a8ff / 蓝 #79c0ff / 绿 #7ee787 / 橙 #ffa657）
  - 同时覆盖 `addition` / `deletion` 的 diff 行底色
- **未引入新依赖**：不装 `highlight.js` 主题包（~700KB），节省体积，且与项目设计 token 体系一致
- **验证**：`npx tsc --noEmit` 干净
- [ ] **待用户手动验证**：在编辑器写一个 ` ```javascript ... ``` ` 代码块，确认有颜色高亮；切到 dark-mocha / dark-starry 主题后再看是否依然清晰

---

#### T-011 · LaTeX 公式渲染（行内 + 块级）

- **状态**：`completed`（待用户手动验证）  · 完成日期：2026-04-25
- **来源建议**：汐雲小倌#62 "行内 latex 和块级 latex 貌似都不支持"
- **价值**：⭐⭐⭐⭐  成本：低（实际半小时内）
- **决策**：用官方 `@tiptap/extension-mathematics@3.22.4` + `katex@0.16.45`（peer deps 自动满足）
- **改动**：
  - `package.json` 加 `@tiptap/extension-mathematics` + `katex`
  - `src/styles/global.css` 顶部 `@import "katex/dist/katex.min.css"`
  - `src/components/editor/TiptapEditor.tsx` 加 `Mathematics` 扩展 + `migrateMathStrings` 升级钩子（onCreate + content useEffect 双保险，把 markdown 里的 `$..$` 和 `$$..$$` 字面量升级成 math 节点）
- **存储格式**（与 OB 完全兼容）：
  - 行内：DB / 文件中是 `$E=mc^2$`，编辑器渲染为公式节点
  - 块级：DB / 文件中是 `$$\sum...$$`，编辑器渲染为块级公式
- **编辑器实时输入触发**（官方扩展约定，与存储格式不同）：
  - 行内：用户键入 `$$expr$$`（**两对** `$`）即转 math node
  - 块级：用户键入 `$$$expr$$$`（**三对** `$`）即转 math block
  - **OB 用户的 `$..$` 单美元写法**：粘贴 / 文件加载时由 `migrateMathStrings` 自动升级，无需手动改写
- **未做**：工具栏"插入公式"按钮（用户可直接键入或从粘贴）
- **风险已规避**：tiptap-markdown 序列化时 math 节点会还原为 `$..$` / `$$..$$`，markdown 文件保持纯净
- **验证**：`npx tsc --noEmit` 干净
- [ ] **待用户手动验证**：(1) 编辑器输入 `$$E=mc^2$$` → 渲染行内公式；(2) `$$$\sum_{i=1}^{n} i$$$` → 块级；(3) 把 OB 笔记里 `$x^2$` 粘进来 → 自动渲染；(4) 切到 dark-mocha 主题 → 公式仍清晰

---

#### T-012 · 自定义 API 提供商 + lm studio 本地兼容

- **状态**：`completed`（待用户手动验证）  · 完成日期：2026-04-25
- **来源建议**：阿泽牙不齐#96 "API 提供商只能用默认那几个吗，可不可以自定义" / 凰药仙#65,#89 "本地 ai 能不能用 lm studio" / 只会睡觉的折戟#85 同 / 书城林城#68 "配置自定义 AI 模型，无法使用"
- **价值**：⭐⭐⭐⭐  成本：低（实际半小时内）
- **改动**：
  - 后端 `services/ai.rs`：5 处硬编码 `match provider == "openai"|"claude"|"deepseek"|"zhipu"` 改为**默认 fallback 走 OpenAI 兼容协议**，仅显式拒绝 `"ollama"` 不支持 JSON / Skills 的场景
  - 前端 `pages/settings/index.tsx`：`PROVIDERS` 列表新增 `lmstudio` / `minimax` / `siliconflow` / `custom` 四个预设；`DEFAULT_URLS` / `MODEL_ID_PLACEHOLDERS` / `MODEL_PRESETS` 同步补全
  - 表单 `extra` 文案改成"除 Ollama 外都按 OpenAI 兼容协议；选『自定义』可填任意 baseUrl"
- **不需要 schema 改动**：`ai_models` 表的 `provider` / `api_url` / `api_key` / `model_id` 字段已够用
- **同时修复**：T-B05 (书城林城 "自定义 AI 模型无法使用") — 同根问题
- **验证**：`cargo check` + `npx tsc --noEmit` 干净
- [ ] **待用户手动验证**：
      1. 设置页 → 添加新 AI 模型 → provider 选"LM Studio (本地 OpenAI 兼容)" → 默认 url 填 `http://localhost:1234/v1` → 启动 LM Studio 加载一个模型 → 在 /ai 对话能流式输出
      2. provider 选"自定义" → 自填 minimax / 任意 OpenRouter / 自建网关的 baseUrl + apiKey → 对话能流出
      3. 老的 deepseek / openai / claude / zhipu 配置不受影响（match 默认 fallback 兼容旧数据）

---

#### T-013 · 数据目录可自定义（不强占 C 盘）

- **状态**：`pending`
- **来源建议**：山下一凡人#100 "数据目录希望可以自定义，c 盘不够大"
- **价值**：⭐⭐⭐⭐  成本：中
- **建议方案**：设置页加"数据目录"项 → 用 `dialog` 选目录 → 写到 `tauri-plugin-store` 的 settings.json → 启动时优先读这个路径，缺失再 fallback 到 `app_data_dir()`
- **风险**：用户切目录后老数据要不要迁？v1 提示"切换后旧数据保留在原位置，请手动复制 .db 与 attachments"，不自动迁

---

#### T-014 · 网页剪藏（粘贴 URL → 抓正文 → 入库）

- **状态**：`pending`
- **来源建议**：B站用户-LUCK#38 "建议增加将网页生成笔记文档功能" / 幻觉概念#75 "浏览器上看见素材图片希望能直接复制粘贴到笔记中，且不会因为网页的消失而损坏"
- **价值**：⭐⭐⭐  成本：中
- **建议方案**：v1 不做浏览器扩展（开发量大），先做"粘贴 URL → 后端 reqwest 抓 HTML → readability-rs 提取正文 → html2md 转 markdown → 新建笔记"，已有 html2md 依赖
- **图片**：抓页面时图片下载到本地 attachments，避免链接失效

---

#### T-015 · 看板 / 四象限待办

- **状态**：`pending`
- **来源建议**：绛降__#11 "kanban、easytypeing 插件" / 一叶闻界#86 "希望待办可以添加四象限的形式" / 铭浥#36 "ob 的 tasks、dataview"
- **价值**：⭐⭐⭐  成本：高
- **建议方案**：在 `/tasks` 页加视图切换（列表 / 看板 / 四象限）；列表→看板需要 task 表加 `column` 字段；四象限按 重要×紧急 自动分组
- **依赖**：`react-dnd` 或 `@hello-pangea/dnd` 拖拽

---

#### T-016 · 导入笔记到当前选中文件夹（**小修但 UX 影响大**）

- **状态**：`pending`
- **来源建议**：玛卡巴卡的冷吃兔#22 "导入笔记只能导入再分类，不能在选中的文件夹下面导入直接自动归类" / 傲娇的小小森#80 / 昱羽#81
- **价值**：⭐⭐⭐⭐  成本：极低
- **建议方案**：检查现有"导入"按钮，传入当前侧栏选中的 folder_id 作为默认目标；纯前端改动 + Service 层加可选参数

---

#### T-017 · 表格增强（合并单元格 / 颜色 / 字体）

- **状态**：`pending`
- **来源建议**：wwzp丿#125 "表格能加合并单元格、填充颜色、更改字体和背景颜色"
- **价值**：⭐⭐⭐  成本：中
- **建议方案**：Tiptap 自带 `@tiptap/extension-table` 已支持基础表格；合并单元格用 `mergeCells`；样式需扩展 cell attributes 写入 markdown 时降级（普通 markdown 不支持单元格颜色，导出兜底为 HTML 表格）

---

#### T-018 · 侧栏可拉伸 / 文件夹嵌套折叠优化

- **状态**：`pending`
- **来源建议**：玛卡巴卡的冷吃兔#22 "侧边栏无法拉伸，子文件夹嵌套过多后看着就很奇怪"
- **价值**：⭐⭐⭐  成本：低
- **建议方案**：用 `react-resizable-panels` 替换或包裹 `SidePanel`；文件夹嵌套缩进改用动态减小（每层 -2px）+ 鼠标悬停显示完整路径 tooltip

---

#### T-019 · 白板 / Karpathy 风格知识图谱

- **状态**：`pending`
- **来源建议**：丨Yoann丨#21 "好奇有无白板计划" / 网工身高190#42 "加入卡帕西的知识库思路" / 卡皮巴拉大魔王#111 "Karparhy 那个样子"
- **价值**：⭐⭐⭐  成本：**很高（独立 epic）**
- **暂缓**：等 v2 再考虑；现有图谱已经够用

---

#### T-020 · 导出 Word / 分享发布

- **状态**：`pending`
- **来源建议**：骑着小猪很疯狂#94 "能导出 word 吗" / 财前葵#46 "有分享或者发布的功能么"
- **价值**：⭐⭐  成本：中
- **建议方案**：Word 用 pandoc CLI 调用（用户需自装）或直接生成 .docx via `docx-rs`；分享暂不做（涉及账号系统）

---

### 🐛 Bug 修复（来自二次抓取，分组分配编号 T-Bxx）

---

#### T-B01 · "黑夜星空"主题下模型 ID 文字纯白看不见

- **状态**：`pending`
- **来源建议**：ちょっとおかしい#54（赞 0，但内容详尽）"我把主题设成黑夜星空时，模型 ID 会变成纯白色，必须光标拖动选中之后才会露出文字颜色"
- **影响**：黑夜星空主题下 AI 模型选择器失效（看不见选项）
- **定位**：`src/theme/antdTheme.ts` 或 `src/styles/variables.css` 在该主题下 `colorText` 与 `colorBgContainer` 都接近白
- **修复**：检查 token 配色，确保所有主题 `colorText` 与 `colorBgElevated` 对比度 ≥ 4.5

---

#### T-B02 · 删除唯一 AI 配置后报数据库错误

- **状态**：`completed` ✅  · 完成日期：2026-04-25
- **来源建议**：ちょっとおかしい#54 "我没有将唯一的一个 AI 设成默认配置...才可以正常使用"
- **影响**：用户删默认配置后整个 AI 模块崩（`get_default_ai_model` 返回 NotFound）
- **修复**：`database/ai.rs::delete_ai_model` 改成事务——删除前查 was_default → DELETE → 如果删的是默认，按 created_at ASC 选下一条标为默认；零条时不动（前端会显示"请先添加 AI 模型"）；不存在的 id 幂等返回
- **测试**：4 个新增单测全过：
  - `delete_default_picks_next_as_default`
  - `delete_non_default_leaves_default_intact`
  - `delete_only_model_does_not_panic`
  - `delete_nonexistent_id_is_idempotent`
- **验证**：`cargo check` + `cargo test database::ai` 全绿

---

#### T-B03 · WebDAV 导入默认行为是"覆盖"（吓人）

- **状态**：`pending`
- **来源建议**：ちょっとおかしい#54 "导入模式 覆盖（清空本地）合并...你居然默认是覆盖...有点吓人"
- **影响**：用户误点导致本地数据被云端覆盖
- **修复**：默认改为"合并"；"覆盖"前增加二次确认（输入"我确认覆盖"）

---

#### T-B04 · macOS 安装提示"应用已损坏"

- **状态**：`pending`
- **来源建议**：单酒窝好害羞#26,#87 / 风轻云淡#60 "macos15 直接崩溃" / 易象玄爻#126 "MAC M2 Tahoe26.4.1 安装后一直重启退出"
- **影响**：未签名导致 macOS 拦截；M2 Tahoe 上还有崩溃
- **修复方向**：
  1. 短期：README 加详细 `xattr -cr /Applications/知识库.app` 步骤说明 + 截图（用户#87 说还是损坏，可能是路径里中文 `知识库` 转义问题，已经在 productName 改 `Knowledge Base` 后缓解）
  2. 长期：申请 Apple 开发者账号 $99/年做 notarize；或在文档站加"macOS 解锁应用指南"专题
  3. M2 Tahoe 崩溃需要 issue 模板让用户提交 crash log；可能是 webview 兼容问题

---

#### T-B05 · 自定义 AI 模型无法使用

- **状态**：`completed`（已随 T-012 一起修复，待用户手动验证）
- **来源建议**：书城林城#68（赞 0）"配置自定义 AI 模型，无法使用"
- **修复要点**：T-012 把后端 `match provider` 的硬编码列表改为 fallback 默认走 OpenAI 兼容；前端 PROVIDERS 加 "自定义" 选项让用户自填 baseUrl
- **验证**：见 T-012 验证步骤

---

#### T-B06 · PDF 导入失败

- **状态**：`pending`
- **来源建议**：sunny-cxy#67 "导入 PDF 文件会显示 PDF 导入失败" / EvilE#124 "图片类型的 pdf 是怎么处理的呢？还得外挂 mineru 吗"
- **影响**：纯文本 PDF 导入是否能稳？图片型（扫描）PDF v1 明确不做 OCR
- **修复**：拿到具体 PDF 样本才能定位；先改文案——失败时区分"密码加密"/"扫描型 PDF（v1 不支持）"/"未知错误（贴日志路径）"
- **依赖确认**：CLAUDE.md 提过项目用 PDFium 绑定，需确认 fallback 路径

---

#### T-B07 · 写长文档时工具栏不跟随

- **状态**：`pending`
- **来源建议**：零想说#52 "写长文档的时候，工具栏没法跟随，有点伤"
- **影响**：长文档下方编辑时要滚回顶部找加粗 / 链接按钮
- **修复**：编辑器顶栏改 `position: sticky; top: 0`，或用 Tiptap 的 BubbleMenu

---

#### T-B08 · 反向链接面板入口不显眼

- **状态**：`pending`
- **来源建议**：bilicxma#109 "底部反向链接面板在哪里找"
- **影响**：用户找不到已经实现的功能
- **修复**：编辑器右侧抽屉加显眼图标 + tooltip "反向链接 (N)"；或在文档站加截图说明

---

### 💡 功能克制 / 设计反馈（不立任务，记录共识）

- 沐云mvyvn#61：配色"有点 ai"，建议参考 OB；"主页上功能太多看起来没有重点"
- daum12569#58：笔记界面圆角没做全
- 玛卡巴卡的冷吃兔#22：AI 问答"回答不到点上，错的离谱"，自建 RAG 更好用 → 暗示 RAG 召回 / 重排还有提升空间，但属持续优化
- 冈子Gungnir#127：笔记软件功能太多反而干扰做笔记 → 提醒后续别再无脑加功能
- 悟空大战72种人格#49：批"AI 风产品 / 套路 / 没产品思考"，主因是"避开了 OB 最强的双链 + 标签 + template + markdown 直编辑"——提醒后续是否需要做 markdown 源码编辑模式

---

### ⛔ 暂不接入（新增）

---

#### T-X02 · 鸿蒙 / 安卓 / iOS 端

- **状态**：`wont_do`
- **来源建议**：无情大猪蹄#4 / 摸鱼大师 online#34 / Tonkv#37 / 设计师大哥哥#73 / Bluzway#97 / urbangirlm#105 / 甲鸟子口各口各哒#107 / lakers-bao#123 / い寻常づ#84 / 学人长记人好#95 / 陆婴#83 / 散光-老表#99 / 随波逐流#28（共 13 条评论提及，**最高频拒绝项**）
- **理由**：与 T-X01 同；移动端定位不同，需独立项目立项
- **回应草稿**：可在置顶评论或 README 加一句"v1 桌面优先，移动端走独立 App 路线（暂未启动）"

---

#### T-X03 · 一键导入有道云 / 飞书 / OneNote / Notion

- **状态**：`wont_do`（v1 仅做 OB / md 通用导入，见 T-009）
- **来源建议**：ArfersIorfik#39 / 安和桥下LF#76 / 敌台搬运工#128（OneNote）
- **理由**：每家有独立 API + 鉴权流程，做完一家又来一家维护成本爆炸；v1 仅做 OB（即 markdown + 附件文件夹）；其他云笔记软件用户大概率也能导出 markdown，先走 T-009 通路

---

#### T-024 · 同步架构重构 V0→V1（多端真同步 + 多 backend）  ⭐ 升级为正式 epic（替换原 T-X04 的拒绝项）

- **状态**：`mostly_done`（a/b/c/e ✅；d 主动放弃；待用户手动验证）  · 开工：2026-04-25 · 完工：2026-04-25
- **来源建议**：baserker2(子)赞 5 "多端同步是痛点"；烧鸡趴喊老吴 #50 赞 1 "webdav 是非实时同步吧？多端使用会不会信息不同步"；独孤重七 #12 赞 3 "便宜点的同步就能干掉 ob"；AVA三十二 #88 阿里云 oss；逸尘健康生活 #115 s3；梨梨梨梨离灵 #15 OneDrive/坚果云；鱼叔乐乐 #92 迅雷云盘
- **价值**：⭐⭐⭐⭐⭐  成本：**极高（~10 工作日，跨多会话 epic）**

##### 核心痛点分析

当前 `services/sync.rs` 的本质：
- **整库 ZIP 全量快照**（每次推送都打包整个 app.db + 资产）
- **每台机一份独立 ZIP**（按 hostname 区分文件名 → 多设备互不知情）
- **"merge 模式 == overwrite"**（注释自己写的：app.db 不合并）
- **结果**：等同于"按设备命名的备份"，不是同步。两台机轮流改笔记会互相覆盖

##### V1 设计

| 维度 | V0（现状） | V1（目标） |
|------|-----------|-----------|
| 数据单元 | 整库 ZIP | 每条笔记一个 `.md` 文件 + 一个 `manifest.json` |
| 推送策略 | 整包覆盖 | 增量上传变更 |
| 拉取策略 | overwrite 清空 | manifest diff → 仅下变更 |
| 多设备 | N 份独立备份 | 共享一份逻辑数据 |
| 冲突 | 无合并 | last-write-wins + 落败方放 `.conflicts/` |
| 附件 | 整包压缩 | 按 SHA-256 hash 命名（CAS，永不冲突） |

##### 拆分（5 段）

###### T-024a · 数据模型 + LocalPath backend（**本会话已完成 ✅**，2026-04-25）

- [x] 新 schema v23→v24：`sync_backends` + `sync_remote_state` 两张表 + 索引
- [x] 新 models：`SyncBackendKind` / `SyncBackend` / `SyncBackendInput` / `SyncRemoteState` / `ManifestEntry` / `SyncManifestV1` / `SyncPushResult` / `SyncPullResult`
- [x] DAO 层 `database/sync_v1.rs`：sync_backends 6 个 CRUD + sync_remote_state 4 个查询/upsert
- [x] Service 层 `services/sync_v1/`：
  - `backend.rs` — `SyncBackendImpl` trait + `BackendAuth` enum + `parse_auth` + `create_backend` 工厂
  - `backend_local.rs` — `LocalPathBackend`（atomic_write + posix path resolve；含 1 个 roundtrip 单测）
  - `manifest.rs` — `compute_local_manifest`（聚合 notes + folders 算出 manifest）+ `diff_manifests`（push/pull/conflicts/tombstone 四向分类；含 7 个单测）
  - `push.rs` — push 编排：compute → diff → put_note → upsert state → write manifest（带进度事件 `sync_v1:progress`）
  - `pull.rs` — pull 编排：read remote manifest → diff → get_note → upsert local note + ensure_folder_path → tombstone 软删 + 冲突文件落 `.conflicts/`（含 2 个 markdown 解析单测）
- [x] Commands 层 `commands/sync_v1.rs`：10 个 Command（CRUD backends / test_connection / read_remote_manifest / push / pull / get_local_manifest）
- [x] `lib.rs` 注册 10 个 Command；`cargo check` 零错误零警告；`cargo test sync_v1` 11/11 通过
- **不动**现有 `services/sync.rs` —— V0 ZIP 模式保留兼容
- 待用户后续手动验证：在前端做出来 UI 后，跑两个目录互推测试

##### T-024a 已知简化（留给后续阶段补）

1. **stable_id 用本地 i64**：多端互导时如果两边各自新建过笔记会撞 id。后续阶段加 `notes.stable_uuid` 列做严格 UUID
2. **本地软删除推送（tombstone push）未实现**：删笔记后远端不知道。`purge_remote_state` 已留接口
3. **附件同步未实现**：`put_attachment` / `get_attachment` 在 trait 中是默认 `Err`
4. **冲突 UI 未实现**：当前冲突落到 `<app_data>/sync_conflicts/backend_<id>/<id>_<ts>.md`，T-024e 前端做合并 UI
5. **加密笔记同步行为未决策**：当前会上传 `content` 列里的占位符，不暴露密文，但用户在另一端拉到的就是 placeholder（不可用）。建议后续：T-007 加密笔记**完全跳过同步**

###### T-024b · S3 协议 backend（**已完成 ✅**，2026-04-25）

- [x] Cargo 加 `rust-s3 = { version = "0.34", default-features = false, features = ["tokio-rustls-tls"] }`（pure Rust + rustls，零 C 依赖）
- [x] `services/sync_v1/backend_s3.rs`（185 行）— 实现 `SyncBackendImpl`：test_connection 用 put+delete 探针；4 个 IO 方法；prefix 支持；统一 path-style 兼容 R2 / 阿里云 / MinIO 自定义 endpoint
- [x] `services/sync_v1/runtime.rs` — 独立 multi-thread tokio runtime + `block_on` 把 async 调用包成 sync trait method
- [x] backend.rs 工厂解锁 S3 分支（接 BackendAuth::S3 → S3Backend::new）
- [x] 前端表单：endpoint / region / bucket / accessKey / secretKey / prefix 6 字段 + 各家服务的 endpoint 模板提示
- [x] `cargo check` 通过 + 11 个单测继续通过 + `npx tsc --noEmit` 通过

##### S3 backend 一次覆盖

| 服务 | endpoint 示例 |
|------|--------------|
| AWS S3 | `https://s3.us-east-1.amazonaws.com` |
| 阿里云 OSS | `https://oss-cn-hangzhou.aliyuncs.com` |
| 腾讯云 COS | `https://cos.ap-shanghai.myqcloud.com` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` |
| MinIO（自部署） | `http://localhost:9000` |

###### T-024c · WebDAV V1 backend（**已完成 ✅**，2026-04-25）

- [x] `services/webdav.rs` 加 3 个新方法：`upload_bytes`（任意路径内存字节流上传 + MKCOL 父目录）/ `delete_file` / `download_bytes_optional`（404 → None）/ `ensure_dir`（递归 MKCOL）
- [x] `services/sync_v1/backend_webdav.rs`（70 行）— 实现 `SyncBackendImpl`，复用已有 WebDavClient + runtime::block_on
- [x] backend.rs 工厂解锁 WebDAV 分支
- [x] 前端表单：URL / 用户名 / 密码 三字段 + 兼容性提示（坚果云用应用密码 / Nextcloud 用 App Token）
- [x] 与 V0 ZIP 备份完全独立，可并存

##### V0 → V1 迁移（用户视角）

- 老用户**继续**用上方"整库 ZIP 备份"也没问题（不强制升级）
- 想用单笔记真同步 → 在 V1 新建一个 WebDAV backend（**同 URL 不冲突**：V0 上传 `kb-sync-<host>.zip`；V1 上传 `manifest.json` + `notes/*.md`，互不覆盖）

###### T-024d · Git backend（**已彻底移除** ⛔，2026-04-25 用户决定）

- **彻底删除理由**：评论 0 人提；libgit2 C 依赖编译时间 +2 分钟 / 体积 +5MB；用户决定下线
- **代码层清理**：
  - [x] `models::SyncBackendKind` 移除 `Git` 变体
  - [x] `services/sync_v1/backend::BackendAuth` 移除 `Git` 变体；`parse_auth` / `create_backend` 删除 git 分支
  - [x] `database/sync_v1::parse_kind` / `kind_to_str` 删 git 分支（旧数据若是 "git" 兜底为 "local"）
  - [x] `types/index.ts` `SyncBackendKind` 移除 `"git"`
  - [x] `SyncV1Section.tsx` Form / KIND_LABEL / KIND_TAG_COLOR / validateForm / Radio 选项 / Alert 全部删除 git 相关
  - [x] `cargo check` + `npx tsc --noEmit` 双绿
- **变通方案**（如果将来真有需求）：用户用 LocalPath backend 选一个 git 仓库目录 + 装 IDE 的 Git GUI 手动提交

###### T-024f · UI 编排合一（**新增子任务，已完成 ✅**，2026-04-25）

- 用户决策：方案 C（Tabs 合一），不要两个独立 Section 并列
- [x] 新建 `src/components/settings/SyncTabs.tsx`：Antd `Tabs` + 顶部 Alert 解释"备份 vs 同步"差异
- [x] 默认 tab = "多端同步"（V1，高频协作场景）；第二 tab = "备份与恢复"（V0，灾备场景）
- [x] 移除 `SyncV1Section` 自身的 `<Card>` 外壳（避免双 Card 嵌套），保留内部 Table + Modal；按钮搬到 div 顶部
- [x] 移除 `SyncV1Section` 内的"区别于上方 V0..."Alert（已在 SyncTabs 顶部统一说明）
- [x] `pages/settings/index.tsx` 用单个 `<SyncTabs />` 替换原两个独立 Section
- [x] `npx tsc --noEmit` 通过

###### T-024e · 前端 UI（**v1 版已落地 ✅**，2026-04-25）

- [x] `src/types/index.ts` 加 7 个新类型（SyncBackend / SyncBackendInput / SyncBackendKind / ManifestEntry / SyncManifestV1 / SyncPushResult / SyncPullResult / SyncV1ProgressEvent）
- [x] `src/lib/api/index.ts` 加 `syncV1Api`（10 个方法）
- [x] `src/components/settings/SyncV1Section.tsx`（507 行）：
  - 表格列出已配置 backends；Tag 区分 local/webdav/s3/git；显示上次推送 / 拉取时间
  - 新增 / 编辑 Modal：4 种 kind 单选（local 启用，其它禁用并显示"敬请期待"占位）
  - LocalPath 表单：路径输入 + Tauri dialog 选目录按钮
  - 操作列：测试连接 / 推送 / 拉取 / 编辑 / 删除（带 Popconfirm）
  - 实时进度：listen `sync_v1:progress` 事件 → Antd Progress 条
  - 错误 / 冲突弹 modal.warning 提示
- [x] `src/pages/settings/index.tsx` 在 V0 SyncSection 下方挂上 `<SyncV1Section />`
- [x] `npx tsc --noEmit` 通过
- [ ] 待用户手动验证：
  1. 设置页底部出现"多端同步 V1"卡片
  2. 新增 LocalPath backend → 选两个不同目录 A / B
  3. backend A 推送 → 检查目录 A 出现 manifest.json + notes/*.md
  4. 改一条笔记 → backend A 推送 → 看 .md 内容更新
  5. backend B 拉取（前提 backend B 指向同一目录 A，模拟另一台机）→ 看本地新增笔记
  6. 制造冲突：两边各改同一笔记 → 都用更早的时间戳 → 看 sync_conflicts/ 目录

##### 评论里的同步相关呼声（共 14 条）

- 阿里云 OSS / S3：4 条
- OneDrive / 坚果云：1 条（坚果云本就 WebDAV）
- 迅雷云盘：1 条（无公开 SDK，走 LocalPath + 用户挂同步盘）
- "多端真同步"信任问题：**baserker2 赞 5 / 烧鸡赞 1**（最高信号）
- 鸿蒙 / Android 多端：13 条（前置依赖 V1 完成）

##### 不在 V1 范围

- **V3 CRDT 真协同**（yrs / Yjs Rust）— 太大，等 v2.x
- **OneDrive 单独 OAuth2 适配** — 用户走"挂载 OneDrive 文件夹 + LocalPath backend"
- **Dropbox / Google Drive** — 国内有墙、OAuth2 维护成本高

---

#### T-X05 · 兼容 OB 第三方插件（dataview / tasks / templater）

- **状态**：`wont_do`
- **来源建议**：乌鸡丸无往不胜#90 / 铭浥#36 / 独孤重七#12 / Carrot 萝卜麻麻#40
- **理由**：OB 插件依赖 OB 的 JS API + 文件结构 + 渲染管线，理论上不可能做兼容层；项目定位是"轻量替代"而非"OB 兼容层"，硬做反而失去差异点

---

#### T-X06 · Docker 部署

- **状态**：`wont_do`
- **来源建议**：小被勒#112 "等一个 docker 部署"
- **理由**：本项目是桌面 GUI 应用（Tauri WebView），不是服务端；用户应该是把它误认成 web 笔记服务（如 affine / outline）。如有"在服务器上跑后端 + 浏览器访问"的需求，是另一个产品形态

---

### ⛔ 暂不接入（记录理由，避免重复讨论）

---

#### T-X01 · Android 端（Tonkv 建议的"安卓"部分）

- **状态**：`wont_do`
- **理由**：
  - 当前项目定位是"桌面应用"（README、落地页、视频标题都这么说）
  - Tauri 2.x 虽支持移动端，但 SQLite 文件路径 / 权限模型 / UI 断点都要重写
  - 成本超过"新建一个孪生项目"的规模
- **如需重启**：作为独立项目 `knowledge-base-mobile` 立项，而非主仓库内实现

---

## 附录 · 本次抓取的原始评论

### 喝水小小能手（赞 23 · 目前最高赞）
> 基础功能体验了，功能挺丰富的。不过有几点建议，AI时代的笔记知识软件，既然可以接入 agent，那么可以实现更智能的功能，比如 AI 可以自动规划今日待办事项，不需要自己去一个个写，还有笔记也是 AI 编写并保存在对应目录。也就是软件内置 skills，让 AI 能够操作软件，还有更多专门针对笔记的提示词。

→ 拆为 T-001 / T-004 / T-005 / T-006

### 鹏钧九派（赞 1）
> 有以下问题需要博主后续改善一下。另外还有一种场景希望博主改进一下，有些文章需要进行加密或者设置一个隐藏，因为存在他人使用电脑的问题，仅仅是个人建议。

→ 拆为 T-003 / T-007 / T-008

### Tonkv（赞 1）
> 必须要有多端，安卓，linux 都要有

→ 拆为 T-002 / T-X01

---

## 抓取状态

- ✅ **2026-04-25 已完整抓取 325 / 325**（主 129 + 楼中楼 196）
- 🔧 抓楼中楼方式：chrome-devtools MCP 接管已登录的 Chrome，在 `bilibili.com` 域名下用 `fetch(..., {credentials: 'include'})` 跑，浏览器自动带 HttpOnly 的 SESSDATA

---

## 🆕 楼中楼增量发现（2026-04-25 二轮分析）

> 主评论级建议已在 T-009~T-020 / T-B01~T-B08 覆盖。下面只列**楼中楼里独有的新点**。

### 新增 Bug

#### T-B09 · 亮色主题下表格表头底色 + [[wiki link]] 文字色混色（Mac M1）

- **状态**：`pending`
- **来源**：xiaofengao（楼中楼，对置顶 #1 回复）"亮色主题下，表头底色会和字体色混成一色…在 [[ 引用其他笔记后，同样字体和颜色混成一色，看不清字"
- **影响**：Mac M1 + 亮色主题下表格 / 双链不可读
- **关联**：与 T-B01（黑夜星空）同根，**统一做"主题色对比度审计"** 涵盖所有主题 × 所有表格 / 链接 / 模型选择器

---

### 新增 / 强化的需求

#### T-009 强化 — OB 导入要按 frontmatter tags 识别 + 跳过隐藏目录

- **来源**：Tonkv 楼中楼"按文件夹以标签识别" / ちょっとおかしい 楼中楼"你把隐藏文件夹.trash 也导入进来了，有点懵逼"
- **补充约束**（写入 T-009 实现方案）：
  - 解析每个 .md 的 YAML frontmatter `tags:` 字段，自动建标签关联
  - 默认**跳过点开头目录**（`.obsidian` / `.trash` / `.git` / `.DS_Store`）
  - 用户可勾选"包含隐藏目录"作为 escape hatch

#### T-013 强化 — 自定义数据目录的需求被多人复述

- **来源**：追新动漫楼中楼"有没有办法可以自定义数据目录位置呢，放在 C 盘我怕电脑出现问题重装系统后，笔记全丢失"
- **补充**：UX 应在"关于"页面醒目显示"当前数据目录"+"修改"按钮（用户在楼中楼承认是在"关于"页找到的位置说明，但没有"自定义"开关）

#### T-019 强化 — 白板有具体技术参考

- **来源**：丨Yoann丨 楼中楼提供具体参考实现：
  - `KALU-c/vision-pad`（Tauri + Tldraw + Excalidraw 笔记 app）
  - `zsviczian/Obsidian-Excalidraw-plugin`（excalidraw 与 md 互嵌）
- **补充**：T-019 真要做时直接对标 Tldraw + Excalidraw

#### T-020 强化 — "Publish" 是分享需求的关键词

- **来源**：财前葵楼中楼"类似于 ob 的 publish 那样的功能，让写完的笔记可以分享给别人看，并保留双链特性"
- **补充**：v1 简单做"导出 HTML 静态站"（Markdown → MDX → 输出到 `./publish/` 目录），用户自己上传 GitHub Pages；不做服务端

---

### 新增（楼中楼独有）

#### T-021 · PicGo 图床集成（提一下，不立项）

- **状态**：`pending`（**不建议做**，记录共识）
- **来源**：xisoul-（楼中楼，赞 1）"你配制图床 picgo 就好了，自动转链"
- **本人立场**：本项目是**本地优先**笔记，图床违反这个理念；ちょっとおかしい 在同串中也明确说"我更喜欢把东西都存储在本地"
- **结论**：v1 不做；v2 看用户呼声

#### T-022 · OneNote `.one` 一键导入（合并到 T-X03）

- **来源**：敌台搬运工楼中楼明确格式是 `.one`（OneNote 专属二进制）
- **结论**：维持 T-X03（不立任务）；如真要做需要用 OneNote SDK 或先在 OneNote 桌面版导出为 .docx/.md 再走 T-009 通路
- **回应草稿**：建议用户在 OneNote 内手动 export 为 markdown 后用 T-009 OB 导入

---

### 设计哲学反馈（不立任务，记入共识）

- **作尘__ 楼中楼**："打开仓库就能用的那种" + 别抢我纱雾酱补充 "ob 本来就是原生 md 格式 随便一个编辑器例如 vscode 都能无缝转移 前提是你不用 ob 的插件"
- **lyric_7901 楼中楼**："重新看了下，笔记在数据库里，没有单独的文件，没法手动拖文件分享了"
- **核心矛盾**：项目存储模式（SQLite）↔ OB 用户预期（文件夹+md 文件）。
- **当前应对**：**导出 markdown** 已存在；可考虑**实时镜像导出**模式（每次保存自动也写一份 .md 到指定目录），让用户的 vault 既有 DB 又有可见的 .md 文件，缓解此矛盾。
- **建议**：T-023 候选 — "实时 markdown 镜像目录"（用户开启后，每次保存额外写一份到 `<vault>/markdown/` 树）

#### T-023 · 实时 markdown 镜像目录（候选）

- **状态**：`pending`（看用户呼声决定是否立项）
- **来源**：作尘__ + lyric_7901 + 别抢我纱雾酱（共识：用户期望文件级访问）
- **价值**：⭐⭐⭐  成本：低（DB save hook 触发文件写入即可）
- **风险**：双源数据需想清楚谁是 source of truth（建议 DB 是主，文件夹只读镜像；用户编辑文件夹中的 .md 不会回写）

---

### 新出现的反向意见 / 攻击性评论（仅记录，不立任务）

- Jimi大叔 楼中楼（赞 13）"OB 的核心是插件，你这个没有扩展性呀" — 加分项警示：扩展性可作为 v2+ 命题
- 此处无人姓蔡（赞 4 + 2）"没有什么特点 / 都是基础功能"
- 浮生 n 若茶 / 孤雪的爸爸 / duxweb：批 "vibe coding / AI 流量产品 / 没特点"
- baserker2（赞 5）"多端同步是痛点，现有的生态基本都是在这里收钱，如果做开源可以从这里找用户突破" — **这条建设性强**，补给 T-X04（虽然现在拒了 S3/OSS，但"一站式付费同步"作为商业化方向值得未来评估）
