//! 存量 `api_url` 修正 —— 从「自动补 /v1」切换到 ai-profile「原样使用」时的一次性规范化。
//!
//! # 为什么需要
//!
//! v1.64.0 之前的端点拼接（`services/ai.rs` 的 `build_openai_api_url`）会**推断版本段**：
//! 末段不是 `v<数字>` / `v<数字.数字>` 就自动补 `/v1`，末尾加 `#` 可以禁止补。
//! 用户存下的 `api_url` 是原始输入（比如 `https://api.deepseek.com`、Ollama 的
//! `http://localhost:11434`），靠这条推断才能用。
//!
//! 模型服务改由 ai-profile crate 提供后，规则变成**原样使用、绝不推断**。直接切换的话，
//! 存量的裸根地址全部 404，用户看不出原因。所以切换前把「旧规则会补的那一段」写进数据：
//! 修正后 crate 拼出的地址与旧规则拼出的**逐字相同**（见对照测试）。
//!
//! # 在哪调用（只对旧来源）
//!
//! | 入口 | 为什么 |
//! |---|---|
//! | schema v62 | 升级时修正已存配置；整库恢复（ZIP / WebDAV / `.bak`）后也会跑到迁移 |
//! | 配置导入（`kbConfig` 信封） | 旧版本导出的配置里是未修正的地址；信封没有 `apiUrlVerbatim` 标记 = 旧来源 |
//!
//! 🔴 **只对旧来源做**：新版本里用户按「原样使用」填的地址（刻意不带版本段）是正确数据，
//! 再过一遍修正会被错补 `/v1`。ai.profile 是跨软件协议，按 crate 语义原样使用，不修正。
//!
//! # 🔴 这段逻辑不进 ai-profile
//!
//! 它是本项目的历史包袱，不是通用知识。reeve 有一份形状相近的，但**旧规则不同**
//! （本项目把 `v1.5` 这类带小数的也算版本段；只认 `/chat/completions` 这一种完整端点），
//! 不能共用。
//!
//! # 幂等
//!
//! 修正后的地址要么以 `#` 结尾、要么带版本段、要么是完整端点，再过一遍不会变。
//! 带 `#` 的**原样保留 `#`**：去掉的话 `…/v1beta/openai#` 变成 `…/v1beta/openai`，
//! 再修一次就被补成 `…/openai/v1`（404）。crate 拼地址时本来就会剥掉末尾的 `#`。

/// 把一个存量 `api_url` 规范成「crate 原样使用也能得到旧行为」的形式。
///
/// | 输入 | 输出 | 理由 |
/// |---|---|---|
/// | 空 / 纯空白 | 空串 | 与旧行为一致（没有地址就没有请求） |
/// | 末尾带 `#` | **原样保留**（含 `#`） | 旧语义「锁定不补」= 新规则本来就不补；保留 `#` 才幂等 |
/// | 完整对话端点（`…/chat/completions`） | 去掉末尾 `/` | 旧规则与 crate 都原样直通 |
/// | 末段已是版本段（`v1`、`v4`、`v1.5`） | 去掉末尾 `/` | 旧规则不补 |
/// | 其余（含 Ollama 的 `http://localhost:11434`） | 追加 `/v1` | 旧规则会补，把它写进数据 |
pub fn normalize_legacy_api_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with('#') {
        return trimmed.to_string();
    }
    let base = trimmed.trim_end_matches('/');
    if base.ends_with("/chat/completions") || legacy_has_version_segment(base) {
        return base.to_string();
    }
    format!("{base}/v1")
}

/// 旧厂商 id → ai-profile 预置 key。
///
/// v1.64.0 之前 `ai_models.provider` 存的是本项目自己的 24 个厂商 id；接入后改存 crate 的
/// 预置 key（下拉、反推模板、限额都按它查）。这张表只给迁移与旧配置导入用。
///
/// | 旧 id | 新 key | 说明 |
/// |---|---|---|
/// | `kimi` / `doubao` / `openai` | `moonshot` / `volcengine_ark` / `openai_official` | 改名 |
/// | `claude` | 自定义 | 本项目没有 Anthropic 原生对话，一直走 Anthropic 的 OpenAI 兼容端点；地址不变 |
/// | `hunyuan` | 自定义 | 混元老地址已停止上新模型，crate 引导走 TokenHub（密钥不通用，不能硬映射过去） |
/// | `lingyi` | 自定义 | 零一万物 API 已停服，crate 没收 |
/// | 其余同名的 | 原样 | |
/// | 未知 | 自定义 | 宁可落到「自定义」也不要存一个 crate 不认识的 key |
pub fn legacy_provider_key(old: &str) -> &'static str {
    match old.trim() {
        "kimi" => "moonshot",
        "doubao" => "volcengine_ark",
        "openai" => "openai_official",
        "deepseek" => "deepseek",
        "zhipu" => "zhipu",
        "qwen" => "qwen",
        "siliconflow" => "siliconflow",
        "minimax" => "minimax",
        "qianfan" => "qianfan",
        "stepfun" => "stepfun",
        "baichuan" => "baichuan",
        "mimo" => "mimo",
        "gemini" => "gemini",
        "xai" => "xai",
        "groq" => "groq",
        "together" => "together",
        "openrouter" => "openrouter",
        "ollama" => "ollama",
        "lmstudio" => "lmstudio",
        "vllm" => "vllm",
        _ => ai_profile::preset::CUSTOM_PRESET_KEY,
    }
}

