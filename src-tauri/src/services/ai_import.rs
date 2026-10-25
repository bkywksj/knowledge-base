//! AI 问答的 `request_import` 工具：AI 发起「把本地文件夹导入知识库」，由用户在弹窗里确认。
//!
//! 为什么不直接给 AI 读盘工具：笔记 / 网页剪藏 / 外部 MCP 的返回都可能夹带提示词注入，
//! 一旦 AI 能读任意路径、又有写库和外部联网工具，"读敏感文件 → 外传"的链路就闭合了。
//! 这里 AI 只能**提出**导入请求：读文件的始终是现有导入管线（`import_selected_files`），
//! 导不导、导哪些由用户在 `ImportPreviewModal` 里决定，AI 事后只拿到统计和新笔记 id。
//!
//! 流程：
//! 1. 工具调用 → 校验路径 / 写权限 → 生成 request_id，把 oneshot 发送端挂进 pending 表
//! 2. emit `ai:import-request` → 前端扫描并弹出导入预览
//! 3. 前端确认导入或取消后调 `ai_resolve_import` → oneshot 唤醒这里，结果回注给模型
//! 4. 用户点「停止」或超时 → 摘掉 pending、emit `ai:import-request-closed` 让前端收起弹窗

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

use crate::error::AppError;
use crate::state::AppState;

/// 工具名（无前缀，与内置 skills 同级）
pub const TOOL_NAME: &str = "request_import";

/// 兜底超时：从发出请求算起，含用户看预览 + 导入本身（几百篇可能要几分钟），所以给宽；
/// 主要的退出手段是「停止」按钮。超时按"未确认"回给模型，
/// 不让对话一直挂着
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 回给模型的新笔记 id 最多列多少个 —— 上百篇导入时全列会白占上下文，
/// 模型要整理时可以再按文件夹列出
const MAX_IDS_IN_RESULT: usize = 100;

/// 前端回传的处理结果
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOutcome {
    /// `"done"` 已导入 / `"cancelled"` 用户取消 / `"error"` 导入失败
    pub status: String,
    pub imported: u32,
    pub duplicated: u32,
    pub skipped: u32,
    pub note_ids: Vec<i64>,
    pub errors: Vec<String>,
    /// 失败原因等补充说明
    pub message: Option<String>,
}

/// 在途请求：request_id → 唤醒工具调用的发送端。
/// 进程级表而非 AppState 字段：只在本模块内读写，生命周期就是一次工具调用。
fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<ImportOutcome>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<ImportOutcome>>>> =
        OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 工具 schema（OpenAI tools 格式）。只在桌面端暴露 —— 移动端没有本地文件夹导入。
pub fn tool_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": "请求把用户电脑上的本地文件夹（或单个 .md 文件）导入知识库。\
                调用后会弹出导入预览窗，由用户确认要导入哪些文件；你读不到文件内容，\
                导入完成后只会拿到导入统计和新笔记 id，再用知识库工具（get_note / kb__* 等）按用户规则整理。\
                用户给出本地路径、想把电脑里的笔记放进知识库时使用。同一路径用户取消后不要重复发起。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "本地绝对路径，原样使用用户给的路径，如 D:\\14 知识库"
                    },
                    "folder_id": {
                        "type": "integer",
                        "description": "导入到哪个知识库文件夹（来自 kb__list_folders）；不填 = 根目录"
                    }
                },
                "required": ["path"]
            }
        }
    })
}

#[derive(Deserialize)]
struct Args {
    path: String,
    folder_id: Option<i64>,
}

/// 执行一次导入请求，挂起直到用户确认 / 取消、对话被停止或超时。返回回注给模型的文本。
pub async fn request(
    app: &AppHandle,
    conversation_id: i64,
    args_json: &str,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<String, AppError> {
    let args: Args = serde_json::from_str(args_json)
        .map_err(|e| AppError::Custom(format!("参数 JSON 解析失败: {e}；需要 {{\"path\": \"...\"}}")))?;
    let path = args.path.trim().trim_matches('"').to_string();
    if path.is_empty() {
        return Err(AppError::Custom("path 不能为空".into()));
    }

    // 导入就是写库，和 kb__ 写工具共用「AI 写权限」开关
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| AppError::Custom("应用状态未就绪".into()))?;
    if !crate::commands::mcp::read_ai_writable(&state) {
        return Err(AppError::Custom(
            "AI 写权限已关闭，不能发起导入。请让用户在 AI 问答页顶部打开「AI 写权限」，\
             或自己在笔记侧栏文件夹右键 →「导入 Markdown 文件夹…」"
                .into(),
        ));
    }

    let p = Path::new(&path);
    let meta = std::fs::metadata(p)
        .map_err(|e| AppError::Custom(format!("路径不存在或无法访问: {path}（{e}）")))?;
    let is_dir = meta.is_dir();
    if !is_dir {
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            return Err(AppError::Custom(format!(
                "只支持文件夹或 .md 文件：{path}。PDF / Word / TXT 请让用户用笔记侧栏右键菜单里对应的导入项"
            )));
        }
    }

    let request_id = format!(
        "imp-{}-{}",
        conversation_id,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let (tx, rx) = oneshot::channel();
    pending()
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?
        .insert(request_id.clone(), tx);

    app.emit(
        "ai:import-request",
        json!({
            "requestId": request_id,
            "conversationId": conversation_id,
            "path": path,
            "isDir": is_dir,
            "folderId": args.folder_id,
        }),
    )
    .map_err(|e| {
        drop_pending(&request_id);
        AppError::Custom(format!("通知前端失败: {e}"))
    })?;

    let outcome = tokio::select! {
        r = rx => r.ok(),
        _ = crate::services::ai::wait_cancelled(cancel_rx) => {
            close_request(app, &request_id);
            return Ok("用户停止了本次对话，导入未执行。".into());
        }
        _ = tokio::time::sleep(CONFIRM_TIMEOUT) => {
            close_request(app, &request_id);
            return Ok("用户长时间没有确认导入，已放弃。不要重复发起，请询问用户是否还要导入。".into());
        }
    };

    Ok(match outcome {
        Some(o) => describe(&path, &o),
        // 发送端被丢弃 = 前端没按流程回传（如窗口被关），按未确认处理
        None => "导入弹窗被关闭，导入未执行。".into(),
    })
}

