import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Popover, InputNumber, Checkbox, Tooltip, theme as antdTheme } from "antd";
import {
  Table as TableIcon,
  ChevronDown,
  Columns3,
  Rows3,
  Combine,
  Split,
  Trash2,
  PanelTop,
  PanelLeft,
} from "lucide-react";

interface Props {
  editor: Editor;
}

// WPS / Word 风格网格选择器的尺寸上限：悬停划选最多 6 行 × 10 列；
// 更大的表格走下方"自定义行列"输入框（支持到 50×50）。
// 行数从 8 减到 6：腾出的纵向空间留给下方编辑命令，使其不显拥挤。
const GRID_ROWS = 6;
const GRID_COLS = 10;

/**
 * 表格工具栏按钮：点击后在浮层里直接选行列插入，无需二次弹窗。
 * - 上半部：网格悬停选择（鼠标划过高亮 N×M，点击立即插入），含表头开关；
 * - 中部：大表格用的「自定义行列」输入框（1–50）；
 * - 下半部：光标在表格内时显示的编辑命令（加行列 / 合并 / 表头 / 删除等）。
 *
 * slash 命令 `/表格` 通过 `kb-open-insert-table` CustomEvent 唤起同一浮层。
 */
export function TableButton({ editor }: Props) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  // 网格当前悬停到的行列（1-based，0 表示未悬停）
  const [hoverR, setHoverR] = useState(0);
  const [hoverC, setHoverC] = useState(0);
  const [withHeader, setWithHeader] = useState(true);
  // 自定义行列输入
  const [customRows, setCustomRows] = useState(3);
  const [customCols, setCustomCols] = useState(3);

  // slash 命令唤起：打开浮层
  useEffect(() => {
    const handler = () => setOpen(true);
    document.addEventListener("kb-open-insert-table", handler);
    return () => document.removeEventListener("kb-open-insert-table", handler);
  }, []);

  const insert = (rows: number, cols: number) => {
    const r = Math.min(Math.max(Math.round(rows || 0), 1), 50);
    const c = Math.min(Math.max(Math.round(cols || 0), 1), 50);
    editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: withHeader }).run();
    setOpen(false);
    setHoverR(0);
    setHoverC(0);
  };

  const inTable = editor.isActive("table");
  const can = editor.can();

  // 编辑命令行：仅在光标位于表格内时有意义（否则禁用）
  const EditBtn = ({
    icon,
    label,
    onClick,
    disabled,
    danger,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onClick();
        setOpen(false);
      }}
      className="flex items-center gap-2.5 w-full rounded text-left transition-colors"
      style={{
        color: disabled ? token.colorTextDisabled : danger ? token.colorError : token.colorText,
        cursor: disabled ? "not-allowed" : "pointer",
        background: "transparent",
        border: "none",
        // 行高/内边距加大，告别拥挤
        fontSize: 14,
        padding: "6px 10px",
        lineHeight: 1.4,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = token.colorFillTertiary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const labelText =
    hoverR > 0 && hoverC > 0 ? `${hoverR} × ${hoverC} 表格` : "拖选行列，或在下方输入";

  const content = (
    <div style={{ width: 248 }} onMouseDown={(e) => e.preventDefault()}>
      {/* 网格选择器 */}
      <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
        {labelText}
      </div>
      <div
        style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}
        onMouseLeave={() => {
          setHoverR(0);
          setHoverC(0);
        }}
      >
        {Array.from({ length: GRID_ROWS }).map((_, ri) => (
          <div key={ri} style={{ display: "flex", gap: 2 }}>
            {Array.from({ length: GRID_COLS }).map((_, ci) => {
              const active = ri < hoverR && ci < hoverC;
              return (
                <div
                  key={ci}
                  onMouseEnter={() => {
                    setHoverR(ri + 1);
                    setHoverC(ci + 1);
                  }}
                  onClick={() => insert(ri + 1, ci + 1)}
                  style={{
                    width: 20,
                    height: 20,
                    cursor: "pointer",
                    border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
                    background: active ? token.colorPrimaryBg : "transparent",
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>

      <Checkbox
        checked={withHeader}
        onChange={(e) => setWithHeader(e.target.checked)}
        style={{ marginTop: 8, fontSize: 12 }}
      >
        首行作为表头
      </Checkbox>

      {/* 自定义行列（大表格） */}
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <InputNumber
          size="small"
          min={1}
          max={50}
          value={customRows}
          onChange={(v) => setCustomRows(Number(v) || 1)}
          style={{ width: 60 }}
          aria-label="行数"
        />
        <span style={{ color: token.colorTextQuaternary }}>×</span>
        <InputNumber
          size="small"
          min={1}
          max={50}
          value={customCols}
          onChange={(v) => setCustomCols(Number(v) || 1)}
          onPressEnter={() => insert(customRows, customCols)}
          style={{ width: 60 }}
          aria-label="列数"
        />
        <Button size="small" type="primary" onClick={() => insert(customRows, customCols)}>
          插入
        </Button>
      </div>

      {/* 表格编辑命令（光标在表格内时启用） */}
      <div
        style={{
          marginTop: 8,
          paddingTop: 6,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <EditBtn
          icon={<Columns3 size={15} />}
          label="在右侧加列"
          disabled={!inTable || !can.addColumnAfter()}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        />
        <EditBtn
          icon={<Rows3 size={15} />}
          label="在下方加行"
          disabled={!inTable || !can.addRowAfter()}
          onClick={() => editor.chain().focus().addRowAfter().run()}
        />
        <EditBtn
          icon={<Combine size={15} />}
          label="合并单元格"
          disabled={!inTable || !can.mergeCells()}
          onClick={() => editor.chain().focus().mergeCells().run()}
        />
        <EditBtn
          icon={<Split size={15} />}
          label="拆分单元格"
          disabled={!inTable || !can.splitCell()}
          onClick={() => editor.chain().focus().splitCell().run()}
        />
        <EditBtn
          icon={<PanelTop size={15} />}
          label="切换首行表头"
          disabled={!inTable || !can.toggleHeaderRow()}
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        />
        <EditBtn
          icon={<PanelLeft size={15} />}
          label="切换首列表头"
          disabled={!inTable || !can.toggleHeaderColumn()}
          onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
        />
        <EditBtn
          icon={<Trash2 size={15} />}
          label="删除当前行"
          disabled={!inTable || !can.deleteRow()}
          onClick={() => editor.chain().focus().deleteRow().run()}
        />
        <EditBtn
          icon={<Trash2 size={15} />}
          label="删除当前列"
          disabled={!inTable || !can.deleteColumn()}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        />
        <EditBtn
          icon={<Trash2 size={15} />}
          label="删除整个表格"
          danger
          disabled={!inTable || !can.deleteTable()}
          onClick={() => editor.chain().focus().deleteTable().run()}
        />
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      content={content}
    >
      <Tooltip title="表格" mouseEnterDelay={0.5}>
        <Button
          type="text"
          size="small"
          className={inTable ? "toolbar-btn-active" : ""}
          style={{ minWidth: 40, height: 26, padding: "0 4px" }}
          icon={
            <span className="inline-flex items-center gap-0.5">
              <TableIcon size={15} />
              <ChevronDown size={11} style={{ opacity: 0.6 }} />
            </span>
          }
        />
      </Tooltip>
    </Popover>
  );
}
