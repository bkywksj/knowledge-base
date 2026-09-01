//! T-014 网页剪藏：直连原网页 → readability 提取正文 → markdown
//!
//! # v2 改造背景（为什么不再默认走 r.jina.ai）
//!
//! v1 把 URL 加 `https://r.jina.ai/` 前缀交给 Jina Reader 代抓。这条路现在两头都堵死了：
//! - **桌面端**：Jina 取消了匿名免费额度，无 Key 请求直接 401；
//! - **移动端**：国内移动网络直连 r.jina.ai 常常连不上，连 401 都拿不到，
//!   `send()` 直接报错（用户反馈的「剪藏失败: 请求 Jina Reader 失败」即此）。
//!
//! 而实测目标站本身（含 mp.weixin.qq.com）直连返回 200 完全正常——绕道第三方
//! 反而成了唯一的失败点。故 v2 改为：
//!
//! ```text
//! reqwest（rustls，已有）直连原页 → 编码嗅探 → 懒加载图片修正 → 噪音容器预裁剪
//!   → dom_smoothie(readability) 提正文 → html2md 转 markdown
//! ```
//!
//! 其中「噪音容器预裁剪」是后加的一步：readability 按文字密度打分，对图多字少的页面
//! （设计站作品页、图集）会把「相关推荐」区当成正文圈进来，连带上百张缩略图被下载落盘。
//! 详见 [`NOISE_SELECTORS`] 与 [`MIN_TRUSTED_PRUNED_CHARS`]。
//!
//! 好处：不经第三方、无 API Key、无额度限制、离线内网页面也能抓，且没有引入新的
//! 网络栈（reqwest+rustls 移动端已验证可用）。
//!
//! Jina 降级为**可选兜底**：仅当用户在设置里填了 API Key，且直连路径失败时才启用。

use std::time::Duration;

use crate::error::AppError;
use crate::services::http_client;
use crate::services::url_safety;
use dom_smoothie::Readability;

/// 手动跟随重定向的最大跳数。
///
/// 正常短链最多两三跳；给到 5 已经宽松，再多基本是跳转陷阱。
const MAX_REDIRECTS: usize = 5;

/// Jina Reader 的代理前缀（仅兜底路径使用）
const JINA_READER_PREFIX: &str = "https://r.jina.ai/";

/// Jina API Key 在 `app_config` 表里的键名。
///
/// 存 app_config 而非 settings.json：它属于"后端抓取时才用得到"的凭据，
/// 前端只在设置页写一次，没必要进全量设置同步。
pub const JINA_KEY_CONFIG: &str = "web_clip_jina_key";

/// 伪装成桌面 Chrome 的 UA。
///
/// 不少站点（尤其微信公众号 / 知乎 / CSDN）对 reqwest 默认 UA 直接 403 或返回
/// 「请在微信客户端打开」的壳页面，拿不到正文。与 `import_attachments.rs` 里
/// 下载外链图片时用的 UA 保持一致。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// 单页抓取超时。移动端弱网下 30s 已经够久，再长用户只会以为卡死。
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// 页面 HTML 体积上限 8 MiB。
///
/// 正常文章页 HTML 撑死几百 KB；超过这个量级基本是把整站塞进单页的异常情况，
/// 继续读只会吃满内存（移动端尤其敏感），直接截断即可——readability 只关心正文。
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// 判定「确实提取到正文」的最小字符数。
///
/// 取 32 是保守值：短公告 / 短说明页仍能通过，而导航页残渣（`[首页](/)` 这类）会被挡下。
const MIN_CONTENT_CHARS: usize = 32;

/// 判定「预裁剪结果可信、无需再跑未裁剪版对照」的最小字符数。
///
/// 预裁剪偶尔会把正文本身删掉（正文被包在 `<header>` 里，或容器 class 带 nav/header 字样）。
/// 这时 readability 不会直接失败，而是退而抠出一堆导航链接充当正文——长度不至于低到
/// 触发 [`MIN_CONTENT_CHARS`]，内容却已经是残渣。实测 MDN 文档页裁剪后只剩 40 字符的
/// 「跳转到主要内容」，GitHub 仓库页只剩 325 字符的 star/fork 链接，都属此类。
///
/// 故在 32 之上再设一道信任线：低于它就必须跑一次未裁剪版做对照，按长度差决定用哪个。
/// 取 600 是因为实测正常正文都在千字符量级（站酷作品页 1271、36氪 1039），
/// 而误删后的导航残渣都在数百以内，两者之间有明显间隔。
///
/// 这条线的误判方向是**安全**的：真正的短文被卷进对照流程，最坏结果也只是多留了噪音，
/// 不会丢失正文。
const MIN_TRUSTED_PRUNED_CHARS: usize = 600;

/// 剪藏结果：标题 + 正文 markdown + 原 URL（供笔记 metadata 用）
#[derive(Debug, Clone)]
pub struct ClippedPage {
    pub title: String,
    pub markdown: String,
    pub source_url: String,
}

