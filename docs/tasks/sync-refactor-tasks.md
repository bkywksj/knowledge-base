# 同步功能重构 — 任务跟踪

> 目标：基于对现有 V0（ZIP 全量备份）+ V1（笔记增量同步）双轨实现的全面分析，分阶段修复 P0/P1 缺陷并系统提升性能。
> 创建日期：2026-05-11
>
> ## 核心决策（已定）
> | 决策项 | 选择 | 理由 |
> |--------|------|------|
> | 路线策略 | **保留 V0+V1 双轨**，V1 作主战场，V0 退化为"快照归档" | V0 全量天生不可增量，硬优化收益有限；V1 才是日常协同 |
> | 数据兼容 | **schema 迁移 + 一次性 backfill**，不破坏现有用户数据 | 既存用户数据不可丢，每次迁移必须可回滚 |
> | 附件同步 | **CAS（内容寻址）方案**：`attachments/<aa>/<bb>/<hash>.<ext>` | 业界标配（Git LFS / Obsidian Sync / IPFS），自动去重 + 自动增量 |
> | 多端身份 | `notes` 加 `stable_uuid` 列（UUID v4），manifest 用 UUID | 替代当前用本地 i64 主键导致的多端 ID 撞车 |
> | 并发模型 | trait 加 `batch_put_notes` 默认实现，WebDAV impl 用 `Semaphore(8)` | 不破坏现有同步阻塞 trait 心智 |
>
> ## 评估结论
> - 当前 V1 实际不可用（附件不同步 / 多端 ID 撞车 / 删除复活 / 元数据丢失）
> - 当前 V0 实际是"多设备各自独立备份"，不是"同步"
> - 大库性能：V0 每次全量重打 ZIP；V1 5000 笔记 ≈ 5GB 内存 + 串行 PUT
> - 总体工程量：**8-12 天**（含测试和数据迁移验证）
> - 完成后预期：10GB 库同步从 30 分钟级 → 1 分钟级（首次后增量）

---

## 🔴 执行规则（每条任务开始前必读）

**每次要开始某条 T-S00x 任务前，必须先走三步：**

1. **重新评估必要性**：此刻这条任务是否仍值得做？优先级是否被新情况改变？
2. **给出实现方案**：
   - 涉及哪些文件（models / database / services / commands / 前端 types/api/components）
   - schema 变更（如有）+ backfill SQL + 回滚策略
   - 兼容性影响：旧 V1 manifest 还能读吗？老用户数据如何升级？
   - 预计工作量 + 潜在风险点
3. **等待用户确认**后再开始写代码。

⛔ 禁止直接跳过以上三步动手实现。

---

## 🔒 数据安全约定（每次合并前必查）

| 检查项 | 命令 / 操作 | 说明 |
|-------|------------|------|
| 桌面端编译通过 | `cd src-tauri && cargo check` | 任何 schema/services 改动后必跑 |
| 桌面端可启动 | `pnpm tauri dev` | 验证迁移逻辑能跑通 |
| 现有数据不丢 | 手测：创建笔记 → 重启 → 笔记还在 + 内容完整 | schema 迁移最高风险点 |
| 同步双向回归 | V0 push/pull + V1 push/pull 各跑一次 | 改动可能影响另一路 |
| 单元测试 | `cargo test sync` | manifest diff / hash 计算等核心逻辑 |
| Schema 迁移幂等 | 多次启动应用，每次都不重复迁移 | `PRAGMA user_version` 严格递增 |

每次 commit message 加 scope 标识：`feat(sync): ...` / `fix(sync): ...` / `refactor(sync): ...`。

---

## 缺陷与瓶颈速查表（来自 2026-05-11 分析）

### P0（阻塞性）
- V1 完全没同步附件（PDF / 图片 / Word 源文件）—— `services/sync_v1/backend.rs:79`
- V1 stable_id 用本地 i64 → 多端 ID 必然撞车 —— `services/sync_v1/manifest.rs:25`
- V1 笔记元数据丢失（标签 / 双链 / frontmatter / 创建时间）
- V1 加密笔记把 placeholder 当内容上传 → 多端覆盖会损坏密文
- V0 设备名作为 ZIP 文件名 → 多设备各自独立备份，**不是同步**

