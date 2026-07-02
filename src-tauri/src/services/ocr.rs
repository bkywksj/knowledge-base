//! 本地 OCR 引擎（#9 方案 A）：RapidOCR-json 常驻进程 sidecar。
//!
//! 参照姊妹项目 AgileShot 的成熟设计（同作者）：
//! - 引擎是自含 ONNXRuntime 的单 exe（无 DLL 依赖），bundle 在 `resources/ocr/`。
//! - **常驻 work loop**：启动一次加载模型，之后逐行喂 `{"image_path":"<相对名>"}`，
//!   逐行读 `{"code":100,"data":[{text,score,box},...]}`（101=无文字，其它=错误）。
//!   每次识别只花推理时间（~几十~200ms），远快于每次重启进程重载模型。
//! - **坑**（AgileShot 已踩）：stdin EOF 会让引擎死循环刷 code=299 → 进程常驻、绝不关 stdin，
//!   退出直接 kill；base64 入参会 299 → 一律用临时 PNG 文件路径。CJK 路径不稳 →
//!   临时图写引擎目录、用纯 ASCII 相对名发送（cwd=引擎目录）。
//!
//! 仅桌面端：移动端不能 spawn 子进程。

#![cfg(desktop)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// 中英 V4 四件套（与 bundle 的裁剪模型集一致，显式指定避免引擎默认指向缺失文件）
const DET_MODEL: &str = "ch_PP-OCRv4_det_infer.onnx";
const CLS_MODEL: &str = "ch_ppocr_mobile_v2.0_cls_infer.onnx";
const REC_MODEL: &str = "rec_ch_PP-OCRv4_infer.onnx";
const KEYS_FILE: &str = "dict_chinese.txt";

/// 临时图序号，保证 ASCII 名唯一
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 常驻引擎进程 + 管道。同一时刻只允许一个请求（外层 Mutex 串行化）。
struct OcrEngine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    engine_dir: PathBuf,
}

impl Drop for OcrEngine {
    /// 关键：Rust 的 Child 被 drop **默认不杀进程**，不显式 kill 会泄漏常驻 RapidOCR 进程。
    /// 直接 kill（不关 stdin —— AgileShot 已验证关 stdin 会让引擎死循环刷 code=299）。
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl OcrEngine {
    /// 启动常驻引擎，阻塞等到 "OCR init completed."。
    fn start(exe_path: &Path) -> Result<Self, String> {
        let engine_dir = exe_path
            .parent()
            .ok_or_else(|| "OCR 引擎路径无父目录".to_string())?
            .to_path_buf();

        // 跨平台：Tauri 把二进制作为 resource 拷到安装目录时，Linux/macOS 上可能不带可执行位，
        // 直接 spawn 会 "Permission denied"。启动前确保 +x（幂等，已可执行则无副作用）。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(exe_path) {
                let mut perm = meta.permissions();
                if perm.mode() & 0o111 == 0 {
                    perm.set_mode(perm.mode() | 0o755);
                    let _ = std::fs::set_permissions(exe_path, perm);
                }
            }
        }

        let mut cmd = Command::new(exe_path);
        cmd.current_dir(&engine_dir)
            .arg("--models=models")
            .arg(format!("--det={DET_MODEL}"))
            .arg(format!("--cls={CLS_MODEL}"))
            .arg(format!("--rec={REC_MODEL}"))
            .arg(format!("--keys={KEYS_FILE}"))
            .arg("--ensureLogger=0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Windows：GUI 进程 spawn 子进程会弹黑窗，必须 CREATE_NO_WINDOW
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 OCR 引擎失败: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法取得 OCR 引擎 stdin")?;
        let stdout = child.stdout.take().ok_or("无法取得 OCR 引擎 stdout")?;
        let mut reader = BufReader::new(stdout);

        // 等待就绪：读到 "OCR init completed." 为止（版本行等忽略）
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .map_err(|e| format!("读 OCR 引擎输出失败: {e}"))?;
            if n == 0 {
                return Err("OCR 引擎在就绪前退出".to_string());
            }
            if line.contains("OCR init completed") {
                break;
            }
        }

