//! .doc → .docx 转换器
//!
//! 检测顺序（首个可用即胜出）：
//! 1. **LibreOffice** (`soffice`)：跨平台，纯命令行 headless
//! 2. **Windows COM** (`Word.Application` / WPS 兼容 ProgId)：仅 Windows
//!
//! 检测结果用 `OnceLock` 缓存，避免每次都探测一遍。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DocConverter {
    LibreOffice,
    // 仅在 Windows 上构造；非 Windows 仍在 match 中引用，所以保留变体但抑制 dead_code
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    WindowsCom,
    None,
}

/// Word COM ProgId 候选列表（按优先级，覆盖 Office + 各种 WPS 版本）
///
/// 注意：ProgId 是大小写不敏感的，但 PowerShell `New-Object -ComObject` 仍按字面值匹配。
#[cfg(target_os = "windows")]
const WORD_PROGIDS: &[&str] = &[
    "Word.Application",   // Microsoft Office Word
    "KWps.Application",   // WPS Office 文字（旧版常见）
    "Wps.Application",    // WPS Office 通用
    "Kwps.Application",   // 大小写变体
    "KingsoftOffice.Wps", // 金山办公早期
    "WPS.Application",    // 又一个变体
];

static CONVERTER: OnceLock<DocConverter> = OnceLock::new();
#[cfg(target_os = "windows")]
static AVAILABLE_PROGID: OnceLock<Option<String>> = OnceLock::new();

/// 检测当前系统可用的 .doc 转换器（首次调用会探测，后续走缓存）
pub fn detect_converter() -> DocConverter {
    *CONVERTER.get_or_init(|| {
        if has_libreoffice() {
            log::info!("检测到 LibreOffice，将用于 .doc 转换");
            return DocConverter::LibreOffice;
        }
        #[cfg(target_os = "windows")]
        if let Some(progid) = detect_word_com_progid() {
            log::info!("检测到 Windows COM ProgId: {}", progid);
            return DocConverter::WindowsCom;
        }
        log::warn!("未检测到 .doc 转换器，.doc 文件将仅作为附件保存");
        DocConverter::None
    })
}

/// 把 LibreOffice / Word 能打开的任意文档（含 `.html`）转换为 `.docx`，
/// 输出到 `dst_dir`，返回输出文件绝对路径。
///
/// 本质与 [`convert_doc_to_docx`] 相同（转换器对输入类型不挑食，靠扩展名/内容自动识别），
/// 单独命名是为了让「笔记 HTML → docx」这条导出路径在调用处语义清晰。
pub fn convert_to_docx(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    convert_doc_to_docx(src, dst_dir)
}

/// 把 `.doc` 转换为 `.docx`，输出到 `dst_dir`，返回输出文件绝对路径
pub fn convert_doc_to_docx(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    if !src.exists() {
        return Err(AppError::NotFound(format!(
            "源文件不存在: {}",
            src.display()
        )));
    }
    std::fs::create_dir_all(dst_dir)?;

    let out = match detect_converter() {
        DocConverter::LibreOffice => convert_via_libreoffice(src, dst_dir),
        DocConverter::WindowsCom => {
            #[cfg(target_os = "windows")]
            {
                convert_via_windows_com(src, dst_dir)
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(AppError::Custom("WindowsCom 仅支持 Windows".into()))
            }
        }
        DocConverter::None => Err(AppError::Custom(
            "未检测到 .doc 转换器，请安装 Microsoft Office 或 WPS Office（含 OLE 自动化组件）"
                .into(),
        )),
    }?;
    ensure_docx(&out)?;
    Ok(out)
}

/// 校验输出确实是 docx（zip 容器，头 4 字节 `PK\x03\x04`）
///
/// 转换器「报成功但没存成 docx」时（老版 Word 把 doc 二进制写成 `.docx`），
/// 不拦下来的话前端 mammoth 只会抛一句看不懂的 "Can't find end of central directory"。
fn ensure_docx(path: &Path) -> Result<(), AppError> {
    let mut head = [0u8; 4];
    let n = std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read(&mut f, &mut head))
        .unwrap_or(0);
    if n == 4 && head == *b"PK\x03\x04" {
        return Ok(());
    }
    let _ = std::fs::remove_file(path);
    let hint = if n == 4 && head == [0xD0, 0xCF, 0x11, 0xE0] {
        "转换器存出的仍是老 .doc 格式（常见于 Office 2003 等不支持 docx 的旧版 Word），\
         请安装 Office 2007+ / WPS，或先用 WPS 另存为 .docx 再导入"
    } else {
        "转换器输出的不是 docx 文件（文件可能已加密或转换器不支持），\
         可先用 WPS / Word 另存为 .docx 再导入"
    };
    Err(AppError::Custom(format!(
        "{}（文件头: {}）",
        hint,
        head[..n]
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ")
    )))
}