### P1（重要）
- V1 不推送 tombstone → 删除复活
- V1 `write_manifest` 用 local 全量覆盖远端 → 吞掉别人的笔记
- V1 冲突文件无 UI 合并通道
- V0 ZIP 完全不加密 → 云端泄露风险

### 性能瓶颈
- V1 push 一次性载入全部 content 进 HashMap —— O(库大小) 内存
- V1 串行 PUT 每条 .md —— 5000 笔记 = 5000 次 RTT
- `content_hash` 每次同步全量 SHA-256 重算
- V0 每次全量重打 ZIP

---

## 任务列表

### Phase 1 · 立竿见影（无 schema 升级，1 天内）

#### T-S001 · 复用 `notes.content_hash` 列让 manifest 计算不再读 content（方案 C）

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐  成本：低（半天）
- **依赖**：无
- **解决问题**：`manifest.rs:15` 每次同步对所有笔记重新 SHA-256 整文 → 大库慢 / 内存高
- **🔑 关键发现**：`notes.content_hash` 列已经在 v22 迁移加了，DAO（create/update/daily）都已正确维护，无需 schema 升档
- **方案 C**：改 manifest hash 公式为 `sha256(title + "\n" + content_hash_hex)`，复用现有列；远端旧 manifest 通过 `hash_algo` 字段识别，升级时清空本地 `sync_remote_state` 强制重建
- **子任务**：
  - [x] `models/mod.rs`：`SyncManifestV1` 加 `hash_algo: Option<String>` 字段 + `HASH_ALGO_V2` 常量
  - [x] `services/sync_v1/manifest.rs`：改公式 + SQL 改 `SELECT content_hash`（不再读 content）+ 构造时填 v2
  - [x] `database/sync_v1.rs`：加 `clear_remote_state_for_backend(backend_id)` DAO
  - [x] `services/sync_v1/pull.rs`：检测远端 `hash_algo != "v2"` → 清空 sync_remote_state + 跳过本次
  - [x] `services/sync_v1/push.rs`：检测同上 → 清空 + 把远端视作 None（走全量首次推送）
  - [x] 单测：v2 算法稳定性 + 旧 manifest（无 hash_algo）反序列化兼容性 + skip_serializing_if 验证
  - [x] sync_v1 模块全部 16 个单测通过（含 backend_local 往返 + pull 解析）
- **顺手修复**：`services/ai.rs` 中两处遗漏 `Folder.color: None` 的预存在测试 bug（commit 38904c7 引入 color 时遗漏，阻塞 lib test 编译）
- **风险**：远端旧 manifest 触发首次"全量重推"，多消耗一次带宽（V1 当前用户极少，可接受）

---

#### T-S002 · V1 push 流式 SELECT（不再把全部 content 装进 HashMap）

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：低（半天）
- **依赖**：T-S001（已完成）
- **解决问题**：`push.rs:81` 一次性 `SELECT id, title, content, updated_at` 全部进内存 → 5000 笔记约 5GB
- **方案**：按 `diff.to_push` 的 id 集合做**分块 IN 查询**（每块 ≤900 防 SQLite 参数上限），HashMap key 改用 i64 note_id
- **子任务**：
  - [x] `push.rs` 删除全量 SELECT
  - [x] 拿到 diff 后，按 to_push 的 id 列表分块 IN 查询（chunks(900) + rusqlite::params_from_iter）
  - [x] 循环中按 i64 id 从 HashMap 取（不再用 stable_id 字符串作键）
  - [x] `cargo check` 通过 + sync_v1 全 16 个单测通过

---

#### T-S003 · 临时文件孤儿启动清理

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐  成本：极低（1 小时）
- **依赖**：无
- **解决问题**：`.sync-tmp-upload.zip` / `.sync-tmp-pull.zip` / `.sync-tmp-app.db` 崩溃后残留
- **子任务**：
  - [x] `services/sync.rs::SyncService::cleanup_orphan_temp_files(data_dir)` 静态方法
    - 顶层扫，严格前缀 `.sync-tmp-`，**不递归子目录**
    - 任意失败仅 warn，不阻塞启动
  - [x] `lib.rs` setup 钩子里 `app.manage(state);` 后调用
  - [x] 单测：前缀边界（缺前导点 / 下划线变体 / 子目录递归）全覆盖
  - [x] 单测：目录不存在不 panic
  - [x] sync 模块 18 个单测全通过

---

### Phase 2 · 多端正确性（schema 升级，2 天）

