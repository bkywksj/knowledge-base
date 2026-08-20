//! 笔记正文哈希工具
//!
//! 用于导入去重：对笔记内容算 SHA-256（16 进制字符串），存到 notes.content_hash 字段，
//! 扫描外部 md 文件时以 (title, content_hash) 做兜底匹配。
//! 不用于安全场景——只要"碰撞概率足够低"即可。
use sha2::{Digest, Sha256};

pub fn sha256_hex(content: &str) -> String {
    sha256_hex_bytes(content.as_bytes())
}

/// 对**任意字节**算 SHA-256（16 进制）。
///
/// 二进制文件（xlsx / 图片…）必须走这个而不是先 `from_utf8_lossy` 再哈希 ——
/// 有损转换会把所有非法字节都变成同一个替换字符，两个不同的文件可能得到相同哈希。
pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}
