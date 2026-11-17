use crate::database::Database;
use crate::error::AppError;
use crate::models::{DailyEntry, Note};

/// 每日笔记服务
pub struct DailyService;

impl DailyService {
    /// 查询每日笔记（不创建）
    pub fn get(db: &Database, date: &str) -> Result<Option<Note>, AppError> {
        validate_date(date)?;
        db.get_daily(date)
    }

    /// 获取或创建每日笔记
    pub fn get_or_create(db: &Database, date: &str) -> Result<Note, AppError> {
        validate_date(date)?;
        db.get_or_create_daily(date)
    }

    /// 找当前日期相邻的"真实存在"的日记日期。
    /// 用于每日笔记顶部 ← / → 按钮跳转——按真实日记跳，跳过没写的日子。
    pub fn get_neighbors(
        db: &Database,
        date: &str,
    ) -> Result<(Option<String>, Option<String>), AppError> {
        validate_date(date)?;
        db.get_daily_neighbors(date)
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

    /// 列出全部日记（前端按年月折叠分组渲染用）
    pub fn list_all(db: &Database) -> Result<Vec<DailyEntry>, AppError> {
        db.list_all_dailies()
    }

    /// 快速记一笔（全局快捷键入口）：把一段文字带 `[HH:MM]` 时间戳追加到今天的日记末尾。
    ///
    /// 写法与首页「记一笔」（PC 首页 / 手机端 mobileQuickNote.ts）一致：
    /// `<p><strong>[HH:MM]</strong> 第一行<br>第二行</p>`。以前这里写的是带 🕐 的 info callout，
    /// 和首页记出来的条目混在同一篇日记里，蓝框 + 图标显得突兀（用户反馈）；旧日记里的 callout
    /// 条目不改写，手机日记时间线（dailyTimeline.ts）仍认得。
    ///
    /// 返回当天日记的 id —— 前端可选择性跳转过去查看效果。
    pub fn append_quick_capture(db: &Database, text: &str) -> Result<i64, AppError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AppError::InvalidInput("内容不能为空".into()));
        }

        let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        let note = db.get_or_create_daily(&today)?;

        let now = chrono::Local::now().format("%H:%M").to_string();
        // 转义用户文本里的 HTML 特殊字符，避免破坏 raw HTML 块结构
        fn esc(s: &str) -> String {
            s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        }
        // 多行用 <br> 接在同一段里（空行跳过）：整块挤在一行，markdown-it 的 raw HTML 块遇到空行会提前中断
        let body = text
            .lines()
            .map(|l| l.trim_end())
            .filter(|l| !l.is_empty())
            .map(esc)
            .collect::<Vec<_>>()
            .join("<br>");
        let block = format!("<p><strong>[{}]</strong> {}</p>", now, body);

        // 与已有内容之间留一个空行，确保 markdown-it 把它当作独立的 HTML 块解析
        let new_content = if note.content.is_empty() {
            block
        } else if note.content.ends_with("\n\n") {
            format!("{}{}", note.content, block)
        } else if note.content.ends_with('\n') {
            format!("{}\n{}", note.content, block)
        } else {
            format!("{}\n\n{}", note.content, block)
        };

        db.update_note_content(note.id, &new_content)?;
        Ok(note.id)
    }
}

/// 验证日期格式 YYYY-MM-DD
fn validate_date(date: &str) -> Result<(), AppError> {
    if date.len() != 10 || date.chars().nth(4) != Some('-') || date.chars().nth(7) != Some('-') {
        return Err(AppError::InvalidInput("日期格式必须为 YYYY-MM-DD".into()));
    }

    // 验证年月日是否为有效数字
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(AppError::InvalidInput("日期格式必须为 YYYY-MM-DD".into()));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 快捷键记一笔与首页「记一笔」同一写法：`[HH:MM]` 加粗前缀，多行用 <br>，HTML 转义
    #[test]
    fn quick_capture_uses_bracket_stamp_like_home() {
        let db = Database::init(":memory:").unwrap();
        let id = DailyService::append_quick_capture(&db, "第一行\n\n<b>第二行</b>").unwrap();
        let content = db.get_note(id).unwrap().unwrap().content;
        assert!(!content.contains("data-callout"));
        let block = content.rsplit("\n\n").next().unwrap();
        assert!(block.starts_with("<p><strong>["), "{block}");
        assert!(block.ends_with("</strong> 第一行<br>&lt;b&gt;第二行&lt;/b&gt;</p>"), "{block}");
    }
}