/// 剪藏单个网页。
///
/// `jina_key`：用户在设置里配置的 Jina Reader API Key（可空）。为空时只走直连路径；
/// 非空时，直连失败会再试一次 Jina 兜底（两条路都失败则把两个原因一并报给用户）。
pub async fn fetch_page(url: &str, jina_key: Option<&str>) -> Result<ClippedPage, AppError> {
    let url = validate_url(url)?;

    let local_err = match fetch_direct(&url).await {
        Ok(page) => return Ok(page),
        Err(e) => e,
    };

    // 直连失败 → 看有没有配 Jina Key 可兜底
    let key = jina_key.map(str::trim).filter(|k| !k.is_empty());
    let Some(key) = key else {
        return Err(local_err);
    };

    log::warn!("[web-clip] 直连抓取失败，改用 Jina 兜底：{}", local_err);
    fetch_via_jina(&url, key).await.map_err(|jina_err| {
        AppError::Custom(format!(
            "直连抓取失败（{}）；Jina 兜底同样失败（{}）",
            local_err, jina_err
        ))
    })
}

/// 校验并规整 URL。
///
/// 只做**静态**校验（协议 / userinfo / 本机地址 / IP 字面量）：这里是入口处的快速拒绝，
/// 真正的 DNS 解析校验在 `fetch_html` 里逐跳做 —— 因为重定向目标同样需要校验，
/// 只在入口查一次挡不住 302 到内网。
fn validate_url(url: &str) -> Result<String, AppError> {
    url_safety::validate_url(url).map(|u| u.to_string())
}

// ─── 直连路径（主路径）────────────────────────────────────

/// 直连原网页并提取正文
async fn fetch_direct(url: &str) -> Result<ClippedPage, AppError> {
    let (html, final_url) = fetch_html(url).await?;
    extract_article(&html, &final_url)
}

/// 抓原始 HTML；返回 `(解码后的 HTML, 重定向后的最终 URL)`
///
/// 最终 URL 要回传：短链 / 跳转页很常见，用最终 URL 做 readability 的 base
/// 才能把页内相对链接正确补全成绝对地址。
async fn fetch_html(url: &str) -> Result<(String, String), AppError> {
    // 逐跳自己走重定向：客户端禁用了自动跟随，每一跳都要重新过 SSRF 校验。
    // 若沿用默认的自动跟随，一个公网短链 302 到 http://127.0.0.1:8080/ 就能绕过全部防护。
    let mut current = url.to_string();
    let mut visited: Vec<String> = Vec::new();
    let resp = loop {
        let (validated, _ips) = url_safety::validate_url_with_dns(&current).await?;
        let normalized = validated.to_string();

        // 循环跳转（A→B→A）会一直耗到跳数上限，直接判定并给出可读原因
        if visited.iter().any(|v| v == &normalized) {
            return Err(AppError::Custom("该链接在重定向中循环跳转".into()));
        }
        visited.push(normalized);
        if visited.len() > MAX_REDIRECTS + 1 {
            return Err(AppError::Custom(format!(
                "重定向次数过多（超过 {} 次）",
                MAX_REDIRECTS
            )));
        }

        let resp = http_client::shared_guarded()
            .get(validated.clone())
            .header(reqwest::header::USER_AGENT, BROWSER_UA)
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("访问网页失败：{}", friendly_reqwest_err(&e))))?;

        // 3xx + Location → 解析成绝对地址后进入下一轮校验
        if resp.status().is_redirection() {
            match redirect_target(&resp, &validated) {
                Some(next) => {
                    log::debug!("[web-clip] 重定向 {} → {}", validated, next);
                    current = next;
                    continue;
                }
                // 3xx 但没有可用的 Location：当普通响应处理，走下面的状态码分支报错
                None => break resp,
            }
        }
        break resp;
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Custom(describe_http_status(status.as_u16())));
    }

    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase());

    // 非 HTML（PDF / 图片 / JSON 等）提前拒掉：readability 对它们只会产出垃圾，
    // 明确告诉用户"这不是网页"比给一篇乱码笔记强。
    if let Some(ct) = &content_type {
        let is_html = ct.contains("text/html") || ct.contains("application/xhtml");
        if !is_html && !ct.contains("text/plain") {
            return Err(AppError::Custom(format!(
                "该链接不是网页（Content-Type: {}）——图片 / PDF / 视频请用「导入文件」功能",
                ct.split(';').next().unwrap_or(ct).trim()
            )));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取网页内容失败：{}", friendly_reqwest_err(&e))))?;

    if bytes.is_empty() {
        return Err(AppError::Custom(
            "网页返回空内容——可能需要登录，或该页由 JS 动态渲染".into(),
        ));
    }

    let slice = if bytes.len() > MAX_HTML_BYTES {
        log::warn!(
            "[web-clip] 页面过大（{} 字节），截断到 {} 字节",
            bytes.len(),
            MAX_HTML_BYTES
        );
        &bytes[..MAX_HTML_BYTES]
    } else {
        &bytes[..]
    };

    Ok((decode_html(slice, content_type.as_deref()), final_url))
}

/// 从 3xx 响应里取出下一跳的**绝对** URL。
///
/// `Location` 常是相对路径（`/next`、`../a`），必须按当前 URL 做 base 解析成绝对地址，
/// 否则下一轮 `validate_url_with_dns` 会因为"不是合法 URL"而误报。
fn redirect_target(resp: &reqwest::Response, base: &reqwest::Url) -> Option<String> {
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)?
        .to_str()
        .ok()?
        .trim()
        .to_string();
    if location.is_empty() {
        return None;
    }
    base.join(&location).ok().map(|u| u.to_string())
}

