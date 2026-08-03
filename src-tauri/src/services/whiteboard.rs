//! 白板业务逻辑。
//!
//! 白板的画布内容是一整坨 Excalidraw 场景 JSON，直接塞进 `notes.content` 存。
//! 本模块负责两件"存进去之前必须做"的事：
//!
//! 1. **校验**：拒绝非法 JSON / 结构明显不对的载荷。画布是高频防抖保存的，
//!    一旦写进去一坨坏数据，用户下次打开就是空白画布且原内容不可恢复。
//! 2. **抽文字**：把画布里的文本元素抽成纯文本存 `notes.search_text`，
//!    让全文搜索能搜到白板里写的字，同时避免 JSON 本身（颜色值、属性名、
//!    元素 id）污染 FTS 索引 —— 详见 schema v52 的说明。

use std::path::Path;
use std::sync::RwLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{EmbeddedWhiteboardSaved, Note, NoteInput};
use crate::services::{
    asset_path,
    image::ImageService,
    vault::{VaultService, VaultState},
};

/// 新建白板时写入的初始空场景。
///
/// 有意存一个**结构完整的空场景**而不是空串：前端 Excalidraw 组件拿到空串要额外
/// 分支处理，而且这份 JSON 也是导出 / 同步到别的 Excalidraw 工具时的合法输入。
fn empty_scene() -> Value {
    json!({
        "type": "excalidraw",
        "version": 2,
        "source": "knowledge-base",
        "elements": [],
        "appState": { "viewBackgroundColor": "#ffffff" },
        "files": {}
    })
}

/// 校验前端传来的场景 JSON，返回解析后的值。
///
/// 只做**结构性**校验，不校验每个元素的字段：Excalidraw 的元素 schema 会随版本演进，
/// 校验太死会让升级 Excalidraw 后老白板存不进去。这里守住的底线是
/// "它至少是个带 elements 数组的 JSON 对象"，坏到无法渲染的载荷进不了库。
pub fn parse_scene(scene_json: &str) -> Result<Value, AppError> {
    let value: Value = serde_json::from_str(scene_json)
        .map_err(|e| AppError::InvalidInput(format!("白板内容不是合法 JSON: {}", e)))?;

    if !value.is_object() {
        return Err(AppError::InvalidInput("白板内容必须是 JSON 对象".into()));
    }
    if !value.get("elements").map(|e| e.is_array()).unwrap_or(false) {
        return Err(AppError::InvalidInput(
            "白板内容缺少 elements 数组，可能已损坏".into(),
        ));
    }
    Ok(value)
}

/// 从场景里抽出所有可搜索文本，用换行连接。
///
/// 抽取范围：
/// - `type == "text"` 元素的 `text`（画布上的文字、图形里的标签文字都是这种元素）
/// - frame（画框）的 `name` —— 用户常拿它当分区标题，属于有检索价值的信息
///
/// 跳过 `isDeleted == true` 的元素：Excalidraw 删除元素时是打标记而非移出数组
/// （撤销要用），照单全收会让搜索命中用户已经删掉的内容。
pub fn extract_text(scene: &Value) -> String {
    let Some(elements) = scene.get("elements").and_then(|e| e.as_array()) else {
        return String::new();
    };

    let mut parts: Vec<&str> = Vec::new();
    for el in elements {
        if el.get("isDeleted").and_then(|d| d.as_bool()).unwrap_or(false) {
            continue;
        }
        let kind = el.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind == "text" {
            if let Some(t) = el.get("text").and_then(|t| t.as_str()) {
                if !t.trim().is_empty() {
                    parts.push(t);
                }
            }
        }
        if kind == "frame" {
            if let Some(n) = el.get("name").and_then(|n| n.as_str()) {
                if !n.trim().is_empty() {
                    parts.push(n);
                }
            }
        }
    }
    parts.join("\n")
}

/// 新建一块白板。`title` 为空时给个带日期的默认名，避免列表里一排"未命名"。
pub fn create(db: &Database, title: &str, folder_id: Option<i64>) -> Result<Note, AppError> {
    let scene = empty_scene();
    let content = serde_json::to_string(&scene)?;
    let title = if title.trim().is_empty() {
        format!("白板 {}", chrono::Local::now().format("%Y-%m-%d %H:%M"))
    } else {
        title.trim().to_string()
    };

    let input = NoteInput {
        title,
        content,
        folder_id,
    };
    // 空场景没有任何文字，search_text 存空串（不是 NULL —— NULL 会让 FTS 的
    // COALESCE 落回 content，把空场景的 JSON 索引进去）
    db.create_whiteboard(&input, "")
}

