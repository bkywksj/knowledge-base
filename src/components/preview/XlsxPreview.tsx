import { useEffect, useMemo, useState } from "react";
import { Spin, Alert, Tabs, Table, Tag } from "antd";
import { attachmentApi, type ExcelPreviewData } from "@/lib/api";
import { DatasetPanel } from "./DatasetPanel";

interface Props {
  /** kb-asset:// 相对路径 */
  rel: string;
}

/**
 * Excel/ODS/CSV 附件预览。
 *
 * 两个视图（P1-3b 起）：
 * - **原样预览**：文件长什么样就显示什么样，多 sheet 用 Tabs 切换
 * - **数据集**：识别出来的结构 —— 一个 sheet 里的说明文字 / 主表 / 小计表会被切成
 *   各自独立的数据集，每列带类型与语义角色
 *
 * 两者都保留是有意的：原样预览用来"确认这是我要的文件"，
 * 数据集用来"看清它的结构、准备拿它算东西"。
 */
export function XlsxPreview({ rel }: Props) {
  return (
    <Tabs
      size="small"
      items={[
        { key: "raw", label: "原样预览", children: <RawSheets rel={rel} /> },
        { key: "dataset", label: "数据集", children: <DatasetPanel rel={rel} /> },
      ]}
    />
  );
}

/** 原样预览：把文件按 sheet 显示出来 */
function RawSheets({ rel }: Props) {
  const [data, setData] = useState<ExcelPreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    attachmentApi
      .previewExcel(rel)
      .then((d) => {
        if (!cancelled) setData(d);
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
  }, [rel]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height: "100%", minHeight: 240 }}
      >
        <Spin tip="正在解析 Excel..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Excel 预览失败"
        description={error}
      />
    );
  }

  if (!data || data.sheets.length === 0) {
    return <Alert type="info" message="文件没有任何 Sheet" />;
  }

  return (
    <Tabs
      size="small"
      items={data.sheets.map((sheet, sheetIdx) => ({
        key: String(sheetIdx),
        label: (
          <span>
            {sheet.name}
            {sheet.truncatedRows > 0 && (
              <Tag color="orange" style={{ marginLeft: 6, fontSize: 10 }}>
                已截断
              </Tag>
            )}
          </span>
        ),
        children: <SheetTable sheet={sheet} />,
      }))}
    />
  );
}

interface SheetTableProps {
  sheet: ExcelPreviewData["sheets"][number];
}

/**
 * 单 sheet 渲染。
 *
 * 用 antd Table 而不是裸 <table>：
 * - 内建虚拟滚动（大表友好）
 * - 列宽自动 + 横向滚动
 * - 单元格自动 ellipsis 防止超宽
 */
function SheetTable({ sheet }: SheetTableProps) {
  const columns = useMemo(() => {
    if (sheet.headers.length === 0) {
      // 没表头：用第一行长度生成 col1/col2/...
      const w = sheet.rows[0]?.length ?? 0;
      return Array.from({ length: w }, (_, i) => ({
        title: `col${i + 1}`,
        dataIndex: String(i),
        key: String(i),
        ellipsis: true,
        width: 140,
      }));
    }
    return sheet.headers.map((h, i) => ({
      title: h || `col${i + 1}`,
      dataIndex: String(i),
      key: String(i),
      ellipsis: true,
      width: 140,
    }));
  }, [sheet.headers, sheet.rows]);

  const dataSource = useMemo(
    () =>
      sheet.rows.map((row, rowIdx) => {
        const o: Record<string, string> = { __key: String(rowIdx) };
        row.forEach((cell, i) => {
          o[String(i)] = cell;
        });
        return o;
      }),
    [sheet.rows],
  );

  if (sheet.rows.length === 0 && sheet.headers.length === 0) {
    return <Alert type="info" message="（空 Sheet）" showIcon />;
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 6 }}>
        共 {sheet.totalRows} 行
        {sheet.truncatedRows > 0 && (
          <span style={{ marginLeft: 8, color: "#d4811f" }}>
            （已省略中间 {sheet.truncatedRows} 行）
          </span>
        )}
      </div>
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey="__key"
        size="small"
        bordered
        scroll={{ x: "max-content", y: 480 }}
        pagination={{
          pageSize: 50,
          size: "small",
          showSizeChanger: false,
          hideOnSinglePage: true,
        }}
      />
    </div>
  );
}
