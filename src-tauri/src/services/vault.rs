//! T-007 笔记加密保险库（Vault）
//!
//! 对外职责：
//! - `status(db)` 判断 vault 当前是什么状态（NotSet / Locked / Unlocked）
//! - `setup(db, state, password)` 首次设置主密码：生成盐 + verifier 存 app_config；
//!   同时解锁（key 缓存到 state）
//! - `unlock(db, state, password)` 用密码派生 key + 校验 verifier；成功则缓存到 state
//! - `lock(state)` 清空内存中的 key（调用 zeroize）
//! - `encrypt_plaintext` / `decrypt_blob` 基于 state 里的 key 做加/解密
//!
//! vault 内部状态存放在 `AppState.vault`（`RwLock<VaultState>`），key 用 `Zeroizing`
//! 包裹，Drop 时自动清零敏感内存。
//!
//! 存储约定（app_config 两条 key）：
//! - `vault.salt`     → base64(盐 16B)
//! - `vault.verifier` → base64(aead_encrypt(key, "knowledge-base:vault:ok"))
//!
//! verifier 是用 key 加密的一个固定字符串。unlock 时用派生的 key 解它，成功=密码对；
//! 失败=密码错。这样服务器永远不存密码也不存 key。

use std::sync::RwLock;

use base64::Engine;
use zeroize::Zeroizing;

use crate::database::Database;
use crate::error::AppError;
use crate::models::VaultStatus;
use crate::crypto;

const CFG_SALT: &str = "vault.salt";
const CFG_VERIFIER: &str = "vault.verifier";
/// verifier 解密后的固定明文；每次解锁都用它做匹配
const VERIFIER_PLAINTEXT: &[u8] = b"knowledge-base:vault:ok";

/// Vault 会话态（只存内存；不落盘）
///
/// `key` 用 `Zeroizing` 包裹：drop 时自动写 0，防止敏感数据在 swap/内存 dump 里残留。
#[derive(Default)]
pub struct VaultState {
    key: Option<Zeroizing<[u8; crypto::KEY_LEN]>>,
}

impl VaultState {
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// 借用 key 做一次性加/解密；外部不应持有这个引用
    fn key_bytes(&self) -> Option<&[u8; crypto::KEY_LEN]> {
        self.key.as_ref().map(|z| &**z)
    }

    fn set_key(&mut self, k: [u8; crypto::KEY_LEN]) {
        self.key = Some(Zeroizing::new(k));
    }

    fn clear(&mut self) {
        // Zeroizing drop 会自动清零
        self.key = None;
    }
}

pub struct VaultService;

impl VaultService {
    /// 查 vault 当前状态
    pub fn status(db: &Database, state: &RwLock<VaultState>) -> Result<VaultStatus, AppError> {
        let has_salt = db.get_config(CFG_SALT)?.is_some();
        let has_verifier = db.get_config(CFG_VERIFIER)?.is_some();
        if !has_salt || !has_verifier {
            return Ok(VaultStatus::NotSet);
        }
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        if guard.is_unlocked() {
            Ok(VaultStatus::Unlocked)
        } else {
            Ok(VaultStatus::Locked)
        }
    }

    /// 首次设置主密码（vault 必须处于 NotSet 态）
    ///
    /// 完成后自动解锁（key 已在内存中，不必立即要求用户再输一遍）。
    pub fn setup(
        db: &Database,
        state: &RwLock<VaultState>,
        password: &str,
    ) -> Result<(), AppError> {
        if password.is_empty() {
            return Err(AppError::Custom("主密码不能为空".to_string()));
        }
        if Self::status(db, state)? != VaultStatus::NotSet {
            return Err(AppError::Custom(
                "主密码已存在，请走 unlock 路径或先销毁 vault".to_string(),
            ));
        }

        let salt = crypto::new_salt();
        let key = crypto::derive_user_key(password, &salt)?;
        let verifier = crypto::aead_encrypt(&key, VERIFIER_PLAINTEXT)?;

        let salt_b64 = base64::engine::general_purpose::STANDARD.encode(salt);
        let verifier_b64 = base64::engine::general_purpose::STANDARD.encode(&verifier);
        db.set_config(CFG_SALT, &salt_b64)?;
        db.set_config(CFG_VERIFIER, &verifier_b64)?;

        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.set_key(key);
        Ok(())
    }