/// 旧规则对「版本段」的判定：末段以 `v` 开头、后面全是数字或小数点。
///
/// 与 crate 的 `ends_with_version_segment`（只认全数字）不同 —— 修正要复现的是
/// **本项目当初怎么解释用户数据**，所以用自己的旧口径。
fn legacy_has_version_segment(base: &str) -> bool {
    base.rsplit('/').next().is_some_and(|seg| {
        seg.starts_with('v')
            && seg.len() > 1
            && seg[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ai_profile::endpoint::{join_api_path, join_chat_endpoint};

    // ── 旧规则的冻结副本 ────────────────────────────────────────────────
    //
    // 🔴 逐字复制自 v1.64.0 的 `src-tauri/src/services/ai.rs`（build_openai_api_url /
    //    strip_chat_endpoint / build_openai_chat_url）。本地实现切换到 crate 后原函数会被删掉，
    //    这份副本是对照测试的唯一基准 —— **不要改它**，它代表用户数据当初被怎么解释。

    fn legacy_build_openai_api_url(api_url: &str, path: &str) -> String {
        let trimmed = api_url.trim();
        let pinned = trimmed.ends_with('#');
        let base = legacy_strip_chat_endpoint(trimmed.trim_end_matches('#').trim_end_matches('/'));
        let has_version_segment = base.rsplit('/').next().is_some_and(|seg| {
            seg.starts_with('v')
                && seg.len() > 1
                && seg[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
        });
        if pinned || has_version_segment {
            format!("{}/{}", base, path)
        } else {
            format!("{}/v1/{}", base, path)
        }
    }

    fn legacy_strip_chat_endpoint(base: &str) -> &str {
        base.strip_suffix("chat/completions")
            .map(|rest| rest.trim_end_matches('/'))
            .unwrap_or(base)
    }

    fn legacy_build_openai_chat_url(api_url: &str) -> String {
        let base = api_url.trim().trim_end_matches('#').trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            return base.to_string();
        }
        legacy_build_openai_api_url(api_url, "chat/completions")
    }

    /// 存量配置里可能出现的写法。前几条取自 v1.64.0 的 URL 规则测试（`ai.rs` remote_model_list_tests）。
    const SAMPLES: &[&str] = &[
        "https://api.anthropic.com/v1",
        "https://api.openai.com/v1/",
        "https://api.deepseek.com",           // 裸根：旧规则补 /v1
        "https://api.deepseek.com/",          // 裸根 + 末尾斜杠
        "  https://api.deepseek.com  ",       // 前后空白
        "https://x.test/v1beta",              // v1beta 不算版本段：旧规则补 /v1
        "https://x.test/v1.5",                // 🔴 带小数的版本段：本项目旧规则不补
        "https://generativelanguage.googleapis.com/v1beta/openai#", // Gemini 预置（带 #）
        "https://generativelanguage.googleapis.com/v1beta/openai",  // 手填 Gemini 没带 #
        "https://proxy.test/v1/chat/completions",                   // 完整端点
        "https://proxy.test/openai/chat/completions#",              // 完整端点 + #
        "https://open.bigmodel.cn/api/paas/v4", // 智谱 /v4
        "https://ark.cn-beijing.volces.com/api/v3",
        "https://qianfan.baidubce.com/v2",
        "http://localhost:11434",             // Ollama 预置：5 个非流式功能靠补 /v1 才走得通
        "http://localhost:1234/v1",           // LM Studio
        "https://relay.example.com/api",      // 中转站自定义前缀
        "https://v4.example.com",             // 主机名像版本段：旧规则仍补 /v1
    ];

    /// 🔴 核心判据：修正后交给 crate，对话端点与旧规则**逐字相同**。
    #[test]
    fn chat_endpoint_unchanged_after_normalize() {
        for raw in SAMPLES {
            let fixed = normalize_legacy_api_url(raw);
            assert_eq!(
                join_chat_endpoint(&fixed, "chat/completions"),
                legacy_build_openai_chat_url(raw),
                "对话端点变了：{raw:?} → 修正为 {fixed:?}"
            );
        }
    }

    /// 「获取模型」端点同样逐字相同 —— 唯一已知例外见下一个测试。
    #[test]
    fn models_endpoint_unchanged_after_normalize() {
        for raw in SAMPLES {
            if is_full_endpoint_without_version(raw) {
                continue;
            }
            let fixed = normalize_legacy_api_url(raw);
            assert_eq!(
                join_api_path(&fixed, "models"),
                legacy_build_openai_api_url(raw, "models"),
                "获取模型端点变了：{raw:?} → 修正为 {fixed:?}"
            );
        }
    }

    fn is_full_endpoint_without_version(raw: &str) -> bool {
        let t = raw.trim();
        if t.ends_with('#') {
            return false; // 带 # 的旧规则不补，crate 也不补，一致
        }
        let b = t.trim_end_matches('/');
        let base = legacy_strip_chat_endpoint(b);
        base != b && !legacy_has_version_segment(base)
    }

    /// 已知且接受的唯一差异：**完整对话端点、且端点前没有版本段**（`https://x/chat/completions`）。
    ///
    /// 同一个存储值满足不了两种旧行为：旧规则对话直通 `x/chat/completions`，拉模型却拼
    /// `x/v1/models`。保对话（用户正在用的），拉模型改为 `x/models`；真拉不到时用户改一下地址即可。
    #[test]
    fn full_endpoint_without_version_keeps_chat_only() {
        let raw = "https://relay.example.com/chat/completions";
        let fixed = normalize_legacy_api_url(raw);
        assert_eq!(
            join_chat_endpoint(&fixed, "chat/completions"),
            legacy_build_openai_chat_url(raw)
        );
        assert_eq!(join_api_path(&fixed, "models"), "https://relay.example.com/models");
        assert_eq!(
            legacy_build_openai_api_url(raw, "models"),
            "https://relay.example.com/v1/models"
        );
    }

    /// 修正函数必须幂等：迁移中途被打断重跑、旧备份反复恢复都不能越修越错。
    #[test]
    fn normalize_is_idempotent() {
        for raw in SAMPLES.iter().chain(["", "   ", "https://relay.example.com/chat/completions"].iter()) {
            let once = normalize_legacy_api_url(raw);
            assert_eq!(normalize_legacy_api_url(&once), once, "不幂等：{raw:?}");
        }
    }

    /// 🔴 映射出的 key 必须真实存在于 crate 预置里，且协议是本项目能说的 OpenAI 兼容 ——
    /// 存一个 crate 不认识的 key，下拉回填、限额查询会静默落空。
    #[test]
    fn legacy_provider_keys_exist_in_crate() {
        let old_ids = [
            "ollama", "lmstudio", "vllm", "deepseek", "zhipu", "qwen", "doubao", "kimi",
            "siliconflow", "minimax", "qianfan", "hunyuan", "stepfun", "baichuan", "lingyi",
            "mimo", "openai", "claude", "gemini", "xai", "groq", "together", "openrouter",
            "custom", "something-unknown",
        ];
        for old in old_ids {
            let key = legacy_provider_key(old);
            let p = ai_profile::preset_by_key(key)
                .unwrap_or_else(|| panic!("{old} → {key} 不在 crate 预置里"));
            assert_eq!(
                p.protocol,
                ai_profile::Protocol::OpenAiCompatible,
                "{old} → {key} 不是 OpenAI 兼容协议，本项目说不了"
            );
        }
    }

    #[test]
    fn concrete_outputs() {
        assert_eq!(normalize_legacy_api_url("http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize_legacy_api_url("https://api.deepseek.com/"), "https://api.deepseek.com/v1");
        assert_eq!(normalize_legacy_api_url("https://x.test/v1.5"), "https://x.test/v1.5");
        assert_eq!(normalize_legacy_api_url("https://x.test/v1beta"), "https://x.test/v1beta/v1");
        assert_eq!(
            normalize_legacy_api_url("https://generativelanguage.googleapis.com/v1beta/openai#"),
            "https://generativelanguage.googleapis.com/v1beta/openai#"
        );
        assert_eq!(normalize_legacy_api_url("  "), "");
    }
}