// ─── 诊断报告（前端可调用） ──────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComProgIdAttempt {
    pub progid: String,
    pub ok: bool,
    /// 失败时的具体错误（PowerShell stderr）
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterDiagnostic {
    /// LibreOffice 可执行文件路径（找到才有值）
    pub libre_office_path: Option<String>,
    /// 每个 Word ProgId 的实测结果（仅 Windows）
    pub com_attempts: Vec<ComProgIdAttempt>,
    /// 当前最终选用的转换器
    pub active: DocConverter,
}

/// 生成诊断报告供前端展示（每次调用都会**重新探测每个 ProgId**，不走缓存）
pub fn diagnose() -> ConverterDiagnostic {
    let lo = libreoffice_exe();
    let lo_opt = if lo.is_empty() { None } else { Some(lo) };

    #[cfg(target_os = "windows")]
    let attempts: Vec<ComProgIdAttempt> = WORD_PROGIDS
        .iter()
        .map(|p| match try_instantiate(p) {
            Ok(_) => ComProgIdAttempt {
                progid: p.to_string(),
                ok: true,
                error: None,
            },
            Err(e) => ComProgIdAttempt {
                progid: p.to_string(),
                ok: false,
                error: Some(e),
            },
        })
        .collect();
    #[cfg(not(target_os = "windows"))]
    let attempts: Vec<ComProgIdAttempt> = Vec::new();

    ConverterDiagnostic {
        libre_office_path: lo_opt,
        com_attempts: attempts,
        active: detect_converter(),
    }
}

// ─── LibreOffice ───────────────────────────────────────

fn has_libreoffice() -> bool {
    !libreoffice_exe().is_empty()
}

/// 返回可用的 LibreOffice 可执行路径，若都找不到返回空字符串
fn libreoffice_exe() -> String {
    if try_run("soffice", &["--version"]) {
        return "soffice".into();
    }
    #[cfg(target_os = "windows")]
    {
        for p in [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ] {
            if Path::new(p).exists() {
                return p.into();
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
        if Path::new(p).exists() {
            return p.into();
        }
    }
    String::new()
}

fn convert_via_libreoffice(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let exe = libreoffice_exe();
    if exe.is_empty() {
        return Err(AppError::Custom("LibreOffice 不可用".into()));
    }
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--headless",
        "--convert-to",
        "docx",
        "--outdir",
        &dst_dir.to_string_lossy(),
        &src.to_string_lossy(),
    ]);
    add_no_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| AppError::Custom(format!("LibreOffice 启动失败: {}", e)))?;
    if !output.status.success() {
        return Err(AppError::Custom(format!(
            "LibreOffice 转换失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    expected_output(src, dst_dir)
}

// ─── Windows COM ───────────────────────────────────────

/// 探测系统上第一个可实例化的 Word ProgId，缓存结果
#[cfg(target_os = "windows")]
fn detect_word_com_progid() -> Option<String> {
    AVAILABLE_PROGID
        .get_or_init(|| {
            for progid in WORD_PROGIDS {
                if try_instantiate(progid).is_ok() {
                    return Some(progid.to_string());
                }
            }
            None
        })
        .clone()
}

/// 实测一个 ProgId 是否能创建 + 退出。失败时返回 stderr 内容（含 HRESULT 等）
///
/// 主版本号 < 12（Office 2003 及更早）也算失败：它占着 `Word.Application`，
/// 却存不出 docx，会把老 doc 二进制写成 `.docx` 还报成功。判掉它，检测才会
/// 落到后面的 WPS ProgId（WPS 自报 12.0）。stderr 走控制台代码页，提示用英文免乱码。
#[cfg(target_os = "windows")]
fn try_instantiate(progid: &str) -> Result<(), String> {
    let escaped = progid.replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         try {{ \
             $w = New-Object -ComObject '{escaped}'; \
             $w.Visible = $false; \
             $w.DisplayAlerts = 0; \
             $ver = [string]$w.Version; \
             $w.Quit(); \
             if ([int]($ver.Split('.')[0]) -lt 12) {{ \
                 [Console]::Error.WriteLine('Version ' + $ver + ' is too old (< 12, e.g. Office 2003), cannot save .docx'); \
                 exit 1 \
             }} \
         }} catch {{ \
             [Console]::Error.WriteLine($_.Exception.Message); \
             exit 1 \
         }}"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    add_no_window(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("退出码 {:?}", output.status.code())
        } else {
            err
        })
    }
}