// ─── 图片：base64 ⇄ kb_assets 附件 ──────────────────────────────
//
// Excalidraw 原生把插入的图片以 base64 dataURL 塞在场景的 `files` 字段里。
// 照原样存库会出三个问题：
//   1. 一张 2MB 截图 → 每次防抖保存都往 SQLite 写 2.7MB 字符串（base64 膨胀 ~33%）
//   2. 同步时整块画布当一个 `.md` 传，图片改一点就要重传全部
//   3. 图片游离在既有的 kb_assets 附件体系之外，GC / 加密 / 打包都覆盖不到
//
// 所以：**存库前把图片外置成附件文件，读库后再内联回 dataURL**。
// Excalidraw 自身永远只见到 dataURL —— 渲染、导出 PNG/SVG 的行为一点没变
// （若直接把自定义协议 URL 交给它，导出时会污染 canvas 导致导出失败）。
//
// 外置后 `dataURL` 字段存 `kb-asset://kb_assets/images/<note_id>/<file>`，
// 这个形式正好被 `sync_v1::attachment_scan::extract_local_refs` 认得 ——
// 白板里的图片因此自动进同步管线，不必再写一套扫描规则。

/// 外置后写进 `dataURL` 字段的前缀，与前端 `lib/assetUrl.ts` 的 KB_ASSET_SCHEME 一致
const KB_ASSET_SCHEME: &str = "kb-asset://";

/// 从 `data:image/png;base64,xxxx` 里拆出 (扩展名, base64 载荷)。
/// 不是 dataURL 就返回 None（说明这条 file 已经是外置过的引用，跳过即可）。
fn split_data_url(data_url: &str) -> Option<(&str, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(",")?;
    if !meta.ends_with(";base64") {
        return None;
    }
    let mime = meta.trim_end_matches(";base64");
    // image/svg+xml → svg；image/jpeg → jpeg。取不到就按 png 兜底
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => "png",
    };
    Some((ext, payload))
}

/// 把场景里所有 base64 图片落盘成附件，`dataURL` 就地换成 `kb-asset://` 引用。
///
/// 单张图片失败不中断整次保存：宁可这张图退化成 base64 存进库（大但没丢），
/// 也不能让用户点了半天画的东西整块存不进去。
fn externalize_files(
    scene: &mut Value,
    db: &Database,
    vault: &RwLock<VaultState>,
    data_dir: &Path,
    note_id: i64,
) {
    let Some(files) = scene.get_mut("files").and_then(|f| f.as_object_mut()) else {
        return;
    };

    for (file_id, entry) in files.iter_mut() {
        let Some(data_url) = entry.get("dataURL").and_then(|d| d.as_str()) else {
            continue;
        };
        let Some((ext, payload)) = split_data_url(data_url) else {
            continue; // 已是 kb-asset:// 引用或外链，不动
        };

        let bytes = match STANDARD.decode(payload) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("白板图片 {} base64 解码失败，保留内联: {}", file_id, e);
                continue;
            }
        };

        // 文件名用 Excalidraw 的 fileId：它本身是内容哈希，天然稳定 ——
        // 同一张图重复保存不会每次生成新文件（safe_filename 判重也依赖名字先撞上）
        let file_name = format!("{}.{}", file_id, ext);
        let abs = match ImageService::save_bytes_routed(
            db, vault, data_dir, note_id, &file_name, &bytes,
        ) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("白板图片 {} 落盘失败，保留内联: {}", file_id, e);
                continue;
            }
        };

        match asset_path::abs_to_rel(Path::new(&abs), data_dir) {
            Some(rel) => {
                entry["dataURL"] = json!(format!("{}{}", KB_ASSET_SCHEME, rel));
            }
            None => {
                log::warn!("白板图片 {} 落在数据目录外，保留内联: {}", file_id, abs);
            }
        }
    }
}

