use crate::database::Database;
use crate::error::AppError;
use crate::models::Note;

/// 每日笔记服务
pub struct DailyService;

impl DailyService {
    /// 获取或创建每日笔记
    pub fn get_or_create(db: &Database, date: &str) -> Result<Note, AppError> {
        validate_date(date)?;
        db.get_or_create_daily(date)
    }

    /// 获取某月有日记的日期列表
    pub fn list_dates(db: &Database, year: i32, month: i32) -> Result<Vec<String>, AppError> {
        if !(1..=12).contains(&month) {
            return Err(AppError::InvalidInput("月份必须在 1-12 之间".into()));
        }
        if year < 1970 || year > 9999 {
            return Err(AppError::InvalidInput("年份无效".into()));
        }
        db.list_daily_dates(year, month)
    }
}

/// 验证日期格式 YYYY-MM-DD
fn validate_date(date: &str) -> Result<(), AppError> {
    if date.len() != 10
        || date.chars().nth(4) != Some('-')
        || date.chars().nth(7) != Some('-')
    {
        return Err(AppError::InvalidInput(
            "日期格式必须为 YYYY-MM-DD".into(),
        ));
    }

    // 验证年月日是否为有效数字
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(AppError::InvalidInput(
            "日期格式必须为 YYYY-MM-DD".into(),
        ));
    }

    let _year: i32 = parts[0]
        .parse()
        .map_err(|_| AppError::InvalidInput("年份无效".into()))?;
    let month: i32 = parts[1]
        .parse()
        .map_err(|_| AppError::InvalidInput("月份无效".into()))?;
    let day: i32 = parts[2]
        .parse()
        .map_err(|_| AppError::InvalidInput("日期无效".into()))?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(AppError::InvalidInput("日期不合法".into()));
    }

    Ok(())
}
