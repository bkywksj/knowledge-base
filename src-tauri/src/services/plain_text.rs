//! Markdown 正文 → 纯文本 / 字数。实现在 kb-core（字数触发器要在 kb-mcp 的连接上也注册），
//! 这里转一下，主应用里照旧用 `services::plain_text::*`。

pub use kb_core::plain_text::*;
