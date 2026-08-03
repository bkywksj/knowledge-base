//! 资产相对路径工具：在绝对路径与"相对 instance_dir 的 POSIX 路径"之间转换。
//!
//! 笔记 content 里的素材 src 永远存为 `kb-asset://<rel>`，`<rel>` 是这里输出的形式。
//! 数据目录可被用户在运行期更换（见 `services::data_dir`），所以绝对路径不能直接落 DB。

use std::path::{Component, Path, PathBuf};

/// 已知的资产子目录。绝对路径若在 instance_dir 下解析不出，
/// 就 fallback 到"找这些段名"的截取策略（用于历史绝对路径迁移到不同 OS / 不同 data_dir 的情况）。
pub(crate) const KNOWN_ASSET_SEGMENTS: &[&str] = &[
    "kb_assets",
    "dev-kb_assets",
    "pdfs",
    "dev-pdfs",
    "sources",
    "dev-sources",
    "attachments",
    "dev-attachments",
];

/// 把绝对路径转成相对 `data_dir` 的 POSIX 风格相对路径。
///
/// 优先策略：纯 `strip_prefix(data_dir)` + 把 `\` 换成 `/`。
/// 失败时（路径不在 data_dir 下，比如老笔记里写的是另一台机器/旧 data_dir 的绝对路径）
/// 走 fallback：扫已知资产段名，从该段开始截。
///
/// 返回 `None` 表示既不在 data_dir 下，也找不到任何已知资产段（无法判定相对路径）。
pub fn abs_to_rel(absolute: &Path, data_dir: &Path) -> Option<String> {
    // ⚠️ `data_dir` 为空时**必须**跳过 strip_prefix：`Path::new("")` 的 components 是空迭代器，
    // `Path::new("C:/x/kb_assets/a.png").strip_prefix("")` 返回 `Ok("C:/x/kb_assets/a.png")`
    // —— 整个绝对路径被原样当成"相对路径"返回。
    //
    // 这曾让 v29 迁移的 fallback 分支从未生效：它传的就是 `Path::new("")` 作 dummy，
    // 于是把 `http://asset.localhost/C:/…/kb_assets/x.png` 转成
    // `kb-asset://C:/…/kb_assets/x.png`（rel 里含绝对路径）。前端 `resolveAssetSrc`
    // 会无条件 `dataDir + "/" + rel` → 拼出 `…/com.agilefr.kb/C:/…/kb_assets/x.png` → 裂图。
    //
    // 同理再加一道保险：strip 之后若结果仍是绝对路径，也不接受，落到下面按段名截取。
    if !data_dir.as_os_str().is_empty() {
        if let Ok(rel) = absolute.strip_prefix(data_dir) {
            if !rel.is_absolute() && rel.as_os_str().len() > 0 {
                return Some(to_posix(rel));
            }
        }
    }
    // fallback：遍历 components 找已知资产段
    let comps: Vec<Component<'_>> = absolute.components().collect();
    for (i, c) in comps.iter().enumerate() {
        if let Component::Normal(name) = c {
            if let Some(name_str) = name.to_str() {
                if KNOWN_ASSET_SEGMENTS.contains(&name_str) {
                    let tail: PathBuf = comps[i..].iter().map(|c| c.as_os_str()).collect();
                    return Some(to_posix(&tail));
                }
            }
        }
    }
    None
}