/// `externalize_files` 的逆操作：把 `kb-asset://` 引用读回 base64 dataURL。
///
/// 读不到的图片（文件被手工删了 / vault 未解锁）保持引用原样：Excalidraw 会把
/// 该图片渲染成占位框，其余画布内容照常可用 —— 比整块画布打不开好得多。
fn inline_files(scene: &mut Value, vault: &RwLock<VaultState>, data_dir: &Path) {
    let Some(files) = scene.get_mut("files").and_then(|f| f.as_object_mut()) else {
        return;
    };

    for (file_id, entry) in files.iter_mut() {
        let Some(rel) = entry
            .get("dataURL")
            .and_then(|d| d.as_str())
            .and_then(|d| d.strip_prefix(KB_ASSET_SCHEME))
        else {
            continue;
        };

        let abs = match asset_path::rel_to_abs(rel, data_dir) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("白板图片 {} 的相对路径非法({}): {}", file_id, rel, e);
                continue;
            }
        };

        // read_for_render 会自动处理 `.enc`（加密笔记的图片）
        let bytes = match ImageService::read_for_render(vault, &abs.to_string_lossy()) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("白板图片 {} 读取失败，保留引用: {}", file_id, e);
                continue;
            }
        };

        // mimeType 存在 entry 里（Excalidraw 自己写的），没有就按 png 兜底
        let mime = entry
            .get("mimeType")
            .and_then(|m| m.as_str())
            .unwrap_or("image/png");
        entry["dataURL"] = json!(format!(
            "data:{};base64,{}",
            mime,
            STANDARD.encode(&bytes)
        ));
    }
}

// ─── 画布内的 [[wiki 双链]] ────────────────────────────────
//
// 用户在画布上写 `[[某笔记]]` 时，除了建立出链（见 save_scene），还要能**点开**。
// 做法是把解析到的目标写进 Excalidraw 元素原生的 `link` 字段：画布上会自动出现
// 链接角标，点击走前端 onLinkOpen 拦截 → React Router 跳转。
//
// 只托管我们自己写的这种 link（`#/notes/<id>` 前缀），用户手动挂的外链一概不碰。

/// 我们托管的元素 link 前缀。与前端 HashRouter 的笔记路由一致。
const NOTE_LINK_PREFIX: &str = "#/notes/";

/// 按文本里的 `[[标题]]` 给元素挂上/摘掉笔记链接。
///
/// 三种情形：
/// - 文本有 `[[X]]` 且 X 能解析到可见笔记 → `link = "#/notes/<id>"`
/// - 文本没有 `[[X]]`（或解析不到）但当前 link 是我们挂的 → 清掉，
///   否则用户把链接语法删了、角标却还赖着不走，点下去还跳转
/// - link 是别的东西（用户手填的 http 外链等）→ **完全不动**
fn apply_wiki_links(scene: &mut Value, db: &Database) {
    let Some(elements) = scene.get_mut("elements").and_then(|e| e.as_array_mut()) else {
        return;
    };

    for el in elements {
        if el.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        let text = el.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let target = crate::database::links::extract_wiki_refs(text)
            .into_iter()
            .find_map(|(title, explicit_id)| match explicit_id {
                Some(id) => Some(id),
                None => db.find_note_id_by_title_loose(&title).ok().flatten(),
            });

        match target {
            Some(id) => {
                el["link"] = json!(format!("{}{}", NOTE_LINK_PREFIX, id));
            }
            None => {
                // 只回收我们自己挂的，别动用户手填的外链
                let ours = el
                    .get("link")
                    .and_then(|l| l.as_str())
                    .map(|l| l.starts_with(NOTE_LINK_PREFIX))
                    .unwrap_or(false);
                if ours {
                    el["link"] = Value::Null;
                }
            }
        }
    }
}

/// 拿一条笔记里「该被当成文本来解析」的内容。
///
/// 普通笔记就是正文；白板则是画布上的文字 —— 因为白板的 `content` 是 Excalidraw JSON，
/// 直接拿去跑 `[[wiki]]` / 全文索引会掺进一堆属性名和转义符。
///
/// 双链解析和搜索索引都走这里，保证两者口径一致：
/// 用户在画布上写 `[[某笔记]]`，既能被搜到，也真的能建立反链。
pub fn text_for_indexing(note_type_val: &str, content: &str) -> String {
    if note_type_val != crate::models::note_type::WHITEBOARD {
        return content.to_string();
    }
    parse_scene(content)
        .map(|scene| extract_text(&scene))
        .unwrap_or_default()
}

/// 保存画布：校验 → 图片外置 → 抽文字 → 落库 → 重建双链。
///
/// 落库的是**外置后**的 JSON，所以 `notes.content` 里不含 base64，
/// 同步传输量和 SQLite 体积都只跟画布结构相关，与图片大小无关。
pub fn save_scene(
    db: &Database,
    vault: &RwLock<VaultState>,
    data_dir: &Path,
    id: i64,
    scene_json: &str,
) -> Result<(), AppError> {
    let mut scene = parse_scene(scene_json)?;
    externalize_files(&mut scene, db, vault, data_dir, id);
    // 把画布里的 [[双链]] 落成元素 link，下次打开就有可点的链接角标
    apply_wiki_links(&mut scene, db);
    let search_text = extract_text(&scene);
    let stored = serde_json::to_string(&scene)?;
    db.update_whiteboard_scene(id, &stored, &search_text)?;

    // 画布上写的 `[[某笔记]]` 要真的算作出链 —— 否则白板在知识库里是座孤岛：
    // 目标笔记的反链看不到它、知识图谱上它没有连线、断链检测也查不出笔画错的标题。
    // 喂的是抽出来的纯文字而非 JSON，跟搜索索引同一口径。
    // 失败只记 warn：双链是派生数据，下次保存会自愈，不该让画布存不进去。
    if let Err(e) = db.rebuild_note_links_from_content(id, &search_text) {
        log::warn!("[whiteboard] 重建白板 {} 的双链失败: {}", id, e);
    }
    Ok(())
}

