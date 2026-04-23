import { theme as antdTheme } from "antd";
import { Check, X } from "lucide-react";

/** 标签预设颜色板（与 Ant Design 默认色板保持一致） */
export const TAG_COLORS = [
  "#1677ff", "#722ed1", "#eb2f96", "#f5222d", "#fa541c",
  "#fa8c16", "#faad14", "#a0d911", "#52c41a", "#13c2c2",
  "#2f54eb", "#531dab", "#c41d7f", "#cf1322", "#d4380d",
  "#d46b08", "#d48806", "#7cb305", "#389e0d", "#08979c",
];

interface Props {
  value?: string | null;
  onChange?: (color: string | null) => void;
  /** 是否显示"清除颜色"按钮（默认 false） */
  allowClear?: boolean;
}

/**
 * 标签预设色选择器 —— 标签页新建/编辑 Modal 和笔记编辑器标签 chip 的 Popover 都用它
 */
export function TagColorPicker({ value, onChange, allowClear = false }: Props) {
  const { token } = antdTheme.useToken();

  return (
    <div className="flex flex-wrap gap-2" style={{ maxWidth: 240 }}>
      {TAG_COLORS.map((c) => (
        <div
          key={c}
          className="flex items-center justify-center cursor-pointer rounded-md transition-all"
          style={{
            width: 26,
            height: 26,
            backgroundColor: c,
            border:
              value === c
                ? `2px solid ${token.colorText}`
                : "2px solid transparent",
            transform: value === c ? "scale(1.12)" : undefined,
          }}
          onClick={() => onChange?.(c)}
        >
          {value === c && <Check size={13} color="#fff" strokeWidth={3} />}
        </div>
      ))}
      {allowClear && (
        <div
          className="flex items-center justify-center cursor-pointer rounded-md transition-all"
          style={{
            width: 26,
            height: 26,
            backgroundColor: "transparent",
            border: `1px dashed ${token.colorBorder}`,
          }}
          title="清除颜色"
          onClick={() => onChange?.(null)}
        >
          <X size={13} color={token.colorTextSecondary} />
        </div>
      )}
    </div>
  );
}
