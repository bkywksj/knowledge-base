//! 模型服务 —— knowledge_base 与 ai-profile crate 的接缝。
//!
//! # 职责边界
//!
//! | ai-profile crate | 本项目（这里 + `services/ai.rs`） |
//! |---|---|
//! | 预置（服务商、地址、模型候选、静态限额） | `ai_models` 表的存储、密钥加密 |
//! | 端点拼接、模型清单清洗、零成本验证 | 对话（Ollama 原生 + OpenAI 兼容 SSE） |
//! | 限额分层合并、上下文超长识别 | 上下文预算 / RAG 配额 / 历史降档阶梯 |
//! | ai.profile 解析与生成（单条 + 打包） | `kbConfig` 信封（webdav / 同步 / ASR 等本项目配置） |
//!
//! 加服务商、加模型、改默认 model → 去 ai-profile 仓库改，这里只升依赖（技能 `ai-profile-integration`）。
//!
//! # 🔴 本项目只说 OpenAI 兼容协议
//!
//! 对话实现只有 Ollama 原生与 OpenAI `chat/completions` 两种，没有 Anthropic 原生 `/v1/messages`。
//! 所以暴露给界面的预置**只含 OpenAI 兼容的**；导入到 Anthropic 协议的配置会被标记
//! `unsupported_protocol`，由界面提醒用户。

use std::sync::OnceLock;

use ai_profile::client::{ServiceConfig, Verifier, VerifyOk};
use ai_profile::{LimitSource, Protocol, ProviderPreset, TokenLimits, VerifyError};
use serde::Serialize;

use crate::error::AppError;
use crate::models::AiModel;

/// `ai_models.limits_source` 的两个取值。🔴 `preset` 不落库：存进库就冻结成旧值，
/// crate 以后修正了数字，这条配置却永远用着当初那份。
pub const LIMITS_SOURCE_USER: &str = "user";
pub const LIMITS_SOURCE_ENDPOINT: &str = "endpoint";

// ─────────────────────────── 预置 ───────────────────────────

/// 界面可选的服务商预置：crate 全量里协议为 OpenAI 兼容的那些，顺序保持 crate 的（同组连续）。
pub fn presets() -> Vec<ProviderPreset> {
    ai_profile::presets()
        .iter()
        .filter(|p| p.protocol == Protocol::OpenAiCompatible)
        .cloned()
        .collect()
}

/// 按 key 取预置；key 不认识时返回 None（界面按「自定义」处理）。
fn preset(key: &str) -> Option<&'static ProviderPreset> {
    ai_profile::preset_by_key(key)
}

/// 是否本机推理服务（Ollama / LM Studio / vLLM）：请求绕开系统代理 —— Clash 等会劫持本地包。
pub fn is_local(provider_key: &str) -> bool {
    preset(provider_key).is_some_and(|p| p.is_local)
}

// ─────────────────────────── 零成本验证（「获取」） ───────────────────────────

/// 验证结果。`ok: false` 不是 Command 失败 —— 端点连不上本身就是验证的结果，
/// 结构化原因交给界面给出动作（一键改用建议地址、载入可用清单……），而不是一行红字。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOutcome {
    pub ok: bool,
    /// 成功时：往返耗时 / 已清洗的模型清单 / 端点上报的限额
    pub result: Option<VerifyOk>,
    /// 失败时的结构化原因（`code` 判别）
    pub error: Option<VerifyError>,
    /// 失败能否靠改配置解决；`false` 只在网络不通时 —— 该给「重试」而不是「去修改」
    pub actionable: bool,
}

/// 两个进程级共享的验证器：走系统代理的（云端）与不走代理的（本机服务）。
///
/// 与 `http_client::shared()` / `shared_no_proxy()` 同一套取舍。构造失败不缓存，下次还能重试。
fn verifier(local: bool) -> Result<&'static Verifier, AppError> {
    static PROXIED: OnceLock<Verifier> = OnceLock::new();
    static DIRECT: OnceLock<Verifier> = OnceLock::new();
    let cell = if local { &DIRECT } else { &PROXIED };
    if let Some(v) = cell.get() {
        return Ok(v);
    }
    let mut builder = ai_profile::reqwest::Client::builder();
    if local {
        builder = builder.no_proxy();
    }
    let v = Verifier::from_builder(builder)
        .map_err(|e| AppError::Custom(format!("初始化验证客户端失败: {e}")))?;
    Ok(cell.get_or_init(|| v))
}

