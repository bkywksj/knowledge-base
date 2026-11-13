//! 发现文件 `kb-mcp.json`：主应用启动时写、kb-mcp sidecar 和外部程序（如智码）读。
//!
//! 为什么要有它：数据库的真实位置要经过 环境变量 / 便携模式 / 指针文件 多级解析
//! （主应用 `services::data_dir::DataDirResolver`），用户在设置里迁移数据目录后还会变。
//! 外部客户端配置里写死 `--db-path` 的话，一迁移就指向旧库。
//! 改成「主应用每次启动把算好的结果写进固定位置的发现文件，sidecar 照着读」——
//! 解析逻辑只有主应用一份，sidecar 不用复刻、也就不会和主应用算得不一样。
//!
//! 固定位置 = 框架 app_data 目录（`%APPDATA%\com.agilefr.kb\`，dev 为 `com.agilefr.kb-dev`），
//! 与主应用 `early_app_data_dir()` 同一套规则；数据目录迁到别处时它也不动。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// 发现文件名，位于框架 app_data 目录下
pub const DISCOVERY_FILE: &str = "kb-mcp.json";

/// app_config 里「外部 AI 客户端（kb-mcp sidecar）是否允许写」的 key。
/// 值 `"0"` = 不允许；缺失 / 其它值 = 允许（兼容老版本：升级前外部客户端只看 `--writable`）。
/// 只有客户端配置里带了 `--writable` 时才有意义——它是收回写权限的总闸，不是放开写权限的开关。
pub const EXTERNAL_WRITABLE_KEY: &str = "mcp_external_writable";

/// 发现文件内容。字段名 camelCase，外部程序（智码，另一个仓库）按这个形状读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// 格式版本，结构有不兼容变化时递增
    pub version: u32,
    /// 当前使用的数据库绝对路径
    pub db_path: String,
    /// kb-mcp sidecar 绝对路径；找不到（dev 未编译 sidecar）时为 None
    pub sidecar_path: Option<String>,
    /// 写入时的主应用版本，排查问题用
    pub app_version: String,
}

/// 当前发现文件格式版本
pub const DISCOVERY_VERSION: u32 = 1;

/// 框架 app_data 目录（发现文件所在目录）。
/// `dev` 对应主应用的 debug 构建（目录名带 `-dev`）；sidecar 传自己的 `cfg!(debug_assertions)`，
/// 因为 dev 主应用旁边的 sidecar 也是 debug 构建，两边天然对得上。
pub fn default_app_data_dir(dev: bool) -> Option<PathBuf> {
    let name = if dev {
        "com.agilefr.kb-dev"
    } else {
        "com.agilefr.kb"
    };
    #[cfg(windows)]
    {
        std::env::var("APPDATA").ok().map(|p| PathBuf::from(p).join(name))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("Library/Application Support").join(name))
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(p) = std::env::var("XDG_DATA_HOME") {
            return Some(PathBuf::from(p).join(name));
        }
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".local/share").join(name))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = name;
        None
    }
}

/// 读发现文件
pub fn read(path: &Path) -> Result<Discovery> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("读取发现文件失败: {}", path.display()))?;
    // 去掉可能的 UTF-8 BOM（用户手改过文件时可能带上），serde_json 不认
    let raw = raw.trim_start_matches('\u{feff}');
    serde_json::from_str(raw).with_context(|| format!("发现文件格式不对: {}", path.display()))
}

/// 写发现文件：先写临时文件再改名，读方永远看不到写了一半的内容
pub fn write(dir: &Path, d: &Discovery) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(DISCOVERY_FILE);
    let tmp = dir.join(format!("{DISCOVERY_FILE}.tmp"));
    let json = serde_json::to_string_pretty(d)?;
    std::fs::write(&tmp, json)?;
    // Windows 上 rename 目标已存在时会失败，先删
    #[cfg(windows)]
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kb-discovery-test-{}", std::process::id()));
        let d = Discovery {
            version: DISCOVERY_VERSION,
            db_path: "D:/kb/app.db".into(),
            sidecar_path: Some("C:/kb/kb-mcp.exe".into()),
            app_version: "9.9.9".into(),
        };
        write(&dir, &d).unwrap();
        // 第二次写要能覆盖已存在的文件（Windows rename 语义）
        write(&dir, &d).unwrap();
        let got = read(&dir.join(DISCOVERY_FILE)).unwrap();
        assert_eq!(got.db_path, d.db_path);
        assert_eq!(got.sidecar_path, d.sidecar_path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_tolerates_bom() {
        let dir = std::env::temp_dir().join(format!("kb-discovery-bom-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(DISCOVERY_FILE);
        std::fs::write(
            &p,
            "\u{feff}{\"version\":1,\"dbPath\":\"x\",\"sidecarPath\":null,\"appVersion\":\"1\"}",
        )
        .unwrap();
        assert_eq!(read(&p).unwrap().db_path, "x");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
