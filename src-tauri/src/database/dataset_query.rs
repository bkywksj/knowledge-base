//! 数据集查询计划执行器（P2-3）。
//!
//! 藏知「表格双轨制」的**执行轨**：向量 / 关键词只负责找到*哪张表*，
//! 真正的计算交给模型填的结构化 [`DatasetQueryPlan`]，由这里拼参数化 SQL 执行。
//!
//! 这么做的核心收益不是性能，是**正确性**：把"算数"从模型手里拿走。
//! 模型看着一张 markdown 表逐行心算求和，错了还答得理直气壮；
//! 换成计划执行后，要么算得准，要么明确报错说这个查询表达不了 ——
//! 用户宁可听到"我算不了"，也不想拿到一个看着像模像样的错数字。
//!
//! # 为什么用 SQLite 原生聚合而不引 DuckDB
//!
//! DuckDB 是为百万行列存准备的，会显著增大包体。个人知识库里的 Excel
//! 通常几十到几千行，SQLite 的 `json_extract` + `GROUP BY` 完全够用。

use crate::error::AppError;
use crate::models::{
    DatasetFilterOp, DatasetMetric, DatasetQueryPlan, DatasetQueryResult, DatasetQueryRow,
    DatasetSortBy, DatasetSortOrder, DatasetSuggestion,
};

use super::Database;

/// 硬上限。抄藏知 `structured_table.py:64-72` 的思路：
/// 这些数字不是性能考虑，而是**给模型划边界** —— 允许它一次拉 5000 个分组，
/// 结果也只会撑爆上下文窗口，还不如逼它把问题问得更具体。
const MAX_RESULT_ROWS: usize = 50;
const MAX_FILTERS: usize = 8;
/// 零结果时提示几个真实取值
const SUGGEST_LIMIT: i64 = 8;

/// SQL 参数收集器：值只能通过它进入语句，保证一律是占位符。
struct Binds(Vec<rusqlite::types::Value>);

impl Binds {
    fn new() -> Self {
        Self(Vec::new())
    }
    /// 压入一个值，返回它对应的占位符（`?1` / `?2` …）
    fn push(&mut self, v: rusqlite::types::Value) -> String {
        self.0.push(v);
        format!("?{}", self.0.len())
    }
}

