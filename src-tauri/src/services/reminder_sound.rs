//! 待办提醒「自定义提示音」的文件管理（纯文件系统，不碰 DB）。
//!
//! ## 为什么把音频文件复制进 app_data_dir
//!
//! 1. `tauri.conf.json` 的 `assetProtocol.scope` 只放行了 `$APPDATA/**` 与 dev 的
//!    `$DATA/com.agilefr.kb-dev/**`。前端要用 `<audio src=convertFileSrc(abs)>` 播放，
//!    文件必须落在这两条 scope 里 —— 直接播用户原路径（D:\music\x.mp3）会被 asset 协议拒掉。
//! 2. 复制一份后，用户再移动 / 删除原文件也不会让提示音突然哑掉。
//! 3. 用 framework_app_data_dir 而非 `state.data_dir`：数据目录是用户可换的（T-013），
//!    换到 scope 之外就播不了；app_data_dir 是 OS 固定位置，永远在 scope 内。
//!
//! 与主题背景图（`commands::system::copy_theme_bg`）同源思路，区别是这里要保留**多份**
//! （用户可以导入一个音色库，在设置页里随时切换），所以带 list / delete。
//!
//! 注意：前端只把**文件名**（不含目录）存进配置，解析绝对路径一律走 `resolve`，
//! 里面做了目录穿越防护 —— 配置值理论上是自家写的，但 app_config 表用户可从
//! 同步 / 外部工具改到，不能默认可信。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;
use crate::services::safe_filename::sanitize_stem;

/// 自定义提示音存放目录（相对 framework_app_data_dir）
pub const SOUND_DIR_NAME: &str = "reminder-sounds";

/// 单个音频文件大小上限：8 MB。
/// 提示音本来就该是几秒的短音效，8MB 足够覆盖无损 wav；再大多半是用户误选了整首歌 /
/// 视频音轨，导入进来只会白占空间还播不完。
const MAX_SOUND_BYTES: u64 = 8 * 1024 * 1024;

/// 放行的音频扩展名。都是 WebView（WebView2 / WKWebView / WebKitGTK）原生能解码的容器。
/// 不放行 `flac` / `wma`：Windows WebView2 能放但 Linux WebKitGTK 常缺解码器，
/// 与其让用户导进来发现不响，不如导入时就拦掉。
const ALLOWED_EXT: &[&str] = &["mp3", "wav", "ogg", "m4a", "aac", "webm", "oga"];

/// 一个已导入的自定义提示音
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CustomSound {
    /// 落盘文件名（含扩展名）。这是配置里存的 key，也是所有接口的句柄
    pub file_name: String,
    /// 去掉扩展名的展示名，用于设置页下拉
    pub display_name: String,
    /// 绝对路径，前端 `convertFileSrc` 后喂 `<audio>`
    pub path: String,
    /// 字节数，设置页展示"多大"用
    pub size: u64,
}

pub struct ReminderSoundService;

impl ReminderSoundService {
    /// 取（并按需创建）自定义提示音目录
    pub fn dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = app_data_dir.join(SOUND_DIR_NAME);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 导入用户选定的音频文件，复制进提示音目录，返回落盘后的条目。
    ///
    /// 同名冲突不覆盖已有文件，自动加 `-1` / `-2` 后缀 —— 用户可能有两个都叫
    /// `ding.mp3` 但内容不同的文件，直接覆盖会让他先前选中的那个提示音悄悄变声。
    pub fn import(app_data_dir: &Path, src_path: &str) -> Result<CustomSound, AppError> {
        let src = PathBuf::from(src_path);
        if !src.is_file() {
            return Err(AppError::NotFound(format!("源文件不存在: {}", src_path)));
        }

        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !ALLOWED_EXT.contains(&ext.as_str()) {
            return Err(AppError::InvalidInput(format!(
                "不支持的音频格式 .{}（支持 {}）",
                if ext.is_empty() { "?" } else { &ext },
                ALLOWED_EXT.join(" / ")
            )));
        }

        let size = src.metadata()?.len();
        if size > MAX_SOUND_BYTES {
            return Err(AppError::InvalidInput(format!(
                "音频文件过大（{:.1} MB），上限 {} MB",
                size as f64 / 1024.0 / 1024.0,
                MAX_SOUND_BYTES / 1024 / 1024
            )));
        }
        if size == 0 {
            return Err(AppError::InvalidInput("音频文件是空的".into()));
        }

        let dir = Self::dir(app_data_dir)?;
        let stem = sanitize_stem(
            src.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("提示音"),
        );
        let (file_name, dst) = unique_target(&dir, &stem, &ext);
        std::fs::copy(&src, &dst)?;

        Ok(CustomSound {
            display_name: strip_ext(&file_name).to_string(),
            path: dst.to_string_lossy().into_owned(),
            size,
            file_name,
        })
    }

