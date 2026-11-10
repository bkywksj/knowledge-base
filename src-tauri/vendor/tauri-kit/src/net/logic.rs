//! 纯逻辑：错误原因链的展开。

use std::error::Error;

/// 把错误连同 source 链展开成一行。
///
/// reqwest 错误的 Display 只有一句 `error sending request`，真正的原因（代理连不上、证书不受信任、
/// DNS 失败）都在 source 链里。Reeve 那次客诉的日志只有第一层，看不出是 socks 的问题。
pub(crate) fn chain(e: &dyn Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    #[derive(Debug)]
    struct E(&'static str, Option<Box<E>>);

    impl fmt::Display for E {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl Error for E {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.1.as_deref().map(|e| e as &(dyn Error + 'static))
        }
    }

    /// 客诉日志里的三层原样复现：原因在最后一层
    #[test]
    fn socks_failure_shows_the_real_cause() {
        let e = E(
            "error sending request",
            Some(Box::new(E(
                "client error (Connect)",
                Some(Box::new(E("unsupported scheme socks5", None))),
            ))),
        );
        assert_eq!(chain(&e), "error sending request: client error (Connect): unsupported scheme socks5");
    }

    #[test]
    fn error_without_source_is_unchanged() {
        assert_eq!(chain(&E("operation timed out", None)), "operation timed out");
    }
}
