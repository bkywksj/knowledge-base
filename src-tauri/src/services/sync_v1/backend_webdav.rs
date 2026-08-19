//! WebDAV V1 backend：复用现有 `services::webdav::WebDavClient`
//!
//! 远端目录结构（与 LocalPathBackend 一致）：
//!   <base_url>/manifest.json
//!   <base_url>/notes/<stable_id>.md
//!
//! 注意：
//! - 用户应该在 WebDAV server 端先建好"基目录"（坚果云 / Cloudreve / Nextcloud 都允许在 UI 创建）
//! - 子目录 `notes/` 在首次 put 时自动 MKCOL

use crate::error::AppError;
use crate::models::SyncManifestV1;
use crate::services::sync_v1::runtime::block_on;
use crate::services::webdav::WebDavClient;

use super::backend::{SyncBackendImpl, MANIFEST_FILENAME};

pub struct WebdavBackend {
    client: WebDavClient,
}

impl WebdavBackend {
    pub fn new(url: &str, username: &str, password: &str) -> Self {
        Self {
            client: WebDavClient::new(url, username, password),
        }
    }
}

impl SyncBackendImpl for WebdavBackend {
    fn name(&self) -> &'static str {
        "webdav"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        block_on(self.client.test_connection())
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        let bytes_opt = block_on(self.client.download_bytes_optional(MANIFEST_FILENAME))?;
        match bytes_opt {
            None => Ok(None),
            Some(bytes) => {
                let m: SyncManifestV1 = serde_json::from_slice(&bytes)
                    .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {}", e)))?;
                Ok(Some(m))
            }
        }
    }

    /// 原子写 manifest：先 PUT 到 `manifest.json.tmp.<uuid>`，再 MOVE 到 `manifest.json`。
    ///
    /// 修「中途断网/服务器超时 → 远端落半截 JSON → 下次 pull 解析失败 / 全量误判」的隐患
    /// （之前直接 `upload_bytes(MANIFEST_FILENAME, …)` 是非原子覆盖）。
    /// MOVE 失败时 best-effort 清掉 .tmp，避免远端堆积无主临时文件。
    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {}", e)))?;
        let tmp_name = format!(
            "{}.tmp.{}",
            MANIFEST_FILENAME,
            uuid::Uuid::new_v4().simple()
        );
        block_on(async {
            // 先 PUT 到临时文件（bytes 先 clone 一份，留给 MOVE 不被支持时的降级 PUT 复用）
            self.client.upload_bytes(&tmp_name, bytes.clone()).await?;
            match self.client.move_file(&tmp_name, MANIFEST_FILENAME).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    let msg = e.to_string();
                    // MOVE 只要不是认证失败，一律降级为直接 PUT 覆盖 manifest.json
                    // （判定与理由见 `move_err_downgrade_reason`）
                    match move_err_downgrade_reason(&msg) {
                        Some(reason) => {
                            log::warn!(
                                "[sync_v1] WebDAV MOVE 换名失败（{}：{}），降级为直接 PUT manifest.json",
                                reason,
                                msg.lines().next().unwrap_or("")
                            );
                            let put_res = self.client.upload_bytes(MANIFEST_FILENAME, bytes).await;
                            // 不论降级 PUT 成功与否，都尽量清掉临时文件，避免远端堆积无主 .tmp
                            let _ = self.client.delete_file(&tmp_name).await;
                            put_res
                        }
                        None => {
                            // 认证失败：降级 PUT 也必然被拒，直接清理 tmp 后原样上报，
                            // 免得再发一次注定 401 的请求、还把错误信息换成更含糊的那条
                            // （tmp 清不掉也只是远端多一个无主文件，下次 GC 可以扫）
                            let _ = self.client.delete_file(&tmp_name).await;
                            Err(e)
                        }
                    }
                }
            }
        })
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        block_on(self.client.upload_bytes(path, content.as_bytes().to_vec()))
    }

    /// T-S031 + 限流加固：并发批量上传
    ///
    /// 上传速度 vs 服务器限流（nginx `limit_req` 触发 → 503）之间取平衡：
    ///   1. 先把所有要写入的父目录 MKCOL **一遍**（不是每篇都来一次）→ 请求数砍一半；撞 5xx 退避重试一次，
    ///      仍失败 → 整批中止，返回一条清晰的"服务器繁忙/限流"错误（避免几十行 503 HTML）。
    ///   2. 目录就绪后逐条 PUT（`put_into_existing_dir`，不再 MKCOL），并发数由调用方给（`max_concurrency`，
    ///      调用方按"撞限流就调小、顺畅就调大"自适应）；至少 1 路。
    ///   3. 单条 PUT 撞 5xx（限流/网关）时**指数退避重试**（共 3 次：立即 / +1s / +3s）→ 偶发限流自愈，不直接判失败。
    fn batch_put_notes(
        &self,
        items: &[(String, String)],
        max_concurrency: usize,
    ) -> Vec<Result<(), AppError>> {
        if items.is_empty() {
            return vec![];
        }
        use std::collections::HashSet;
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        // ── 1. 一次性 MKCOL 所有父目录（带 1 次退避重试）──
        let parent_dirs: Vec<String> = {
            let mut set: HashSet<String> = HashSet::new();
            for (path, _) in items {
                if let Some((dir, _)) = path.rsplit_once('/') {
                    if !dir.is_empty() {
                        set.insert(dir.to_string());
                    }
                }
            }
            set.into_iter().collect()
        };
        let ensure_err: Option<AppError> = block_on(async {
            for attempt in 0..2u8 {
                let mut err: Option<AppError> = None;
                for d in &parent_dirs {
                    if let Err(e) = self.client.ensure_dir(d).await {
                        err = Some(e);
                        break;
                    }
                }
                match err {
                    None => return None,
                    Some(e) => {
                        if attempt == 0 && is_transient_server_err(&e.to_string()) {
                            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                            continue;
                        }
                        return Some(e);
                    }
                }
            }
            None
        });
        if let Some(e) = ensure_err {
            let msg = e.to_string();
            let condensed = if is_transient_server_err(&msg) {
                "WebDAV 服务器繁忙 / 被限流（返回 5xx），本次推送已中止。多半是并发请求太多触发了服务器 nginx 限速，稍后再试即可；若一直这样，多半是该 WebDAV 服务负载偏低。".to_string()
            } else {
                format!(
                    "远端目录创建失败，本次推送已中止：{}",
                    msg.lines().next().unwrap_or(&msg)
                )
            };
            return vec![Err(AppError::Custom(condensed))];
        }

        // ── 2. 并发逐条 PUT（目录已就绪，不再 MKCOL）；单条撞 5xx 指数退避重试 ──
        let sem = Arc::new(Semaphore::new(max_concurrency.max(1)));
        let owned: Vec<(String, String)> = items.to_vec();
        block_on(async move {
            let mut handles = Vec::with_capacity(owned.len());
            for (path, content) in owned {
                let client = self.client.clone();
                let sem = Arc::clone(&sem);
                handles.push(tokio::spawn(async move {
                    let _permit = match sem.acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => return Err(AppError::Custom("Semaphore 已关闭".into())),
                    };
                    let bytes = content.into_bytes();
                    // 3 次尝试：立即 / +1s / +3s；只对临时性 5xx 重试
                    let backoffs = [0u64, 1000, 3000];
                    let mut last: Result<(), AppError> = Ok(());
                    for (i, delay_ms) in backoffs.iter().enumerate() {
                        if *delay_ms > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
                        }
                        match client.put_into_existing_dir(&path, bytes.clone()).await {
                            Ok(()) => {
                                last = Ok(());
                                break;
                            }
                            Err(e) => {
                                let retry = i + 1 < backoffs.len()
                                    && is_transient_server_err(&e.to_string());
                                last = Err(e);
                                if !retry {
                                    break;
                                }
                            }
                        }
                    }
                    last
                }));
            }
            let mut out = Vec::with_capacity(handles.len());
            for h in handles {
                out.push(match h.await {
                    Ok(r) => r,
                    Err(e) => Err(AppError::Custom(format!("并发上传任务 panic: {}", e))),
                });
            }
            out
        })
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        let bytes_opt = block_on(self.client.download_bytes_optional(path))?;
        Ok(bytes_opt.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        block_on(self.client.delete_file(path))
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = super::backend::cas_path(hash);
        block_on(self.client.upload_bytes(&path, bytes.to_vec()))
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        let path = super::backend::cas_path(hash);
        block_on(self.client.download_bytes_optional(&path))
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        // P1-4：用 HEAD 探测（不传 body）。之前用 download_bytes_optional（GET）会把
        // 整份附件下载下来只为判断存在性 → 每次 push 都重下全部远端附件，大库浪费带宽。
        let path = super::backend::cas_path(hash);
        block_on(self.client.head_exists(&path))
    }

    /// T-S025: 用 PROPFIND Depth:infinity 递归列 attachments/ 下所有附件文件名（即 hash）
    ///
    /// 大多数 WebDAV 服务器（坚果云 / Nextcloud / Cloudreve）支持 infinity；少数（Apache mod_dav
    /// 默认配置）禁用 → 收到 403 时降级返回空（GC 对这类服务器 no-op，不报错）。
    fn list_attachment_hashes(&self) -> Result<Vec<String>, AppError> {
        let hrefs = match block_on(self.client.list_hrefs_under("attachments", "infinity")) {
            Ok(h) => h,
            Err(e) => {
                log::warn!(
                    "[sync_v1] WebDAV PROPFIND attachments/ (infinity) 失败 ({}), GC 跳过该 backend",
                    e
                );
                return Ok(vec![]);
            }
        };
        Ok(hrefs_to_attachment_hashes(&hrefs))
    }
}

