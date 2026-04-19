//! 本地敏感数据加密（AES-256-GCM）
//!
//! 用于加密存入 SQLite app_config 的敏感字段（如 WebDAV 密码）。
//! 密钥来源：机器 hostname + 应用标识 → SHA-256 派生 32 字节 key。
//!
//! 威胁模型：
//! - 目标：防止"app.db 被复制到别的机器后密码明文泄漏"
//! - 不防：同机器上的恶意程序逆向二进制拿到 salt 后重建 key
//!   （本地应用的固有限制，需用户信任运行环境）
//!
//! 格式：base64(nonce || ciphertext_with_tag)
//! - nonce: 12 字节随机（每次加密独立）
//! - GCM tag: 16 字节，附在密文后

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 应用内固定 salt，用来和 hostname 拼接派生 key
/// 改这个常量会让已有的加密数据不可解密——**永不修改**
const APP_SALT: &[u8] = b"knowledge-base:v1:webdav-enc";

/// 派生 AES-256 key：sha256(hostname || APP_SALT)
fn derive_key() -> [u8; 32] {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-host".into());
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    hasher.update(APP_SALT);
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// 加密字符串 → base64 (nonce || ciphertext||tag)
pub fn encrypt(plaintext: &str) -> Result<String, AppError> {
    let key_bytes = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 字节
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| AppError::Custom(format!("加密失败: {}", e)))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

/// 解密 base64 → 原字符串
pub fn decrypt(encoded: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| AppError::Custom(format!("密文 base64 解析失败: {}", e)))?;
    if bytes.len() < 12 + 16 {
        return Err(AppError::Custom("密文长度不足".into()));
    }

    let (nonce_bytes, cipher_and_tag) = bytes.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key_bytes = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let plain = cipher
        .decrypt(nonce, cipher_and_tag)
        .map_err(|e| AppError::Custom(format!("解密失败（可能密钥或数据损坏）: {}", e)))?;
    String::from_utf8(plain).map_err(|e| AppError::Custom(format!("解密后非法 UTF-8: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let plain = "my-secret-password";
        let enc = encrypt(plain).expect("encrypt ok");
        let dec = decrypt(&enc).expect("decrypt ok");
        assert_eq!(plain, dec);
    }

    #[test]
    fn different_nonce_each_time() {
        let p = "same input";
        let a = encrypt(p).unwrap();
        let b = encrypt(p).unwrap();
        assert_ne!(a, b, "nonce 必须随机，两次加密结果应不同");
    }
}