// ─── 笔记内嵌白板 ────────────────────────────────────────────
//
// 与"整页白板"（note_type='whiteboard' 的笔记）并存的另一种形态：
// 笔记正文里插一个白板块，平时显示成一张预览图，点开才进画布编辑 —— 就是飞书文档里的画板。
//
// **场景数据存文件而不是内联进笔记**：一个带图的画布 JSON 动辄几百 KB，
// 塞进 Tiptap 节点属性会让 `.md` 没法看，也让每次笔记保存都要搬运这坨数据。
//
// 文件落在 `kb_assets/images/<note_id>/` 下（扩展名 `.excalidraw`）。
// 放 images 目录看着有点将就，但换来的是**全套生命周期管理白拿**：
// 笔记永久删除时 `delete_note_images` 一并清掉、孤儿扫描能扫到、
// 加密笔记的 `.enc` 路由也是现成的。为此单开一个 whiteboards 目录，
// 上面每一条都得重写一遍。
//
// 笔记里引用它的形式是 `kb-asset://kb_assets/images/<id>/xxx.excalidraw`，
// 正好被 `sync_v1::attachment_scan` 认成本地资产 → 自动进同步，不必另写规则。

/// 内嵌白板场景文件的扩展名
const EMBEDDED_SCENE_EXT: &str = "excalidraw";

/// 保存内嵌白板的画布。
///
/// `rel_path` 传 `Some(已有路径)` 表示**覆盖原文件**（用户在编辑已有白板）；
/// 传 `None` 则新建一个。必须支持覆盖 —— 否则用户每存一次就多一个文件，
/// 一块反复修改的白板会在磁盘上留下几十个残骸。
///
/// 返回相对 data_dir 的 POSIX 路径，前端拼成 `kb-asset://` 存进节点属性。
pub fn save_embedded_scene(
    db: &Database,
    vault: &RwLock<VaultState>,
    data_dir: &Path,
    note_id: i64,
    rel_path: Option<&str>,
    scene_json: &str,
    preview_png_base64: &str,
) -> Result<EmbeddedWhiteboardSaved, AppError> {
    let mut scene = parse_scene(scene_json)?;
    // 画布里的图片同样外置成附件，别让 base64 撑爆场景文件
    externalize_files(&mut scene, db, vault, data_dir, note_id);
    let stored = serde_json::to_string(&scene)?;

    // 加密笔记的白板内容也要加密，否则"这篇笔记加密了"就是个假象。
    // 预览图同样加密 —— 只加密场景、留明文预览图等于把画的东西直接摊开给人看。
    let is_encrypted = db.get_note_is_encrypted(note_id)?;
    let enc_suffix = if is_encrypted { ".enc" } else { "" };

    // 场景与预览图共用一个 stem，"改同一块白板"永远落回这两个文件
    let stem = match rel_path {
        Some(rel) => embedded_stem_of(rel).ok_or_else(|| {
            AppError::InvalidInput(format!("无法从白板路径解析出文件名: {}", rel))
        })?,
        None => format!("wb-{}", uuid::Uuid::new_v4()),
    };

    let dir = match rel_path {
        // 覆盖已有文件：走 rel_to_abs 校验路径确实在数据目录内，
        // 防止前端传个 `../../` 把文件写到数据目录外
        Some(rel) => {
            let p = asset_path::rel_to_abs(rel, data_dir)
                .map_err(|e| AppError::InvalidInput(format!("白板路径非法: {}", e)))?;
            p.parent()
                .map(|d| d.to_path_buf())
                .ok_or_else(|| AppError::InvalidInput("白板路径没有父目录".into()))?
        }
        // 复用 ImageService 的目录约定（含 dev- 前缀隔离），别自己拼目录名
        None => ImageService::images_dir(data_dir).join(note_id.to_string()),
    };
    std::fs::create_dir_all(&dir)?;

    // ── 场景文件
    let scene_bytes: Vec<u8> = if is_encrypted {
        VaultService::encrypt_plaintext(vault, stored.as_bytes())?
    } else {
        stored.into_bytes()
    };
    let scene_abs = dir.join(format!("{}.{}{}", stem, EMBEDDED_SCENE_EXT, enc_suffix));
    std::fs::write(&scene_abs, &scene_bytes)?;

    // ── 预览图
    let png = STANDARD
        .decode(preview_png_base64)
        .map_err(|e| AppError::InvalidInput(format!("预览图 base64 解码失败: {}", e)))?;
    let preview_bytes: Vec<u8> = if is_encrypted {
        VaultService::encrypt_plaintext(vault, &png)?
    } else {
        png
    };
    let preview_abs = dir.join(format!("{}.png{}", stem, enc_suffix));
    std::fs::write(&preview_abs, &preview_bytes)?;

    let to_rel = |p: &Path| -> Result<String, AppError> {
        asset_path::abs_to_rel(p, data_dir)
            .ok_or_else(|| AppError::Custom(format!("{} 不在数据目录下", p.display())))
    };
    Ok(EmbeddedWhiteboardSaved {
        scene_path: to_rel(&scene_abs)?,
        preview_path: to_rel(&preview_abs)?,
    })
}