#### T-S010 · `notes` 表加 `stable_uuid` 列 + 一次性 backfill

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：中（半天）
- **依赖**：无（独立做完即可）
- **解决问题**：跨设备 ID 撞车（A 的 note_id=5 和 B 的 note_id=5 不同笔记）
- **方案要点**：
  - SQLite `ALTER TABLE ADD COLUMN` 不支持 NOT NULL + dynamic DEFAULT → 列允许 NULL + **部分唯一索引** `WHERE stable_uuid IS NOT NULL`
  - UUID v4 由 Rust 侧生成（uuid crate 已是间接依赖）
  - backfill 在单个事务里完成，幂等可重跑
- **子任务**：
  - [x] 加 Cargo 依赖 `uuid = { version = "1", features = ["v4"] }`（显式声明，零体积代价）
  - [x] schema v35→v36：`ALTER TABLE notes ADD COLUMN stable_uuid TEXT` + 部分唯一索引 `idx_notes_stable_uuid`
  - [x] backfill：所有 NULL 行按 id 顺序填 UUID v4（事务内）
  - [x] `create_note` 写入时自动生成 UUID
  - [x] `get_or_create_daily` 同步加 UUID（业务唯一另一个 INSERT 入口）
  - [x] 新 DAO `get_note_id_by_stable_uuid(uuid)` 预留给 T-S011
  - [x] 单测 5/5 通过：列与索引创建 / 版本号 / 自动填充 / UNIQUE 拦截 / 反查
  - [x] sync 模块 18 个单测无回归

---

#### T-S011 · V1 manifest stable_id 切换到 UUID

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：低（半天）
- **依赖**：T-S010
- **解决问题**：让多端共用同一 backend 不再产生重复笔记
- **方案要点**：
  - `manifest.rs` 从 i64 切换到 stable_uuid；远端 `.md` 路径变成 `notes/<uuid>.md`
  - `sync_remote_state` 表**不动**（保持按本地 note_id 索引，因为它表达"本机笔记的同步状态"）
  - pull 时按 stable_uuid 查本地 → 决定 update/create，create 用 `create_note_with_uuid` 保留远端 UUID
  - 跨升级兼容性已通过 T-S001 的 `hash_algo` 检测覆盖：旧 manifest 进入清空 + 视作首次推送路径
- **子任务**：
  - [x] `database/notes.rs` 加 `create_note_with_uuid(input, uuid)`
  - [x] `database/notes.rs::get_note_id_by_stable_uuid` 去掉 `dead_code`（现在正式被调用）
  - [x] `manifest.rs::compute_local_manifest` 改 SQL 用 `stable_uuid` 列，删除 `stable_id_for(i64)`
  - [x] `push.rs` HashMap key 改 String(uuid)，IN 查询用 stable_uuid；跳过判定先拿 note_id 再查 state_map
  - [x] `pull.rs` 主流程改 `get_note_id_by_stable_uuid` + `create_note_with_uuid` 分支
  - [x] `pull.rs` to_delete_local 同样改按 UUID 查 note_id
  - [x] 单测：compute_local_manifest 用 UUID 作 stable_id 和 remote_path（端到端）
  - [x] sync_v1 全部 17 个单测通过；全 lib 153 个单测通过

---

#### T-S012 · tombstone 推送（解决删除复活）

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐  成本：低（半天）
- **依赖**：T-S011
- **解决问题**：`push.rs:10` 注释明说"v1 阶段简化：不支持本地软删除推送"
- **方案要点**：
  - `compute_local_manifest` 包含最近 30 天软删的笔记，entry.tombstone=true + updated_at 用 deleted_at
  - GC：30 天前的 tombstone 不进 manifest（防止无限增长）
  - `diff_manifests` 双方都有时新增 4 个 case：`(L=t,R=f) → to_push` / `(L=f,R=t) → to_delete_local` / `(L=t,R=t) → skip` / 否则按 hash 比较
  - push 循环对 tombstone entry：调 `backend.delete_note` 删远端 .md + 更新本地 state.tombstone=true（远端 404 仅 warn 不阻塞）
