//! 系统字体枚举（仅桌面端）。
//!
//! 用途：设置页「正文字体」下拉，让用户从本机**已安装的所有字体**里自选任意字体
//! （所见即所得），而不再局限于内置的 5 个预设（system/sans/serif/kaiti/mono）。
//!
//! 为什么走 font-enumeration 而非 font-kit：只需要「列出字体族名」，不需要光栅化 /
//! 字形加载。font-enumeration 仅调用平台原生字体目录 API（Windows=DirectWrite /
//! macOS=CoreText / Linux=fontconfig），**无 freetype C 依赖**，构建更轻、体积更小。
//!
//! 移动端不编译本模块（`#[cfg(desktop)]` gate on mod 声明）——font-enumeration 无
//! Android 后端，且移动端在设置页回退到「预设 + 手动输入字体名」。

use std::collections::BTreeSet;

/// 列出本机已安装的所有字体族名（去重 + 按名排序）。
///
/// 返回：字体族名列表（如 `["Arial", "Microsoft YaHei", "宋体", ...]`），前端把它塞进
/// 「正文字体」可搜索下拉，每一项用该字体自身渲染做预览。
///
/// 失败不 panic：枚举出错（驱动异常 / 平台不支持）时返回 `Err(String)`，前端据此静默
/// 回退到「预设 + 手动输入字体名」，不影响其它设置。
#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    let collection = font_enumeration::Collection::new()
        .map_err(|e| format!("枚举系统字体失败: {e}"))?;

    // BTreeSet 天然去重 + 有序：同一字体族常有多个 face（Regular/Bold/Italic…），
    // 只保留唯一的 family_name；排序后前端下拉稳定、便于搜索定位。
    let mut families: BTreeSet<String> = BTreeSet::new();
    for font in collection.all() {
        let name = font.family_name.trim();
        if !name.is_empty() {
            families.insert(name.to_string());
        }
    }
    Ok(families.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实证 font-enumeration 在当前桌面平台（本机为 Windows）确实能枚举出字体，
    /// 且结果去重有序。任何桌面开发/CI 环境都至少装有若干系统字体。
    #[test]
    fn enumerates_nonempty_sorted_unique() {
        let fonts = list_system_fonts().expect("桌面环境应能枚举系统字体");
        assert!(!fonts.is_empty(), "系统字体列表不应为空");

        // 已排序
        let mut sorted = fonts.clone();
        sorted.sort();
        assert_eq!(fonts, sorted, "字体族名应按名排序");

        // 已去重
        let unique: BTreeSet<&String> = fonts.iter().collect();
        assert_eq!(unique.len(), fonts.len(), "字体族名应去重");
    }
}