/// 前端回传结果，唤醒对应的工具调用。request 已超时 / 被停止时静默忽略。
pub fn resolve(request_id: &str, outcome: ImportOutcome) -> Result<(), AppError> {
    let tx = pending()
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?
        .remove(request_id);
    if let Some(tx) = tx {
        let _ = tx.send(outcome);
    }
    Ok(())
}

fn drop_pending(request_id: &str) {
    if let Ok(mut map) = pending().lock() {
        map.remove(request_id);
    }
}

/// 不再等这个请求：摘掉 pending，并让前端收起还开着的弹窗
fn close_request(app: &AppHandle, request_id: &str) {
    drop_pending(request_id);
    let _ = app.emit("ai:import-request-closed", json!({ "requestId": request_id }));
}

/// 把前端结果整理成给模型看的文本
fn describe(path: &str, o: &ImportOutcome) -> String {
    match o.status.as_str() {
        "done" => {
            let mut s = format!(
                "用户已确认导入 {path}：新建 {} 篇，副本 {} 篇，跳过（已存在）{} 篇。",
                o.imported, o.duplicated, o.skipped
            );
            if !o.note_ids.is_empty() {
                let shown: Vec<String> = o
                    .note_ids
                    .iter()
                    .take(MAX_IDS_IN_RESULT)
                    .map(|id| id.to_string())
                    .collect();
                s.push_str(&format!("\n新笔记 id：{}", shown.join(", ")));
                if o.note_ids.len() > MAX_IDS_IN_RESULT {
                    s.push_str(&format!(
                        " …（共 {} 篇，其余可按文件夹列出）",
                        o.note_ids.len()
                    ));
                }
            }
            if !o.errors.is_empty() {
                s.push_str(&format!("\n{} 个文件导入失败：{}", o.errors.len(), o.errors.join("；")));
            }
            s.push_str("\n接下来可用 get_note / kb__* 工具读取并按用户规则整理这些笔记。");
            s
        }
        "cancelled" => "用户在预览窗里取消了导入。不要重复发起，请询问用户下一步。".into(),
        _ => format!(
            "导入失败：{}。请把原因告诉用户。",
            o.message.as_deref().unwrap_or("未知错误")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_done_truncates_ids() {
        let o = ImportOutcome {
            status: "done".into(),
            imported: 120,
            note_ids: (1..=120).collect(),
            ..Default::default()
        };
        let s = describe("D:\\x", &o);
        assert!(s.contains("新建 120 篇"));
        assert!(s.contains("共 120 篇"));
        assert!(!s.contains(", 101,"));
    }

    #[test]
    fn describe_cancelled_and_error() {
        let c = ImportOutcome { status: "cancelled".into(), ..Default::default() };
        assert!(describe("p", &c).contains("取消"));
        let e = ImportOutcome {
            status: "error".into(),
            message: Some("磁盘满".into()),
            ..Default::default()
        };
        assert!(describe("p", &e).contains("磁盘满"));
    }

    #[test]
    fn resolve_unknown_request_is_noop() {
        assert!(resolve("not-exist", ImportOutcome::default()).is_ok());
    }

    #[tokio::test]
    async fn resolve_wakes_pending_request() {
        let (tx, rx) = oneshot::channel();
        pending().lock().unwrap().insert("t1".into(), tx);
        resolve("t1", ImportOutcome { status: "done".into(), imported: 3, ..Default::default() })
            .unwrap();
        assert_eq!(rx.await.unwrap().imported, 3);
        assert!(!pending().lock().unwrap().contains_key("t1"));
    }
}
