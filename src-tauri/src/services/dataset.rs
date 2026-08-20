//! Excel 数据集的业务编排层（P1-3b）。
//!
//! 串起：解析文件（含合并单元格回填）→ 识别数据区域 + 字段画像 → 落库。
//!
//! # 在整体设计里的位置
//!
//! 这是「目录卡 + 执行器」双轨制里**执行轨**的地基。向量检索永远算不准
//! count/sum，而把全表行灌进索引又会淹没检索 —— 所以精确计算这一路要有
//! 结构化数据可查。本层负责把 Excel 变成可查询的数据，
//! 查询计划执行器（P2-3）在此之上做白名单聚合。

#[cfg(desktop)]
use crate::database::dataset::DatasetInput;
#[cfg(desktop)]
use crate::database::Database;
#[cfg(desktop)]
use crate::error::AppError;
#[cfg(desktop)]
use crate::models::DatasetField;

/// 单个文件最多入库多少个数据集。
///
/// 防的是"一个 sheet 里全是零散小表"导致刷出上百条记录 ——
/// 那种表格本来也不适合结构化查询，与其半吊子入库不如明确截断。
#[cfg(desktop)]
const MAX_DATASETS_PER_FILE: usize = 50;

/// 单个数据集最多入库多少行。
///
/// 超出部分不入库（前端会显示实际总行数与已入库行数的差）。
/// 桌面端 SQLite 单表几万行没问题，但一次 INSERT 十万行会让导入卡住好几秒，
/// 而这种规模的表用 Excel 本身打开更合适。
#[cfg(desktop)]
const MAX_ROWS_PER_DATASET: usize = 50_000;

#[cfg(desktop)]
pub struct DatasetService;

#[cfg(desktop)]
impl DatasetService {
    /// 解析一个表格文件并把其中的数据集整体写入库。
    ///
    /// `source_path` 是相对 data_dir 的附件路径（作为数据集的业务归属键）；
    /// `abs_path` 是磁盘上的真实路径。
    ///
    /// 返回入库的数据集个数。重复导入同一文件 = 整体替换（见 DAO 注释）。
    ///
    /// `force = false` 时，若源文件哈希与库里一致则**直接跳过**：
    /// 解析 + 重插几千行是实打实的耗时，而文件没变时这些活儿等于白干。
    /// 用户想强制重建（比如怀疑识别错了、或改过识别规则）就传 `force = true`。
    pub fn import_file(
        db: &Database,
        source_path: &str,
        abs_path: &str,
        force: bool,
    ) -> Result<usize, AppError> {
        // 源文件哈希：判断"文件变了没"。
        // 走字节版而非 from_utf8_lossy —— xlsx 是二进制，有损转换会让不同文件哈希相同
        let bytes = std::fs::read(abs_path).map_err(AppError::Io)?;
        let source_hash = crate::services::hash::sha256_hex_bytes(&bytes);

        if !force {
            if let Some(known) = db.dataset_source_hash(source_path)? {
                if known == source_hash {
                    let existing = db.list_datasets_by_source(source_path)?.len();
                    log::debug!("[dataset] {} 未变化，跳过重新解析", source_path);
                    return Ok(existing);
                }
            }
        }

        let summary = crate::services::excel_parser::read_workbook(abs_path)?;

        let mut inputs: Vec<DatasetInput> = Vec::new();
        for sheet in &summary.sheets {
            // 解析结果里表头与数据行是分开的，这里拼回原始行序列交给区域识别 ——
            // 因为"首行到底是不是表头"应当由启发式判断，而不是沿用解析层的假设
            // （解析层是无脑取首行，那对"上面有几行说明文字"的表就错了）
            let mut raw: Vec<Vec<String>> = Vec::with_capacity(sheet.rows.len() + 1);
            if !sheet.headers.is_empty() {
                raw.push(sheet.headers.clone());
            }
            raw.extend(sheet.rows.iter().cloned());

            for region in crate::services::dataset_detect::detect_regions(&raw) {
                if inputs.len() >= MAX_DATASETS_PER_FILE {
                    log::warn!(
                        "[dataset] {} 的数据集超过 {} 个，其余已跳过",
                        source_path,
                        MAX_DATASETS_PER_FILE
                    );
                    break;
                }
                let fields: Vec<DatasetField> = region
                    .fields
                    .iter()
                    .map(|f| DatasetField {
                        col_index: f.col_index as i64,
                        name: f.name.clone(),
                        inferred_type: f.inferred_type.as_str().to_string(),
                        semantic_role: f.semantic_role.map(|r| r.as_str().to_string()),
                        completeness: f.completeness,
                        distinct_count: f.distinct_count as i64,
                    })
                    .collect();

                let mut rows = region.rows;
                if rows.len() > MAX_ROWS_PER_DATASET {
                    log::warn!(
                        "[dataset] {}/{} 超过 {} 行，仅入库前 {} 行",
                        source_path,
                        sheet.name,
                        MAX_ROWS_PER_DATASET,
                        MAX_ROWS_PER_DATASET
                    );
                    rows.truncate(MAX_ROWS_PER_DATASET);
                }

                inputs.push(DatasetInput {
                    source_path: source_path.to_string(),
                    sheet_name: sheet.name.clone(),
                    region_index: region.region_index as i64,
                    header_row: region.header_row.map(|h| h as i64),
                    source_hash: source_hash.clone(),
                    headers: region.headers,
                    fields,
                    rows,
                });
            }
        }

        db.replace_datasets_for_source(source_path, &inputs)
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_dssvc_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        Database::init(dir.join("t.db").to_str().unwrap()).expect("init db")
    }