/// 错误信息看着像"服务器繁忙 / 限流 / 网关挂了"这类**临时性 5xx**吗？
/// 用于决定要不要退避重试 + 给用户一条"过会儿再试"而不是一坨 503 HTML。
pub(crate) fn is_transient_server_err(msg: &str) -> bool {
    msg.contains("503")
        || msg.contains("502")
        || msg.contains("504")
        || msg.contains("Service Unavailable")
        || msg.contains("Service Temporarily Unavailable")
        || msg.contains("Bad Gateway")
        || msg.contains("Gateway Time-out")
        || msg.contains("Gateway Timeout")
}

/// manifest 的 MOVE 换名失败后，该不该降级成直接 PUT 覆盖 `manifest.json`？
///
/// `Some(原因)` = 降级（原因只进日志）；`None` = 不降级、把错误原样上报。
///
/// 规则：**只要不是认证失败，一律降级**。
///
/// 之前这里是"状态码白名单"（405/501/502/400 + 409），每遇到一种新服务器就得补一次名单：
/// 飞牛/群晖反代回 502、坚果云回 409 DuplicateName、某些 NAS / Alist 处理"MOVE 到已存在
/// 目标"时直接回 500 Internal Server Error —— 500 不在名单里就直接判推送失败
/// （用户实测症状：能拉不能推，卡在"写远端 manifest 失败"）。故改为反向判定，
/// 不再逐个状态码打补丁。
///
/// 为什么这样安全：
///   - 401/403 在 `WebDavClient::move_file` 内已被单独识别成"认证失败"，不会降级，
///     鉴权问题仍然如实上报（`is_move_auth_failure`）。
///   - 直接 PUT 覆盖本就是写 manifest 的合法终态（tauri-cc 一直这么写）：manifest 体积小，
///     PUT 传输不完整时服务端不会提交半截文件。
///   - 即便降级判断"过宽"（服务器真挂了、网络断了），降级 PUT 同样会失败并把真实错误
///     如实上报，不会掩盖问题。
pub(crate) fn move_err_downgrade_reason(msg: &str) -> Option<&'static str> {
    if is_move_auth_failure(msg) {
        None
    } else if is_move_dest_exists(msg) {
        Some("目标已存在且服务器不支持 MOVE 覆盖（坚果云式 409 DuplicateName）")
    } else if is_move_unsupported(msg) {
        Some("服务器不支持 MOVE 方法")
    } else {
        Some("MOVE 换名失败（服务器 500 等未分类原因）")
    }
}