impl Database {
    /// 执行一份查询计划。
    ///
    /// # 安全边界
    ///
    /// SQL 由三部分拼成，每部分都不可能来自模型的自由文本：
    ///
    /// 1. **算子 / 聚合函数** —— 来自 Rust enum，编译期就是有限集
    /// 2. **列名** —— 必须命中该 dataset 在 `dataset_fields` 里的已知列，
    ///    且只作为 `json_extract(data_json, ?)` 的**绑定参数**出现，不进 SQL 文本
    /// 3. **值** —— 全部走 `?` 占位
    ///
    /// 所以模型即便把列名填成 `a"); DROP TABLE notes;--`，也只会得到
    /// 「未知列」错误，而不是一条被拼进去的语句。
    pub fn execute_dataset_query(
        &self,
        plan: &DatasetQueryPlan,
    ) -> Result<DatasetQueryResult, AppError> {
        let schema = self.get_dataset_schema(plan.dataset_id)?;

        // 列名校验顺带给出可用列 —— 只说"未知列"的话，模型下一轮只会再猜一个
        let resolve = |name: &str| -> Result<String, AppError> {
            match schema.fields.iter().find(|f| f.name == name) {
                Some(f) => Ok(f.name.clone()),
                None => Err(AppError::InvalidInput(format!(
                    "数据集 {} 没有列「{}」。可用列：{}",
                    plan.dataset_id,
                    name,
                    schema
                        .fields
                        .iter()
                        .map(|f| f.name.as_str())
                        .collect::<Vec<_>>()
                        .join(" / ")
                ))),
            }
        };

        if plan.filters.len() > MAX_FILTERS {
            return Err(AppError::InvalidInput(format!(
                "过滤条件最多 {} 个，收到 {} 个；请把问题拆成几次查询",
                MAX_FILTERS,
                plan.filters.len()
            )));
        }

        let mut binds = Binds::new();

        // ── 聚合表达式 ──
        let metric_col = match (plan.metric.needs_column(), &plan.metric_column) {
            (true, Some(c)) => Some(resolve(c)?),
            (true, None) => {
                return Err(AppError::InvalidInput(
                    "该聚合口径需要 metric_column（只有 metric=rows 可以不给）".into(),
                ))
            }
            (false, _) => None,
        };

        // 拿标识列求和是典型误用：订单编号加起来是个没有意义的数字，
        // 但模型不会自己意识到，只会把它当"数值列"用（P1-3b 的画像正好能拦下来）
        if plan.metric.numeric_only() {
            if let Some(name) = &metric_col {
                let f = schema.fields.iter().find(|f| &f.name == name).expect("已校验");
                if f.inferred_type != "number" {
                    return Err(AppError::InvalidInput(format!(
                        "列「{}」推断类型是 {}，不适合 sum/avg。若只是想数条目请用 count 或 rows",
                        name, f.inferred_type
                    )));
                }
            }
        }

        let metric_expr = match plan.metric {
            DatasetMetric::Rows => "COUNT(*)".to_string(),
            _ => {
                let ph = binds.push(json_path(metric_col.as_deref().expect("已校验")).into());
                let cell = format!("json_extract(data_json, {ph})");
                match plan.metric {
                    DatasetMetric::Count => format!("COUNT(NULLIF({cell}, ''))"),
                    DatasetMetric::CountDistinct => format!("COUNT(DISTINCT NULLIF({cell}, ''))"),
                    // CAST 不能省：值在 JSON 里是字符串，直接 SUM 会按 0 处理
                    DatasetMetric::Sum => format!("SUM(CAST({cell} AS REAL))"),
                    DatasetMetric::Avg => format!("AVG(CAST({cell} AS REAL))"),
                    DatasetMetric::Min => format!("MIN({cell})"),
                    DatasetMetric::Max => format!("MAX({cell})"),
                    DatasetMetric::Rows => unreachable!("上面分支已处理"),
                }
            }
        };

        // ── 分组 ──
        let group_expr = match &plan.group_by {
            Some(g) => {
                let name = resolve(g)?;
                let ph = binds.push(json_path(&name).into());
                Some(format!("COALESCE(json_extract(data_json, {ph}), '')"))
            }
            None => None,
        };

        // ── 过滤 ──
        let mut wheres: Vec<String> = Vec::new();
        for f in &plan.filters {
            let name = resolve(&f.column)?;
            let ph = binds.push(json_path(&name).into());
            let cell = format!("json_extract(data_json, {ph})");
            wheres.push(build_filter_sql(f.op, &cell, f.value.as_ref(), &mut binds)?);
        }
        let where_sql = if wheres.is_empty() {
            String::new()
        } else {
            format!(" AND {}", wheres.join(" AND "))
        };

        // ── 组装 ──
        let limit = plan
            .limit
            .unwrap_or(MAX_RESULT_ROWS)
            .clamp(1, MAX_RESULT_ROWS);
        let order = match plan.sort_order.unwrap_or(DatasetSortOrder::Desc) {
            DatasetSortOrder::Asc => "ASC",
            DatasetSortOrder::Desc => "DESC",
        };
        let sort_key = match plan.sort_by.unwrap_or(DatasetSortBy::Metric) {
            DatasetSortBy::Metric => "v",
            DatasetSortBy::Group => "g",
        };
        let ds_ph = binds.push(plan.dataset_id.into());

        let sql = match &group_expr {
            // 多取一行是为了判断"是不是还有分组被截掉了"，好如实告诉模型
            Some(g) => format!(
                "SELECT {g} AS g, {metric_expr} AS v, COUNT(*) AS n \
                 FROM dataset_rows WHERE dataset_id = {ds_ph}{where_sql} \
                 GROUP BY g ORDER BY {sort_key} {order} LIMIT {}",
                limit + 1
            ),
            None => format!(
                "SELECT '' AS g, {metric_expr} AS v, COUNT(*) AS n \
                 FROM dataset_rows WHERE dataset_id = {ds_ph}{where_sql}"
            ),
        };

        let mut matched: i64 = 0;
        let mut rows: Vec<DatasetQueryRow> = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| AppError::Custom(e.to_string()))?;
            let mut stmt = conn.prepare(&sql)?;
            let bound: Vec<&dyn rusqlite::ToSql> =
                binds.0.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            let collected = stmt
                .query_map(bound.as_slice(), |r| {
                    let g: String = r.get::<_, Option<String>>(0)?.unwrap_or_default();
                    let v = sql_value_to_json(r.get_ref(1)?);
                    let n: i64 = r.get(2)?;
                    Ok((g, v, n))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            collected
                .into_iter()
                .map(|(g, v, n)| {
                    matched += n;
                    DatasetQueryRow { group: g, value: v }
                })
                .collect()
        };

        let truncated = group_expr.is_some() && rows.len() > limit;
        rows.truncate(limit);

        // 无分组的 SQL 恒返回一行；一条都没匹配上时那行是 NULL/0，要如实说成"零结果"
        if group_expr.is_none() && matched == 0 {
            rows.clear();
        }

        // 零结果 → 给出该列真实存在的取值，让模型自纠，而不是反复猜同一个错值
        let suggested_values = if rows.is_empty() {
            self.suggest_values_for(plan)?
        } else {
            None
        };

        Ok(DatasetQueryResult {
            rows,
            matched_rows: matched,
            truncated,
            suggested_values,
        })
    }