    /// 端到端：一个 sheet 里含「说明行 + 主表 + 小计表」，应识别成 2 个数据集。
    ///
    /// 这条链路（calamine 解析 → 区域识别 → 字段画像 → 落库）纯函数测试覆盖不到，
    /// 故用真实文件跑。标 ignore 是因为依赖外部样本，跑法：
    /// 先用 openpyxl 造 %TEMP%/kb_dataset_e2e.xlsx，再
    /// `cargo test -- import_real_xlsx --ignored`。
    #[test]
    #[ignore = "依赖外部生成的 xlsx 样本，手动验证用"]
    fn import_real_xlsx() {
        let p = std::env::temp_dir().join("kb_dataset_e2e.xlsx");
        assert!(p.exists(), "样本不存在: {:?}", p);
        let db = temp_db();

        let n = DatasetService::import_file(&db, "t/orders.xlsx", p.to_str().unwrap(), false).unwrap();
        assert_eq!(n, 2, "应识别出主表 + 小计表两个数据集");

        let list = db.list_datasets_by_source("t/orders.xlsx").unwrap();
        assert_eq!(list.len(), 2);

        // 第一个区域：订单明细（说明行被空行隔开，不该混进来）
        let s0 = db.get_dataset_schema(list[0].id).unwrap();
        let names: Vec<&str> = s0.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(
            names.contains(&"订单编号") && names.contains(&"金额"),
            "表头识别错误: {:?}",
            names
        );
        assert_eq!(s0.dataset.row_count, 3, "订单表应有 3 行数据");

        // 字段画像：编号是标识（不该被当度量求和），金额是数字
        let id_field = s0.fields.iter().find(|f| f.name == "订单编号").unwrap();
        assert_eq!(id_field.semantic_role.as_deref(), Some("identifier"));
        let amount = s0.fields.iter().find(|f| f.name == "金额").unwrap();
        assert_eq!(amount.inferred_type, "number");
        assert_eq!(amount.semantic_role.as_deref(), Some("measure"));

        // 行数据按列名存 JSON
        let rows = db.preview_dataset_rows(list[0].id, 0, 10).unwrap();
        let first: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(first["订单编号"], "A001");

        // 文件没变 → 跳过重新解析，但返回的仍是已有数据集数（不是 0，免得调用方误以为失败）
        let n2 =
            DatasetService::import_file(&db, "t/orders.xlsx", p.to_str().unwrap(), false).unwrap();
        assert_eq!(n2, 2);
        assert_eq!(db.list_datasets_by_source("t/orders.xlsx").unwrap().len(), 2);

        // force 强制重建：数量一致且不翻倍
        let n3 =
            DatasetService::import_file(&db, "t/orders.xlsx", p.to_str().unwrap(), true).unwrap();
        assert_eq!(n3, 2);
        assert_eq!(db.list_datasets_by_source("t/orders.xlsx").unwrap().len(), 2);
    }
}