/// 把笔记 content / 渲染产物里出现的素材 URL 解析为本地绝对路径。
///
/// 识别的形态（按优先级）：
/// - `kb-asset://<rel>` —— 当前唯一会写进 content 的形态，`<rel>` 相对 `data_dir`
/// - `file://<abs>` —— 老笔记拖入附件用过的协议（Windows 上是 `file:///E:/...`）
/// - `asset://localhost/<abs>` / `asset://<abs>` —— Tauri 运行期形态
/// - `http://asset.localhost/<abs>` / `https://asset.localhost/<abs>` —— `convertFileSrc` 运行期输出
/// - 裸绝对路径（`C:\...` / `/home/...`）—— 很早期写法
/// - 裸相对路径 —— 相对 `data_dir` 解析
///
/// 返回 `None`：真·外链（`http(s)://` / `ftp://` 等非 asset.localhost）、`data:` / `blob:`、
/// 页内锚点 `#...`、`mailto:` / `tel:`、空串、解码失败。
///
/// 注意：**不**校验文件是否存在，也**不**做"必须在 data_dir 下"的安全校验 ——
/// 需要时由调用方自行 `canonicalize()` + `starts_with(data_dir)`。
pub fn resolve_content_url(url: &str, data_dir: &Path) -> Option<PathBuf> {
    let url = url.trim();
    if url.is_empty()
        || url.starts_with('#')
        || url.starts_with("data:")
        || url.starts_with("blob:")
        || url.starts_with("mailto:")
        || url.starts_with("tel:")
    {
        return None;
    }

    // kb-asset://<rel>：当前 content 里素材的唯一形态
    if let Some(rest) = url.strip_prefix("kb-asset://") {
        let rel = pct_decode(rest);
        return rel_to_abs(&rel, data_dir).ok();
    }

    // 带协议的"伪本地"形态：剥协议头后是（编码过的）路径
    let (body, is_file) = if let Some(r) = url.strip_prefix("http://asset.localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("https://asset.localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("asset://localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("asset://") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("file://") {
        (r, true)
    } else if url.contains("://") {
        // 其它带 scheme 的（http/https 外链、ftp...）都不是本地文件
        return None;
    } else {
        // 裸路径：绝对路径原样用（含跨机兜底）；相对路径相对 data_dir 拼
        let s = if url.contains('%') { pct_decode(url) } else { url.to_string() };
        let p = PathBuf::from(s);
        return Some(if p.is_absolute() {
            remap_foreign_asset_path(p, data_dir)
        } else {
            data_dir.join(p)
        });
    };

    // 去掉 query / fragment 再 urldecode
    let body = body.split(['?', '#']).next().unwrap_or(body);
    let decoded = pct_decode(body);
    let path_str = if is_file {
        // file:///E:/...（Windows，strip 后剩 /E:/...）；file:///home/...（POSIX，保留前导 /）
        if decoded.starts_with('/') && decoded.len() >= 3 && decoded.as_bytes()[2] == b':' {
            decoded[1..].to_string()
        } else {
            decoded
        }
    } else if decoded.len() >= 2 && decoded.as_bytes()[1] == b':' {
        // Windows 盘符：E:/foo 已是绝对路径
        decoded
    } else if decoded.starts_with('/') {
        decoded
    } else {
        // POSIX 缺前导 / 时补上（asset 协议 strip 后偶尔会丢）
        format!("/{}", decoded)
    };
    Some(remap_foreign_asset_path(PathBuf::from(path_str), data_dir))
}

/// 跨机 / 跨平台兜底：把"另一台机器的绝对路径"重映射到**本机** data_dir 下的同名资产。
///
/// 场景：笔记从 Windows 同步/拷贝到 macOS，content 里遗留
/// `file:///E:/kb/kb_assets/images/1/x.png`（v54 迁移会清洗掉大部分，但外部导入的笔记、
/// 或迁移之后又从旧端拉回来的内容仍可能出现）。这个绝对路径在 macOS 上必然不存在，
/// 而同一份文件其实已经随附件同步躺在本机 `<data_dir>/kb_assets/images/1/x.png`。
///
/// 判定极保守，四个条件全满足才重映射，避免掩盖"文件真的丢了"这类问题：
/// 1. `data_dir` 非空（迁移期传空 dummy 时不参与）
/// 2. 原路径**不存在**（存在就说明本来就对，别动）
/// 3. 原路径不在 `data_dir` 下（在里面还找不到 = 真缺文件，重映射也救不了）
/// 4. 能收敛到已知资产段，且重映射后的路径**确实存在**
fn remap_foreign_asset_path(abs: PathBuf, data_dir: &Path) -> PathBuf {
    if data_dir.as_os_str().is_empty() || abs.exists() || abs.starts_with(data_dir) {
        return abs;
    }
    let Some(rel) = abs_to_rel(&abs, data_dir) else {
        return abs;
    };
    let Ok(remapped) = rel_to_abs(&rel, data_dir) else {
        return abs;
    };
    if remapped.exists() {
        log::debug!(
            "[asset-path] 跨机路径重映射: {} → {}",
            abs.display(),
            remapped.display()
        );
        return remapped;
    }
    abs
}

