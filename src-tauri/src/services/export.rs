use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ExportProgress, ExportResult, SingleExportResult};

pub struct ExportService;

impl ExportService {
    /// 导出笔记为 Markdown 文件
    ///
    /// 行为：在用户选定的 `output_dir` 下自动创建一层 `知识库导出_YYYYMMDD_HHmmss/`
    /// 作为实际导出根目录，避免散落污染目标目录。
    ///
    /// - `output_dir`: 用户选择的父目录
    /// - `instance_data_dir`: 当前实例的数据根目录（用于资产路径校验，防越权拷贝）
    /// - `folder_id`: 可选，仅导出指定文件夹的笔记；None 表示导出全部
    pub fn export_notes<R: Runtime, E: Emitter<R>>(
        db: &Database,
        instance_data_dir: &Path,
        output_dir: &str,
        folder_id: Option<i64>,
        emitter: &E,
    ) -> Result<ExportResult, AppError> {
        let parent_path = Path::new(output_dir);
        std::fs::create_dir_all(parent_path)?;

        // 在父目录下创建带时间戳的导出根目录（包一层），重名时自动加 _1/_2 后缀
        let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let root_name = unique_dir_name(parent_path, &format!("知识库导出_{}", stamp));
        let output_path = parent_path.join(&root_name);
        std::fs::create_dir_all(&output_path)?;

        // ★ 关键点：把所有需要读的数据一次性拉出来后**立即释放 DB 锁**，
        // 然后再做耗时的文件 I/O。否则整个导出期间（可能数秒～数十秒）
        // 其他 Command 的任何 DB 操作都会被这把锁阻塞。
        let (folder_names, folder_parents, notes) = {
            let conn = db.conn_lock()?;

            // 1. 构建文件夹 id -> name 映射 和 id -> parent_id 映射
            let mut folder_names: HashMap<i64, String> = HashMap::new();
            let mut folder_parents: HashMap<i64, Option<i64>> = HashMap::new();
            {
                let mut stmt = conn.prepare("SELECT id, name, parent_id FROM folders")?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })?;
                for row in rows {
                    let (id, name, parent_id) = row?;
                    folder_names.insert(id, name);
                    folder_parents.insert(id, parent_id);
                }
            }

            // 2. 查询笔记
            let notes: Vec<(i64, String, String, Option<i64>, bool, Option<String>)> = {
                let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
                    if let Some(fid) = folder_id {
                        (
                            "SELECT id, title, content, folder_id, is_daily, daily_date \
                             FROM notes WHERE is_deleted = 0 AND folder_id = ?1 \
                             ORDER BY updated_at DESC"
                                .into(),
                            vec![Box::new(fid)],
                        )
                    } else {
                        (
                            "SELECT id, title, content, folder_id, is_daily, daily_date \
                             FROM notes WHERE is_deleted = 0 \
                             ORDER BY updated_at DESC"
                                .into(),
                            vec![],
                        )
                    };

                let mut stmt = conn.prepare(&sql)?;
                let params_refs: Vec<&dyn rusqlite::types::ToSql> =
                    params_vec.iter().map(|p| p.as_ref()).collect();
                let rows = stmt.query_map(params_refs.as_slice(), |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            (folder_names, folder_parents, notes)
            // conn 在这里随着 block 结束自动 drop，锁释放
        };

        // 提前规范化实例根，rewrite_assets 内每张图都要比对
        let canon_root = instance_data_dir
            .canonicalize()
            .unwrap_or_else(|_| instance_data_dir.to_path_buf());

        let total = notes.len();
        let mut exported = 0usize;
        let mut total_assets_copied = 0usize;
        let mut errors = Vec::new();

        for (i, (id, title, content, note_folder_id, is_daily, daily_date)) in
            notes.iter().enumerate()
        {
            // 构建子目录路径
            let sub_dir = if *is_daily {
                "每日笔记".to_string()
            } else if let Some(fid) = note_folder_id {
                build_folder_path(*fid, &folder_names, &folder_parents)
            } else {
                "未分类".to_string()
            };

            let dir = output_path.join(&sub_dir);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                errors.push(format!("{}: 创建目录失败 - {}", title, e));
                continue;
            }

            // 生成文件名（不含扩展名 + 完整名）
            let basename = if *is_daily {
                daily_date.as_deref().unwrap_or("unknown").to_string()
            } else {
                sanitize_filename(title)
            };
            let file_name = format!("{}.md", basename);
            let file_path = dir.join(&file_name);

            // 发送进度事件
            let _ = emitter.emit(
                "export:progress",
                ExportProgress {
                    current: i + 1,
                    total,
                    file_name: file_name.clone(),
                },
            );

            // 拷资产 + 重写 URL（资产目录 = 同级 <basename>.assets/）
            let assets_subdir = format!("{}.assets", basename);
            let (rewritten, copied) =
                rewrite_assets_for_export(content, &dir, &assets_subdir, &canon_root);
            total_assets_copied += copied;

            match std::fs::write(&file_path, &rewritten) {
                Ok(_) => exported += 1,
                Err(e) => {
                    errors.push(format!("{}: 写入失败 - {}", title, e));
                }
            }

            log::debug!(
                "导出笔记 #{}: {} -> {:?} (拷贝资产 {})",
                id,
                title,
                file_path,
                copied
            );
        }