- **子任务**：
  - [x] `compute_local_manifest` 加最近 30 天 tombstone（含 deleted_at 作为 entry.updated_at）
  - [x] `TOMBSTONE_RETENTION_DAYS` 常量（30 天 GC 阈值）
  - [x] `diff_manifests` 四象限 tombstone 处理
  - [x] `backend.delete_note` trait 方法去 dead_code（正式启用）
  - [x] `push.rs` 循环：tombstone entry → 删远端 + 标 state；幂等跳过（state 已 tombstone）
  - [x] 单测：4 个 diff 案例 + 1 个 compute_local_manifest GC 集成测试
  - [x] sync_v1 全 21 个单测通过；全 lib 158 个单测无回归

---

#### T-S013 · `write_manifest` 改为合并写入

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：低（半天）
- **依赖**：T-S011
- **解决问题**：`push.rs` 用 local 全量覆盖远端 → 吞掉远端独有项（多端 race 灾难）
- **方案**：
  - `manifest::merge_manifests(local, remote)`：以 stable_uuid 为键 outer-join，本地全量 + 远端独有
  - push 末尾**重读**远端 manifest（捕获 race 期间别人的 push），合并后再 write
  - 不取 updated_at 较新者：diff 阶段已做过冲突分流，本地每条都是"本机视角对的版本"
  - 重读失败时退化用 local（不阻塞同步，但记 error）
- **子任务**：
  - [x] `services/sync_v1/manifest.rs` 加 `merge_manifests` 函数（outer-join）
  - [x] `services/sync_v1/push.rs` 末尾改：重读 remote → merge → write_manifest(&merged)
  - [x] 单测 5 个：仅 local / 仅 remote / 远端独有保留 / 元数据 v2 排序 / 本地 tombstone 优先
  - [x] sync_v1 全 26 个单测通过；全 lib 163 个单测无回归
- **未做的优化**（任务条目里曾考虑但本阶段不实现）：
  - **ETag/CAS 写**：WebDAV 部分服务器支持 If-Match 头，可以拒绝并发覆盖；本阶段先用 read-modify-write，
    多端并发写极小概率会有 race 窗口（数十毫秒级），实际影响可控。如需进一步硬化留 T-X 任务。

---

#### T-S014 · 加密笔记同步策略（端到端加密，方案 B）

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐  成本：中（1 天）
- **依赖**：T-S011
- **采用方案**：**方案 B（共享 vault salt + 同步密文）**
- **方案要点**：
  - `SyncManifestV1.vault: Option<VaultMeta>`：salt+verifier base64 顶层字段
  - 首次同步：本机无 vault → `import_meta_if_not_set` 从远端拉 salt+verifier
  - vault salt 不匹配 → 警告 + 加密笔记跳过本次同步（不阻塞普通笔记）
  - 加密笔记 manifest entry `encrypted: true` + `content_hash` 基于 `sha256(blob_hex)`
  - 远端 `notes/<uuid>.md` 文件：base64(encrypted_blob) 而非占位字符串
  - pull 时按 stable_uuid 走 `upsert_encrypted_note_with_uuid`，复用现有 vault key 解密
- **子任务**：
  - [x] `models/mod.rs`：`VaultMeta` 结构 + `ManifestEntry.encrypted` 字段 + `SyncManifestV1.vault` 顶层字段
  - [x] `services/vault.rs`：`read_meta` / `import_meta` / `import_meta_if_not_set` / `meta_matches`
  - [x] `database/notes.rs`：`get_note_crypto_state_by_uuid` / `upsert_encrypted_note_with_uuid`
  - [x] `services/sync_v1/manifest.rs::compute_local_manifest`：读 is_encrypted + blob，base hash 用 blob hex
  - [x] `services/sync_v1/push.rs`：encrypted entry → base64(blob) 上传
  - [x] `services/sync_v1/pull.rs`：远端 vault meta 处理 + base64 解码 + upsert_encrypted_note
  - [x] 单测 5/5 新增通过：vault_meta_serde / 加密笔记 manifest / DAO 往返 / 导入 + 拒绝坏 base64
  - [x] 全 lib 168 个单测通过
- **安全保证**：
  - 远端只见到 salt（公开数据）+ verifier（密文）+ 密文 blob，**不见明文与 vault key**
  - 派生 key 仍是 Argon2id(用户密码, salt) — 即使远端被盗，无密码不可解
  - "忘密码 = 数据丢失" 取舍延续到云端
- **限制**：
  - 笔记 title 仍是明文（manifest entry.title 公开）；后续可加 title 加密
  - 标签 / 文件夹路径 / 双链 等元数据未加密
  - 本机已设置 vault + 远端不同 salt → 加密笔记两端无法互通（设计如此）

