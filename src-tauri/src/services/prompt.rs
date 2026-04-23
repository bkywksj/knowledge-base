//! AI 提示词模板业务层
//!
//! 现阶段职责只有一个：**变量渲染**。把 `{{selection}}` / `{{context}}` / `{{title}}` / `{{language}}`
//! 等占位符替换成实际内容，然后交回给 `services::ai::AiService::write_assist` 发给大模型。
//!
//! 不在这里做 LLM 调用 —— 那是 AiService 的活。这样 Prompt 模板跟调用通道解耦，
//! 将来要换调用协议（如从 OpenAI 迁到 Anthropic Messages）只动 AiService 即可。

use crate::database::Database;
use crate::error::AppError;
use crate::models::PromptTemplate;

/// 已知占位符变量。未在此列的 `{{xxx}}` 会被保留原样交给模型
/// （模型通常能理解"请忽略 {{xxx}}"，不强制清理以保留未来扩展的可能）。
pub const VAR_SELECTION: &str = "selection";
pub const VAR_CONTEXT: &str = "context";
pub const VAR_TITLE: &str = "title";
pub const VAR_LANGUAGE: &str = "language";

/// 调用 Prompt 时的上下文变量组
///
/// 字段都用 `&str` 以避免在热路径上多余的 clone；渲染结果返回 `String`。
pub struct PromptVars<'a> {
    pub selection: &'a str,
    pub context: &'a str,
    pub title: &'a str,
    /// 用户语言（BCP 47），比如 "zh-CN"、"en-US"，供翻译类 Prompt 使用
    pub language: &'a str,
}

/// 把模板 body 里的 `{{var}}` 替换成实际值
///
/// 设计取舍：
/// - 不用正则/模板引擎，就是朴素 `replace()`，避免拉新依赖；
///   变量总共 ~5 个，每个替换一次的 O(n) 开销完全可接受。
/// - 替换顺序不重要，因为变量名两两不重叠。
pub fn render(template: &str, vars: &PromptVars<'_>) -> String {
    template
        .replace(&placeholder(VAR_SELECTION), vars.selection)
        .replace(&placeholder(VAR_CONTEXT), vars.context)
        .replace(&placeholder(VAR_TITLE), vars.title)
        .replace(&placeholder(VAR_LANGUAGE), vars.language)
}

fn placeholder(var: &str) -> String {
    format!("{{{{{}}}}}", var)
}

/// Prompt 服务
pub struct PromptService;

impl PromptService {
    /// 解析 action 字符串 → 定位到对应的 Prompt 模板
    ///
    /// 支持两种格式：
    /// - `prompt:{id}` 直接按主键查
    /// - `continue` / `summarize` / ...（旧硬编码 action）按 `builtin_code` 查
    ///
    /// 查不到时返回 `Err`，调用方可据此决定是回退到默认 system prompt 还是直接报错。
    pub fn resolve(db: &Database, action: &str) -> Result<PromptTemplate, AppError> {
        if let Some(id_str) = action.strip_prefix("prompt:") {
            let id: i64 = id_str.parse().map_err(|_| {
                AppError::Custom(format!("非法的 prompt action: {}", action))
            })?;
            return db.get_prompt(id);
        }

        // 兜底按 builtin_code 查（兼容老前端 / 外部脚本直接传 action）
        match db.get_prompt_by_builtin_code(action)? {
            Some(p) => Ok(p),
            None => Err(AppError::Custom(format!(
                "未找到对应的提示词：{}",
                action
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_replaces_all_known_vars() {
        let vars = PromptVars {
            selection: "S",
            context: "C",
            title: "T",
            language: "zh-CN",
        };
        let out = render(
            "sel={{selection}} ctx={{context}} ttl={{title}} lang={{language}}",
            &vars,
        );
        assert_eq!(out, "sel=S ctx=C ttl=T lang=zh-CN");
    }

    #[test]
    fn render_leaves_unknown_vars_alone() {
        let vars = PromptVars {
            selection: "",
            context: "",
            title: "",
            language: "",
        };
        let out = render("before {{unknown}} after", &vars);
        assert_eq!(out, "before {{unknown}} after");
    }

    #[test]
    fn render_handles_empty_template() {
        let vars = PromptVars {
            selection: "x",
            context: "",
            title: "",
            language: "",
        };
        assert_eq!(render("", &vars), "");
    }
}
