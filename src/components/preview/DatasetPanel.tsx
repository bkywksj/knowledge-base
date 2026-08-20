import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from "antd";
import { RefreshCw, Database as DatabaseIcon } from "lucide-react";
import { datasetApi } from "@/lib/api";
import { parseDatasetRows, type DatasetRow } from "@/lib/datasetRows";
import type {
  Dataset,
  DatasetField,
  DatasetFieldType,
  DatasetSchema,
  DatasetSemanticRole,
} from "@/types";

/** 一页取多少行 */
const PAGE_SIZE = 50;

/**
 * 字段类型的中文名与配色。
 *
 * 用中文而不是直接显示 `number`/`text`：这个面板是给用户看的，
 * 不是给开发者看的。
 */
const TYPE_META: Record<DatasetFieldType, { label: string; color: string }> = {
  number: { label: "数字", color: "blue" },
  date: { label: "日期", color: "purple" },
  boolean: { label: "是/否", color: "gold" },
  text: { label: "文本", color: "default" },
};

/**
 * 语义角色的中文名与说明。
 *
 * `identifier` 的说明特意写明"不适合求和" —— 这是整个画像里最有实际价值的一条：
 * 「订单编号」是数字但把它加起来毫无意义，用户看到标注就知道别这么用。
 */
const ROLE_META: Record<DatasetSemanticRole, { label: string; hint: string }> = {
  identifier: { label: "标识", hint: "编号 / ID 一类，唯一定位用，不适合求和" },
  measure: { label: "度量", hint: "可求和 / 求平均的数值列" },
  time: { label: "时间", hint: "日期或时间维度，适合按时间分组" },
  status: { label: "状态", hint: "是否 / 完成 一类的状态列" },
  category: { label: "分类", hint: "类别 / 部门 / 地区，适合分组统计" },
};

interface Props {
  /** kb-asset:// 相对路径 */
  rel: string;
}

/**
 * Excel 二维数据集面板（P1-3b）。
 *
 * 与「表格预览」的区别：预览是把文件原样显示出来；这里是**识别出来的结构**——
 * 一个 sheet 里的说明文字、主表、小计表会被切成各自独立的数据集，
 * 每列还带类型与语义角色。这是「精确计算」那一轨的入口
 * （向量检索永远算不准 count/sum，得有结构化数据可查）。
 */
export function DatasetPanel({ rel }: Props) {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      setError(null);
      try {
        // 先解析入库（哈希没变时后端会直接跳过，不会重复解析）
        await datasetApi.import(rel, force);
        setDatasets(await datasetApi.list(rel));
      } catch (e) {
        setError(String(e));
      }
    },
    [rel],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDatasets(null);
    load(false).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [rel, load]);

  async function handleRebuild() {
    setImporting(true);
    await load(true);
    setImporting(false);
    message.success("已重新识别");
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height: "100%", minHeight: 240 }}
      >
        <Spin tip="正在识别数据集..." />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" showIcon message="识别数据集失败" description={error} />;
  }

  if (!datasets || datasets.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span className="text-xs">
            没有识别出可查询的数据区域
            <br />
            （需要至少两行、且列结构规整的表格）
          </span>
        }
      />
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span style={{ fontSize: 12, color: "#999" }}>
          识别出 {datasets.length} 个数据集
        </span>
        <Button
          size="small"
          type="text"
          icon={<RefreshCw size={13} />}
          loading={importing}
          onClick={handleRebuild}
          title="源文件没变时不会重复解析；点这里可强制重新识别"
        >
          重新识别
        </Button>
      </div>
      <Tabs
        size="small"
        items={datasets.map((d) => ({
          key: String(d.id),
          label: (
            <span>
              {d.sheetName}
              {/* 同一 sheet 有多个区域时才显示序号，单区域不加噪声 */}
              {datasets.filter((x) => x.sheetName === d.sheetName).length > 1 && (
                <Tag style={{ marginLeft: 6, fontSize: 10 }}>
                  区域 {d.regionIndex + 1}
                </Tag>
              )}
            </span>
          ),
          children: <DatasetDetail dataset={d} />,
        }))}
      />
    </div>
  );
}

/** 单个数据集：字段画像 + 分页行 */
function DatasetDetail({ dataset }: { dataset: Dataset }) {
  const [schema, setSchema] = useState<DatasetSchema | null>(null);
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      datasetApi.getSchema(dataset.id),
      datasetApi.previewRows(dataset.id, (page - 1) * PAGE_SIZE, PAGE_SIZE),
    ])
      .then(([s, rawRows]) => {
        if (cancelled) return;
        setSchema(s);
        // 后端返回的是每行一个 JSON 字符串（见 parseDatasetRows 注释）
        setRows(parseDatasetRows(rawRows));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset.id, page]);

  const columns = useMemo(
    () =>
      (schema?.fields ?? []).map((f) => ({
        title: <FieldHeader field={f} />,
        dataIndex: f.name,
        key: String(f.colIndex),
        ellipsis: true,
        width: 160,
      })),
    [schema],
  );

  const dataSource = useMemo(
    () =>
      rows.map((r, i) => ({
        ...r,
        __key: `${(page - 1) * PAGE_SIZE + i}`,
      })),
    [rows, page],
  );

  if (error) {
    return <Alert type="error" showIcon message="读取数据集失败" description={error} />;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 6 }}>
        共 {dataset.rowCount} 行 · {dataset.colCount} 列
        {dataset.headerRow === null && (
          <Tooltip title="首行看起来是数据而非列名，故列名回退成 A列/B列">
            <Tag color="orange" style={{ marginLeft: 8, fontSize: 10 }}>
              无表头
            </Tag>
          </Tooltip>
        )}
      </div>
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey="__key"
        size="small"
        bordered
        loading={loading}
        scroll={{ x: "max-content", y: 420 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: dataset.rowCount,
          size: "small",
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: setPage,
        }}
      />
    </div>
  );
}

/** 列头：列名 + 类型徽章 + 语义角色 + 完整度 */
function FieldHeader({ field }: { field: DatasetField }) {
  const type = TYPE_META[field.inferredType] ?? TYPE_META.text;
  const role = field.semanticRole ? ROLE_META[field.semanticRole] : null;
  // 完整度不满 100% 才显示 —— 大多数列是满的，全都标反而看不出哪列有缺失
  const pct = Math.round(field.completeness * 100);

  return (
    <div className="flex flex-col gap-0.5">
      <span>{field.name}</span>
      <span className="flex items-center gap-1" style={{ fontWeight: 400 }}>
        <Tag color={type.color} style={{ fontSize: 10, marginInlineEnd: 0 }}>
          {type.label}
        </Tag>
        {role && (
          <Tooltip title={role.hint}>
            <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>{role.label}</Tag>
          </Tooltip>
        )}
        {pct < 100 && (
          <Tooltip title={`${pct}% 的行在这一列有值`}>
            <Tag color="orange" style={{ fontSize: 10, marginInlineEnd: 0 }}>
              {pct}%
            </Tag>
          </Tooltip>
        )}
        <Tooltip title={`去重后有 ${field.distinctCount} 种取值`}>
          <span style={{ fontSize: 10, color: "#999" }}>
            <DatabaseIcon size={9} style={{ verticalAlign: -1 }} />{" "}
            {field.distinctCount}
          </span>
        </Tooltip>
      </span>
    </div>
  );
}
