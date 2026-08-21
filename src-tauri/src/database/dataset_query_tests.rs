//! `dataset_query` 的单测。
//!
//! 这块是**安全边界**（模型的自由文本经此变成 SQL），所以注入用例与算子用例同等重要。

#![cfg(test)]

use crate::database::dataset::DatasetInput;
use crate::database::Database;
use crate::models::{
    DatasetField, DatasetFilter, DatasetFilterOp, DatasetMetric, DatasetQueryPlan, DatasetSortBy,
    DatasetSortOrder,
};

fn temp_db() -> Database {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("kb_dsq_{}_{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).unwrap();
    Database::init(dir.join("test.db").to_str().unwrap()).expect("init test db")
}

fn field(idx: i64, name: &str, ty: &str, role: Option<&str>) -> DatasetField {
    DatasetField {
        col_index: idx,
        name: name.to_string(),
        inferred_type: ty.to_string(),
        semantic_role: role.map(|s| s.to_string()),
        completeness: 1.0,
        distinct_count: 0,
    }
}

/// 一张销售表：区域 / 城市 / 销售额(number) / 订单编号(identifier, text)
fn seed(db: &Database) -> i64 {
    let rows: Vec<Vec<String>> = vec![
        vec!["华东".into(), "上海".into(), "100".into(), "A001".into()],
        vec!["华东".into(), "杭州".into(), "250".into(), "A002".into()],
        vec!["华北".into(), "北京".into(), "80".into(), "A003".into()],
        vec!["华北".into(), "天津".into(), "9".into(), "A004".into()],
        // 空销售额：用来验证 count 与 rows 的区别
        vec!["华南".into(), "广州".into(), "".into(), "A005".into()],
    ];
    let input = DatasetInput {
        source_path: "kb_assets/sales.xlsx".into(),
        sheet_name: "Sheet1".into(),
        region_index: 0,
        header_row: Some(0),
        source_hash: "h1".into(),
        headers: vec!["区域".into(), "城市".into(), "销售额".into(), "订单编号".into()],
        fields: vec![
            field(0, "区域", "text", Some("category")),
            field(1, "城市", "text", Some("category")),
            field(2, "销售额", "number", Some("measure")),
            field(3, "订单编号", "text", Some("identifier")),
        ],
        rows,
    };
    db.replace_datasets_for_source("kb_assets/sales.xlsx", &[input])
        .expect("入库失败");
    db.list_datasets_by_source("kb_assets/sales.xlsx").unwrap()[0].id
}

fn plan(dataset_id: i64, metric: DatasetMetric) -> DatasetQueryPlan {
    DatasetQueryPlan {
        dataset_id,
        filters: vec![],
        group_by: None,
        metric,
        metric_column: None,
        sort_by: None,
        sort_order: None,
        limit: None,
    }
}

fn f(col: &str, op: DatasetFilterOp, v: serde_json::Value) -> DatasetFilter {
    DatasetFilter {
        column: col.into(),
        op,
        value: Some(v),
    }
}

// ─── 算子与聚合 ─────────────────────────────

#[test]
fn sum_with_filter_and_group() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Sum);
    p.metric_column = Some("销售额".into());
    p.group_by = Some("区域".into());
    p.sort_by = Some(DatasetSortBy::Metric);
    p.sort_order = Some(DatasetSortOrder::Desc);

    let r = db.execute_dataset_query(&p).unwrap();
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.rows[0].group, "华东");
    assert_eq!(r.rows[0].value.as_f64().unwrap(), 350.0);
    assert_eq!(r.rows[1].group, "华北");
    assert_eq!(r.rows[1].value.as_f64().unwrap(), 89.0);
    assert_eq!(r.matched_rows, 5);
    assert!(!r.truncated);
}