---

### Phase 3 · 附件同步（sidecar CAS 方案 B，2-3 天）

> **方案 B 设计哲学**：本地目录结构原样保留（`kb_assets/images/`、`pdfs/`、`sources/`、`kb_assets/attachments/<note_id>/`），
> 仅在**同步阶段**走 CAS（内容寻址）远端布局。新增 `note_attachments` 索引表记录 (note_id, local_rel_path, sha256)，
> 同步时按 sha256 去重上传到远端 `attachments/<aa>/<bb>/<hash>.<ext>`。
>
> **零本地迁移风险**：不动现有文件、不重写笔记 content；用户感知零变化。

#### T-S020 · `note_attachments` 表 schema（v36→v37）

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：低（30 min）
- **依赖**：无
- **子任务**：
  - [x] schema 迁移 v36→v37：note_attachments 表 + hash 索引 + note_id 索引 + 外键 CASCADE
  - [x] 新文件 `database/note_attachments.rs` + DAO 4 个：upsert / list_for_note / list_all_unique / find_by_hash
  - [x] 6 个单测：表创建 / upsert 覆盖 / 列表 / hash 去重 / 反查 / CASCADE
  - [x] 全 lib 174 个单测通过

#### T-S021 · 资产引用扫描器

- **状态**：`completed` · 完成日期：2026-05-11
- **价值**：⭐⭐⭐⭐⭐  成本：中（0.5 天）
- **依赖**：T-S020
- **子任务**：
  - [x] `services/sync_v1/attachment_scan.rs::extract_local_refs`：3 个 regex 静态实例（md image / md link / wiki embed），URL decode + 路径过滤
  - [x] `looks_like_local_asset`：拒绝 http(s) / asset 协议 / 绝对路径 / `..` 穿越；只接受已知前缀（kb_assets/、pdfs/、sources/ + dev- 变体）
  - [x] `try_resolve`：按相对路径读文件计算 sha256 + size + mime（按扩展名推断）
  - [x] `scan_note(db, data_dir, note_id, content)`：单笔记扫描 + upsert，文件不存在跳过
  - [x] `scan_all_active_notes`：全库扫描入口（设置页"重建附件索引"用）
  - [x] 12 个单测：5 种引用模式 / 4 种过滤规则 / 去重 / dev 前缀 / mime 推断 / 端到端 hash 稳定性 / 文件缺失跳过
  - [x] 全 lib 186 个单测通过

#### T-S022 · manifest 加 `attachments` 字段

- **状态**：`pending`
- **价值**：⭐⭐⭐⭐  成本：低（30 min）
- **依赖**：T-S020
- **子任务**：
  - [ ] SyncManifestV1.attachments: Vec<AttachmentEntry> 顶层字段
  - [ ] compute_local_manifest 时填充

#### T-S023 · backend trait 附件 IO

- **状态**：`pending`
- **价值**：⭐⭐⭐⭐⭐  成本：中（0.5 天）
- **依赖**：T-S020
- **子任务**：
  - [ ] trait put_attachment / get_attachment / has_attachment 三方法去 dead_code 并实现
  - [ ] backend_local / backend_webdav / backend_s3 各自实现

#### T-S024 · push/pull 集成附件同步

- **状态**：`pending`
- **价值**：⭐⭐⭐⭐⭐  成本：中（0.5 天）
- **依赖**：T-S022 + T-S023
- **子任务**：
  - [ ] push：本地 unique hashes - has_attachment 远端 → 上传缺失的
  - [ ] pull：远端 manifest.attachments - 本地 unique hashes → 下载缺失的到 sync_in/

#### T-S025 · 孤儿附件 GC（可选）

- **状态**：`pending`
- **价值**：⭐⭐⭐  成本：低（0.5 天）
- **依赖**：T-S024

---
### Phase 4 · 并发提速（1-2 天）

#### T-S030 · trait 加 `batch_put_notes` 默认实现

- **状态**：`pending`
- **价值**：⭐⭐⭐  成本：低（半天）
- **依赖**：无（与 Phase 2/3 独立）
- **子任务**：
  - [ ] trait 加 `fn batch_put_notes(&self, items: Vec<(String, String)>) -> Vec<Result<()>>`
  - [ ] 默认实现：串行调 `put_note`（保持向后兼容）
  - [ ] `push.rs` 改用 `batch_put_notes`

