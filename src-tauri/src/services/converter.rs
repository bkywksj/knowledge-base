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
    WindowsCom,
    None,
}

/// Word COM ProgId 候选列表（按优先级，覆盖 Office + 各种 WPS 版本）
///
/// 注意：ProgId 是大小写不敏感的，但 PowerShell `New-Object -ComObject` 仍按字面值匹配。
const WORD_PROGIDS: &[&str] = &[
    "Word.Application",       // Microsoft Office Word
    "KWps.Application",       // WPS Office 文字（旧版常见）
    "Wps.Application",        // WPS Office 通用
    "Kwps.Application",       // 大小写变体
    "KingsoftOffice.Wps",     // 金山办公早期
    "WPS.Application",        // 又一个变体
];

static CONVERTER: OnceLock<DocConverter> = OnceLock::new();
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

/// 把 `.doc` 转换为 `.docx`，输出到 `dst_dir`，返回输出文件绝对路径
pub fn convert_doc_to_docx(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    if !src.exists() {
        return Err(AppError::NotFound(format!(
            "源文件不存在: {}",
            src.display()
        )));
    }
    std::fs::create_dir_all(dst_dir)?;

    match detect_converter() {
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
            "未检测到 .doc 转换器，请安装 Microsoft Office 或 WPS Office（含 OLE 自动化组件）".into(),
        )),
    }
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
#[cfg(target_os = "windows")]
fn try_instantiate(progid: &str) -> Result<(), String> {
    let escaped = progid.replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         try {{ \
             $w = New-Object -ComObject '{escaped}'; \
             $w.Visible = $false; \
             $w.DisplayAlerts = 0; \
             $w.Quit() \
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

#[cfg(not(target_os = "windows"))]
fn try_instantiate(_progid: &str) -> Result<(), String> {
    Err("仅 Windows 支持 COM".into())
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

    // wdFormatXMLDocument = 16 (.docx)
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $word = New-Object -ComObject '{progid_escaped}'; \
         $word.Visible = $false; \
         $word.DisplayAlerts = 0; \
         try {{ \
             $doc = $word.Documents.Open('{src}', $false, $true); \
             $doc.SaveAs([ref] '{dst}', [ref] 16); \
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
