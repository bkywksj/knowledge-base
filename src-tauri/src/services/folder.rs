use crate::database::Database;
use crate::error::AppError;
use crate::models::Folder;

/// 文件夹服务
pub struct FolderService;

impl FolderService {
    /// 创建文件夹
    pub fn create(db: &Database, name: &str, parent_id: Option<i64>) -> Result<Folder, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("文件夹名称不能为空".into()));
        }
        db.create_folder(name, parent_id)
    }

    /// 重命名文件夹
    pub fn rename(db: &Database, id: i64, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("文件夹名称不能为空".into()));
        }
        db.rename_folder(id, name)
    }

    /// 删除文件夹
    /// 当文件夹含有子文件夹或未回收的笔记时拒绝删除。
    /// 注：隐藏笔记 / 加密笔记 UI 默认不显示，但 is_deleted=0 仍占用文件夹 ——
    /// 错误信息显式给出数量，方便用户判断是不是有"看不见的"笔记拦着。
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let (sub_folders, active_notes) = db.folder_children_count(id)?;
        if sub_folders > 0 || active_notes > 0 {
            let mut parts = Vec::new();
            if sub_folders > 0 {
                parts.push(format!("{} 个子文件夹", sub_folders));
            }
            if active_notes > 0 {
                parts.push(format!(
                    "{} 篇笔记（含隐藏 / 加密 / 已打开但未保存的）",
                    active_notes
                ));
            }
            return Err(AppError::InvalidInput(format!(
                "该文件夹下还有 {}，请先清空后再删除",
                parts.join(" 和 ")
            )));
        }
        let deleted = db.delete_folder(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("文件夹 {} 不存在", id)));
        }
        Ok(())
    }

    /// 子树统计：返回 `(子孙文件夹数, 子树内未回收笔记数)`，供级联删除确认弹窗用。
    pub fn subtree_stats(db: &Database, id: i64) -> Result<(i64, i64), AppError> {
        db.folder_subtree_stats(id)
    }

    /// 级联删除：子树笔记软删进回收站（可恢复）+ 物理删除子树文件夹。
    /// 返回 `(软删笔记数, 删除文件夹数)`。与 `delete` 的区别：delete 遇非空拒绝，
    /// 本方法在用户明确确认后强制删除（用户诉求：提醒即可，给我删的权限）。
    pub fn delete_cascade(db: &Database, id: i64) -> Result<(usize, usize), AppError> {
        db.delete_folder_cascade(id)
    }

    /// 移动文件夹（改父节点，不处理同级排序）
    pub fn move_to(db: &Database, id: i64, new_parent_id: Option<i64>) -> Result<(), AppError> {
        db.move_folder(id, new_parent_id)
    }

    /// 批量重排同级文件夹顺序
    /// ordered_ids 应为同一父节点下的所有子节点，按期望顺序排列
    pub fn reorder(db: &Database, ordered_ids: &[i64]) -> Result<(), AppError> {
        db.set_folder_sort_orders(ordered_ids)
    }

    /// 获取文件夹树
    pub fn list_tree(db: &Database) -> Result<Vec<Folder>, AppError> {
        db.list_folders_tree()
    }

    /// 设置文件夹颜色（hex `#RRGGBB`，传空字符串/None 清除）
    pub fn set_color(db: &Database, id: i64, color: Option<&str>) -> Result<(), AppError> {
        let normalized = color.map(str::trim).filter(|s| !s.is_empty());

        if let Some(c) = normalized {
            // 简单 hex 校验：以 # 开头 + 3 或 6 位十六进制
            let hex = c.strip_prefix('#').unwrap_or(c);
            let hex_ok = (hex.len() == 3 || hex.len() == 6)
                && hex.chars().all(|ch| ch.is_ascii_hexdigit());
            if !c.starts_with('#') || !hex_ok {
                return Err(AppError::InvalidInput(format!(
                    "无效的颜色值: {} (期望 #RGB 或 #RRGGBB)",
                    c
                )));
            }
        }

        db.set_folder_color(id, normalized)
    }

    /// T-006: 把 "工作/周报" 这样的路径字符串解析成 folder_id，不存在则一路递归创建
    ///
    /// - 路径分隔符用 "/"（跨平台友好，避免 Windows `\`）
    /// - 空串或纯空白 → 返回 None（即根目录）
    /// - 段内的前后空白会被 trim；空段跳过（容忍 `"a//b"`）
    /// - 每一段先 `find_folder_by_name` 命中则复用，否则 `create_folder` 新建
    pub fn ensure_path(db: &Database, path: &str) -> Result<Option<i64>, AppError> {
        let segments: Vec<&str> = path
            .split('/')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if segments.is_empty() {
            return Ok(None);
        }

        let mut parent: Option<i64> = None;
        for name in segments {
            let existing = db.find_folder_by_name(parent, name)?;
            parent = match existing {
                Some(id) => Some(id),
                None => {
                    let f = db.create_folder(name, parent)?;
                    Some(f.id)
                }
            };
        }
        Ok(parent)
    }
}
