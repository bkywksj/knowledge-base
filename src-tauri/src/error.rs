use thiserror::Error;

/// 应用统一错误类型
#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("JSON 解析错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ZIP 错误: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// 数据库来自更高版本的应用（用户装回了旧版 / 数据目录被新版应用打开过）。
    ///
    /// **必须与"数据库损坏"区分开**：这种情况下数据完好无损，正确处置是提示用户升级应用，
    /// 而不是走 `services::db_recovery` 的留档 + 空库启动 ——
    /// 那会让用户打开软件看到一个空知识库，以为数据全没了
    /// （见 `db_recovery::should_attempt_recovery`）。
    #[error("数据库版本({db})高于当前应用支持的版本({app})，请升级应用后再打开")]
    SchemaTooNew { db: i32, app: i32 },

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("参数无效: {0}")]
    InvalidInput(String),

    #[error("{0}")]
    Custom(String),
}

/// 让 Tauri Command 能直接使用 AppError 作为错误类型
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}