/// 把响应字节按正确编码解成字符串。
///
/// 国内老站大量是 GBK / GB18030 / Big5，`resp.text()` 在缺 charset 时一律按 UTF-8 解，
/// 会得到满屏乱码（违反项目「中文不许乱码」的硬要求）。这里复用项目已有的
/// chardetng + encoding_rs（.txt 导入同款方案）：优先信 Content-Type 里的 charset，
/// 缺失或不认识时再嗅探。
fn decode_html(bytes: &[u8], content_type: Option<&str>) -> String {
    let declared = content_type
        .and_then(charset_from_content_type)
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()));

    let encoding = declared.unwrap_or_else(|| {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(bytes, true);
        detector.guess(None, true)
    });

    let (decoded, _, _) = encoding.decode(bytes);
    decoded.into_owned()
}

/// 从 `text/html; charset=gbk` 里抠出 `gbk`
fn charset_from_content_type(content_type: &str) -> Option<String> {
    content_type.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix("charset=")
            .map(|v| v.trim().trim_matches(['"', '\'']).to_string())
            .filter(|v| !v.is_empty())
    })
}

/// 噪音预裁剪 → readability 提正文 → markdown
///
/// 拆成独立的纯函数（不碰网络），便于单测喂固定 HTML 验证。
///
/// 走两段式：先裁掉通用噪音容器（见 [`NOISE_SELECTORS`]）再提取，结果够长就采用；
/// 偏短则说明预裁剪可能把正文也切了，再跑一次未裁剪版做长度对照，取可信的那个。
/// 判定阈值与取舍理由见 [`MIN_TRUSTED_PRUNED_CHARS`]。
pub fn extract_article(html: &str, source_url: &str) -> Result<ClippedPage, AppError> {
    if html.trim().is_empty() {
        return Err(AppError::Custom("网页内容为空".into()));
    }

    let prepared = lift_lazy_images(html);

    // 主路径：先裁掉通用噪音容器，再交给 readability
    let pruned = extract_once(&prune_noise(&prepared), source_url);

    // 裁剪结果够长 → 直接采用。绝大多数页面走到这里就返回，只跑一次 readability。
    if let Ok(page) = &pruned {
        if page.markdown.chars().count() >= MIN_TRUSTED_PRUNED_CHARS {
            return pruned;
        }
    }

    // 裁剪结果失败或偏短 → 再跑一次未裁剪版做对照，两者取可信的那个
    log::debug!("[web-clip] 预裁剪结果偏短，回退比对未裁剪 HTML");
    match extract_once(&prepared, source_url) {
        Ok(raw) => match pruned {
            // 两版长度接近 → 裁剪没切掉多少东西，用更干净的裁剪版
            Ok(p) if p.markdown.chars().count() * 2 > raw.markdown.chars().count() => Ok(p),
            // 未裁剪版明显更长 → 预裁剪多半连正文一起切了，改用未裁剪版。
            // 宁可多留噪音，也不能把正文剪没。
            _ => Ok(raw),
        },
        // 未裁剪版也提不出来 → 有裁剪版就用，否则把未裁剪版的错误报给用户
        Err(raw_err) => pruned.map_err(|_| raw_err),
    }
}

/// 单次提取：readability 提正文 → markdown → 阈值判定。
///
/// 抽成独立函数是为了让 `extract_article` 能对「预裁剪版」和「原始版」两份 HTML
/// 跑同一套逻辑，避免两条路径的判定标准出现分叉。
fn extract_once(html: &str, source_url: &str) -> Result<ClippedPage, AppError> {
    let mut readability = Readability::new(html, Some(source_url), None)
        .map_err(|e| AppError::Custom(format!("解析网页结构失败：{}", e)))?;

    let article = readability
        .parse()
        .map_err(|e| AppError::Custom(format!("提取正文失败：{}", e)))?;

    let content_html = article.content.to_string();
    let markdown = crate::services::markdown::html_to_markdown(&content_html);
    let markdown = markdown.trim().to_string();

    // 只判空还不够：readability 对导航页 / 登录墙 / 空壳页会「尽力」抠出一两个链接，
    // 结果是给用户建一篇正文只有 `[首页](/)` 的垃圾笔记。用长度阈值把这类残渣一并挡掉，
    // 让用户拿到明确的失败提示，而不是一篇需要自己回头删的空笔记。
    if markdown.chars().count() < MIN_CONTENT_CHARS {
        return Err(AppError::Custom(
            "未能提取到正文——该页可能需要登录、由 JS 动态渲染，或本身没有文章内容".into(),
        ));
    }

    let title = normalize_title(&article.title)
        .or_else(|| extract_first_heading(&markdown))
        .unwrap_or_else(|| "未命名网页".to_string());

    Ok(ClippedPage {
        title,
        markdown,
        source_url: article.url.unwrap_or_else(|| source_url.to_string()),
    })
}

