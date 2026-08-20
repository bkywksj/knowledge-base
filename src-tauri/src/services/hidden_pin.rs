//! 隐藏笔记 PIN（UX 门禁，不是真加密）
//!
//! 设计要点：
//! - PIN 只挡"打开隐藏页"这一个入口；隐藏笔记本身在数据库里仍是明文
//! - 与 Vault 主密码完全独立：忘 PIN 可在设置页清除（需当前 PIN）或导入新 PIN
//! - 错误次数限制：连续错 MAX_FAIL 次冷却 LOCK_SECS 秒，防暴力
//! - 哈希用 Argon2id（复用 crypto::derive_user_key），扛离线字典攻击

use base64::Engine;

use crate::database::Database;
use crate::error::AppError;
use crate::crypto;

const KEY_HASH: &str = "hidden_pin_hash";
const KEY_SALT: &str = "hidden_pin_salt";
const KEY_FAIL_COUNT: &str = "hidden_pin_fail_count";
const KEY_LOCKED_UNTIL: &str = "hidden_pin_locked_until";
const KEY_HINT: &str = "hidden_pin_hint";

const MAX_FAIL: u32 = 3;
const LOCK_SECS: i64 = 30;
const PIN_MIN_LEN: usize = 4;
const PIN_MAX_LEN: usize = 64;
const HINT_MAX_LEN: usize = 100;

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn validate_pin(pin: &str) -> Result<(), AppError> {
    let len = pin.chars().count();
    if len < PIN_MIN_LEN || len > PIN_MAX_LEN {
        return Err(AppError::InvalidInput(format!(
            "PIN 长度需在 {}~{} 之间",
            PIN_MIN_LEN, PIN_MAX_LEN
        )));
    }
    Ok(())
}

/// 校验提示文本：长度限制 + 不能直接泄露 PIN
///
/// 不能包含 PIN 是关键安全约束 —— 否则用户写"我的 PIN 是 1234"就把保护破了。
/// 大小写不敏感地比较，避免简单大小写绕过。
fn validate_hint(hint: &str, pin: &str) -> Result<(), AppError> {
    let trimmed = hint.trim();
    if trimmed.is_empty() {
        return Ok(()); // 允许清空
    }
    if trimmed.chars().count() > HINT_MAX_LEN {
        return Err(AppError::InvalidInput(format!(
            "提示长度不能超过 {} 字符",
            HINT_MAX_LEN
        )));
    }
    let hint_lower = trimmed.to_lowercase();
    let pin_lower = pin.to_lowercase();
    if !pin_lower.is_empty() && hint_lower.contains(&pin_lower) {
        return Err(AppError::InvalidInput(
            "提示不能包含 PIN 本身（这会使保护失效）".into(),
        ));
    }
    Ok(())
}

/// 是否已设置 PIN（前端用来决定要不要拦截入口）
pub fn is_pin_set(db: &Database) -> Result<bool, AppError> {
    Ok(db.get_config(KEY_HASH)?.is_some())
}

/// 设置/修改 PIN（可选附带提示）
/// - 若已设过：必须传 old_pin 并校验通过
/// - hint = None 表示不修改现有提示；Some("") 表示清空提示
/// - 设置成功后清空失败计数与锁定时间
pub fn set_pin(
    db: &Database,
    old_pin: Option<String>,
    new_pin: String,
    hint: Option<String>,
) -> Result<(), AppError> {
    validate_pin(&new_pin)?;
    if let Some(ref h) = hint {
        validate_hint(h, &new_pin)?;
    }

    if is_pin_set(db)? {
        let old = old_pin
            .ok_or_else(|| AppError::InvalidInput("已设置 PIN，需提供当前 PIN 才能修改".into()))?;
        // 直接调内部 verify（不走错误次数限制：修改场景下用户主动操作）
        let stored_hash = load_hash(db)?
            .ok_or_else(|| AppError::Custom("PIN 数据损坏：哈希存在但解码失败".into()))?;
        let stored_salt =
            load_salt(db)?.ok_or_else(|| AppError::Custom("PIN 数据损坏：盐缺失".into()))?;
        let ok = crypto::verify_pin(&old, &stored_salt, &stored_hash)?;
        if !ok {
            return Err(AppError::InvalidInput("当前 PIN 不正确".into()));
        }
    }

    let salt = crypto::new_salt();
    let hash = crypto::hash_pin(&new_pin, &salt)?;
    db.set_config(KEY_HASH, &b64().encode(hash))?;
    db.set_config(KEY_SALT, &b64().encode(salt))?;
    db.set_config(KEY_FAIL_COUNT, "0")?;
    db.set_config(KEY_LOCKED_UNTIL, "0")?;

    // 提示：Some("") = 清空，Some(非空) = 保存，None = 保留原提示
    if let Some(h) = hint {
        let trimmed = h.trim();
        if trimmed.is_empty() {
            db.delete_config(KEY_HINT)?;
        } else {
            db.set_config(KEY_HINT, trimmed)?;
        }
    }
    Ok(())
}