    /// 用密码解锁 vault。成功 → key 缓存到内存；失败（密码错）→ 不改 state
    pub fn unlock(
        db: &Database,
        state: &RwLock<VaultState>,
        password: &str,
    ) -> Result<(), AppError> {
        let salt_b64 = db
            .get_config(CFG_SALT)?
            .ok_or_else(|| AppError::Custom("vault 尚未初始化，请先 setup".to_string()))?;
        let verifier_b64 = db
            .get_config(CFG_VERIFIER)?
            .ok_or_else(|| AppError::Custom("vault 损坏：缺少 verifier".to_string()))?;
        let salt = base64::engine::general_purpose::STANDARD
            .decode(salt_b64.as_bytes())
            .map_err(|e| AppError::Custom(format!("vault salt 解析失败: {}", e)))?;
        let verifier = base64::engine::general_purpose::STANDARD
            .decode(verifier_b64.as_bytes())
            .map_err(|e| AppError::Custom(format!("vault verifier 解析失败: {}", e)))?;

        let key = crypto::derive_user_key(password, &salt)?;

        // 用 key 去解 verifier；解成功 + 明文匹配 = 密码正确
        let decrypted = crypto::aead_decrypt(&key, &verifier)
            .map_err(|_| AppError::Custom("主密码错误".to_string()))?;
        if decrypted != VERIFIER_PLAINTEXT {
            return Err(AppError::Custom(
                "主密码错误（verifier 不匹配）".to_string(),
            ));
        }

        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.set_key(key);
        Ok(())
    }

    /// 锁定 vault（清空内存里的 key）。下次加/解密前需再 unlock
    pub fn lock(state: &RwLock<VaultState>) -> Result<(), AppError> {
        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.clear();
        Ok(())
    }

