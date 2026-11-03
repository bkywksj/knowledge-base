import { useEffect, useState } from "react";
import {
  Button,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from "antd";
import { RotateCcw } from "lucide-react";
import { useAppStore } from "@/store";
import {
  EDITOR_HIGHLIGHT_SHORTCUT_DEFAULT,
  accelToKeys,
  keyboardEventToAccel,
  isMacPlatform,
} from "@/lib/shortcuts/registry";

const { Text } = Typography;

/**
 * 设置页 - 「编辑器外观」卡片内的一行：自定义编辑器「高亮」快捷键。
 *
 * 与全局快捷键（ShortcutsSection，后端注册的系统级热键）不同，高亮是编辑器内动作，
 * 键位存在 store.editorHighlightShortcut，由 TiptapEditor 的 handleKeyDown 实时读取触发。
 * 这里提供录键改键 / 恢复默认 / 禁用三个操作，录键交互复用 registry 的 keyboardEventToAccel。
 */
export function EditorHighlightShortcutRow() {
  const accel = useAppStore((s) => s.editorHighlightShortcut);
  const setAccel = useAppStore((s) => s.setEditorHighlightShortcut);
  const [recording, setRecording] = useState(false);

  const isDefault = accel === EDITOR_HIGHLIGHT_SHORTCUT_DEFAULT;
  const isDisabled = !accel;

  return (
    <div
      className="flex items-center justify-between py-1 mt-2"
      style={{ borderTop: "1px solid var(--ant-color-border-secondary, #f0f0f0)", paddingTop: 12 }}
    >
      <div>
        <div>
          高亮快捷键
          {isDisabled && (
            <Tag color="default" style={{ marginLeft: 8, fontSize: 10 }}>
              已禁用
            </Tag>
          )}
          {!isDisabled && !isDefault && (
            <Tag color="orange" style={{ marginLeft: 8, fontSize: 10 }}>
              已自定义
            </Tag>
          )}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          选中文字后按此快捷键即可加 / 取消高亮。可改键或禁用，仅在编辑器内生效。
        </Text>
      </div>
      <Space size={8}>
        <KeyDisplay accel={accel} />
        <Tooltip title="点击录入新键位">
          <Button size="small" onClick={() => setRecording(true)}>
            改键
          </Button>
        </Tooltip>
        {!isDefault && (
          <Tooltip title="恢复为默认值">
            <Button
              size="small"
              icon={<RotateCcw size={12} />}
              onClick={() => setAccel(EDITOR_HIGHLIGHT_SHORTCUT_DEFAULT)}
            />
          </Tooltip>
        )}
        {!isDisabled && (
          <Tooltip title="禁用高亮快捷键（仍可用工具栏按钮加高亮）">
            <Button size="small" danger onClick={() => setAccel("")}>
              禁用
            </Button>
          </Tooltip>
        )}
      </Space>

      <RecordModal
        open={recording}
        onClose={() => setRecording(false)}
        onConfirm={(next) => {
          setAccel(next);
          setRecording(false);
        }}
      />
    </div>
  );
}

/** 按当前平台键位渲染一段 accel（macOS ⌘⌥⇧ / Win/Linux Ctrl Alt Shift）；空串显示"—" */
function KeyDisplay({ accel }: { accel: string }) {
  const { token } = antdTheme.useToken();
  const keys = accelToKeys(accel);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      {keys.map((k, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          {i > 0 && (
            <span style={{ color: token.colorTextQuaternary, fontSize: 11 }}>+</span>
          )}
          <kbd
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 11,
              minWidth: 22,
              textAlign: "center",
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgTextHover,
              color: token.colorTextSecondary,
              fontFamily: "inherit",
            }}
          >
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/** 录键 Modal：弹窗后监听 keydown，转成 accelerator 字符串预览 */
function RecordModal({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (accel: string) => void;
}) {
  const [recorded, setRecorded] = useState("");

  useEffect(() => {
    if (!open) {
      setRecorded("");
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // 阻止录键过程触发其他热键 / 默认行为
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const accel = keyboardEventToAccel(e);
      if (accel) setRecorded(accel);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  return (
    <Modal
      open={open}
      title="改键：高亮"
      onCancel={onClose}
      okText="应用"
      okButtonProps={{ disabled: !recorded }}
      onOk={() => {
        if (recorded) onConfirm(recorded);
      }}
    >
      <div style={{ padding: "16px 0", textAlign: "center" }}>
        <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          请按下新的快捷键组合（按 Esc 取消）
        </Text>
        <div
          style={{
            padding: "20px",
            border: "2px dashed var(--kb-border)",
            borderRadius: 8,
            minHeight: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--kb-bg-panel)",
          }}
        >
          {recorded ? <KeyDisplay accel={recorded} /> : <Text type="secondary">尚未录入…</Text>}
        </div>
        <Text type="secondary" style={{ display: "block", marginTop: 12, fontSize: 12 }}>
          需包含至少一个修饰键（{isMacPlatform() ? "⌘ / ⌃ / ⌥ / ⇧" : "Ctrl / Alt / Shift"}）+ 主键；
          建议避开已被占用的组合（如加粗 Ctrl+B）。
        </Text>
      </div>
    </Modal>
  );
}
