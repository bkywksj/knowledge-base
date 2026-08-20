//! 应用启动锁（软锁 / UX 门禁，不是数据加密）
//!
//! 设计要点（与 hidden_pin 同源，独立一套配置键）：
//! - 进入密码只挡"打开软件"这一个入口；笔记数据库里仍是明文
//!   （要真加密请用 Vault）。防的是"公用电脑被家人/同事顺手翻"。
//! - 与 Vault 主密码、HiddenPin 完全独立：忘密码可在设置页关闭（需当前密码）
//! - 错误次数限制：连续错 MAX_FAIL 次冷却 LOCK_SECS 秒，防暴力
//! - 哈希用 Argon2id（复用 crypto::hash_pin / verify_pin），扛离线字典攻击
//! - 额外存"闲置自动锁定分钟数"，0 = 关闭；由前端计时，后端只负责持久化
//!
//! "锁是否开启" = 是否设过密码（hash 存在），不再单独存 enabled 标志，
//! 与 HiddenPin 的 is_pin_set 模型一致，避免两处状态打架。

use base64::Engine;

use crate::database::Database;
use crate::error::AppError;
use crate::models::AppLockStatus;
use crate::crypto;

const KEY_HASH: &str = "app_lock_hash";
const KEY_SALT: &str = "app_lock_salt";
const KEY_FAIL_COUNT: &str = "app_lock_fail_count";
const KEY_LOCKED_UNTIL: &str = "app_lock_locked_until";
const KEY_HINT: &str = "app_lock_hint";
const KEY_AUTO_MINUTES: &str = "app_lock_auto_minutes";

const MAX_FAIL: u32 = 5;
const LOCK_SECS: i64 = 60;
const PWD_MIN_LEN: usize = 4;
const PWD_MAX_LEN: usize = 64;
const HINT_MAX_LEN: usize = 100;
/// 闲置自动锁定分钟数上限（4 小时）；0 = 关闭
const AUTO_MINUTES_MAX: i64 = 240;

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn validate_password(pwd: &str) -> Result<(), AppError> {
    let len = pwd.chars().count();
    if len < PWD_MIN_LEN || len > PWD_MAX_LEN {
        return Err(AppError::InvalidInput(format!(
            "密码长度需在 {}~{} 之间",
            PWD_MIN_LEN, PWD_MAX_LEN
        )));
    }
    Ok(())
}

/// 校验提示文本：长度限制 + 不能直接泄露密码
///
/// 不能包含密码是关键安全约束 —— 否则用户写"我的密码是 1234"就把保护破了。
/// 大小写不敏感地比较，避免简单大小写绕过。
fn validate_hint(hint: &str, pwd: &str) -> Result<(), AppError> {
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
    let pwd_lower = pwd.to_lowercase();
    if !pwd_lower.is_empty() && hint_lower.contains(&pwd_lower) {
        return Err(AppError::InvalidInput(
            "提示不能包含密码本身（这会使保护失效）".into(),
        ));
    }
    Ok(())
}

/// 是否已设置进入密码（= 锁是否开启）
pub fn is_set(db: &Database) -> Result<bool, AppError> {
    Ok(db.get_config(KEY_HASH)?.is_some())
}

/// 当前完整状态：是否开启 + 闲置自动锁定分钟数
pub fn status(db: &Database) -> Result<AppLockStatus, AppError> {
    Ok(AppLockStatus {
        enabled: is_set(db)?,
        auto_lock_minutes: get_auto_minutes(db)?,
    })
}

/// 设置/修改进入密码（可选附带提示）
/// - 若已设过：必须传 old_password 并校验通过
/// - hint = None 表示不修改现有提示；Some("") 表示清空提示
/// - 设置成功后清空失败计数与锁定时间
pub fn set_password(
    db: &Database,
    old_password: Option<String>,
    new_password: String,
    hint: Option<String>,
) -> Result<(), AppError> {
    validate_password(&new_password)?;
    if let Some(ref h) = hint {
        validate_hint(h, &new_password)?;
    }

    if is_set(db)? {
        let old = old_password.ok_or_else(|| {
            AppError::InvalidInput("已设置进入密码，需提供当前密码才能修改".into())
        })?;
        // 直接调内部 verify（不走错误次数限制：修改场景下用户主动操作）
        let stored_hash = load_hash(db)?
            .ok_or_else(|| AppError::Custom("密码数据损坏：哈希存在但解码失败".into()))?;
        let stored_salt =
            load_salt(db)?.ok_or_else(|| AppError::Custom("密码数据损坏：盐缺失".into()))?;
        let ok = crypto::verify_pin(&old, &stored_salt, &stored_hash)?;
        if !ok {
            return Err(AppError::InvalidInput("当前密码不正确".into()));
        }
    }

    let salt = crypto::new_salt();
    let hash = crypto::hash_pin(&new_password, &salt)?;
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

/// 获取密码提示（无则返回 None）
pub fn get_hint(db: &Database) -> Result<Option<String>, AppError> {
    db.get_config(KEY_HINT)
}

/// 读取闲置自动锁定分钟数（无值/解析失败 = 0 关闭）
pub fn get_auto_minutes(db: &Database) -> Result<i64, AppError> {
    Ok(load_i64(db, KEY_AUTO_MINUTES)?.unwrap_or(0).clamp(0, AUTO_MINUTES_MAX))
}

/// 设置闲置自动锁定分钟数（clamp 到 [0, AUTO_MINUTES_MAX]；0 = 关闭）
pub fn set_auto_minutes(db: &Database, minutes: i64) -> Result<(), AppError> {
    let clamped = minutes.clamp(0, AUTO_MINUTES_MAX);
    db.set_config(KEY_AUTO_MINUTES, &clamped.to_string())?;
    Ok(())
}

/// 校验进入密码（带错误次数限制）
/// 成功 → Ok(())，调用方负责更新前端解锁会话
/// 失败 → Err，包含人话提示（"密码错误"或"锁定中，X 秒后重试"）
pub fn verify(db: &Database, password: String) -> Result<(), AppError> {
    if !is_set(db)? {
        return Err(AppError::InvalidInput("尚未设置进入密码".into()));
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
        load_hash(db)?.ok_or_else(|| AppError::Custom("密码数据损坏：哈希解码失败".into()))?;
    let stored_salt =
        load_salt(db)?.ok_or_else(|| AppError::Custom("密码数据损坏：盐缺失".into()))?;
    let ok = crypto::verify_pin(&password, &stored_salt, &stored_hash)?;

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
            Err(AppError::Custom(format!("密码错误，还可尝试 {} 次", left)))
        }
    }
}