/// 正文提取前整块删除的噪音容器选择器（站点无关的通用特征，不针对具体域名）。
///
/// # 为什么需要这一步
///
/// readability 按**文字密度**给容器打分，对「图多字少」的页面（设计站作品页、
/// 图集、相册）会误判：正文只有一两句简介，反而是「相关推荐」区块的文字量更大，
/// 于是整个推荐区被当成正文圈了进来。
///
/// 实测站酷作品页（`zcool.com.cn/work/*`，纯文本仅 1588 字符、文字密度 0.0032）：
/// 不裁剪时产出 32060 字符 / 121 张图，其中真正的作品图只有 4 张，其余 117 张是
/// 用户头像与推荐位缩略图——而这些图会被 `rewrite_external_images` **全部下载落盘**。
/// 加上预裁剪后是 1271 字符 / 4 张图，噪音图归零。
///
/// # 关于 `i` 标志
///
/// `[class*=xxx i]` 的 `i` 是 CSS 大小写不敏感匹配（dom_query 0.28 实测支持），
/// 所以 `workRecommend`、`recommendContentBox` 这类驼峰命名都能命中，
/// 不必为每种大小写写一条。
const NOISE_SELECTORS: &[&str] = &[
    // 语义标签：站点框架结构，正文不会长在这里
    "nav",
    "aside",
    "footer",
    "header",
    // 非内容节点：留着只会干扰 readability 打分
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    // 通用命名特征：推荐位 / 侧栏 / 评论 / 分享 / 广告
    "[class*=recommend i]",
    "[class*=related i]",
    "[class*=sidebar i]",
    "[class*=comment i]",
    "[class*=share i]",
    "[class*=advert i]",
    "[class*=banner i]",
    "[class*=header i]",
    "[class*=footer i]",
    "[class*=nav i]",
    // 视频播放器控件：不删会把 `Current Time 0:00` / `Playback Rate` 混进正文
    "[class*=video-react i]",
    "[id*=recommend i]",
    "[id*=related i]",
];

/// 按 [`NOISE_SELECTORS`] 整块摘除噪音节点，返回裁剪后的 HTML。
///
/// 失败不向上传播：这一步是**优化**而非必需，任何异常都应让流程继续走
/// 未裁剪的原始 HTML，而不是让整次剪藏失败。
fn prune_noise(html: &str) -> String {
    let doc = dom_query::Document::from(html);
    for sel in NOISE_SELECTORS {
        // try_select 返回 None 只代表本页没有匹配节点（常见情况），不是错误
        if let Some(nodes) = doc.try_select(sel) {
            nodes.remove();
        }
    }
    doc.html().to_string()
}

