//! 定时推送服务层
//!
//! 子模块：
//! - `schedule_calc`：算"下次运行时刻"
//! - `dispatch`：把生成内容投递到各通道（MVP 系统通知）
//! - `scheduler`：常驻调度 loop（事件驱动 + 兜底唤醒，骨架照搬 task_reminder）
//!
//! 业务编排（跑提示词 → 投递 → 记日志）集中在本文件的 `PushService`。

pub mod dispatch;
pub mod schedule_calc;
pub mod scheduler;

use chrono::Local;
use tauri::AppHandle;

use crate::database::Database;
use crate::models::PushJob;
use crate::services::ai::AiService;

pub struct PushService;

impl PushService {
    /// 「定时推送」模块是否启用（设置→功能模块的总开关）。
    ///
    /// 真相源是 app_config 的 `enabled_views`（前端持久化的已启用可选视图 JSON 数组）：
    /// - 无该配置（全新用户，尚未保存过）→ 视为启用（与前端默认一致）
    /// - 有配置且不含 "push" → 模块被关 → 调度器静默推进但不投递
    /// 这样「关掉模块」= 连后台推送也停，符合用户预期。
    pub fn is_module_enabled(db: &Database) -> bool {
        match db.get_config("enabled_views") {
            Ok(Some(raw)) => match serde_json::from_str::<Vec<String>>(&raw) {
                Ok(list) => list.iter().any(|v| v == "push"),
                // 脏数据解析失败：保守视为启用，避免误停
                Err(_) => true,
            },
            // 无配置 = 全新用户，默认启用
            Ok(None) => true,
            // 读配置出错：保守视为启用
            Err(_) => true,
        }
    }

    /// 以"现在"为基准算下次运行时刻字符串（命令层建/改/启用推送时用）。
    pub fn next_run_from_now(
        schedule_time: &str,
        repeat_kind: &str,
        repeat_weekdays: Option<&str>,
    ) -> Option<String> {
        schedule_calc::compute_next_run(
            schedule_time,
            repeat_kind,
            repeat_weekdays,
            Local::now().naive_local(),
        )
    }

    /// 执行一条推送：跑提示词 → 投递 → 写运行日志。
    ///
    /// 无人值守：内部消化所有错误（写 run_log + 失败通知），绝不 panic、绝不向上抛，
    /// 以免拖垮调度 loop。MVP 只处理生成型（source_kind=none）；阶段 2 在调 AI 前按
    /// source_kind 抓数据拼进 prompt。
    pub async fn run_job(app: &AppHandle, db: &Database, job: &PushJob) {
        let run_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let prompt = job.prompt.clone();

        match AiService::complete_once(db, &prompt, job.model_id).await {
            Ok(content) => {
                // 先落库拿 log_id（弹窗通道要据此打开 #/push-popup/<id>），再投递
                match db.insert_push_run_log(job.id, &run_at, "success", 1, Some(&content), None) {
                    Ok(log_id) => dispatch::dispatch(app, job, &content, log_id),
                    Err(e) => {
                        log::warn!("[push] 写运行日志失败 (job #{}): {}", job.id, e);
                        // 没拿到 log_id：弹窗无法按 id 拉数据，退化为系统通知（dispatch 内 popup 失败也会兜底）
                        dispatch::dispatch_failure(app, job, &content);
                    }
                }
                log::info!("[push] 推送 #{} 「{}」执行成功", job.id, job.name);
            }
            Err(e) => {
                let err = e.to_string();
                let _ = db.insert_push_run_log(job.id, &run_at, "failed", 0, None, Some(&err));
                dispatch::dispatch_failure(app, job, &err);
                log::warn!("[push] 推送 #{} 「{}」执行失败: {}", job.id, job.name, err);
            }
        }
    }
}
