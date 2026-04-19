//! .doc → .docx 转换器
//!
//! 检测顺序（首个可用即胜出）：
//! 1. **LibreOffice** (`soffice`)：跨平台，纯命令行 headless，最稳
//! 2. **Windows COM** (`Word.Application`)：仅 Windows，需装 Office 或 WPS
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

static CONVERTER: OnceLock<DocConverter> = OnceLock::new();

/// 检测当前系统可用的 .doc 转换器（首次调用会探测，后续走缓存）
pub fn detect_converter() -> DocConverter {
    *CONVERTER.get_or_init(|| {
        if has_libreoffice() {
            log::info!("检测到 LibreOffice，将用于 .doc 转换");
            return DocConverter::LibreOffice;
        }
        #[cfg(target_os = "windows")]
        if has_windows_com() {
            log::info!("检测到 Windows COM (Word.Application)，将用于 .doc 转换");
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
            "未检测到 .doc 转换器，请安装 LibreOffice 或 Microsoft Office / WPS".into(),
        )),
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

#[cfg(target_os = "windows")]
fn has_windows_com() -> bool {
    // GetTypeFromProgId 不会启动 Word，纯查注册表，最干净
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "if ([type]::GetTypeFromProgId('Word.Application')) { exit 0 } else { exit 1 }",
    ]);
    add_no_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn convert_via_windows_com(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let out_path = expected_output(src, dst_dir)?;
    let src_str = ps_escape(&src.to_string_lossy());
    let dst_str = ps_escape(&out_path.to_string_lossy());

    // wdFormatXMLDocument = 16 (.docx)
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $word = New-Object -ComObject Word.Application; \
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
            "Windows COM 转换失败: {}",
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