/// 数值比较必须按数值来：字符串序下 "9" > "250"，一旦漏了 CAST 这条就会返回 9
#[test]
fn numeric_compare_is_not_string_compare() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![f("销售额", DatasetFilterOp::Gt, serde_json::json!(100))];

    let r = db.execute_dataset_query(&p).unwrap();
    // 只有 250 > 100；若按字符串比，"80" / "9" 也会被算进来
    assert_eq!(r.rows[0].value.as_i64().unwrap(), 1);
}

/// `rows` 数行，`count` 数非空 —— 广州那行销售额是空的
#[test]
fn rows_counts_all_but_count_skips_empty() {
    let db = temp_db();
    let id = seed(&db);

    let all = db.execute_dataset_query(&plan(id, DatasetMetric::Rows)).unwrap();
    assert_eq!(all.rows[0].value.as_i64().unwrap(), 5);

    let mut p = plan(id, DatasetMetric::Count);
    p.metric_column = Some("销售额".into());
    let non_empty = db.execute_dataset_query(&p).unwrap();
    assert_eq!(non_empty.rows[0].value.as_i64().unwrap(), 4);
}

#[test]
fn count_distinct_and_min_max() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::CountDistinct);
    p.metric_column = Some("区域".into());
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_i64().unwrap(),
        3
    );

    // min/max 作用在文本列上，结果是文本 —— 不能写死成数字
    let mut p = plan(id, DatasetMetric::Max);
    p.metric_column = Some("订单编号".into());
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_str().unwrap(),
        "A005"
    );
}

#[test]
fn contains_and_in_operators() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![f("城市", DatasetFilterOp::Contains, serde_json::json!("州"))];
    // 杭州 / 广州
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_i64().unwrap(),
        2
    );

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![f(
        "区域",
        DatasetFilterOp::In,
        serde_json::json!(["华东", "华南"]),
    )];
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_i64().unwrap(),
        3
    );
}

/// `is_empty` 看的是"空串或缺失"，广州那行销售额正是空串
#[test]
fn is_empty_matches_blank_cell() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![DatasetFilter {
        column: "销售额".into(),
        op: DatasetFilterOp::IsEmpty,
        value: None,
    }];
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_i64().unwrap(),
        1
    );
}

/// 用户数据里真实出现的 `%` 不能被当成通配符
#[test]
fn like_wildcards_in_user_value_are_escaped() {
    let db = temp_db();
    let input = DatasetInput {
        source_path: "kb_assets/pct.xlsx".into(),
        sheet_name: "S".into(),
        region_index: 0,
        header_row: Some(0),
        source_hash: "h".into(),
        headers: vec!["名称".into()],
        fields: vec![field(0, "名称", "text", None)],
        // 🔴 第二行必须也含 "50"、且 "50" 与 "o" 之间隔着别的字符：
        //    转义后 `%50\%o%` 要求字面 "50%o"，只中第一行；
        //    不转义时 `%50%o%` 里的 % 变成通配，两行都中 —— 这样才测得出转义有没有生效。
        //    （第一版写的是「折扣任意off」，不含 "50"，两种实现都只中 1 行 = 假测试）
        rows: vec![vec!["折扣50%off".into()], vec!["折扣50元off".into()]],
    };
    let db_id = {
        db.replace_datasets_for_source("kb_assets/pct.xlsx", &[input])
            .unwrap();
        db.list_datasets_by_source("kb_assets/pct.xlsx").unwrap()[0].id
    };

    let mut p = plan(db_id, DatasetMetric::Rows);
    p.filters = vec![f("名称", DatasetFilterOp::Contains, serde_json::json!("50%o"))];
    // 只该命中字面含 "50%o" 的那行；不转义的话 % 会变成"任意字符"，两行都中
    assert_eq!(
        db.execute_dataset_query(&p).unwrap().rows[0].value.as_i64().unwrap(),
        1
    );
}

// ─── 边界与防呆 ─────────────────────────────

