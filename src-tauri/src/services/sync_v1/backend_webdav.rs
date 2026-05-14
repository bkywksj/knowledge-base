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
            self.client.upload_bytes(&tmp_name, bytes).await?;
            match self.client.move_file(&tmp_name, MANIFEST_FILENAME).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    // best-effort 清理 .tmp（清不掉也只是远端多一个无主文件，下次 GC 可以扫）
                    let _ = self.client.delete_file(&tmp_name).await;
                    Err(e)
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
        // TODO 性能优化：用 HEAD 请求探测，不传输 body
        // 当前用 download_bytes_optional 是正确但浪费带宽（附件可能 MB 级）
        let path = super::backend::cas_path(hash);
        let exists = block_on(self.client.download_bytes_optional(&path))?.is_some();
        Ok(exists)
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
}