/// 把懒加载图片的真实地址提升到 `src`。
///
/// 微信公众号 / 知乎 / 简书等站点的 `<img>` 普遍写成
/// `<img data-src="https://mmbiz.qpic.cn/xxx" src="占位.gif">`，正文里真正的图在
/// `data-src` 上。不做这步，readability 转出来的 markdown 会是一堆占位图或空图。
///
/// 处理完仍是 https 外链，后续由 `import_attachments::rewrite_external_images`
/// 统一下载落盘（那边已带按 host 选 Referer 的防盗链绕过）。
fn lift_lazy_images(html: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    static IMG_TAG: OnceLock<Regex> = OnceLock::new();
    static LAZY_ATTR: OnceLock<Regex> = OnceLock::new();
    static SRC_ATTR: OnceLock<Regex> = OnceLock::new();

    let img_tag = IMG_TAG.get_or_init(|| Regex::new(r"(?is)<img\b[^>]*>").unwrap());
    // 常见懒加载属性名，按优先级排列（微信用 data-src，知乎用 data-original / data-actualsrc）
    let lazy_attr = LAZY_ATTR.get_or_init(|| {
        Regex::new(
            r#"(?is)\b(?:data-src|data-original|data-actualsrc|data-lazy-src|data-echo)\s*=\s*["']([^"']+)["']"#,
        )
        .unwrap()
    });
    let src_attr = SRC_ATTR.get_or_init(|| Regex::new(r#"(?is)\ssrc\s*=\s*["'][^"']*["']"#).unwrap());

    img_tag
        .replace_all(html, |caps: &regex::Captures| {
            let tag = &caps[0];
            let Some(lazy) = lazy_attr.captures(tag) else {
                return tag.to_string();
            };
            let real = lazy[1].trim();
            // 只接管真实的网络地址，跳过 base64 占位图和空值
            if real.is_empty() || real.starts_with("data:") {
                return tag.to_string();
            }
            // 先摘掉原来的占位 src，再把真实地址插到标签开头，避免同标签两个 src
            let without_src = src_attr.replace_all(tag, " ");
            without_src.replacen(
                "<img",
                &format!("<img src=\"{}\"", real.replace('"', "&quot;")),
                1,
            )
        })
        .into_owned()
}

/// 标题清洗：去空白，过滤 readability 偶尔吐出的空串
fn normalize_title(title: &str) -> Option<String> {
    let t = title.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 从 markdown 文本里抓第一个 `# H1` 当备用标题
fn extract_first_heading(md: &str) -> Option<String> {
    for line in md.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let h1 = rest.trim().to_string();
            if !h1.is_empty() {
                return Some(h1);
            }
        }
    }
    None
}

// ─── 错误信息友好化 ────────────────────────────────────

/// reqwest 的原始错误对用户没意义（一长串 hyper / rustls 内部链），转成人话。
fn friendly_reqwest_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "连接超时（30 秒）——网络不通，或对方站点响应太慢".to_string()
    } else if e.is_connect() {
        "无法建立连接——检查网络是否可用、代理设置是否正确".to_string()
    } else if e.is_redirect() {
        "重定向次数过多——该链接可能需要登录".to_string()
    } else {
        e.to_string()
    }
}

/// HTTP 状态码 → 用户能看懂的原因
fn describe_http_status(status: u16) -> String {
    match status {
        401 | 403 => format!("对方站点拒绝访问（HTTP {}）——该页可能需要登录，或有反爬校验", status),
        404 | 410 => format!("页面不存在（HTTP {}）——检查链接是否完整、是否已被删除", status),
        429 => "请求过于频繁被限流（HTTP 429）——稍等几分钟再试".to_string(),
        500..=599 => format!("对方服务器出错（HTTP {}）——稍后再试", status),
        _ => format!("网页返回异常状态：HTTP {}", status),
    }
}

// ─── Jina 兜底路径（可选，需用户配置 API Key）────────────────

/// 通过 Jina Reader 抓取（兜底路径）。
///
/// Jina 已取消匿名额度，必须带 `Authorization: Bearer <key>`，否则一律 401。
async fn fetch_via_jina(url: &str, api_key: &str) -> Result<ClippedPage, AppError> {
    let proxied = format!("{}{}", JINA_READER_PREFIX, url);

    let resp = http_client::shared()
        .get(&proxied)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", api_key),
        )
        .header(reqwest::header::ACCEPT, "text/plain")
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求 Jina Reader 失败：{}", friendly_reqwest_err(&e))))?;

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(AppError::Custom(match status {
            401 | 403 => "Jina API Key 无效或已过期——去设置里更新".to_string(),
            402 => "Jina 账户额度已用尽".to_string(),
            429 => "Jina 触发限流——稍后再试".to_string(),
            other => format!("Jina Reader 返回异常状态：HTTP {}", other),
        }));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Custom(format!("读取 Jina 响应失败：{}", e)))?;

    parse_jina_response(&body, url)
}