---

#### T-S031 · WebDAV backend 并发上传（Semaphore=8）

- **状态**：`pending`
- **价值**：⭐⭐⭐⭐⭐  成本：中（1 天）
- **依赖**：T-S030
- **子任务**：
  - [ ] `backend_webdav.rs::batch_put_notes` override：用 `tokio::spawn` + `Arc<Semaphore>(8)`
  - [ ] 复用一个 reqwest::Client（HTTP/1.1 keep-alive）
  - [ ] 实测：5000 笔记 push 时间 8 分钟 → 1 分钟级
  - [ ] 失败重试（指数退避 3 次）

---

#### T-S032 · S3 / Local backend 并发实现

- **状态**：`pending`
- **价值**：⭐⭐⭐  成本：低（半天）
- **依赖**：T-S030
- **子任务**：
  - [ ] S3 SDK 自带并发，包成 batch_put_notes
  - [ ] Local 用 `rayon::par_iter`

---

### Phase 5 · V0 退化为快照归档（0.5 天）

#### T-S040 · UI 文案与功能区分

- **状态**：`pending`
- **价值**：⭐⭐⭐  成本：低（2 小时）
- **依赖**：Phase 3 完成（CAS 跑稳后才能让 V1 接管日常）
- **子任务**：
  - [ ] `SyncTabs.tsx`：V0 tab 改名"快照归档（灾备/迁移）"，V1 tab 改名"多端实时同步（推荐）"
  - [ ] V0 自动同步选项移除（仅手动触发）
  - [ ] 文案说明两者关系：日常协同走 V1+CAS，整库快照走 V0

---

### Phase X · 可选增强（Phase 1-5 完成后再考虑）

#### T-S050 · 同步内容端到端加密

- **状态**：`pending`
- **价值**：⭐⭐⭐⭐  成本：高（2-3 天）
- **依赖**：Phase 1-4 全部完成
- **决策点**：
  - 用户密码派生 key（PBKDF2 / Argon2）
  - 加密时机：上传前 / 解密：下载后
  - V0 ZIP 加密 vs V1 笔记+附件加密

#### T-S051 · 冲突合并 UI（三栏 diff）

- **状态**：`pending`
- **价值**：⭐⭐⭐  成本：高（2-3 天）
- **依赖**：T-S013（合并 manifest 后）
- **子任务**：基于 monaco-diff-editor 或 react-diff-viewer 做三栏（本地 / 远端 / 合并结果）

---

## 路线图与里程碑

```
Phase 1 (1 天)        ──────► 大库 push 内存 5GB→50MB，hash 计算归零
                                   │
                                   ▼
Phase 2 (2 天)        ──────► 多端正确（UUID + tombstone + manifest 合并）
                                   │ ⬆ 此时 V1 才真正可用
                                   ▼
Phase 3 (3-5 天)      ──────► 附件能同步（CAS 自动去重 + 增量）
                                   │ ⬆ 此时 V1 比 V0 更适合日常用
                                   ▼
Phase 4 (1-2 天)      ──────► 并发上传，5000 笔记 8 分钟→1 分钟
                                   │
                                   ▼
Phase 5 (0.5 天)      ──────► UI 引导用户走 V1，V0 退到灾备角色
                                   │
                                   ▼
Phase X (按需)        ──────► 端到端加密 / 冲突合并 UI
```

**核心里程碑**：Phase 3 完成时 = V1 真正可用 = 用户可以放心用多设备同步。

---

## 当前状态

- **Phase 1**：✅ 完成（T-S001 / T-S002 / T-S003）—— 2026-05-11
  - 收益：manifest 计算不再读 content；push 不再全量装 HashMap；崩溃残留自动清理
- **Phase 2**：✅ 完成（T-S010 / T-S011 / T-S012 / T-S013 / T-S014）—— 2026-05-11
  - 收益：多端 stable_uuid 不撞车；tombstone 推送解决删除复活；manifest 合并不再吞远端；
    端到端加密笔记跨端同步（方案 B：共享 salt + 密文 base64 上传）
- **Phase 3-5 / X**：⏸ 排队中（CAS 附件、并发上传、V0 退化）

下次开始任务时，从 **Phase 3 / T-S020 (CAS 目录结构设计)** 开始：先评估 + 给方案 + 等确认。