        Ok(Self {
            child,
            stdin,
            stdout: reader,
            engine_dir,
        })
    }

    /// 进程是否还活着
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 识别一张图片文件，返回按行拼接的全文（无文字返回空串）。
    /// 内部：把源图拷成引擎目录下的 ASCII 临时名（绕 CJK），发相对名，读一行响应，删临时图。
    fn recognize(&mut self, image_path: &Path) -> Result<String, String> {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let rel_name = format!("._kb_ocr_{seq}.png");
        let temp_abs = self.engine_dir.join(&rel_name);
        std::fs::copy(image_path, &temp_abs)
            .map_err(|e| format!("准备 OCR 临时图失败: {e}"))?;

        let result = self.request_and_read(&rel_name);
        let _ = std::fs::remove_file(&temp_abs); // 无论成败都清临时图
        result
    }

    /// 发一条 `{"image_path":...}` 请求并读回一行响应（内部，已排他持有 &mut self）。
    fn request_and_read(&mut self, rel_name: &str) -> Result<String, String> {
        let req = format!("{{\"image_path\":\"{rel_name}\"}}\n");
        self.stdin
            .write_all(req.as_bytes())
            .map_err(|e| format!("写 OCR 请求失败: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush OCR 请求失败: {e}"))?;

        // 读响应：跳过非 JSON 行，直到拿到带 code 的对象
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .stdout
                .read_line(&mut line)
                .map_err(|e| format!("读 OCR 响应失败: {e}"))?;
            if n == 0 {
                return Err("OCR 引擎意外退出".to_string());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if let Some(code) = v.get("code").and_then(|c| c.as_i64()) {
                    return Ok(parse_response(code, &v));
                }
            }
            // 非响应行（残留日志等）→ 继续读
        }
    }
}

/// 解析引擎响应为全文：code=100 拼接各 box 的 text（按行）；101 无文字 → 空串；
/// 其它错误码也返回空串（识别不出不算致命错误，扫描件某页无字很正常）。
fn parse_response(code: i64, v: &serde_json::Value) -> String {
    if code == 100 {
        let mut lines: Vec<String> = Vec::new();
        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        lines.push(t.to_string());
                    }
                }
            }
        }
        lines.join("\n")
    } else {
        // 101 无文字 → 空串；其它错误码也返回空串（识别不出不算致命错误）
        String::new()
    }
}

/// 全局常驻引擎单例。`Option` 内层：懒启动；进程死掉后可重启。
static ENGINE: OnceLock<Mutex<Option<OcrEngine>>> = OnceLock::new();

/// 已解析的引擎 exe 路径（由 lib.rs setup 时用 AppHandle 解析后注入）。
static ENGINE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 应用启动时注入引擎路径（存在才注入 Some）。多次调用只第一次生效。
pub fn set_engine_path(path: Option<PathBuf>) {
    let _ = ENGINE_PATH.set(path);
}

/// OCR 引擎是否可用（bundle 里有 exe）。
pub fn is_available() -> bool {
    matches!(ENGINE_PATH.get(), Some(Some(p)) if p.exists())
}

/// 识别一张图片文件，返回全文。会懒启动/自动重启常驻引擎。
pub fn recognize_image(image_path: &Path) -> Result<String, String> {
    let path = match ENGINE_PATH.get() {
        Some(Some(p)) if p.exists() => p.clone(),
        _ => return Err("本地 OCR 引擎不可用（未随安装包分发）".to_string()),
    };
    let slot = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|e| format!("OCR 锁失败: {e}"))?;

    // 懒启动 / 死进程重启
    let need_start = match guard.as_mut() {
        Some(eng) => !eng.is_alive(),
        None => true,
    };
    if need_start {
        *guard = Some(OcrEngine::start(&path)?);
    }

    let eng = guard.as_mut().ok_or("OCR 引擎未就绪")?;
    match eng.recognize(image_path) {
        Ok(text) => Ok(text),
        Err(e) => {
            // 出错时丢弃可能已损坏的进程，下次重启
            *guard = None;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端到端：用 bundle 的 RapidOCR 引擎识别 fixture 测试图。
    /// 引擎 exe 或测试图缺失时**自动跳过**（CI 上不带引擎时不失败）。
    /// 直接调 `OcrEngine`（不经全局 ENGINE_PATH 的 OnceLock，避免与其它测试相互污染）。
    #[test]
    fn recognize_bundled_engine_reads_text() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let exe = PathBuf::from(manifest).join("resources/ocr/RapidOCR-json.exe");
        let img = PathBuf::from(manifest).join("tests/fixtures/ocr_sample.png");
        if !exe.exists() || !img.exists() {
            eprintln!("[ocr test] 引擎或 fixture 缺失，跳过");
            return;
        }
        let mut eng = OcrEngine::start(&exe).expect("引擎应能启动");
        let text = eng.recognize(&img).expect("识别应成功");
        eprintln!("[ocr test] 识别结果: {text}");
        // fixture 含 "Hello 知识库 OCR 123" 与 "test line two"
        assert!(text.contains("知识库"), "应识别出中文'知识库': {text}");
        assert!(
            text.to_lowercase().contains("hello"),
            "应识别出英文'Hello': {text}"
        );
    }
}