    /// 列出全库所有数据集的**目录卡**（元信息 + 列画像），供 AI 发现"有哪些表能查"。
    ///
    /// 这是藏知「表格双轨制」的检索轨落点：只给卡片、不给行数据 ——
    /// 卡片是给模型看的"表长什么样"，真要算数走 [`Database::execute_dataset_query`]。
    /// 一张几千行的表整个塞进上下文既撑爆窗口、又让模型回到"逐行心算"的老路。
    pub fn list_all_dataset_schemas(
        &self,
        limit: i64,
    ) -> Result<Vec<crate::models::DatasetSchema>, AppError> {
        let ids: Vec<i64> = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| AppError::Custom(e.to_string()))?;
            let mut stmt = conn.prepare(
                "SELECT id FROM datasets ORDER BY created_at DESC, id DESC LIMIT ?1",
            )?;
            // 必须先绑到变量再作为块的值返回：直接把 collect() 当尾表达式，
            // stmt 会在块结束时先于返回值被 drop，借用检查不过
            let collected = stmt
                .query_map([limit.clamp(1, 200)], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        // get_dataset_schema 自己要拿锁，所以先把 id 收完再逐个取，别在持锁时调它
        ids.into_iter()
            .map(|id| self.get_dataset_schema(id))
            .collect()
    }

    /// 零结果时，挑第一个等值 / 包含类过滤所用的列，返回它真实存在的前几个取值。
    fn suggest_values_for(
        &self,
        plan: &DatasetQueryPlan,
    ) -> Result<Option<DatasetSuggestion>, AppError> {
        let Some(f) = plan.filters.iter().find(|f| {
            matches!(
                f.op,
                DatasetFilterOp::Eq | DatasetFilterOp::Contains | DatasetFilterOp::In
            )
        }) else {
            return Ok(None);
        };

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT json_extract(data_json, ?2) AS v \
             FROM dataset_rows WHERE dataset_id = ?1 AND v IS NOT NULL AND v <> '' \
             ORDER BY v LIMIT ?3",
        )?;
        let values: Vec<String> = stmt
            .query_map(
                rusqlite::params![plan.dataset_id, json_path(&f.column), SUGGEST_LIMIT],
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;

        if values.is_empty() {
            return Ok(None);
        }
        Ok(Some(DatasetSuggestion {
            column: f.column.clone(),
            values,
        }))
    }
}