#[cfg(target_os = "windows")]
fn convert_via_windows_com(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let progid = detect_word_com_progid().ok_or_else(|| {
        AppError::Custom("Windows COM 不可用：未检测到任何 Word.Application 等 ProgId".into())
    })?;
    let out_path = expected_output(src, dst_dir)?;
    let src_str = ps_escape(&src.to_string_lossy());
    let dst_str = ps_escape(&out_path.to_string_lossy());
    let progid_escaped = progid.replace('\'', "''");

    // wdFormatXMLDocument = 12：固定存 .docx。原先写的 16 其实是 wdFormatDocumentDefault，
    // 即「按软件默认格式存」，默认格式被改成 .doc 时就不是 docx 了
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $word = New-Object -ComObject '{progid_escaped}'; \
         $word.Visible = $false; \
         $word.DisplayAlerts = 0; \
         try {{ \
             $doc = $word.Documents.Open('{src}', $false, $true); \
             $doc.SaveAs([ref] '{dst}', [ref] 12); \
             $doc.Close($false) \
         }} finally {{ $word.Quit() }}",
        src = src_str,
        dst = dst_str,
    );

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    add_no_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| AppError::Custom(format!("PowerShell 启动失败: {}", e)))?;
    if !output.status.success() {
        return Err(AppError::Custom(format!(
            "Windows COM 转换失败（ProgId={}）: {}",
            progid,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    if !out_path.exists() {
        return Err(AppError::Custom("转换完成但找不到输出文件".into()));
    }
    Ok(out_path)
}

#[cfg(target_os = "windows")]
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

// ─── 工具函数 ─────────────────────────────────────────

fn expected_output(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let stem = src
        .file_stem()
        .ok_or_else(|| AppError::Custom("源文件名无效".into()))?;
    Ok(dst_dir.join(format!("{}.docx", stem.to_string_lossy())))
}

fn try_run(program: &str, args: &[&str]) -> bool {
    let mut cmd = Command::new(program);
    cmd.args(args);
    add_no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn add_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn add_no_window(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("kb_converter_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn ensure_docx_accepts_zip() {
        let p = write_tmp("ok.docx", b"PK\x03\x04rest");
        assert!(ensure_docx(&p).is_ok());
        assert!(p.exists());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn ensure_docx_rejects_ole_doc_with_hint() {
        // 老版 Word 把 doc 二进制存成 .docx 的情形
        let p = write_tmp("ole.docx", &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1]);
        let err = ensure_docx(&p).unwrap_err().to_string();
        assert!(err.contains("老 .doc 格式"), "{err}");
        assert!(err.contains("D0 CF 11 E0"), "{err}");
        assert!(!p.exists(), "坏输出应被删掉");
    }

    #[test]
    fn ensure_docx_rejects_short_or_other() {
        let p = write_tmp("short.docx", b"PK");
        let err = ensure_docx(&p).unwrap_err().to_string();
        assert!(err.contains("不是 docx"), "{err}");
    }

    /// 真机冒烟：要本机装 Office / WPS，默认不跑。
    /// `KB_DOC_SAMPLE=<某个 .doc> cargo test -- --ignored real_doc_convert --nocapture`
    #[test]
    #[ignore]
    fn real_doc_convert() {
        let src = PathBuf::from(std::env::var("KB_DOC_SAMPLE").expect("设 KB_DOC_SAMPLE"));
        println!("{:#?}", diagnose());
        let dir = std::env::temp_dir().join("kb_converter_test");
        let out = convert_doc_to_docx(&src, &dir).expect("转换失败");
        println!("ok: {}", out.display());
        let _ = std::fs::remove_file(&out);
    }
}
