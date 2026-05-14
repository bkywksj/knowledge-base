//! 资产相对路径工具：在绝对路径与"相对 instance_dir 的 POSIX 路径"之间转换。
//!
//! 笔记 content 里的素材 src 永远存为 `kb-asset://<rel>`，`<rel>` 是这里输出的形式。
//! 数据目录可被用户在运行期更换（见 `services::data_dir`），所以绝对路径不能直接落 DB。

use std::path::{Component, Path, PathBuf};

/// 已知的资产子目录。绝对路径若在 instance_dir 下解析不出，
/// 就 fallback 到"找这些段名"的截取策略（用于历史绝对路径迁移到不同 OS / 不同 data_dir 的情况）。
const KNOWN_ASSET_SEGMENTS: &[&str] = &[
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
    if let Ok(rel) = absolute.strip_prefix(data_dir) {
        return Some(to_posix(rel));
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
        // 裸路径：绝对路径原样用；相对路径相对 data_dir 拼
        let s = if url.contains('%') { pct_decode(url) } else { url.to_string() };
        let p = PathBuf::from(s);
        return Some(if p.is_absolute() { p } else { data_dir.join(p) });
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
    Some(PathBuf::from(path_str))
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