        let result = ExportResult {
            exported,
            errors,
            output_dir: output_dir.to_string(),
            root_dir: output_path.to_string_lossy().to_string(),
            assets_copied: total_assets_copied,
        };

        let _ = emitter.emit("export:done", &result);

        Ok(result)
    }

    /// 导出单篇笔记为 Markdown 文件
    ///
    /// 行为：在用户选择的 `parent_dir` 下创建一层 `{标题}/` 子目录，里面放：
    /// - `{标题}.md`：正文
    /// - `assets/`：图片+附件
    ///
    /// 重名时自动加 `_1` / `_2` 后缀，避免覆盖已有目录。
    pub fn export_single_note(
        db: &Database,
        instance_data_dir: &Path,
        note_id: i64,
        parent_dir: &str,
    ) -> Result<SingleExportResult, AppError> {
        // 单独 block 让 stmt/conn 在拷贝资产前及时释放 DB 锁
        let (title, content): (String, String) = {
            let conn = db.conn_lock()?;
            let mut stmt =
                conn.prepare("SELECT title, content FROM notes WHERE id = ?1 AND is_deleted = 0")?;
            stmt.query_row([note_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|_| AppError::NotFound(format!("笔记 {} 不存在", note_id)))?
        };

        let parent = Path::new(parent_dir);
        std::fs::create_dir_all(parent)?;

        let safe_title = sanitize_filename(&title);
        let basename = if safe_title.is_empty() {
            format!("note-{}", note_id)
        } else {
            safe_title
        };

        // 包一层目录：{parent_dir}/{basename}/
        let folder_name = unique_dir_name(parent, &basename);
        let root_dir = parent.join(&folder_name);
        std::fs::create_dir_all(&root_dir)?;

        let file_path = root_dir.join(format!("{}.md", basename));

        let canon_root = instance_data_dir
            .canonicalize()
            .unwrap_or_else(|_| instance_data_dir.to_path_buf());

        // 资产目录统一叫 assets/（包了目录后命名可以更简洁）
        let (rewritten, copied) =
            rewrite_assets_for_export(&content, &root_dir, "assets", &canon_root);
        std::fs::write(&file_path, rewritten)?;

        Ok(SingleExportResult {
            root_dir: root_dir.to_string_lossy().to_string(),
            file_path: file_path.to_string_lossy().to_string(),
            assets_copied: copied,
        })
    }
}

/// 构建文件夹的完整路径（递归拼接父级）
fn build_folder_path(
    folder_id: i64,
    names: &HashMap<i64, String>,
    parents: &HashMap<i64, Option<i64>>,
) -> String {
    let mut parts = Vec::new();
    let mut current = Some(folder_id);

    while let Some(id) = current {
        if let Some(name) = names.get(&id) {
            parts.push(sanitize_filename(name));
            current = parents.get(&id).copied().flatten();
        } else {
            break;
        }
    }

    parts.reverse();
    if parts.is_empty() {
        "未分类".to_string()
    } else {
        parts.join(std::path::MAIN_SEPARATOR_STR)
    }
}

/// 文件名安全化：移除不合法字符
fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = sanitized.trim().to_string();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed
    }
}

// ───────── 资产导出（图片 + 附件） ─────────