/// 解析 Jina Reader 返回体；纯函数便于单测
pub fn parse_jina_response(body: &str, fallback_url: &str) -> Result<ClippedPage, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::Custom(
            "Jina Reader 返回空内容（网址可能不可达）".into(),
        ));
    }

    // 头部三行结构：Title / URL Source / Markdown Content:
    // 各字段可能缺失或顺序不同，这里逐行扫，记下索引；
    // "Markdown Content:" 行下面的全部内容（直到文末）即为正文。
    let mut title: Option<String> = None;
    let mut source: Option<String> = None;
    let mut content_start: Option<usize> = None;

    let mut byte_idx = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if let Some(rest) = trimmed.strip_prefix("Title:") {
            if title.is_none() {
                title = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = trimmed.strip_prefix("URL Source:") {
            if source.is_none() {
                source = Some(rest.trim().to_string());
            }
        } else if trimmed.trim_start().starts_with("Markdown Content:") {
            // 正文从下一行开始
            content_start = Some(byte_idx + line.len());
            break;
        }
        byte_idx += line.len();
    }

    let markdown = match content_start {
        Some(idx) => body[idx..].trim().to_string(),
        None => {
            // Jina 偶尔不带 "Markdown Content:" 头，直接是正文
            body.trim().to_string()
        }
    };

    if markdown.is_empty() {
        return Err(AppError::Custom(
            "Jina Reader 返回的正文为空（页面可能纯图片 / 需 JS 渲染）".into(),
        ));
    }

    let title = title
        .filter(|s| !s.is_empty())
        .or_else(|| extract_first_heading(&markdown))
        .unwrap_or_else(|| "未命名网页".to_string());

    let source_url = source.unwrap_or_else(|| fallback_url.to_string());

    Ok(ClippedPage {
        title,
        markdown,
        source_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 直连主路径：HTML → markdown ───────────────────

    /// 构造一篇「正文 + 侧栏 + 页脚」的页面，验证 readability 只留正文。
    fn article_html(body: &str) -> String {
        format!(
            r#"<!DOCTYPE html><html><head><title>页面标题</title></head><body>
            <nav id="sidebar"><ul><li>导航一</li><li>导航二</li></ul></nav>
            <article>{}</article>
            <footer>版权所有 © 2026 某站</footer>
            </body></html>"#,
            body
        )
    }

    #[test]
    fn extract_strips_chrome_and_keeps_body() {
        // 正文要足够长，否则 readability 会认为整页都不是文章
        let body = "<h1>真正的标题</h1>".to_string()
            + &"<p>这是一段足够长的正文内容，用来让 readability 判定它是文章主体。</p>".repeat(8);
        let page = extract_article(&article_html(&body), "https://example.com/a").unwrap();

        assert!(page.markdown.contains("足够长的正文内容"));
        assert!(!page.markdown.contains("导航一"), "侧栏应被剥离");
        assert!(!page.markdown.contains("版权所有"), "页脚应被剥离");
        assert!(!page.title.trim().is_empty());
    }

    #[test]
    fn extract_empty_html_errors() {
        let err = extract_article("   ", "https://x.com").unwrap_err();
        assert!(err.to_string().contains("为空"));
    }

    #[test]
    fn extract_page_without_article_errors() {
        // 只有导航、没有正文 → 应报「未能提取到正文」而不是产出垃圾笔记。
        // readability 会从这种空壳页里抠出 `[首页](/)`，靠 MIN_CONTENT_CHARS 挡下。
        let html = "<html><body><nav><a href='/'>首页</a></nav></body></html>";
        let err = extract_article(html, "https://x.com").unwrap_err();
        assert!(err.to_string().contains("未能提取到正文"));
    }

    #[test]
    fn extract_short_but_real_article_is_kept() {
        // 阈值不能误杀真实的短文——这段正文刚过 MIN_CONTENT_CHARS
        let body = "<h1>短公告</h1><p>今天下午三点全体开会，地点在二楼会议室，请准时参加。</p>";
        let page = extract_article(&article_html(body), "https://example.com/n").unwrap();
        assert!(page.markdown.contains("二楼会议室"));
    }

    // ─── 噪音预裁剪 ───────────────────────────────────

    #[test]
    fn prune_removes_recommendation_blocks_case_insensitively() {
        // 驼峰命名（workRecommend）必须被小写选择器命中——靠的是 `[class*=... i]` 的 i 标志。
        // 这条断言若挂掉，说明 dom_query 的大小写不敏感匹配失效，
        // 选择器表就得为每种大小写各写一条。
        let html = r#"<html><body>
            <div class="workRecommend">推荐位噪音</div>
            <div class="recommendContentBox">另一块推荐</div>
            <p>真正的正文</p>
        </body></html>"#;
        let out = prune_noise(html);

        assert!(!out.contains("推荐位噪音"), "驼峰 class 的推荐区应被删除");
        assert!(!out.contains("另一块推荐"));
        assert!(out.contains("真正的正文"), "正文不能被误删");
    }

    #[test]
    fn prune_removes_whole_subtree_not_just_wrapper() {
        // 噪音容器是嵌套的：必须整棵子树摘掉，不能只删外层留下孤儿子节点
        // （这正是不用正则、改用真实 DOM 的原因）。
        let html = r#"<html><body>
            <aside class="sidebar"><div><ul><li><img src="x.jpg">侧栏深层内容</li></ul></div></aside>
            <p>正文</p></body></html>"#;
        let out = prune_noise(html);

        assert!(!out.contains("侧栏深层内容"), "嵌套子节点应一并删除");
        assert!(!out.contains("x.jpg"), "噪音区里的图片不应残留（否则会被下载落盘）");
        assert!(out.contains("正文"));
    }

    #[test]
    fn prune_removes_video_player_chrome() {
        // 播放器控件文案若不删，会混进正文变成 `Current Time 0:00` / `Playback Rate` 之类的垃圾行
        let html = r#"<div class="video-react-control-bar">Playback Rate 1.00x</div><p>正文</p>"#;
        let out = prune_noise(html);

        assert!(!out.contains("Playback Rate"));
        assert!(out.contains("正文"));
    }

    #[test]
    fn image_heavy_page_keeps_only_content_images() {
        // 复现站酷类「图多字少」页面的结构：正文 4 张图，推荐区一堆缩略图。
        // 不做预裁剪时 readability 会把推荐区当正文圈进来，导致噪音图被全部下载。
        let mut recommend = String::from(r#"<div class="workRecommend">相关推荐"#);
        for i in 0..30 {
            recommend.push_str(&format!(
                r#"<a href="/w/{i}"><img src="https://img.x/thumb{i}.jpg">推荐作品标题{i}</a>"#
            ));
        }
        recommend.push_str("</div>");

        let mut content = String::from(
            "<h1>作品标题</h1><p>这是一段作品简介，说明创作思路与展出信息，长度足够通过阈值判定。</p>",
        );
        for i in 0..4 {
            content.push_str(&format!(r#"<img src="https://img.x/work{i}.jpg"><p>作品图说明{i}</p>"#));
        }

        let html = format!(
            "<html><head><title>作品页</title></head><body><article>{content}</article>{recommend}</body></html>"
        );
        let page = extract_article(&html, "https://example.com/work/1").unwrap();

        assert_eq!(page.markdown.matches("work").count(), 4, "4 张正文图应全部保留");
        assert!(!page.markdown.contains("thumb"), "推荐位缩略图不应进入正文");
        assert!(!page.markdown.contains("推荐作品标题"), "推荐区文案不应进入正文");
        assert!(page.markdown.contains("创作思路"), "正文简介应保留");
    }

    #[test]
    fn content_wrapped_in_header_falls_back_to_unpruned() {
        // 回退兜底：正文被包在 <header> 里时，预裁剪会把它连根删掉。
        // 此时必须回退到未裁剪的 HTML 重跑，而不是报「未能提取到正文」。
        let body = "<p>这是被包在 header 元素里的正文段落，内容足够长以便通过阈值判定。</p>".repeat(6);
        let html = format!(
            r#"<html><head><title>陷阱页</title></head><body>
            <header class="article-header"><h1>真标题</h1>{body}</header>
            </body></html>"#
        );

        // 先确认预裁剪确实把正文删没了（否则这条测试没有在测回退）
        let pruned = prune_noise(&lift_lazy_images(&html));
        assert!(!pruned.contains("正文段落"), "前提：预裁剪应已删掉正文");

        // 而 extract_article 靠回退仍然能剪出内容
        let page = extract_article(&html, "https://example.com/trap").unwrap();
        assert!(page.markdown.contains("正文段落"), "回退未生效，正文丢失");
    }

    #[test]
    fn navigation_residue_does_not_replace_real_content() {
        // 回归护栏（真实案例：MDN 文档页、GitHub 仓库页）。
        // 正文容器 class 含 header 被裁掉后，readability 不会失败，而是抠出页面里
        // 残留的跳转链接充当正文——长度超过 MIN_CONTENT_CHARS，内容却全是残渣。
        // 光靠「失败或过短就回退」识别不出来，必须与未裁剪版做长度对照。
        let long_body =
            "<p>这是文档的真实正文段落，讲解具体用法与注意事项，长度足够构成一篇文章。</p>".repeat(20);
        // 用 r##"…"## 定界：正文里的 `"#content"` 会提前终结 r#"…"#
        let html = format!(
            r##"<html><head><title>文档页</title></head><body>
            <a href="#content">跳转到主要内容</a>
            <a href="#search">跳转到搜索</a>
            <a href="#nav">跳转到导航栏区域</a>
            <div class="content-header">{long_body}</div>
            </body></html>"##
        );

        // 前提校验：确认裁剪版确实落在「不失败、但短于信任线」的区间，
        // 否则这条测试就没有覆盖到长度对照那段逻辑。
        let residue = extract_once(&prune_noise(&lift_lazy_images(&html)), "https://x.com/d")
            .expect("前提：裁剪版应产出残渣而非直接失败");
        let residue_len = residue.markdown.chars().count();
        assert!(
            (MIN_CONTENT_CHARS..MIN_TRUSTED_PRUNED_CHARS).contains(&residue_len),
            "前提不成立：裁剪版长度 {residue_len} 不在 [{MIN_CONTENT_CHARS}, {MIN_TRUSTED_PRUNED_CHARS}) 区间"
        );
        assert!(!residue.markdown.contains("真实正文段落"), "前提：裁剪版应已丢失正文");

        // 实际行为：长度对照应识破残渣，改用未裁剪版
        let page = extract_article(&html, "https://x.com/d").unwrap();
        assert!(page.markdown.contains("真实正文段落"), "正文被导航残渣顶替了");
    }

    // ─── 懒加载图片修正 ───────────────────────────────

    #[test]
    fn lazy_image_data_src_is_lifted_to_src() {
        let html = r#"<img class="rich_pages" data-src="https://mmbiz.qpic.cn/real.jpg" src="placeholder.gif">"#;
        let out = lift_lazy_images(html);
        assert!(out.contains(r#"src="https://mmbiz.qpic.cn/real.jpg""#));
        assert!(!out.contains("placeholder.gif"), "占位 src 应被摘掉");
        assert_eq!(out.matches("src=").count(), 2, "只应剩 src + data-src 各一个");
    }

    #[test]
    fn lazy_image_variants_are_supported() {
        for attr in ["data-original", "data-actualsrc", "data-lazy-src"] {
            let html = format!(r#"<img {}="https://cdn.x/real.png">"#, attr);
            let out = lift_lazy_images(&html);
            assert!(
                out.contains(r#"src="https://cdn.x/real.png""#),
                "{} 未被提升",
                attr
            );
        }
    }

    #[test]
    fn plain_image_is_left_untouched() {
        let html = r#"<img src="https://cdn.x/a.png" alt="图">"#;
        assert_eq!(lift_lazy_images(html), html);
    }

    #[test]
    fn base64_placeholder_is_not_lifted() {
        // data: 占位图不该覆盖真实 src
        let html = r#"<img data-src="data:image/gif;base64,AAAA" src="https://cdn.x/a.png">"#;
        assert_eq!(lift_lazy_images(html), html);
    }

    // ─── 编码嗅探 ─────────────────────────────────────

    #[test]
    fn charset_is_parsed_from_content_type() {
        assert_eq!(
            charset_from_content_type("text/html; charset=gbk").as_deref(),
            Some("gbk")
        );
        assert_eq!(
            charset_from_content_type(r#"text/html;charset="utf-8""#).as_deref(),
            Some("utf-8")
        );
        assert_eq!(charset_from_content_type("text/html"), None);
    }

    #[test]
    fn gbk_bytes_decode_without_mojibake() {
        // "中文测试" 的 GBK 字节
        let gbk_bytes: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4,
        ];
        let decoded = decode_html(gbk_bytes, Some("text/html; charset=gbk"));
        assert_eq!(decoded, "中文测试");
    }

    #[test]
    fn utf8_bytes_decode_when_charset_missing() {
        let bytes = "中文内容足够长以便嗅探器判断编码".as_bytes();
        let decoded = decode_html(bytes, None);
        assert_eq!(decoded, "中文内容足够长以便嗅探器判断编码");
    }

    // ─── 错误信息 ─────────────────────────────────────

    #[test]
    fn http_status_messages_are_human_readable() {
        assert!(describe_http_status(403).contains("拒绝访问"));
        assert!(describe_http_status(404).contains("不存在"));
        assert!(describe_http_status(429).contains("限流"));
        assert!(describe_http_status(503).contains("服务器出错"));
    }

    #[test]
    fn validate_url_rejects_non_http() {
        assert!(validate_url("ftp://x.com").is_err());
        assert!(validate_url("").is_err());
        assert!(validate_url("  https://x.com  ").is_ok());
    }

    /// 剪藏入口必须挡住内网地址：用户可能被诱导粘贴一个指向自己路由器 / 本地服务的链接。
    /// 逐跳的重定向校验在 `fetch_html` 里，这里钉住入口这一道。
    #[test]
    fn validate_url_rejects_internal_targets() {
        for u in [
            "http://127.0.0.1:8080/admin",
            "http://localhost/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://example.com@127.0.0.1/",
            "file:///etc/passwd",
        ] {
            assert!(validate_url(u).is_err(), "{} 不该被允许剪藏", u);
        }
    }

    // ─── Jina 兜底路径解析（保留 v1 单测）───────────────

    #[test]
    fn parse_full_jina_response() {
        let body = "Title: 我的标题\nURL Source: https://example.com/a\nMarkdown Content:\n# H1\n正文一\n正文二\n";
        let r = parse_jina_response(body, "https://example.com/a").unwrap();
        assert_eq!(r.title, "我的标题");
        assert_eq!(r.source_url, "https://example.com/a");
        assert!(r.markdown.starts_with("# H1"));
        assert!(r.markdown.contains("正文二"));
    }

    #[test]
    fn parse_missing_title_falls_back_to_h1() {
        let body = "URL Source: https://x.com\nMarkdown Content:\n# 真标题\n内容\n";
        let r = parse_jina_response(body, "https://x.com").unwrap();
        assert_eq!(r.title, "真标题");
    }

    #[test]
    fn parse_no_markdown_header_treats_whole_body_as_content() {
        let body = "纯文本\n第二行\n";
        let r = parse_jina_response(body, "https://x.com").unwrap();
        assert_eq!(r.title, "未命名网页");
        assert!(r.markdown.contains("纯文本"));
        assert_eq!(r.source_url, "https://x.com");
    }

    #[test]
    fn parse_empty_body_errors() {
        let err = parse_jina_response("   \n", "https://x.com").unwrap_err();
        assert!(err.to_string().contains("空"));
    }

    #[test]
    fn parse_only_headers_no_body_errors() {
        let body = "Title: T\nMarkdown Content:\n";
        let err = parse_jina_response(body, "https://x.com").unwrap_err();
        assert!(err.to_string().contains("正文为空"));
    }
}