/// 获取 PIN 提示（无则返回 None）
pub fn get_hint(db: &Database) -> Result<Option<String>, AppError> {
    db.get_config(KEY_HINT)
}

/// 校验 PIN（带错误次数限制）
/// 成功 → Ok(())，调用方负责更新前端解锁会话
/// 失败 → Err，包含人话提示（"PIN 错误"或"锁定中，X 秒后重试"）
pub fn verify_pin(db: &Database, pin: String) -> Result<(), AppError> {
    if !is_pin_set(db)? {
        return Err(AppError::InvalidInput("尚未设置 PIN".into()));
    }

    // 锁定检查
    let locked_until = load_i64(db, KEY_LOCKED_UNTIL)?.unwrap_or(0);
    let now = now_ts();
    if now < locked_until {
        let remaining = locked_until - now;
        return Err(AppError::Custom(format!(
            "连续输错被临时锁定，{} 秒后再试",
            remaining
        )));
    }

    let stored_hash =
        load_hash(db)?.ok_or_else(|| AppError::Custom("PIN 数据损坏：哈希解码失败".into()))?;
    let stored_salt =
        load_salt(db)?.ok_or_else(|| AppError::Custom("PIN 数据损坏：盐缺失".into()))?;
    let ok = crypto::verify_pin(&pin, &stored_salt, &stored_hash)?;

    if ok {
        // 重置失败计数
        db.set_config(KEY_FAIL_COUNT, "0")?;
        db.set_config(KEY_LOCKED_UNTIL, "0")?;
        Ok(())
    } else {
        let new_count = load_i64(db, KEY_FAIL_COUNT)?.unwrap_or(0) as u32 + 1;
        if new_count >= MAX_FAIL {
            // 触发锁定，清零计数下一次重新累计
            db.set_config(KEY_FAIL_COUNT, "0")?;
            db.set_config(KEY_LOCKED_UNTIL, &(now + LOCK_SECS).to_string())?;
            Err(AppError::Custom(format!(
                "连续输错 {} 次，锁定 {} 秒",
                MAX_FAIL, LOCK_SECS
            )))
        } else {
            db.set_config(KEY_FAIL_COUNT, &new_count.to_string())?;
            let left = MAX_FAIL - new_count;
            Err(AppError::Custom(format!("PIN 错误，还可尝试 {} 次", left)))
        }
    }
}

/// 清除 PIN（需当前 PIN 校验通过）
pub fn clear_pin(db: &Database, current_pin: String) -> Result<(), AppError> {
    if !is_pin_set(db)? {
        return Ok(());
    }
    // 用同样的限流校验，避免暴力清除
    verify_pin(db, current_pin)?;
    db.delete_config(KEY_HASH)?;
    db.delete_config(KEY_SALT)?;
    db.delete_config(KEY_FAIL_COUNT)?;
    db.delete_config(KEY_LOCKED_UNTIL)?;
    db.delete_config(KEY_HINT)?;
    Ok(())
}

// ─── helpers ──────────────────────────────────────────────────────────

fn load_hash(db: &Database) -> Result<Option<[u8; crypto::KEY_LEN]>, AppError> {
    let Some(s) = db.get_config(KEY_HASH)? else {
        return Ok(None);
    };
    let bytes = b64()
        .decode(s.trim())
        .map_err(|e| AppError::Custom(format!("PIN 哈希 base64 解码失败: {}", e)))?;
    if bytes.len() != crypto::KEY_LEN {
        return Err(AppError::Custom("PIN 哈希长度异常".into()));
    }
    let mut arr = [0u8; crypto::KEY_LEN];
    arr.copy_from_slice(&bytes);
    Ok(Some(arr))
}

fn load_salt(db: &Database) -> Result<Option<Vec<u8>>, AppError> {
    let Some(s) = db.get_config(KEY_SALT)? else {
        return Ok(None);
    };
    let bytes = b64()
        .decode(s.trim())
        .map_err(|e| AppError::Custom(format!("PIN 盐 base64 解码失败: {}", e)))?;
    Ok(Some(bytes))
}

fn load_i64(db: &Database, key: &str) -> Result<Option<i64>, AppError> {
    let Some(s) = db.get_config(key)? else {
        return Ok(None);
    };
    Ok(s.trim().parse::<i64>().ok())
}