/// 从场景文件的相对路径里取出 stem（去掉 `.excalidraw` / `.excalidraw.enc`）。
/// 预览图靠这个 stem 与场景配对，保证覆盖写而不是每次新建。
fn embedded_stem_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?;
    let name = name.strip_suffix(".enc").unwrap_or(name);
    let stem = name.strip_suffix(&format!(".{}", EMBEDDED_SCENE_EXT))?;
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}

/// 读回内嵌白板的画布，图片已内联成 dataURL，可直接交给 Excalidraw。
pub fn load_embedded_scene(
    vault: &RwLock<VaultState>,
    data_dir: &Path,
    rel_path: &str,
) -> Result<String, AppError> {
    let abs = asset_path::rel_to_abs(rel_path, data_dir)
        .map_err(|e| AppError::InvalidInput(format!("白板路径非法: {}", e)))?;
    // read_for_render 会按 `.enc` 后缀自动解密
    let bytes = ImageService::read_for_render(vault, &abs.to_string_lossy())?;
    let text = String::from_utf8(bytes)
        .map_err(|e| AppError::Custom(format!("白板文件不是合法 UTF-8: {}", e)))?;
    let mut scene = parse_scene(&text)?;
    inline_files(&mut scene, vault, data_dir);
    Ok(serde_json::to_string(&scene)?)
}

/// 同步 V1 pull 用：按远端 manifest 声明的类型对齐本地笔记。
///
/// 拉到白板时顺手重建 `search_text` —— pull 走的是通用的 `update_note_synced`，
/// 它只写 content，不知道白板要额外抽一份可搜索文本；不补这一步，
/// 从别的设备同步过来的白板在本机是"搜不到内容"的。
///
/// 内容坏掉（不是合法场景 JSON）时 `search_text` 存空串而不是报错：
/// 类型标记本身要对齐成功，否则用户点开会进 Markdown 编辑器，把画布覆盖得更彻底。
pub fn sync_note_type(
    db: &Database,
    id: i64,
    note_type_val: &str,
    content: &str,
) -> Result<(), AppError> {
    if note_type_val == crate::models::note_type::WHITEBOARD {
        let text = parse_scene(content)
            .map(|scene| extract_text(&scene))
            .unwrap_or_default();
        db.set_note_type(id, note_type_val, Some(&text))
    } else {
        // 退回普通笔记：清空 search_text，让 FTS 索引落回 content
        db.set_note_type(id, note_type_val, None)
    }
}