/// 🔴 安全底线：列名是模型的自由文本，绝不能拼进 SQL
#[test]
fn injected_column_name_is_rejected_not_executed() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![f(
        "区域\"); DROP TABLE notes;--",
        DatasetFilterOp::Eq,
        serde_json::json!("华东"),
    )];

    let err = db.execute_dataset_query(&p).unwrap_err().to_string();
    assert!(err.contains("没有列"), "应报未知列，实际: {err}");
    // notes 表必须还在
    let conn = db.conn.lock().unwrap();
    conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
        .expect("notes 表被删了！");
}

/// 拿标识列求和是典型误用（订单编号加起来毫无意义），靠 P1-3b 的列画像拦下
#[test]
fn sum_on_non_number_column_is_refused() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Sum);
    p.metric_column = Some("订单编号".into());

    let err = db.execute_dataset_query(&p).unwrap_err().to_string();
    assert!(err.contains("不适合 sum/avg"), "实际: {err}");
}

#[test]
fn metric_needing_column_without_one_is_refused() {
    let db = temp_db();
    let id = seed(&db);
    let err = db
        .execute_dataset_query(&plan(id, DatasetMetric::Sum))
        .unwrap_err()
        .to_string();
    assert!(err.contains("metric_column"), "实际: {err}");
}

#[test]
fn too_many_filters_refused() {
    let db = temp_db();
    let id = seed(&db);
    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = (0..9)
        .map(|_| f("区域", DatasetFilterOp::Eq, serde_json::json!("华东")))
        .collect();
    let err = db.execute_dataset_query(&p).unwrap_err().to_string();
    assert!(err.contains("最多"), "实际: {err}");
}

/// 零结果要给出该列真实取值，模型才有的可改 —— 否则它只会再猜一个错的
#[test]
fn zero_result_suggests_real_values() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.filters = vec![f("区域", DatasetFilterOp::Eq, serde_json::json!("西北"))];

    let r = db.execute_dataset_query(&p).unwrap();
    assert!(r.rows.is_empty(), "不该编出一行 0");
    assert_eq!(r.matched_rows, 0);
    let s = r.suggested_values.expect("零结果应给候选值");
    assert_eq!(s.column, "区域");
    assert!(s.values.contains(&"华东".to_string()), "实际: {:?}", s.values);
}

/// 分组超过 limit 时要如实说被截了，不能让模型以为看到的是全部
#[test]
fn truncation_is_reported() {
    let db = temp_db();
    let id = seed(&db);

    let mut p = plan(id, DatasetMetric::Rows);
    p.group_by = Some("城市".into());
    p.limit = Some(2);

    let r = db.execute_dataset_query(&p).unwrap();
    assert_eq!(r.rows.len(), 2);
    assert!(r.truncated, "5 个城市取 2 个应标记截断");
}

// ─── 反序列化契约 ─────────────────────────────

/// `deny_unknown_fields`：模型幻想出一个字段时**当场失败**，
/// 而不是静默忽略后返回一个"看着对但少了条件"的结果
#[test]
fn unknown_field_in_plan_is_rejected() {
    let raw = r#"{"dataset_id":1,"metric":"rows","having":"count > 3"}"#;
    let err = serde_json::from_str::<DatasetQueryPlan>(raw).unwrap_err();
    assert!(err.to_string().contains("having"), "实际: {err}");
}

/// 白名单外的算子 / 口径必须解析失败，不能兜底成某个默认值
#[test]
fn unknown_metric_or_op_is_rejected() {
    assert!(serde_json::from_str::<DatasetQueryPlan>(
        r#"{"dataset_id":1,"metric":"median"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<DatasetFilter>(
        r#"{"column":"a","op":"regex","value":"x"}"#
    )
    .is_err());
}

#[test]
fn minimal_plan_parses_with_defaults() {
    let p: DatasetQueryPlan =
        serde_json::from_str(r#"{"dataset_id":7,"metric":"rows"}"#).unwrap();
    assert_eq!(p.dataset_id, 7);
    assert!(p.filters.is_empty());
    assert!(p.group_by.is_none());
    assert!(p.limit.is_none());
}
