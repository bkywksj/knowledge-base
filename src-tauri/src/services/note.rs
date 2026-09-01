use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, NoteImageRef, NoteInput, NoteQuery, PageResult};
use crate::services::sync_v1::attachment_scan::extract_local_refs;

/// 单篇笔记最多回传的图片数，防一篇图墙笔记撑爆 IPC 载荷 / 刷屏 AI 回答下方。
const MAX_IMAGES_PER_NOTE: usize = 12;

/// 笔记服务
pub struct NoteService;

impl NoteService {
    /// 抽取一批笔记 content 里的图片资源，给 AI 回答下方"溯源"挂缩略图用。
    ///
    /// 入参一般来自 AI message 的 references（引用了哪几篇笔记）。逐篇取 content，
    /// 复用 `extract_local_refs` 抽出所有本地资产相对路径，再按 `kb_assets/images/`
    /// 路径段过滤——只留图片，自然排除视频(`videos/`)、PDF(`pdfs/`)、附件(`attachments/`)。
    /// 加密笔记 content 是占位符，抽不到图；查不到的 note_id 静默跳过（可能已删）。
    pub fn images_for_notes(
        db: &Database,
        note_ids: &[i64],
    ) -> Result<Vec<NoteImageRef>, AppError> {
        let mut out = Vec::new();
        for &id in note_ids {
            // get_note 返回 Result<Option<Note>>：查不到（None）或出错都静默跳过
            let note = match db.get_note(id) {
                Ok(Some(n)) => n,
                _ => continue,
            };
            let images: Vec<String> = extract_local_refs(&note.content)
                .into_iter()
                // dev 前缀目录 `dev-kb_assets/images/` 同样含该子串，prod/dev 都覆盖
                .filter(|rel| rel.contains("kb_assets/images/"))
                .take(MAX_IMAGES_PER_NOTE)
                .collect();
            if !images.is_empty() {
                out.push(NoteImageRef {
                    note_id: id,
                    title: note.title,
                    images,
                });
            }
        }
        Ok(out)
    }