/// 用 `/models` 零成本验证地址与密钥，顺带拿回已清洗的模型清单与端点上报的限额。
///
/// Ollama 也走这里：它的 OpenAI 兼容层同样有 `/v1/models`，与对话用的是同一个地址。
pub async fn verify(
    provider_key: &str,
    api_url: &str,
    api_key: Option<&str>,
    model: &str,
) -> Result<VerifyOutcome, AppError> {
    let base = api_url.trim();
    if base.is_empty() {
        return Err(AppError::InvalidInput("API 地址不能为空".into()));
    }
    let cfg = ServiceConfig::new(Protocol::OpenAiCompatible, base)
        .with_api_key(api_key.map(str::trim).unwrap_or(""))
        .with_model(model.trim());
    Ok(match verifier(is_local(provider_key))?.verify(cfg).await {
        Ok(ok) => VerifyOutcome {
            ok: true,
            result: Some(ok),
            error: None,
            actionable: true,
        },
        Err(e) => VerifyOutcome {
            ok: false,
            result: None,
            actionable: e.is_actionable(),
            error: Some(e),
        },
    })
}

// ─────────────────────────── 限额 ───────────────────────────

/// 已存的限额（用户手填 / 端点上报）。`max_context` 用 0 表示未设置（schema v62）。
fn stored_limits(m: &AiModel) -> Option<TokenLimits> {
    let source = match m.limits_source.as_deref()? {
        LIMITS_SOURCE_USER => LimitSource::User,
        LIMITS_SOURCE_ENDPOINT => LimitSource::Endpoint,
        _ => return None,
    };
    let to_u32 = |v: i64| u32::try_from(v).ok().filter(|n| *n > 0);
    let l = TokenLimits::with_source(to_u32(m.max_context), m.max_output.and_then(to_u32), source);
    (!l.is_empty()).then_some(l)
}

/// crate 预置里登记的静态限额（按本项目存的预置 key 查，不靠地址反推）。
fn preset_limits(m: &AiModel) -> Option<TokenLimits> {
    preset(&m.provider)?
        .models
        .iter()
        .find(|o| o.value == m.model_id.trim())
        .and_then(|o| o.preset_limits())
}

/// 这条配置实际生效的限额：用户手填 > 端点上报 > 预置 > 未知，**逐字段**合并。
///
/// 用户只填了窗口，输出上限照样从下一层补。
pub fn effective_limits(m: &AiModel) -> Option<TokenLimits> {
    match (stored_limits(m), preset_limits(m)) {
        (Some(s), Some(p)) => Some(s.or(p)),
        (s, p) => s.or(p),
    }
}

/// 上下文窗口（token）；未知返回 0 —— `compute_context_budget` 对 `<= 0` 走保守的固定预算。
pub fn effective_context_window(m: &AiModel) -> i64 {
    effective_limits(m)
        .and_then(|l| l.context_window)
        .map(i64::from)
        .unwrap_or(0)
}

/// 用户设的 `max_tokens` 超过模型真实输出上限时压到上限 —— 填超了服务商直接 400。
///
/// 只收紧、不放大：`None`（不传）与 `-1`（Ollama 无限）原样保留；上限未知时也原样。
pub fn clamp_max_tokens(m: &AiModel) -> Option<i64> {
    let want = m.max_tokens?;
    if want <= 0 {
        return Some(want);
    }
    let cap = effective_limits(m).and_then(|l| l.max_output).map(i64::from);
    Some(match cap {
        Some(c) => want.min(c),
        None => want,
    })
}

// ─────────────────────────── ai.profile ───────────────────────────

/// 解析出的一条配置，已换成本项目 `ai_models` 的字段口径。
///
/// 🔴 含明文密钥：只经 IPC 回给「导入配置」弹窗，别写日志。
#[derive(Debug, Clone, Serialize)]
pub struct ImportedAiModel {
    pub name: String,
    /// crate 预置 key（按地址反推，认不出是「OpenAI 兼容自定义」）
    pub provider: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    /// 来源是 Anthropic 原生协议 —— 本项目没有 `/v1/messages` 实现，按 OpenAI 兼容导入，
    /// 官方地址能用（Anthropic 有 OpenAI 兼容端点），只开放 `/v1/messages` 的中转用不了
    pub unsupported_protocol: bool,
}