/// 列名 → JSON1 路径。
///
/// 列名里的 `"` 必须转义，否则 `$."a"b"` 是个非法路径、`json_extract` 直接报错。
/// 路径本身作为**绑定参数**传入，不进 SQL 文本。
fn json_path(col: &str) -> String {
    format!("$.\"{}\"", col.replace('"', "\\\""))
}

/// 按算子生成 SQL 片段，值全部走占位符。
fn build_filter_sql(
    op: DatasetFilterOp,
    cell: &str,
    value: Option<&serde_json::Value>,
    binds: &mut Binds,
) -> Result<String, AppError> {
    use DatasetFilterOp as Op;

    if op.needs_value() && value.is_none() {
        return Err(AppError::InvalidInput(format!("算子 {op:?} 需要 value")));
    }

    let sql = match op {
        Op::IsEmpty => format!("({cell} IS NULL OR {cell} = '')"),
        Op::IsNotEmpty => format!("({cell} IS NOT NULL AND {cell} <> '')"),
        Op::In => {
            let arr = value
                .and_then(|v| v.as_array())
                .ok_or_else(|| AppError::InvalidInput("算子 in 的 value 必须是数组".into()))?;
            if arr.is_empty() {
                return Err(AppError::InvalidInput("算子 in 的数组不能为空".into()));
            }
            let phs: Vec<String> = arr.iter().map(|v| binds.push(json_to_sql(v))).collect();
            format!("{cell} IN ({})", phs.join(", "))
        }
        Op::Contains | Op::StartsWith | Op::EndsWith => {
            let raw = json_to_text(value.expect("已校验"));
            // 转义 LIKE 通配符：用户数据里真实出现的 % 不该变成"匹配任意"
            let esc = raw
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pat = match op {
                Op::Contains => format!("%{esc}%"),
                Op::StartsWith => format!("{esc}%"),
                _ => format!("%{esc}"),
            };
            let ph = binds.push(pat.into());
            format!("{cell} LIKE {ph} ESCAPE '\\'")
        }
        Op::Eq | Op::Ne | Op::Gt | Op::Gte | Op::Lt | Op::Lte => {
            // 数值比较必须 CAST：JSON 里存的是字符串，字符串序下 "9" > "10"
            let (lhs, v) = if op.numeric_compare() {
                let text = json_to_text(value.expect("已校验"));
                let n = text.parse::<f64>().map_err(|_| {
                    AppError::InvalidInput(format!("算子 {op:?} 需要数值 value，收到「{text}」"))
                })?;
                (
                    format!("CAST({cell} AS REAL)"),
                    rusqlite::types::Value::Real(n),
                )
            } else {
                (cell.to_string(), json_to_sql(value.expect("已校验")))
            };
            let ph = binds.push(v);
            let sym = match op {
                Op::Eq => "=",
                Op::Ne => "<>",
                Op::Gt => ">",
                Op::Gte => ">=",
                Op::Lt => "<",
                Op::Lte => "<=",
                _ => unreachable!("其余算子在上面分支处理"),
            };
            format!("{lhs} {sym} {ph}")
        }
    };
    Ok(sql)
}

/// JSON 值 → SQL 绑定值（数字保持数字，其余按文本）
fn json_to_sql(v: &serde_json::Value) -> rusqlite::types::Value {
    match v {
        serde_json::Value::Number(n) => n
            .as_f64()
            .map(rusqlite::types::Value::Real)
            .unwrap_or_else(|| rusqlite::types::Value::Text(n.to_string())),
        serde_json::Value::Null => rusqlite::types::Value::Null,
        other => rusqlite::types::Value::Text(json_to_text(other)),
    }
}

fn json_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// SQLite 值 → JSON。聚合结果既可能是数字也可能是文本
/// （`min`/`max` 作用在文本列上就是文本），故不能写死成数字。
fn sql_value_to_json(v: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::json!(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => serde_json::Value::Null,
    }
}