/// MOVE 的错误是"认证失败"吗？—— **唯一不降级为 PUT 的情况**（见 `move_err_downgrade_reason`）。
///
/// `WebDavClient::move_file` 收到 401/403 时不会带状态码上报，而是统一转成
/// "认证失败，请检查用户名/密码"，所以这里主要认这句中文；状态码字样一并兜住，
/// 防止将来别处构造的错误信息没走那条转换。
///
/// 认证失败时降级 PUT 也必然被同样拒掉，只会多发一次请求、还把清晰的"认证失败"
/// 换成含糊的上传错误，故直接原样上报。
pub(crate) fn is_move_auth_failure(msg: &str) -> bool {
    msg.contains("认证失败") || msg.contains("401") || msg.contains("403")
}

/// 错误信息看着像"服务器 / 反向代理根本不支持 WebDAV MOVE 方法"吗？
///
/// 飞牛 NAS（fnOS）、群晖等经公网反代暴露 WebDAV 时，MOVE 常被反代或上游拒掉：
/// - 405 Method Not Allowed：服务端显式不允许 MOVE
/// - 501 Not Implemented：服务端没实现 MOVE
/// - 502 Bad Gateway：反代无法把 MOVE 透传给上游（用户实测就是这个）
/// - 400 Bad Request：个别反代对未知方法直接报 400
///
/// ⚠️ 仅用于**在日志里写清降级原因**：是否降级由 `write_manifest` 按
/// "非认证失败一律降级"决定，不再依赖本函数命中（500 等未分类原因同样降级）。
pub(crate) fn is_move_unsupported(msg: &str) -> bool {
    msg.contains("405")
        || msg.contains("Method Not Allowed")
        || msg.contains("501")
        || msg.contains("Not Implemented")
        || msg.contains("502")
        || msg.contains("Bad Gateway")
        || msg.contains("400")
        || msg.contains("Bad Request")
}