/// [`parse_ai_profile`] 的结果。
#[derive(Debug, Clone, Serialize)]
pub struct ImportedAiModels {
    pub models: Vec<ImportedAiModel>,
    /// 跳过的条数：设备绑定的 OAuth 档案，以及来源没给模型名、也推断不出的
    pub skipped: usize,
    pub bundle: bool,
}

/// Anthropic 官方的 OpenAI 兼容地址 —— 来源是 Anthropic 协议却没给地址时用它。
const ANTHROPIC_OPENAI_COMPAT_URL: &str = "https://api.anthropic.com/v1";

/// 解析 ai.profile（单条或打包）并换成本项目字段。解析失败返回 crate 的中文原因。
pub fn parse_ai_profile(text: &str) -> Result<ImportedAiModels, AppError> {
    // 来源没给 model 时先留空，下面按反推出的预置补 —— 每条的服务商不同，不能统一兜一个
    let parsed = ai_profile::parse_profiles(text, "")
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;

    let mut models = Vec::with_capacity(parsed.profiles.len());
    let mut skipped = parsed.skipped;
    for p in parsed.profiles {
        let unsupported = p.protocol != Protocol::OpenAiCompatible;
        let base = if p.base_url.is_empty() && unsupported {
            ANTHROPIC_OPENAI_COMPAT_URL.to_string()
        } else {
            p.base_url.clone()
        };
        let key =
            ai_profile::preset::infer_preset_key(Protocol::OpenAiCompatible, Some(base.as_str()));
        let pre = preset(key);
        let model = if p.model.is_empty() {
            pre.map(|x| x.model.to_string()).unwrap_or_default()
        } else {
            p.model.clone()
        };
        if model.is_empty() {
            // ai_models.model_id 必填，而自定义端点没有可推断的默认 —— 导进来也用不了
            skipped += 1;
            continue;
        }
        let api_url = if base.is_empty() {
            pre.and_then(|x| x.base_url).unwrap_or_default().to_string()
        } else {
            base
        };
        let name = if p.name.is_empty() {
            pre.map(|x| x.label.to_string()).unwrap_or_else(|| model.clone())
        } else {
            p.name.clone()
        };
        models.push(ImportedAiModel {
            name,
            provider: key.to_string(),
            api_url,
            api_key: Some(p.api_key.clone()).filter(|k| !k.is_empty()),
            model_id: model,
            unsupported_protocol: unsupported,
        });
    }
    if models.is_empty() {
        return Err(AppError::InvalidInput(
            "没有可导入的模型配置（来源没给模型名，或都是设备绑定的 OAuth 档案）".into(),
        ));
    }
    Ok(ImportedAiModels {
        models,
        skipped,
        bundle: parsed.bundle,
    })
}

/// 生成 ai.profile 文本（规范写法）。本项目只说 OpenAI 兼容，协议固定。
///
/// 🔴 产物含明文密钥，由用户点「分享」触发，去向由调用方决定。
pub fn to_ai_profile(name: &str, api_url: &str, api_key: &str, model_id: &str) -> String {
    ai_profile::to_profile(name, Protocol::OpenAiCompatible, api_url, api_key, model_id)
}

// ─────────────────────────── 旧配置导入 ───────────────────────────

/// 旧版本（v1.64.0 及以前）导出的 `kbConfig` 模型配置 → 本版本口径。
///
/// 与 schema v62 同一套规则：地址按旧规则补齐、厂商 id 换成 crate key、历史默认窗口当作未设置。
/// 只给**没有** `api_url_verbatim` 标记的信封用（新版本导出的已经是新口径，再修会错补 `/v1`）。
#[derive(Debug, Clone, Serialize)]
pub struct LegacyAiModelFix {
    pub provider: String,
    pub api_url: String,
    /// None = 未设置（回落端点上报 / 预置）
    pub max_context: Option<i64>,
}