/// 把笔记 content 中所有指向本地资产的 URL 拷贝到 `<export_dir>/<basename>.assets/`，
/// 并把 URL 重写为相对路径。返回 `(新 content, 实际拷贝的资产数)`
///
/// 处理范围：
/// - 图片：`http(s)://asset.localhost/...` 或 `asset://localhost/...`（Tauri convertFileSrc 输出）
/// - 附件：`file:///...`（编辑器拖入附件时以此协议插入）
///
/// 安全策略：仅拷贝 `instance_data_dir` 之下的文件（防越权读取系统文件）；
/// 同一物理路径在同一笔记里多次出现只拷一份；多张同名不同路径的资产自动加序号去重。
fn rewrite_assets_for_export(
    content: &str,
    export_dir: &Path,
    assets_subdir: &str,
    canon_instance_root: &Path,
) -> (String, usize) {
    let spans = extract_md_url_spans(content);
    if spans.is_empty() {
        return (content.to_string(), 0);
    }

    let assets_dir = export_dir.join(assets_subdir);
    let mut copied = 0usize;
    let mut path_to_relative: HashMap<PathBuf, String> = HashMap::new();
    let mut taken_names: HashSet<String> = HashSet::new();
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();

    for (start, end, url) in spans {
        let abs = match crate::services::asset_path::resolve_content_url(&url, canon_instance_root) {
            Some(p) => p,
            None => continue, // 远程链接 / 未识别协议，原样保留
        };
        let canon_abs = match abs.canonicalize() {
            Ok(p) => p,
            Err(_) => continue, // 文件不存在，原样保留
        };
        // 安全：只允许实例数据目录下的文件
        if !canon_abs.starts_with(canon_instance_root) {
            continue;
        }

        let relative = if let Some(rel) = path_to_relative.get(&canon_abs) {
            rel.clone()
        } else {
            // 首次出现 → 拷贝
            if std::fs::create_dir_all(&assets_dir).is_err() {
                continue;
            }
            let original_name = canon_abs
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "asset".to_string());
            let unique = unique_file_name(&original_name, &mut taken_names);
            let dest = assets_dir.join(&unique);
            if std::fs::copy(&canon_abs, &dest).is_err() {
                continue;
            }
            copied += 1;
            // markdown 标准用正斜杠
            let rel = format!("{}/{}", assets_subdir, unique);
            path_to_relative.insert(canon_abs.clone(), rel.clone());
            rel
        };
        replacements.push((start, end, relative));
    }

    // 倒序应用替换，避免下标错位
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut new_content = content.to_string();
    for (s, e, rel) in replacements {
        new_content.replace_range(s..e, &rel);
    }

    (new_content, copied)
}

/// 扫描 content 中所有 URL 字节范围（图片/链接/HTML 属性）
///
/// 覆盖三种形式：
/// 1. Markdown 标准 `](url)` —— 图片和链接
/// 2. HTML 属性 `src="url"` / `src='url'` —— `<img>` 标签（tiptap-extension-resize-image 走这条路）
/// 3. HTML 属性 `href="url"` / `href='url'` —— HTML `<a>` 标签
///
/// 返回 `(url 起始字节, url 结束字节(不含终止符), 原始 url 字符串)`
fn extract_md_url_spans(content: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    out.extend(scan_paren_urls(content));
    out.extend(scan_attr_urls(content, b"src"));
    out.extend(scan_attr_urls(content, b"href"));
    // 按 start 排序，重叠的留第一个（理论上不会重叠，但保险）
    out.sort_by_key(|&(s, _, _)| s);
    let mut dedup = Vec::with_capacity(out.len());
    let mut last_end = 0usize;
    for span in out {
        if span.0 >= last_end {
            last_end = span.1;
            dedup.push(span);
        }
    }
    dedup
}

/// 扫 markdown `](url)` 模式
fn scan_paren_urls(content: &str) -> Vec<(usize, usize, String)> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b'(' {
            let url_start = i + 2;
            let mut j = url_start;
            while j < bytes.len() && bytes[j] != b')' && bytes[j] != b'\n' && bytes[j] != b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b')' {
                if let Ok(url) = std::str::from_utf8(&bytes[url_start..j]) {
                    out.push((url_start, j, url.to_string()));
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 扫 HTML 属性 `name="url"` 或 `name='url'`（忽略属性名前后的空白）
/// 要求属性名前是 ASCII 空白/`<`，避免 css `background-image: url(...)` 之类误判
fn scan_attr_urls(content: &str, attr_name: &[u8]) -> Vec<(usize, usize, String)> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + attr_name.len() + 3 < bytes.len() {
        // 位置 i 起必须是属性名
        if &bytes[i..i + attr_name.len()] == attr_name {
            // 属性名前必须是空白或 '<'（确保是标签属性，不是普通文本一部分）
            let prev_ok = i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b'<');
            let mut k = i + attr_name.len();
            // 允许等号前后的空白
            while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                k += 1;
            }
            if prev_ok && k < bytes.len() && bytes[k] == b'=' {
                k += 1;
                while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                    k += 1;
                }
                if k < bytes.len() && (bytes[k] == b'"' || bytes[k] == b'\'') {
                    let quote = bytes[k];
                    let url_start = k + 1;
                    let mut j = url_start;
                    while j < bytes.len() && bytes[j] != quote && bytes[j] != b'\n' {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == quote {
                        if let Ok(url) = std::str::from_utf8(&bytes[url_start..j]) {
                            out.push((url_start, j, url.to_string()));
                        }
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// 解决目录重名：在 `parent` 下找一个尚未存在的目录名（首选 `base`，否则 `base_1`、`base_2`...）
fn unique_dir_name(parent: &Path, base: &str) -> String {
    if !parent.join(base).exists() {
        return base.to_string();
    }
    for n in 1..10_000 {
        let candidate = format!("{}_{}", base, n);
        if !parent.join(&candidate).exists() {
            return candidate;
        }
    }
    base.to_string()
}

/// 解决文件名重名：第一次直接用，再次出现加 `_1`、`_2` 后缀
fn unique_file_name(name: &str, taken: &mut HashSet<String>) -> String {
    if taken.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(p) => (&name[..p], &name[p..]),
        None => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name.to_string()
}