/// 错误信息看着像"MOVE 目标已存在、服务器拒绝覆盖"吗？
///
/// 坚果云的 WebDAV **不遵守 `Overwrite: T`**：当 MOVE 的目标文件已存在时，不覆盖，
/// 而是返回 `409 Conflict` + `<s:exception>DuplicateName</s:exception>`（消息形如
/// "The object on path /manifest.json existed"）。
/// 因为 manifest 原子写是「PUT 到 .tmp → MOVE 改名到 manifest.json」，首次推送目标不存在
/// 能成功，之后每次 manifest.json 都已存在就必挂在 409 —— 降级为直接 PUT 覆盖
/// （见 `write_manifest`）。
///
/// ⚠️ 同 `is_move_unsupported`：本函数现在只负责给日志分类降级原因，不决定是否降级。
pub(crate) fn is_move_dest_exists(msg: &str) -> bool {
    msg.contains("DuplicateName")
        || msg.contains("existed")
        || msg.contains("409")
        || msg.contains("Conflict")
}

/// 从 PROPFIND href 列表提取附件 hash（纯函数，便于单测）
///
/// 规则：跳过目录（href 以 `/` 结尾）、跳过 `_` 开头的特殊文件、跳过 manifest.json；
/// 取每个 href 路径的最后一段作为 hash；结果排序去重。
fn hrefs_to_attachment_hashes(hrefs: &[String]) -> Vec<String> {
    let mut hashes: Vec<String> = hrefs
        .iter()
        .filter(|h| !h.ends_with('/'))
        .filter_map(|h| h.rsplit('/').next())
        .filter(|n| !n.is_empty() && !n.starts_with('_') && *n != "manifest.json")
        .map(|n| n.to_string())
        .collect();
    hashes.sort();
    hashes.dedup();
    hashes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hrefs_to_attachment_hashes_filters_dirs_and_specials() {
        let hrefs = vec![
            "/dav/folder/attachments/".to_string(),                  // 目录自身
            "/dav/folder/attachments/aa/".to_string(),               // 子目录
            "/dav/folder/attachments/aa/bb/".to_string(),            // 子目录
            "/dav/folder/attachments/aa/bb/hash_one".to_string(),    // 文件 ✓
            "/dav/folder/attachments/cc/dd/hash_two".to_string(),    // 文件 ✓
            "/dav/folder/attachments/_gc_marks.json".to_string(),    // 特殊文件，跳过
            "/dav/folder/manifest.json".to_string(),                 // manifest，跳过
            "".to_string(),                                          // 空，跳过
        ];
        let hashes = hrefs_to_attachment_hashes(&hrefs);
        assert_eq!(hashes, vec!["hash_one".to_string(), "hash_two".to_string()]);
    }

    #[test]
    fn hrefs_to_attachment_hashes_dedup_sorted() {
        let hrefs = vec![
            "/x/attachments/bb/cc/zzz".to_string(),
            "/x/attachments/aa/bb/aaa".to_string(),
            "/x/attachments/aa/bb/aaa".to_string(), // 重复
        ];
        let hashes = hrefs_to_attachment_hashes(&hrefs);
        assert_eq!(hashes, vec!["aaa".to_string(), "zzz".to_string()]);
    }

    #[test]
    fn hrefs_to_attachment_hashes_empty_input() {
        assert!(hrefs_to_attachment_hashes(&[]).is_empty());
    }

    #[test]
    fn transient_server_err_detection() {
        assert!(is_transient_server_err("MKCOL notes 失败 (503 Service Unavailable): <html>..."));
        assert!(is_transient_server_err("上传失败，服务器返回 502 Bad Gateway"));
        assert!(is_transient_server_err("504 Gateway Time-out"));
        assert!(!is_transient_server_err("认证失败，请检查用户名/密码"));
        assert!(!is_transient_server_err("MKCOL notes 失败 (409 Conflict)"));
    }

    #[test]
    fn move_unsupported_detection() {
        // 飞牛公网实测：MOVE 收到 502 → 应判定为"不支持 MOVE"，触发降级 PUT
        assert!(is_move_unsupported(
            "MOVE manifest.json.tmp.abc -> manifest.json 失败 (502 Bad Gateway): Bad Gateway"
        ));
        // 服务端显式不允许 / 未实现 MOVE
        assert!(is_move_unsupported("MOVE a -> b 失败 (405 Method Not Allowed): "));
        assert!(is_move_unsupported("MOVE a -> b 失败 (501 Not Implemented): "));
        assert!(is_move_unsupported("MOVE a -> b 失败 (400 Bad Request): "));
        // 认证失败不应被误判为"降级"（move_file 已先把它识别成认证错误）
        assert!(!is_move_unsupported("认证失败，请检查用户名/密码"));
        // 普通成功语义之外的 409 冲突等，不属于"MOVE 不支持"（走 is_move_dest_exists 分支）
        assert!(!is_move_unsupported("MOVE a -> b 失败 (409 Conflict): "));
    }

    #[test]
    fn move_dest_exists_detection() {
        // 坚果云实测：目标已存在 → 409 DuplicateName，应判定为"目标已存在"触发降级 PUT
        assert!(is_move_dest_exists(
            "MOVE manifest.json.tmp.098a465c63d444aa97c5fac106e41c34 -> manifest.json 失败 (409 Conflict): <?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?><d:error xmlns:d=\"DAV:\" xmlns:s=\"http://ns.jianguoyun.com\"><s:exception>DuplicateName</s:exception><s:message>The object on path /manifest.json existed</s:message></d:error>"
        ));
        // 只带 409 Conflict、不带 body 的实现也应命中
        assert!(is_move_dest_exists("MOVE a -> b 失败 (409 Conflict): "));
        // 认证失败 / 临时 5xx 不属于"目标已存在"，不应命中（避免误吞真实错误）
        assert!(!is_move_dest_exists("认证失败，请检查用户名/密码"));
        assert!(!is_move_dest_exists("MOVE a -> b 失败 (502 Bad Gateway): Bad Gateway"));
    }

    #[test]
    fn move_auth_failure_detection() {
        // move_file 把 401/403 统一转成这句中文
        assert!(is_move_auth_failure("认证失败，请检查用户名/密码"));
        // 兜底：别处若带着状态码上报，同样认得出
        assert!(is_move_auth_failure("MOVE a -> b 失败 (401 Unauthorized): "));
        assert!(is_move_auth_failure("MOVE a -> b 失败 (403 Forbidden): "));
        // 服务器故障 / 冲突不是认证问题
        assert!(!is_move_auth_failure(
            "MOVE a -> b 失败 (500 Internal Server Error): Internal Server Error"
        ));
        assert!(!is_move_auth_failure("MOVE a -> b 失败 (409 Conflict): "));
    }

    /// 用户实测（NAS/Alist 式 WebDAV）：MOVE 到已存在的 manifest.json 回 500 →
    /// 旧的状态码白名单不认 500，推送直接失败（能拉不能推）。现在必须降级为 PUT。
    #[test]
    fn move_500_falls_back_to_put() {
        let msg = "MOVE manifest.json.tmp.a10e41ea4a9b4ac6b1d0137314a6867e -> manifest.json 失败 (500 Internal Server Error): Internal Server Error";
        assert!(move_err_downgrade_reason(msg).is_some());
        // 未分类原因也要能进日志，方便下次看清是哪种服务器
        assert_eq!(
            move_err_downgrade_reason(msg),
            Some("MOVE 换名失败（服务器 500 等未分类原因）")
        );
    }

    #[test]
    fn move_downgrade_reason_covers_known_and_unknown() {
        // 已知分类：坚果云 409 / 反代 502 —— 降级，且原因文案区分得开
        assert_eq!(
            move_err_downgrade_reason("MOVE a -> b 失败 (409 Conflict): DuplicateName"),
            Some("目标已存在且服务器不支持 MOVE 覆盖（坚果云式 409 DuplicateName）")
        );
        assert_eq!(
            move_err_downgrade_reason("MOVE a -> b 失败 (502 Bad Gateway): Bad Gateway"),
            Some("服务器不支持 MOVE 方法")
        );
        // 没见过的状态码一律降级（不再逐个打补丁）
        assert!(move_err_downgrade_reason("MOVE a -> b 失败 (507 Insufficient Storage): ").is_some());
        assert!(move_err_downgrade_reason("MOVE 失败: connection reset by peer").is_some());
        // 唯一例外：认证失败不降级，原样上报
        assert_eq!(
            move_err_downgrade_reason("认证失败，请检查用户名/密码"),
            None
        );
    }
}