pub fn fix_legacy_ai_model(provider: &str, api_url: &str, max_context: Option<i64>) -> LegacyAiModelFix {
    use crate::database::schema::LEGACY_DEFAULT_MAX_CONTEXT;
    use crate::services::legacy_api_url::{legacy_provider_key, normalize_legacy_api_url};
    LegacyAiModelFix {
        provider: legacy_provider_key(provider).to_string(),
        api_url: normalize_legacy_api_url(api_url),
        max_context: max_context.filter(|v| *v > 0 && *v != LEGACY_DEFAULT_MAX_CONTEXT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, model_id: &str) -> AiModel {
        AiModel {
            id: 1,
            name: "t".into(),
            provider: provider.into(),
            api_url: "https://api.deepseek.com/v1".into(),
            api_key: None,
            has_api_key: false,
            model_id: model_id.into(),
            is_default: true,
            max_context: 0,
            limits_source: None,
            max_output: None,
            max_tokens: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn presets_are_openai_compatible_only() {
        let all = presets();
        assert!(!all.is_empty());
        assert!(all.iter().all(|p| p.protocol == Protocol::OpenAiCompatible));
        assert!(all.iter().any(|p| p.key == "ollama"), "本机 Ollama 必须在");
        assert!(!all.iter().any(|p| p.key == "anthropic_official"), "本项目说不了 /v1/messages");
    }

    /// 用户手填 > 端点上报 > 预置，逐字段合并；未设置时回落预置。
    #[test]
    fn effective_limits_layering() {
        let mut m = model("deepseek", "deepseek-flash");
        let preset_ctx = effective_context_window(&m);
        assert!(preset_ctx > 0, "DeepSeek 预置登记了窗口，未设置时应回落到它");

        m.max_context = 8_000;
        m.limits_source = Some(LIMITS_SOURCE_USER.into());
        assert_eq!(effective_context_window(&m), 8_000, "用户手填压过预置");

        // 只填了窗口：输出上限照样从预置补
        let l = effective_limits(&m).unwrap();
        assert_eq!(l.source, LimitSource::User);
        assert!(l.max_output.is_some(), "输出上限应逐字段从预置补");

        // 来源为空的存量值不算数（v62 前的数据都在迁移里处理过，这里防的是脏数据）
        let mut n = model("openai_compatible_custom", "whatever");
        n.max_context = 50_000;
        assert_eq!(effective_context_window(&n), 0);
    }

    #[test]
    fn clamp_only_tightens() {
        let mut m = model("deepseek", "deepseek-flash");
        m.max_output = Some(1_000);
        m.limits_source = Some(LIMITS_SOURCE_ENDPOINT.into());
        m.max_tokens = Some(999_999);
        assert_eq!(clamp_max_tokens(&m), Some(1_000));
        m.max_tokens = Some(500);
        assert_eq!(clamp_max_tokens(&m), Some(500));
        m.max_tokens = Some(-1);
        assert_eq!(clamp_max_tokens(&m), Some(-1), "Ollama 的无限不动");
        m.max_tokens = None;
        assert_eq!(clamp_max_tokens(&m), None, "不传就是不传");
    }

    #[test]
    fn parses_single_and_bundle() {
        let single = r#"{"kind":"ai.profile","v":1,"data":{"name":"DS","provider":"deepseek",
            "baseURL":"https://api.deepseek.com/v1","apiKey":"sk-1","model":"deepseek-flash"}}"#;
        let r = parse_ai_profile(single).unwrap();
        assert!(!r.bundle);
        assert_eq!(r.models[0].provider, "deepseek", "按地址反推出预置 key");
        assert_eq!(r.models[0].api_key.as_deref(), Some("sk-1"));

        // 智码打包：OAuth 跳过；Anthropic 协议标记为不支持但仍导入
        let bundle = r#"{"kind":"ai.profile.bundle","v":1,"data":{"api_profiles":[
            {"name":"登录","auth_type":"oauth","model":"x"},
            {"name":"官方 Claude","provider":"anthropic","api_key":"sk-ant","base_url":"","model":"claude-opus-5"},
            {"name":"","provider":"deepseek","api_key":"k","base_url":"https://api.deepseek.com/v1","model":""}
        ]}}"#;
        let r = parse_ai_profile(bundle).unwrap();
        assert!(r.bundle);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.models.len(), 2);
        assert!(r.models[0].unsupported_protocol);
        assert_eq!(r.models[0].api_url, ANTHROPIC_OPENAI_COMPAT_URL);
        assert!(!r.models[1].model_id.is_empty(), "来源没给模型名，按预置默认补");
        assert!(!r.models[1].name.is_empty(), "来源没给名字，用服务商名");
    }

    #[test]
    fn legacy_import_fix_matches_migration() {
        let f = fix_legacy_ai_model("kimi", "https://api.moonshot.cn", Some(128_000));
        assert_eq!(f.provider, "moonshot");
        assert_eq!(f.api_url, "https://api.moonshot.cn/v1");
        assert_eq!(f.max_context, None, "历史默认 128000 当作未设置");
        assert_eq!(fix_legacy_ai_model("ollama", "http://localhost:11434", Some(4096)).max_context, Some(4096));
    }
}
