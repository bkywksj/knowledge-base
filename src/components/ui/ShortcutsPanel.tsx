import { Modal, theme as antdTheme } from "antd";
import { Keyboard } from "lucide-react";

interface ShortcutGroup {
  title: string;
  items: { keys: string[]; desc: string }[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "全局",
    items: [
      { keys: ["Ctrl", "K"], desc: "打开命令面板" },
      { keys: ["Ctrl", "S"], desc: "保存当前笔记" },
      { keys: ["F11"], desc: "专注模式" },
      { keys: ["Esc"], desc: "退出专注模式" },
    ],
  },
  {
    title: "编辑器 - 文本格式",
    items: [
      { keys: ["Ctrl", "B"], desc: "粗体" },
      { keys: ["Ctrl", "I"], desc: "斜体" },
      { keys: ["Ctrl", "U"], desc: "下划线" },
      { keys: ["Ctrl", "Shift", "X"], desc: "删除线" },
      { keys: ["Ctrl", "Shift", "H"], desc: "高亮" },
      { keys: ["Ctrl", "E"], desc: "行内代码" },
    ],
  },
  {
    title: "编辑器 - 段落",
    items: [
      { keys: ["Ctrl", "Shift", "1"], desc: "标题 1" },
      { keys: ["Ctrl", "Shift", "2"], desc: "标题 2" },
      { keys: ["Ctrl", "Shift", "3"], desc: "标题 3" },
      { keys: ["Ctrl", "Shift", "7"], desc: "有序列表" },
      { keys: ["Ctrl", "Shift", "8"], desc: "无序列表" },
      { keys: ["Ctrl", "Shift", "9"], desc: "任务列表" },
      { keys: ["Ctrl", "Shift", "B"], desc: "引用" },
      { keys: ["Ctrl", "Alt", "C"], desc: "代码块" },
    ],
  },
  {
    title: "编辑器 - 操作",
    items: [
      { keys: ["Ctrl", "Z"], desc: "撤销" },
      { keys: ["Ctrl", "Shift", "Z"], desc: "重做" },
      { keys: ["Ctrl", "A"], desc: "全选" },
      { keys: ["Tab"], desc: "增加缩进" },
      { keys: ["Shift", "Tab"], desc: "减少缩进" },
    ],
  },
];

interface ShortcutsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsPanel({ open, onClose }: ShortcutsPanelProps) {
  const { token } = antdTheme.useToken();

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Keyboard size={16} />
          键盘快捷键
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      styles={{ body: { maxHeight: 480, overflowY: "auto", padding: "12px 20px" } }}
    >
      {shortcutGroups.map((group) => (
        <div key={group.title} className="mb-4">
          <div
            className="text-xs font-semibold mb-2 pb-1"
            style={{
              color: token.colorTextSecondary,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {group.title}
          </div>
          {group.items.map((item) => (
            <div
              key={item.desc}
              className="flex items-center justify-between py-1.5"
            >
              <span className="text-sm" style={{ color: token.colorText }}>
                {item.desc}
              </span>
              <span className="flex items-center gap-1">
                {item.keys.map((key, i) => (
                  <span key={i}>
                    {i > 0 && (
                      <span
                        className="mx-0.5 text-xs"
                        style={{ color: token.colorTextQuaternary }}
                      >
                        +
                      </span>
                    )}
                    <kbd
                      className="px-1.5 py-0.5 rounded text-xs"
                      style={{
                        background: token.colorBgTextHover,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        color: token.colorTextSecondary,
                        fontFamily: "inherit",
                        minWidth: 24,
                        textAlign: "center",
                        display: "inline-block",
                      }}
                    >
                      {key}
                    </kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}