fn pct_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// 把相对 POSIX 路径还原成绝对路径（拼接 data_dir）。
///
/// 不验证文件是否存在 —— 调用方按需 `metadata()`。
/// 安全：rel 含 `..` 会触发 `Err` 返回，避免逃逸 data_dir。
///
/// 注意：必须按 component 逐段 push，而不是直接 `data_dir.join(rel_path)`。
/// 否则 Windows 上会保留 rel 里的 `/`，产出 `C:\foo\kb_assets/images/x.png` 这种混合分隔符路径，
/// 把它再转成 String 喂给 `revealItemInDir` 时，Windows 的 `ILCreateFromPathW` 会拒收，
/// 报 OS error 123 "文件名、目录名或卷标语法不正确"。
pub fn rel_to_abs(rel: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        if matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("非法相对路径（含 .. 或绝对前缀）: {}", rel));
        }
    }
    let mut abs = data_dir.to_path_buf();
    for c in rel_path.components() {
        if let Component::Normal(seg) = c {
            abs.push(seg);
        }
    }
    Ok(abs)
}

/// 把 `Path` 转成 POSIX 风格字符串（`\` → `/`，剥掉 Windows verbatim 前缀）
fn to_posix(p: &Path) -> String {
    let s = p.to_string_lossy();
    // Windows 上 strip_prefix 偶尔会留下 `\\?\` 之类的 verbatim 前缀，简单处理
    let s = s.trim_start_matches(r"\\?\");
    s.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_prefix_path() {
        let data = Path::new("/tmp/kb");
        let abs = Path::new("/tmp/kb/kb_assets/images/1/x.png");
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn fallback_when_not_under_data_dir() {
        let data = Path::new("/totally/different/place");
        let abs = Path::new("C:/Users/xxx/AppData/Roaming/com.app/kb_assets/images/1/x.png");
        // 找到 "kb_assets" 段名后开始截
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn fallback_dev_prefix_segment() {
        let data = Path::new("/totally/different/place");
        let abs = Path::new("/old/data/dev-kb_assets/images/1/x.png");
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("dev-kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn unknown_path_returns_none() {
        let data = Path::new("/tmp/kb");
        let abs = Path::new("/usr/share/random/file.png");
        assert!(abs_to_rel(abs, data).is_none());
    }

    /// 回归：`data_dir` 为空（迁移里的 dummy）时必须走 fallback 按段名截，
    /// **不能**因为 `strip_prefix("")` 返回 Ok 就把整个绝对路径当相对路径。
    ///
    /// 这曾产出 `kb-asset://C:/…/kb_assets/x.png`，前端拼 dataDir 后必然裂图。
    #[test]
    fn empty_data_dir_falls_back_to_segment_scan() {
        let empty = Path::new("");

        let win = Path::new(r"C:\Users\me\AppData\Roaming\com.agilefr.kb\kb_assets\images\1\x.png");
        assert_eq!(
            abs_to_rel(win, empty).as_deref(),
            Some("kb_assets/images/1/x.png"),
            "Windows 绝对路径必须收敛到已知资产段"
        );

        let posix = Path::new("/Users/me/Library/Application Support/com.agilefr.kb/pdfs/2/a.pdf");
        assert_eq!(
            abs_to_rel(posix, empty).as_deref(),
            Some("pdfs/2/a.pdf"),
            "POSIX 绝对路径必须收敛到已知资产段"
        );

        // 不含任何已知资产段 → None（保留原样，不瞎猜）
        assert!(abs_to_rel(Path::new("/usr/share/x.png"), empty).is_none());
    }

    /// 回归：strip_prefix 命中但结果为空（abs == data_dir）不应返回空 rel
    #[test]
    fn abs_equal_to_data_dir_is_not_a_valid_rel() {
        let data = Path::new("/tmp/kb");
        assert!(abs_to_rel(Path::new("/tmp/kb"), data).is_none());
    }

    #[test]
    fn rel_to_abs_joins() {
        let data = Path::new("/tmp/kb");
        let p = rel_to_abs("kb_assets/images/1/x.png", data).unwrap();
        assert_eq!(p, Path::new("/tmp/kb/kb_assets/images/1/x.png"));
    }

    #[test]
    fn rel_to_abs_rejects_parent_dir() {
        let data = Path::new("/tmp/kb");
        assert!(rel_to_abs("../etc/passwd", data).is_err());
        assert!(rel_to_abs("kb_assets/../../etc/passwd", data).is_err());
    }

    #[test]
    fn rel_to_abs_strips_leading_slash() {
        let data = Path::new("/tmp/kb");
        let p = rel_to_abs("/kb_assets/images/1/x.png", data).unwrap();
        assert_eq!(p, Path::new("/tmp/kb/kb_assets/images/1/x.png"));
    }
}

#[cfg(test)]
mod cross_machine_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("kb_ap_{}_{}_{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 核心场景：笔记从 Windows 拷到本机，content 里是另一台机器的绝对路径，
    /// 但同名资产已随同步躺在本机 data_dir 下 → 应重映射到本机路径。
    #[test]
    fn remaps_foreign_absolute_to_local_data_dir() {
        let data = temp_dir("remap");
        let local = data.join("kb_assets").join("images").join("1");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("x.png"), b"png").unwrap();

        // 另一台机器（Windows）的绝对路径，本机必然不存在
        let foreign = r"file:///E:/other-machine/kb/kb_assets/images/1/x.png";
        let got = resolve_content_url(foreign, &data).expect("应解析出路径");
        assert_eq!(got, local.join("x.png"), "应重映射到本机同名资产");
    }

    /// 本机确实没有这份资产 → 保持原始路径，不能假装解析成功，
    /// 否则"文件真的丢了"会被掩盖成一个看似合理但不存在的本地路径。
    #[test]
    fn keeps_original_when_local_asset_missing() {
        let data = temp_dir("missing");
        let foreign = r"file:///E:/other-machine/kb/kb_assets/images/9/nope.png";
        let got = resolve_content_url(foreign, &data).expect("仍应返回一个路径");
        assert!(
            got.to_string_lossy().contains("other-machine"),
            "本机没有对应文件时应保持原路径, got = {}",
            got.display()
        );
    }

    /// 原路径本来就存在 → 一个字都不该动（不误伤正常的本机绝对路径引用）
    #[test]
    fn leaves_existing_path_untouched() {
        let data = temp_dir("exists");
        let elsewhere = temp_dir("elsewhere");
        let f = elsewhere.join("real.png");
        std::fs::write(&f, b"x").unwrap();

        let url = format!("file:///{}", f.to_string_lossy().replace('\\', "/"));
        let got = resolve_content_url(&url, &data).expect("应解析");
        assert_eq!(got, f, "已存在的路径不应被重映射");
    }

    /// 外链 / data: 等仍然返回 None（重映射不能改变这些语义）
    #[test]
    fn external_urls_still_none() {
        let data = temp_dir("ext");
        assert!(resolve_content_url("https://example.com/a.png", &data).is_none());
        assert!(resolve_content_url("data:image/png;base64,AAA", &data).is_none());
        assert!(resolve_content_url("#anchor", &data).is_none());
    }

    /// 契约测试：`asset_path` 的已知资产段必须与同步扫描器的前缀清单一一对应。
    /// 两边漂移会导致某类资产**静默漏同步**（`attachments/` 曾因此整目录没同步）。
    #[test]
    fn known_segments_match_sync_scanner_prefixes() {
        use crate::services::sync_v1::attachment_scan::KNOWN_PREFIXES;
        for seg in KNOWN_ASSET_SEGMENTS {
            let want = format!("{}/", seg);
            assert!(
                KNOWN_PREFIXES.contains(&want.as_str()),
                "attachment_scan::KNOWN_PREFIXES 缺少 {:?} —— 该目录下的附件会漏同步",
                want
            );
        }
        for p in KNOWN_PREFIXES {
            let seg = p.trim_end_matches('/');
            assert!(
                KNOWN_ASSET_SEGMENTS.contains(&seg),
                "asset_path::KNOWN_ASSET_SEGMENTS 缺少 {:?} —— 该目录的绝对路径无法收敛成相对路径",
                seg
            );
        }
    }
}
