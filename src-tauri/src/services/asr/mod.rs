//! 语音识别（ASR）服务层。
//!
//! 抽象出统一的入口 `AsrService`，按 `AsrProviderKind` 分发到具体实现。
//! 当前仅一家：阿里云百炼 DashScope（[`dashscope`]）。
//!
//! 配置读写走 `app_config` 表 KV，前缀 `asr.*`，与现有 `ai_models.api_key`
//! 风格一致 —— schema v59 起两者**都改为 AES-256-GCM 加密入库**
//! （威胁模型见 `crate::crypto`：防 app.db 被复制到别的机器后明文泄漏）。

pub mod dashscope;

use crate::crypto;
use crate::database::Database;
use crate::error::AppError;
use crate::models::{AsrConfig, AsrProviderKind, AsrTestResult, TranscribeResult};

pub struct AsrService;

impl AsrService {
    const KEY_PROVIDER: &'static str = "asr.provider";
    const KEY_API_KEY: &'static str = "asr.api_key";
    const KEY_MODEL: &'static str = "asr.model";
    const KEY_REGION: &'static str = "asr.region";
    const KEY_ENABLED: &'static str = "asr.enabled";

    /// 读取当前 ASR 配置。任意字段缺失走 `AsrConfig::default()`。
    pub fn get_config(db: &Database) -> Result<AsrConfig, AppError> {
        let mut cfg = AsrConfig::default();
        if let Some(v) = db.get_config(Self::KEY_PROVIDER)? {
            if let Some(k) = AsrProviderKind::parse(&v) {
                cfg.provider = k;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_API_KEY)? {
            // v59 起密文入库；解密失败（换机器 / 改主机名）降级为空，
            // 前端会显示成"未配置"引导用户重填，而不是拿密文去调 DashScope 报 401
            cfg.api_key = crypto::decrypt_field_or_none(&v, "ASR API Key").unwrap_or_default();
        }
        if let Some(v) = db.get_config(Self::KEY_MODEL)? {
            if !v.is_empty() {
                cfg.model = v;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_REGION)? {
            if !v.is_empty() {
                cfg.region = v;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_ENABLED)? {
            cfg.enabled = matches!(v.as_str(), "1" | "true");
        }
        Ok(cfg)
    }

    /// 保存配置；启用 = true 时强校验 api_key 非空，避免静默失败。
    pub fn save_config(db: &Database, cfg: &AsrConfig) -> Result<(), AppError> {
        if cfg.enabled && cfg.api_key.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "启用语音识别前必须填写 API Key".into(),
            ));
        }
        db.set_config(Self::KEY_PROVIDER, cfg.provider.as_str())?;
        // v59 起加密入库，防 app.db 被复制走后明文泄漏
        db.set_config(Self::KEY_API_KEY, &crypto::encrypt_field(cfg.api_key.trim())?)?;
        db.set_config(Self::KEY_MODEL, &cfg.model)?;
        db.set_config(Self::KEY_REGION, &cfg.region)?;
        db.set_config(Self::KEY_ENABLED, if cfg.enabled { "1" } else { "0" })?;
        Ok(())
    }

    /// 转录入口：从 DB 读配置 → 校验 → 派发到具体实现。
    pub async fn transcribe(
        db: &Database,
        audio_b64: &str,
        mime: &str,
        language: Option<&str>,
    ) -> Result<TranscribeResult, AppError> {
        let cfg = Self::get_config(db)?;
        if !cfg.enabled {
            return Err(AppError::InvalidInput("语音识别未启用".into()));
        }
        if cfg.api_key.trim().is_empty() {
            return Err(AppError::InvalidInput("尚未配置 API Key".into()));
        }
        match cfg.provider {
            AsrProviderKind::Dashscope => {
                dashscope::transcribe(&cfg, audio_b64, mime, language).await
            }
        }
    }

    /// 「测试连接」按钮专用：仅校验鉴权 / 端点可达，不真正消耗识别用量。
    pub async fn test_connection(cfg: &AsrConfig) -> AsrTestResult {
        let start = std::time::Instant::now();
        if cfg.api_key.trim().is_empty() {
            return AsrTestResult {
                ok: false,
                latency_ms: 0,
                message: Some("API Key 不能为空".into()),
            };
        }
        let result = match cfg.provider {
            AsrProviderKind::Dashscope => dashscope::probe(cfg).await,
        };
        match result {
            Ok(_) => AsrTestResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                message: None,
            },
            Err(e) => AsrTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: Some(e.to_string()),
            },
        }
    }
}