    /// 列出已导入的自定义提示音（按展示名排序，保证设置页下拉稳定）
    pub fn list(app_data_dir: &Path) -> Result<Vec<CustomSound>, AppError> {
        let dir = app_data_dir.join(SOUND_DIR_NAME);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if !ALLOWED_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            out.push(CustomSound {
                file_name: file_name.to_string(),
                display_name: strip_ext(file_name).to_string(),
                path: path.to_string_lossy().into_owned(),
                size: entry.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
        out.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(out)
    }

    /// 把配置里存的文件名解析成绝对路径。
    ///
    /// 防目录穿越：只接受**单段**文件名，含分隔符 / `..` 一律拒绝，
    /// 避免 `../../../etc/passwd` 这类值被当成提示音路径回灌给前端。
    pub fn resolve(app_data_dir: &Path, file_name: &str) -> Result<String, AppError> {
        let path = Self::checked_path(app_data_dir, file_name)?;
        if !path.is_file() {
            return Err(AppError::NotFound(format!("提示音文件已不存在: {}", file_name)));
        }
        Ok(path.to_string_lossy().into_owned())
    }

    /// 删除一个自定义提示音。文件已不在时静默成功（用户点两次删除不该报错）。
    pub fn delete(app_data_dir: &Path, file_name: &str) -> Result<(), AppError> {
        let path = Self::checked_path(app_data_dir, file_name)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// 校验文件名合法后拼出绝对路径（不检查是否存在）
    fn checked_path(app_data_dir: &Path, file_name: &str) -> Result<PathBuf, AppError> {
        let name = file_name.trim();
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\\')
            || name.contains('\0')
        {
            return Err(AppError::InvalidInput(format!("非法的提示音文件名: {}", file_name)));
        }
        Ok(app_data_dir.join(SOUND_DIR_NAME).join(name))
    }
}

/// 去掉最后一个扩展名，用作展示名
fn strip_ext(file_name: &str) -> &str {
    match file_name.rfind('.') {
        Some(i) if i > 0 => &file_name[..i],
        _ => file_name,
    }
}

/// 在目录内找一个未被占用的 `<stem>.<ext>` / `<stem>-N.<ext>`
fn unique_target(dir: &Path, stem: &str, ext: &str) -> (String, PathBuf) {
    let mut candidate = format!("{}.{}", stem, ext);
    let mut n = 1;
    while dir.join(&candidate).exists() {
        candidate = format!("{}-{}.{}", stem, n, ext);
        n += 1;
        // 理论上撞不到，兜底防死循环：加时间戳一定唯一
        if n > 999 {
            candidate = format!(
                "{}-{}.{}",
                stem,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                ext
            );
            break;
        }
    }
    let path = dir.join(&candidate);
    (candidate, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kb-sound-test-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_src(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn imports_and_lists_custom_sound() {
        let app_data = tmp_dir("import");
        let src_dir = tmp_dir("import-src");
        let src = write_src(&src_dir, "叮咚 声.mp3", b"fake-mp3-bytes");

        let imported = ReminderSoundService::import(&app_data, &src).unwrap();
        assert_eq!(imported.file_name, "叮咚 声.mp3");
        assert_eq!(imported.display_name, "叮咚 声");
        assert_eq!(imported.size, 14);
        assert!(PathBuf::from(&imported.path).is_file());

        let list = ReminderSoundService::list(&app_data).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], imported);

        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    /// 同名不覆盖：第二次导入同名文件应落成 `-1` 后缀，
    /// 否则用户先前选中的提示音会被悄悄换成另一份内容
    #[test]
    fn same_name_does_not_overwrite() {
        let app_data = tmp_dir("dup");
        let src_dir = tmp_dir("dup-src");
        let a = write_src(&src_dir, "ding.wav", b"aaa");
        let b_dir = tmp_dir("dup-src2");
        let b = write_src(&b_dir, "ding.wav", b"bbbb");

        let first = ReminderSoundService::import(&app_data, &a).unwrap();
        let second = ReminderSoundService::import(&app_data, &b).unwrap();
        assert_eq!(first.file_name, "ding.wav");
        assert_eq!(second.file_name, "ding-1.wav");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"aaa");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"bbbb");

        for d in [&app_data, &src_dir, &b_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn rejects_unsupported_extension() {
        let app_data = tmp_dir("ext");
        let src_dir = tmp_dir("ext-src");
        let src = write_src(&src_dir, "song.txt", b"not audio");
        let err = ReminderSoundService::import(&app_data, &src).unwrap_err();
        assert!(err.to_string().contains("不支持的音频格式"), "{}", err);

        for d in [&app_data, &src_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// 目录穿越必须被拦：配置值可能来自同步 / 外部改库，不可信
    #[test]
    fn resolve_rejects_path_traversal() {
        let app_data = tmp_dir("traversal");
        for bad in ["../secret.mp3", "..", "sub/x.mp3", "sub\\x.mp3", "  "] {
            let err = ReminderSoundService::resolve(&app_data, bad).unwrap_err();
            assert!(err.to_string().contains("非法的提示音文件名"), "{} -> {}", bad, err);
        }
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn delete_is_idempotent_and_list_ignores_others() {
        let app_data = tmp_dir("del");
        let src_dir = tmp_dir("del-src");
        let src = write_src(&src_dir, "bell.ogg", b"xyz");
        let s = ReminderSoundService::import(&app_data, &src).unwrap();

        // 目录里混入非音频文件不应出现在列表里
        std::fs::write(app_data.join(SOUND_DIR_NAME).join("readme.txt"), b"hi").unwrap();
        assert_eq!(ReminderSoundService::list(&app_data).unwrap().len(), 1);

        ReminderSoundService::delete(&app_data, &s.file_name).unwrap();
        ReminderSoundService::delete(&app_data, &s.file_name).unwrap(); // 幂等
        assert!(ReminderSoundService::list(&app_data).unwrap().is_empty());

        for d in [&app_data, &src_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// 目录不存在时 list 返回空而非报错（全新安装 / 从未导入过）
    #[test]
    fn list_on_missing_dir_returns_empty() {
        let app_data = tmp_dir("empty");
        assert!(ReminderSoundService::list(&app_data).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