    /// 用已解锁的 vault 加密一段明文 → blob（nonce ‖ ciphertext+tag）
    ///
    /// 未解锁返回错误。
    pub fn encrypt_plaintext(
        state: &RwLock<VaultState>,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, AppError> {
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        let key = guard
            .key_bytes()
            .ok_or_else(|| AppError::Custom("vault 未解锁".to_string()))?;
        crypto::aead_encrypt(key, plaintext)
    }

    /// 用已解锁的 vault 解密 blob → 明文
    pub fn decrypt_blob(state: &RwLock<VaultState>, blob: &[u8]) -> Result<Vec<u8>, AppError> {
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        let key = guard
            .key_bytes()
            .ok_or_else(|| AppError::Custom("vault 未解锁".to_string()))?;
        crypto::aead_decrypt(key, blob)
    }

    // ─── T-S014：vault meta 跨端同步 ─────────────────────────

    /// 读取本机 vault 元数据（salt + verifier 的 base64）。NotSet 态返回 None。
    pub fn read_meta(db: &Database) -> Result<Option<crate::models::VaultMeta>, AppError> {
        let salt = db.get_config(CFG_SALT)?;
        let verifier = db.get_config(CFG_VERIFIER)?;
        match (salt, verifier) {
            (Some(s), Some(v)) if !s.is_empty() && !v.is_empty() => {
                Ok(Some(crate::models::VaultMeta {
                    salt: s,
                    verifier: v,
                }))
            }
            _ => Ok(None),
        }
    }

    /// 从远端 manifest 导入 vault 元数据（首次同步场景：本机无 vault）。
    ///
    /// **安全约定**：
    /// - 本机已设置 vault → 拒绝（避免静默覆盖；冲突需用户手动决断）
    /// - 本机未设置 vault → 写入 salt+verifier，vault 处于 Locked 态，用户用同步过来的密码解锁即可
    /// - 导入后本机 vault 状态从 NotSet 变 Locked（解锁需用户输入相同密码）
    ///
    /// 注：sync_v1 pull 流程因为无 VaultState 句柄，实际走 `import_meta_if_not_set`。
    /// 本方法保留给未来"加密笔记同步"显式命令使用（可校验 state 解锁态）。
    #[allow(dead_code)]
    pub fn import_meta(
        db: &Database,
        state: &RwLock<VaultState>,
        meta: &crate::models::VaultMeta,
    ) -> Result<(), AppError> {
        if Self::status(db, state)? != VaultStatus::NotSet {
            return Err(AppError::Custom(
                "本机 vault 已存在，不允许从远端覆盖（同步加密笔记前请确认两端 vault 状态一致）".into(),
            ));
        }
        // 简单验证 base64 可解析（防止脏数据写入）
        let _ = base64::engine::general_purpose::STANDARD
            .decode(meta.salt.as_bytes())
            .map_err(|e| AppError::Custom(format!("远端 vault salt 解析失败: {}", e)))?;
        let _ = base64::engine::general_purpose::STANDARD
            .decode(meta.verifier.as_bytes())
            .map_err(|e| AppError::Custom(format!("远端 vault verifier 解析失败: {}", e)))?;
        db.set_config(CFG_SALT, &meta.salt)?;
        db.set_config(CFG_VERIFIER, &meta.verifier)?;
        Ok(())
    }

    /// 判定远端 vault meta 是否与本机一致（用于决定加密笔记能否互通）。
    /// 两端任一未设置 → false；salt 字符串相等 → true（同一 salt 派生同一 key）。
    pub fn meta_matches(
        db: &Database,
        remote: &crate::models::VaultMeta,
    ) -> Result<bool, AppError> {
        let local = match Self::read_meta(db)? {
            Some(m) => m,
            None => return Ok(false),
        };
        Ok(local.salt == remote.salt)
    }

    /// 同 import_meta，但不依赖 VaultState（同步流程中无 state 句柄可用）
    ///
    /// 返回值：
    /// - `Ok(true)`  本机原先未设置 vault，已成功导入 → 用户用相同密码即可解锁
    /// - `Ok(false)` 本机已设置过 vault，未导入（保留原 vault）
    /// - `Err(_)`    base64 解析失败等异常
    pub fn import_meta_if_not_set(
        db: &Database,
        meta: &crate::models::VaultMeta,
    ) -> Result<bool, AppError> {
        let has_local =
            db.get_config(CFG_SALT)?.is_some() || db.get_config(CFG_VERIFIER)?.is_some();
        if has_local {
            return Ok(false);
        }
        let _ = base64::engine::general_purpose::STANDARD
            .decode(meta.salt.as_bytes())
            .map_err(|e| AppError::Custom(format!("远端 vault salt 解析失败: {}", e)))?;
        let _ = base64::engine::general_purpose::STANDARD
            .decode(meta.verifier.as_bytes())
            .map_err(|e| AppError::Custom(format!("远端 vault verifier 解析失败: {}", e)))?;
        db.set_config(CFG_SALT, &meta.salt)?;
        db.set_config(CFG_VERIFIER, &meta.verifier)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_state_zeroizing() {
        // 确保 VaultState 清理后 is_unlocked=false
        let mut vs = VaultState::default();
        assert!(!vs.is_unlocked());
        vs.set_key([1u8; crypto::KEY_LEN]);
        assert!(vs.is_unlocked());
        vs.clear();
        assert!(!vs.is_unlocked());
    }

    /// T-S014：远端 vault meta 导入与 salt 匹配判定
    #[test]
    fn import_meta_if_not_set_writes_on_first_call() {
        let db = Database::init(":memory:").unwrap();
        let meta = crate::models::VaultMeta {
            salt: "AAAAAAAAAAAAAAAAAAAAAA==".into(),
            verifier: "AAECAwQFBgcICQ==".into(),
        };

        let first = VaultService::import_meta_if_not_set(&db, &meta).unwrap();
        assert!(first, "本机原先无 vault，首次应导入");

        // 第二次调用：本机已有，不再覆盖
        let second = VaultService::import_meta_if_not_set(&db, &meta).unwrap();
        assert!(!second, "本机已有 vault，不应再次导入");

        // 落库正确
        let read = VaultService::read_meta(&db).unwrap().unwrap();
        assert_eq!(read.salt, meta.salt);
        assert_eq!(read.verifier, meta.verifier);

        // 一致性判定
        assert!(VaultService::meta_matches(&db, &meta).unwrap());
        let other = crate::models::VaultMeta {
            salt: "BBBBBBBBBBBBBBBBBBBBBQ==".into(),
            verifier: meta.verifier.clone(),
        };
        assert!(!VaultService::meta_matches(&db, &other).unwrap());
    }

    #[test]
    fn import_meta_if_not_set_rejects_invalid_base64() {
        let db = Database::init(":memory:").unwrap();
        let bad = crate::models::VaultMeta {
            salt: "this is not base64!!!".into(),
            verifier: "AAECAwQFBgcICQ==".into(),
        };
        assert!(VaultService::import_meta_if_not_set(&db, &bad).is_err());
        // 失败后不应写入
        assert!(VaultService::read_meta(&db).unwrap().is_none());
    }
}