/// 读画布给前端：把外置的图片内联回 dataURL，Excalidraw 才能直接吃。
pub fn load_scene(
    db: &Database,
    vault: &RwLock<VaultState>,
    data_dir: &Path,
    id: i64,
) -> Result<String, AppError> {
    let note = db
        .get_note(id)?
        .ok_or_else(|| AppError::NotFound(format!("白板 {} 不存在", id)))?;
    // 空内容按空白板处理（历史数据 / 异常中断都可能留下空串）
    if note.content.trim().is_empty() {
        return Ok(serde_json::to_string(&empty_scene())?);
    }
    let mut scene = parse_scene(&note.content)?;
    inline_files(&mut scene, vault, data_dir);
    Ok(serde_json::to_string(&scene)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scene_rejects_garbage() {
        assert!(parse_scene("not json").is_err());
        // 合法 JSON 但不是对象
        assert!(parse_scene("[1,2,3]").is_err());
        // 是对象但没有 elements → 渲染不出来，挡住
        assert!(parse_scene(r#"{"type":"excalidraw"}"#).is_err());
        // elements 不是数组
        assert!(parse_scene(r#"{"elements":{}}"#).is_err());
    }

    #[test]
    fn parse_scene_accepts_minimal_and_empty_scene() {
        assert!(parse_scene(r#"{"elements":[]}"#).is_ok());
        let empty = serde_json::to_string(&empty_scene()).unwrap();
        assert!(parse_scene(&empty).is_ok());
    }

    #[test]
    fn extract_text_collects_text_and_frame_names() {
        let scene = json!({
            "elements": [
                { "type": "text", "text": "第一段文字" },
                { "type": "rectangle", "strokeColor": "#000000" },
                { "type": "text", "text": "第二段文字" },
                { "type": "frame", "name": "架构图" }
            ]
        });
        assert_eq!(extract_text(&scene), "第一段文字\n第二段文字\n架构图");
    }

    /// Excalidraw 删元素是打 isDeleted 标记（撤销要用），不抽这些 ——
    /// 否则用户删掉的内容还能被搜出来。
    #[test]
    fn extract_text_skips_deleted_elements() {
        let scene = json!({
            "elements": [
                { "type": "text", "text": "保留的" },
                { "type": "text", "text": "删掉的", "isDeleted": true },
                { "type": "frame", "name": "删掉的画框", "isDeleted": true }
            ]
        });
        assert_eq!(extract_text(&scene), "保留的");
    }

    /// 纯空白文字不该进搜索索引，否则 search_text 里全是换行
    #[test]
    fn extract_text_ignores_blank_strings() {
        let scene = json!({
            "elements": [
                { "type": "text", "text": "   " },
                { "type": "text", "text": "" },
                { "type": "frame", "name": " " },
                { "type": "text", "text": "有效内容" }
            ]
        });
        assert_eq!(extract_text(&scene), "有效内容");
    }

    /// 没有 elements 字段时不能 panic（extract_text 也被 save 之外的路径调用）
    #[test]
    fn extract_text_handles_missing_elements() {
        assert_eq!(extract_text(&json!({})), "");
        assert_eq!(extract_text(&json!({ "elements": "oops" })), "");
    }

    #[test]
    fn split_data_url_maps_common_mime_types() {
        assert_eq!(split_data_url("data:image/png;base64,AAAA"), Some(("png", "AAAA")));
        assert_eq!(split_data_url("data:image/jpeg;base64,BBBB"), Some(("jpg", "BBBB")));
        assert_eq!(split_data_url("data:image/svg+xml;base64,CCCC"), Some(("svg", "CCCC")));
        // 认不出的 mime 按 png 兜底，总比丢图强
        assert_eq!(split_data_url("data:image/avif;base64,DDDD"), Some(("png", "DDDD")));
    }

    /// 已经外置过的引用 / 外链不能被当成 dataURL 再处理一遍 ——
    /// 否则第二次保存会把 `kb-asset://...` 这串文本当图片内容落盘。
    #[test]
    fn split_data_url_rejects_non_data_urls() {
        assert_eq!(split_data_url("kb-asset://kb_assets/images/1/a.png"), None);
        assert_eq!(split_data_url("https://example.com/a.png"), None);
        // data: 但不是 base64 编码（如 utf8 的 svg）→ 不处理，保持原样
        assert_eq!(split_data_url("data:image/svg+xml,%3Csvg/%3E"), None);
        assert_eq!(split_data_url(""), None);
    }

    /// 外置后场景里不该再有 base64；这里验证「读回来」这一侧对
    /// 非 kb-asset 前缀的条目不作为（幂等，重复调用安全）。
    #[test]
    fn inline_files_leaves_plain_data_urls_untouched() {
        let vault = RwLock::new(VaultState::default());
        let mut scene = json!({
            "elements": [],
            "files": {
                "abc": { "dataURL": "data:image/png;base64,AAAA", "mimeType": "image/png" }
            }
        });
        inline_files(&mut scene, &vault, Path::new("."));
        assert_eq!(
            scene["files"]["abc"]["dataURL"].as_str(),
            Some("data:image/png;base64,AAAA")
        );
    }

    // ─── 画布内 [[双链]] → 元素 link ───────────────────

    fn mem_db() -> Database {
        Database::init(":memory:").unwrap()
    }

    /// 建一条笔记当链接目标，返回 id
    fn make_note(db: &Database, title: &str) -> i64 {
        db.create_note(&NoteInput {
            title: title.into(),
            content: String::new(),
            folder_id: None,
        })
        .unwrap()
        .id
    }

    #[test]
    fn apply_wiki_links_sets_link_for_existing_note() {
        let db = mem_db();
        let target = make_note(&db, "目标笔记");
        let mut scene = json!({
            "elements": [
                { "type": "text", "text": "见 [[目标笔记]] 了解详情" }
            ]
        });
        apply_wiki_links(&mut scene, &db);
        assert_eq!(
            scene["elements"][0]["link"].as_str(),
            Some(format!("#/notes/{}", target).as_str())
        );
    }

    /// 标题查不到对应笔记（断链）时不能瞎挂 link —— 点了会跳到不存在的笔记
    #[test]
    fn apply_wiki_links_skips_unresolvable_titles() {
        let db = mem_db();
        let mut scene = json!({
            "elements": [
                { "type": "text", "text": "见 [[根本不存在的笔记]]" }
            ]
        });
        apply_wiki_links(&mut scene, &db);
        assert!(scene["elements"][0].get("link").is_none());
    }

    /// 用户把 [[X]] 删掉后，之前挂上的角标必须跟着消失，
    /// 否则画布上留着一个点了就乱跳的幽灵链接。
    #[test]
    fn apply_wiki_links_clears_stale_note_link() {
        let db = mem_db();
        let mut scene = json!({
            "elements": [
                { "type": "text", "text": "已经不含链接语法了", "link": "#/notes/42" }
            ]
        });
        apply_wiki_links(&mut scene, &db);
        assert!(scene["elements"][0]["link"].is_null());
    }

    /// 用户手动挂的外链不归我们管，绝不能被清掉或覆盖
    #[test]
    fn apply_wiki_links_preserves_user_external_links() {
        let db = mem_db();
        let mut scene = json!({
            "elements": [
                { "type": "text", "text": "普通文字", "link": "https://example.com" }
            ]
        });
        apply_wiki_links(&mut scene, &db);
        assert_eq!(
            scene["elements"][0]["link"].as_str(),
            Some("https://example.com")
        );
    }

    /// 非文本元素（矩形等）不该被碰
    #[test]
    fn apply_wiki_links_ignores_non_text_elements() {
        let db = mem_db();
        make_note(&db, "目标笔记");
        let mut scene = json!({
            "elements": [
                { "type": "rectangle", "text": "见 [[目标笔记]]" }
            ]
        });
        apply_wiki_links(&mut scene, &db);
        assert!(scene["elements"][0].get("link").is_none());
    }

    // ─── 笔记内嵌白板：文件读写 ─────────────────────

    #[test]
    fn embedded_stem_parses_plain_and_encrypted() {
        assert_eq!(
            embedded_stem_of("kb_assets/images/5/wb-abc.excalidraw").as_deref(),
            Some("wb-abc")
        );
        // 加密笔记的场景文件带 .enc，stem 必须一样 —— 否则加密笔记里
        // 每存一次就换个文件名，旧文件全成垃圾
        assert_eq!(
            embedded_stem_of("kb_assets/images/5/wb-abc.excalidraw.enc").as_deref(),
            Some("wb-abc")
        );
        // 不是场景文件 → None，调用方会当作"新建"处理而不是误覆盖别的文件
        assert!(embedded_stem_of("kb_assets/images/5/photo.png").is_none());
        assert!(embedded_stem_of("").is_none());
    }

    /// 建一个临时数据目录 + 一条笔记，返回 (db, vault, data_dir, note_id)
    fn embedded_fixture(
        tag: &str,
    ) -> (Database, RwLock<VaultState>, std::path::PathBuf, i64) {
        let db = mem_db();
        let note_id = make_note(&db, "宿主笔记");
        let dir = std::env::temp_dir().join(format!("kb-wb-test-{}-{}", tag, note_id));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (db, RwLock::new(VaultState::default()), dir, note_id)
    }

    fn scene_with_text(text: &str) -> String {
        json!({
            "type": "excalidraw",
            "elements": [{ "type": "text", "text": text }],
            "appState": {},
            "files": {}
        })
        .to_string()
    }

    /// 1×1 透明 PNG 的 base64，当预览图用
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn save_embedded_writes_scene_and_preview() {
        let (db, vault, dir, note_id) = embedded_fixture("new");
        let saved = save_embedded_scene(
            &db,
            &vault,
            &dir,
            note_id,
            None,
            &scene_with_text("流程草图"),
            TINY_PNG,
        )
        .unwrap();

        // 两个文件都落盘了，且是配对命名（同 stem，不同扩展名）
        assert!(saved.scene_path.ends_with(".excalidraw"));
        assert!(saved.preview_path.ends_with(".png"));
        assert_eq!(
            embedded_stem_of(&saved.scene_path),
            saved
                .preview_path
                .rsplit('/')
                .next()
                .and_then(|n| n.strip_suffix(".png"))
                .map(|s| s.to_string()),
        );
        assert!(asset_path::rel_to_abs(&saved.scene_path, &dir).unwrap().exists());
        assert!(asset_path::rel_to_abs(&saved.preview_path, &dir).unwrap().exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反复保存同一块白板必须覆盖原文件。
    /// 这条守的是"用户改十次白板，磁盘上多出十对垃圾文件"这个退化。
    #[test]
    fn save_embedded_overwrites_instead_of_piling_up() {
        let (db, vault, dir, note_id) = embedded_fixture("overwrite");
        let first = save_embedded_scene(
            &db,
            &vault,
            &dir,
            note_id,
            None,
            &scene_with_text("第一版"),
            TINY_PNG,
        )
        .unwrap();

        let second = save_embedded_scene(
            &db,
            &vault,
            &dir,
            note_id,
            Some(&first.scene_path),
            &scene_with_text("第二版"),
            TINY_PNG,
        )
        .unwrap();

        // 路径完全没变 = 覆盖了同一对文件
        assert_eq!(first.scene_path, second.scene_path);
        assert_eq!(first.preview_path, second.preview_path);

        // 目录里就只有这两个文件，没有堆积
        let note_dir = ImageService::images_dir(&dir).join(note_id.to_string());
        let count = std::fs::read_dir(&note_dir).unwrap().count();
        assert_eq!(count, 2, "应只有 1 个场景文件 + 1 张预览图");

        // 内容确实更新成了第二版
        let loaded = load_embedded_scene(&vault, &dir, &second.scene_path).unwrap();
        assert!(loaded.contains("第二版"));
        assert!(!loaded.contains("第一版"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_embedded_round_trips_scene() {
        let (db, vault, dir, note_id) = embedded_fixture("roundtrip");
        let saved = save_embedded_scene(
            &db,
            &vault,
            &dir,
            note_id,
            None,
            &scene_with_text("往返测试"),
            TINY_PNG,
        )
        .unwrap();

        let loaded = load_embedded_scene(&vault, &dir, &saved.scene_path).unwrap();
        let scene: Value = serde_json::from_str(&loaded).unwrap();
        assert_eq!(extract_text(&scene), "往返测试");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前端传来的路径不能逃出数据目录 —— 否则等于给了个任意写文件的口子
    #[test]
    fn save_embedded_rejects_path_traversal() {
        let (db, vault, dir, note_id) = embedded_fixture("traversal");
        let r = save_embedded_scene(
            &db,
            &vault,
            &dir,
            note_id,
            Some("../../evil/wb-x.excalidraw"),
            &scene_with_text("坏东西"),
            TINY_PNG,
        );
        assert!(r.is_err(), "带 .. 的路径必须被拒绝");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 白板走画布文字、普通笔记走原文 —— 双链与搜索都靠这个口径
    #[test]
    fn text_for_indexing_switches_by_note_type() {
        let scene = json!({
            "elements": [{ "type": "text", "text": "画布上的字" }]
        })
        .to_string();
        assert_eq!(
            text_for_indexing(crate::models::note_type::WHITEBOARD, &scene),
            "画布上的字"
        );
        // 普通笔记原样返回，不做任何解析
        assert_eq!(
            text_for_indexing(crate::models::note_type::MARKDOWN, "# 标题\n正文"),
            "# 标题\n正文"
        );
        // 白板内容坏掉时返回空串而不是 panic
        assert_eq!(
            text_for_indexing(crate::models::note_type::WHITEBOARD, "坏数据"),
            ""
        );
    }

    /// 场景没有 files 字段（纯图形白板）时两个方向都不能 panic
    #[test]
    fn file_helpers_handle_missing_files_field() {
        let vault = RwLock::new(VaultState::default());
        let mut scene = json!({ "elements": [] });
        inline_files(&mut scene, &vault, Path::new("."));
        assert!(scene.get("files").is_none());
    }

    /// 画布上只有图形没有文字时，search_text 必须是空串 ——
    /// 让 FTS 索引到"什么都没有"，而不是把一坨 JSON 属性名索引进去。
    #[test]
    fn extract_text_returns_empty_for_shapes_only() {
        let scene = json!({
            "elements": [
                { "type": "rectangle", "strokeColor": "#1e1e1e", "backgroundColor": "transparent" },
                { "type": "arrow", "strokeWidth": 2 }
            ]
        });
        assert_eq!(extract_text(&scene), "");
    }
}