    /// 创建笔记
    pub fn create(db: &Database, input: &NoteInput) -> Result<Note, AppError> {
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("笔记标题不能为空".into()));
        }
        db.create_note(input)
    }

    /// 更新笔记
    ///
    /// 仅做 DB 写入。外部 .md 写回由前端在保存成功后**显式调用** `write_back_source_md`，
    /// 这样冲突状态可以直接返回给调用方，避免事件 + 状态机的复杂度。
    pub fn update(db: &Database, id: i64, input: &NoteInput) -> Result<Note, AppError> {
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("笔记标题不能为空".into()));
        }
        // 覆盖之前留一份旧正文（自带时间窗节流 + 内容去重，见 services::snapshot）。
        // 必须在 update_note 之前 —— 此刻库里还是上一版；也必须在这一层而不是 DAO 里，
        // 因为 capture_auto 会自己去 get_note，在 DAO 的锁内再调会把同一个 Mutex 锁死。
        crate::services::snapshot::capture_auto(db, id);
        db.update_note(id, input)
    }

    /// 批量移动笔记到指定文件夹；返回实际移动的条数
    ///
    /// - `folder_id = None` → 移到根目录
    /// - folder_id 的合法性由前端（`folderApi.list()`）保证；这里不再 round-trip 校验
    pub fn move_batch(
        db: &Database,
        ids: &[i64],
        folder_id: Option<i64>,
    ) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        db.move_notes_batch(ids, folder_id)
    }

    /// 批量软删除（移入回收站）；返回实际标记删除的条数
    pub fn trash_batch(db: &Database, ids: &[i64]) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        db.soft_delete_notes_batch(ids)
    }

    /// 批量给多篇笔记追加标签（不清除原有标签）；返回新增的关联条数
    pub fn add_tags_batch(
        db: &Database,
        note_ids: &[i64],
        tag_ids: &[i64],
    ) -> Result<usize, AppError> {
        if note_ids.is_empty() || tag_ids.is_empty() {
            return Ok(0);
        }
        db.add_tags_to_notes_batch(note_ids, tag_ids)
    }

    /// 删除笔记（永久删除，预留给未来使用）
    #[allow(dead_code)]
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.delete_note(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }

    /// 获取单个笔记
    pub fn get(db: &Database, id: i64) -> Result<Note, AppError> {
        db.get_note(id)?
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))
    }

    /// 切换笔记置顶状态
    pub fn toggle_pin(db: &Database, id: i64) -> Result<bool, AppError> {
        db.toggle_pin(id)
    }

    /// 移动笔记到文件夹
    pub fn move_to_folder(
        db: &Database,
        note_id: i64,
        folder_id: Option<i64>,
    ) -> Result<(), AppError> {
        db.move_note_to_folder(note_id, folder_id)
    }

    /// 批量重排同一 folder 内笔记的 sort_order（自定义排序专用）
    pub fn reorder(db: &Database, ordered_ids: &[i64]) -> Result<(), AppError> {
        db.reorder_notes(ordered_ids)
    }

    /// 拖拽排序用：取当前筛选条件下**全部**笔记 id（不分页），按当前 sort_by 排序。
    /// 前端拿到完整 id 列表后做 arrayMove → reorder，保证跨页 sort_order 一致。
    pub fn list_ids_for_reorder(db: &Database, query: &NoteQuery) -> Result<Vec<i64>, AppError> {
        db.list_note_ids_for_reorder(
            query.folder_id,
            query.keyword.as_deref(),
            query.uncategorized.unwrap_or(false),
            query.include_descendants.unwrap_or(true),
            query.sort_by.as_deref(),
        )
    }

    /// 全部移到回收站（软删，可在回收站恢复）
    pub fn trash_all(db: &Database) -> Result<usize, AppError> {
        db.trash_all_notes()
    }

    /// 查询笔记列表（分页）
    pub fn list(db: &Database, query: &NoteQuery) -> Result<PageResult<Note>, AppError> {
        let page = query.page.unwrap_or(1).max(1);
        let page_size = query.page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_notes(
            query.folder_id,
            query.keyword.as_deref(),
            page,
            page_size,
            query.uncategorized.unwrap_or(false),
            // 默认递归子文件夹（符合用户直觉：点父目录看到所有子树笔记）
            query.include_descendants.unwrap_or(true),
            query.sort_by.as_deref(),
        )?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    // ─── T-003 隐藏笔记 ────────────────────────────

    /// 切换笔记"隐藏"状态
    pub fn set_hidden(db: &Database, id: i64, hidden: bool) -> Result<bool, AppError> {
        db.set_note_hidden(id, hidden)
    }

    /// 列出所有隐藏笔记（分页 + 可选目录过滤）
    pub fn list_hidden(
        db: &Database,
        page: Option<usize>,
        page_size: Option<usize>,
        folder_id: Option<i64>,
        uncategorized: Option<bool>,
    ) -> Result<PageResult<Note>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);
        let (items, total) =
            db.list_hidden_notes(page, page_size, folder_id, uncategorized.unwrap_or(false))?;
        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 列出所有"含至少一篇隐藏笔记"的 folder_id（含 None=未分类）
    pub fn list_hidden_folder_ids(db: &Database) -> Result<Vec<Option<i64>>, AppError> {
        db.list_hidden_folder_ids()
    }

    /// 列出"临时编辑"笔记（以临时方式打开的外部 .md）—— 用于「临时文件」面板
    pub fn list_scratch(
        db: &Database,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PageResult<Note>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);
        let (items, total) = db.list_scratch_notes(page, page_size)?;
        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 设置 / 取消"临时编辑"标记（取消 = 转为正式笔记，回到主列表与搜索）
    pub fn set_scratch(db: &Database, id: i64, scratch: bool) -> Result<(), AppError> {
        db.set_note_scratch(id, scratch)
    }

    // ─── T-007 笔记加密 ────────────────────────────

    /// 加密这篇笔记：读 content → vault 加密 → 写入 blob + 占位 content；
    /// 同时立即把 `images/{id}/` 下所有明文图片迁移成 `.enc`。
    ///
    /// 要求 vault 已解锁。调用前自行检查 `VaultService::status`。
    /// 图片迁移是 best-effort：迁移失败会回滚 DB（取消加密），保证 DB 与磁盘一致。
    pub fn encrypt_note(
        db: &Database,
        vault: &std::sync::RwLock<crate::services::vault::VaultState>,
        app_data_dir: &std::path::Path,
        id: i64,
    ) -> Result<(), AppError> {
        // 读现有明文 content
        let note = db
            .get_note(id)?
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 不存在", id)))?;
        if note.is_encrypted {
            return Err(AppError::Custom("笔记已经处于加密态".to_string()));
        }
        let blob = crate::services::vault::VaultService::encrypt_plaintext(
            vault,
            note.content.as_bytes(),
        )?;
        // 占位符不会参与 FTS5 匹配（跟标题分隔开）；前端也用它做"已加密"提示
        const PLACEHOLDER: &str = "🔒 已加密内容——请解锁后查看";
        db.enable_note_encryption(id, PLACEHOLDER, &blob)?;

        // 立即迁移图片到 .enc。失败则回滚 DB，避免出现"DB 已加密但图片仍是明文"的不一致状态
        if let Err(e) = crate::services::image::ImageService::migrate_note_images(
            vault,
            app_data_dir,
            id,
            crate::services::image::ImageMigration::Encrypt,
        ) {
            log::error!("笔记 {} 图片加密迁移失败，回滚 DB 加密：{}", id, e);
            db.disable_note_encryption(id, &note.content)?;
            return Err(AppError::Custom(format!("图片加密迁移失败：{}", e)));
        }
        Ok(())
    }

    /// 解密并返回明文（不改库状态）。vault 必须已解锁
    pub fn decrypt_note(
        db: &Database,
        vault: &std::sync::RwLock<crate::services::vault::VaultState>,
        id: i64,
    ) -> Result<String, AppError> {
        let blob = db
            .get_encrypted_blob(id)?
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 未加密或不存在", id)))?;
        let plaintext_bytes = crate::services::vault::VaultService::decrypt_blob(vault, &blob)?;
        String::from_utf8(plaintext_bytes)
            .map_err(|e| AppError::Custom(format!("密文解码为 UTF-8 失败: {}", e)))
    }

    /// 取消加密：解密后把明文写回 content + 清 blob；
    /// 同时立即把 `images/{id}/` 下所有 `.enc` 图片解密回原后缀。
    ///
    /// 图片迁移失败回滚 DB（重新加密 placeholder + blob），保证一致性。
    pub fn disable_encrypt(
        db: &Database,
        vault: &std::sync::RwLock<crate::services::vault::VaultState>,
        app_data_dir: &std::path::Path,
        id: i64,
    ) -> Result<(), AppError> {
        let plaintext = Self::decrypt_note(db, vault, id)?;
        // 先存一份加密 blob 用于回滚
        let blob = db
            .get_encrypted_blob(id)?
            .ok_or_else(|| AppError::NotFound(format!("笔记 {} 未加密", id)))?;
        db.disable_note_encryption(id, &plaintext)?;

        if let Err(e) = crate::services::image::ImageService::migrate_note_images(
            vault,
            app_data_dir,
            id,
            crate::services::image::ImageMigration::Decrypt,
        ) {
            log::error!("笔记 {} 图片解密迁移失败，回滚 DB 解密：{}", id, e);
            const PLACEHOLDER: &str = "🔒 已加密内容——请解锁后查看";
            db.enable_note_encryption(id, PLACEHOLDER, &blob)?;
            return Err(AppError::Custom(format!("图片解密迁移失败：{}", e)));
        }
        Ok(())
    }

    /// T-014 网页剪藏：抓 URL → markdown → 创建笔记 → 正文图片落本地
    ///
    /// `folder_id` 优先级：用户传入 > None（根目录）。
    ///
    /// `app_data_dir` 必须是 `AppState.data_dir`（DataDirResolver 解析过的实际数据目录），
    /// 不能用 framework 默认的 `app_data_dir()`——否则图片会落到用户没在用的目录里。
    ///
    /// 图片处理放在建笔记**之后**：`rewrite_external_images` 按 note_id 分目录落盘，
    /// 必须先有 id。下载失败不影响剪藏本身（正文保留原始外链，仅记 warn）。
    pub async fn clip_url(
        db: &Database,
        url: &str,
        folder_id: Option<i64>,
        app_data_dir: &std::path::Path,
    ) -> Result<Note, AppError> {
        // 用户在设置里配的 Jina API Key（可空）——仅作直连失败时的兜底，读不到就当没配
        let jina_key = db
            .get_config(crate::services::web_clip::JINA_KEY_CONFIG)
            .unwrap_or(None);

        let clipped = crate::services::web_clip::fetch_page(url, jina_key.as_deref()).await?;

        // 笔记正文头部加一行 source 元信息，方便用户回溯原文
        let body = format!(
            "> 🌐 来源：[{src}]({src})\n\n{content}",
            src = clipped.source_url,
            content = clipped.markdown,
        );

        let mut input = NoteInput {
            title: clipped.title,
            content: body,
            folder_id,
        };
        let note = Self::create(db, &input)?;

        // 正文里的 https:// 图片下载到本地（微信等站点的防盗链绕过已在该函数内处理），
        // 否则笔记里的图迟早因 CDN 过期 / Referer 校验而裂掉。
        match crate::services::import_attachments::rewrite_external_images(
            &input.content,
            note.id,
            app_data_dir,
        )
        .await
        {
            Ok(rewrite) => {
                if !rewrite.missing.is_empty() {
                    log::warn!(
                        "[web-clip] 笔记 {} 有 {} 张图片下载失败，保留原始外链",
                        note.id,
                        rewrite.missing.len()
                    );
                }
                if rewrite.copied > 0 {
                    input.content = rewrite.new_body;
                    return Self::update(db, note.id, &input);
                }
            }
            Err(e) => {
                log::warn!("[web-clip] 笔记 {} 图片本地化失败：{}", note.id, e);
            }
        }

        Ok(note)
    }

    /// 剪藏网页并返回**可直接插入编辑器的 HTML**，不新建笔记——供编辑器工具栏用。
    ///
    /// 与 [`Self::clip_url`] 的区别只在落点：那个建新笔记，这个把正文插进已有笔记。
    /// 因此图片本地化要传**当前笔记的 id**（`rewrite_external_images` 按 note_id 分目录），
    /// 图片才会跟着宿主笔记走、随其一起被同步和清理。
    ///
    /// 返回 HTML 而非 markdown：Tiptap 的 `insertContent` 吃 HTML，
    /// 在这里用现成的 `markdown_to_html` 转好，前端就不必再引一个 markdown 解析器。
    /// 内容带 `> 🌐 来源：...` 头，与新建笔记的正文格式保持一致。
    pub async fn clip_url_to_html(
        db: &Database,
        url: &str,
        note_id: i64,
        app_data_dir: &std::path::Path,
    ) -> Result<String, AppError> {
        let jina_key = db
            .get_config(crate::services::web_clip::JINA_KEY_CONFIG)
            .unwrap_or(None);

        let clipped = crate::services::web_clip::fetch_page(url, jina_key.as_deref()).await?;

        let body = format!(
            "> 🌐 来源：[{src}]({src})\n\n{content}",
            src = clipped.source_url,
            content = clipped.markdown,
        );

        // 图片本地化失败不阻断插入：正文保留原始外链，用户仍拿得到内容（与 clip_url 同策略）
        match crate::services::import_attachments::rewrite_external_images(
            &body,
            note_id,
            app_data_dir,
        )
        .await
        {
            Ok(rewrite) => {
                if !rewrite.missing.is_empty() {
                    log::warn!(
                        "[web-clip] 插入笔记 {} 时有 {} 张图片下载失败，保留原始外链",
                        note_id,
                        rewrite.missing.len()
                    );
                }
                if rewrite.copied > 0 {
                    return Ok(crate::services::markdown::markdown_to_html(&rewrite.new_body));
                }
            }
            Err(e) => {
                log::warn!("[web-clip] 插入笔记 {} 时图片本地化失败：{}", note_id, e);
            }
        }

        Ok(crate::services::markdown::markdown_to_html(&body))
    }
}