/// 关闭应用锁（需当前密码校验通过）。清空所有相关配置（含自动锁定分钟数）。
pub fn disable(db: &Database, current_password: String) -> Result<(), AppError> {
    if !is_set(db)? {
        return Ok(());
    }
    // 用同样的限流校验，避免暴力关闭
    verify(db, current_password)?;
    db.delete_config(KEY_HASH)?;
    db.delete_config(KEY_SALT)?;
    db.delete_config(KEY_FAIL_COUNT)?;
    db.delete_config(KEY_LOCKED_UNTIL)?;
    db.delete_config(KEY_HINT)?;
    db.delete_config(KEY_AUTO_MINUTES)?;
    Ok(())
}

// ─── helpers ──────────────────────────────────────────────────────────

fn load_hash(db: &Database) -> Result<Option<[u8; crypto::KEY_LEN]>, AppError> {
    let Some(s) = db.get_config(KEY_HASH)? else {
        return Ok(None);
    };
    let bytes = b64()
        .decode(s.trim())
        .map_err(|e| AppError::Custom(format!("密码哈希 base64 解码失败: {}", e)))?;
    if bytes.len() != crypto::KEY_LEN {
        return Err(AppError::Custom("密码哈希长度异常".into()));
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
        .map_err(|e| AppError::Custom(format!("密码盐 base64 解码失败: {}", e)))?;
    Ok(Some(bytes))
}

fn load_i64(db: &Database, key: &str) -> Result<Option<i64>, AppError> {
    let Some(s) = db.get_config(key)? else {
        return Ok(None);
    };
    Ok(s.trim().parse::<i64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Database {
        Database::init(":memory:").unwrap()
    }

    #[test]
    fn not_set_by_default() {
        let db = mem_db();
        assert!(!is_set(&db).unwrap());
        let st = status(&db).unwrap();
        assert!(!st.enabled);
        assert_eq!(st.auto_lock_minutes, 0);
    }

    #[test]
    fn set_then_verify() {
        let db = mem_db();
        set_password(&db, None, "1234".into(), Some("家里地址".into())).unwrap();
        assert!(is_set(&db).unwrap());
        // 正确密码通过
        assert!(verify(&db, "1234".into()).is_ok());
        // 错误密码失败
        assert!(verify(&db, "9999".into()).is_err());
        // 提示已存
        assert_eq!(get_hint(&db).unwrap().as_deref(), Some("家里地址"));
    }

    #[test]
    fn change_requires_old_password() {
        let db = mem_db();
        set_password(&db, None, "1234".into(), None).unwrap();
        // 不给旧密码改 → 报错
        assert!(set_password(&db, None, "5678".into(), None).is_err());
        // 旧密码错 → 报错
        assert!(set_password(&db, Some("0000".into()), "5678".into(), None).is_err());
        // 旧密码对 → 成功
        set_password(&db, Some("1234".into()), "5678".into(), None).unwrap();
        assert!(verify(&db, "5678".into()).is_ok());
    }

    #[test]
    fn hint_cannot_contain_password() {
        let db = mem_db();
        // 提示包含密码（大小写不敏感）→ 拒绝
        assert!(set_password(&db, None, "abcd".into(), Some("my pin ABCD!".into())).is_err());
    }

    #[test]
    fn disable_clears_everything() {
        let db = mem_db();
        set_password(&db, None, "1234".into(), Some("x".into())).unwrap();
        set_auto_minutes(&db, 10).unwrap();
        // 错误密码不能关
        assert!(disable(&db, "0000".into()).is_err());
        // 正确密码关闭
        disable(&db, "1234".into()).unwrap();
        assert!(!is_set(&db).unwrap());
        assert_eq!(get_auto_minutes(&db).unwrap(), 0);
        assert!(get_hint(&db).unwrap().is_none());
    }

    #[test]
    fn auto_minutes_clamped() {
        let db = mem_db();
        set_auto_minutes(&db, 9999).unwrap();
        assert_eq!(get_auto_minutes(&db).unwrap(), AUTO_MINUTES_MAX);
        set_auto_minutes(&db, -5).unwrap();
        assert_eq!(get_auto_minutes(&db).unwrap(), 0);
    }
}
