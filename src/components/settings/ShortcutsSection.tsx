import { useCallback, useEffect, useState } from "react";
import {
  Card,
  Typography,
  Button,
  Modal,
  Space,
  Tag,
  Tooltip,
  message,
  Spin,
  Alert,
  theme as antdTheme,
} from "antd";
import { Keyboard, RotateCcw } from "lucide-react";
import { shortcutsApi } from "@/lib/api";
import { findShortcut, accelToKeys, keyboardEventToAccel, isMacPlatform } from "@/lib/shortcuts/registry";
import type { ShortcutBinding } from "@/types";

const { Text } = Typography;

/**
 * 设置页：全局快捷键管理。
 *
 * - 列出全部 global scope 热键，支持改键 / 重置 / 禁用
 * - 改键弹 Modal 录键：监听 keydown 转 accelerator
 * - 后端 set_shortcut_binding 内部已做冲突检测；UI 把错误用 message.error 反馈
 */
export function ShortcutsSection() {
  const { token } = antdTheme.useToken();
  const [list, setList] = useState<ShortcutBinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState<ShortcutBinding | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setList(await shortcutsApi.list());
    } catch (e) {
      message.error(`加载快捷键失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSet(id: string, accel: string) {
    try {
      await shortcutsApi.set(id, accel);
      message.success("已应用新快捷键");
      await reload();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleReset(id: string) {
    try {
      await shortcutsApi.reset(id);
      message.success("已重置为默认值");
      await reload();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleDisable(id: string) {
    try {
      await shortcutsApi.disable(id);
      message.success("已禁用该快捷键");
      await reload();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Keyboard size={16} />
          全局快捷键
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <Alert
        type="info"
        showIcon
        message="系统级快捷键，应用最小化到托盘 / 在后台运行时也能触发。改键 / 重置即时生效。"
        style={{ marginBottom: 12 }}
      />
      <Spin spinning={loading}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {list.map((b) => {
            const def = findShortcut(b.id);
            return (
              <div
                key={b.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 6,
                  background: token.colorFillAlter,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{def?.desc ?? b.id}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    默认：<KeyDisplay accel={b.defaultAccel} muted />
                    {b.isCustom && !b.disabled && (
                      <Tag color="orange" style={{ marginLeft: 8, fontSize: 10 }}>
                        已自定义
                      </Tag>
                    )}
                    {b.disabled && (
                      <Tag color="default" style={{ marginLeft: 8, fontSize: 10 }}>
                        已禁用
                      </Tag>
                    )}
                  </Text>
                </div>
                <Space size={8}>
                  <KeyDisplay accel={b.accel} />
                  <Tooltip title="点击录入新键位">
                    <Button size="small" onClick={() => setRecording(b)}>
                      改键
                    </Button>
                  </Tooltip>
                  {b.isCustom && (
                    <Tooltip title="恢复为默认值">
                      <Button
                        size="small"
                        icon={<RotateCcw size={12} />}
                        onClick={() => handleReset(b.id)}
                      />
                    </Tooltip>
                  )}
                  {!b.disabled && (
                    <Tooltip title="禁用此快捷键">
                      <Button size="small" danger onClick={() => handleDisable(b.id)}>
                        禁用
                      </Button>
                    </Tooltip>
                  )}
                </Space>
              </div>
            );
          })}
        </div>
      </Spin>

      <RecordModal
        binding={recording}
        onClose={() => setRecording(null)}
        onConfirm={async (accel) => {
          if (recording) {
            await handleSet(recording.id, accel);
            setRecording(null);
          }
        }}
      />
    </Card>
  );
}

/** 显示一段 accel，按当前平台键位渲染（macOS ⌘ ⌥ ⇧，Win/Linux Ctrl Alt Shift） */
function KeyDisplay({ accel, muted = false }: { accel: string; muted?: boolean }) {
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
              background: muted ? "transparent" : token.colorBgTextHover,
              color: muted ? token.colorTextQuaternary : token.colorTextSecondary,
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

/** 录键 Modal：弹窗后监听 keydown，把按键组合转成 accelerator 字符串预览 */
function RecordModal({
  binding,
  onClose,
  onConfirm,
}: {
  binding: ShortcutBinding | null;
  onClose: () => void;
  onConfirm: (accel: string) => void;
}) {
  const [recorded, setRecorded] = useState<string>("");

  useEffect(() => {
    if (!binding) {
      setRecorded("");
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // 阻止录键过程触发其他热键 / 默认行为（输入框聚焦等）
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
  }, [binding, onClose]);

  return (
    <Modal
      open={!!binding}
      title={`改键：${binding ? findShortcut(binding.id)?.desc ?? binding.id : ""}`}
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
            border: "2px dashed #d9d9d9",
            borderRadius: 8,
            minHeight: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#fafafa",
          }}
        >
          {recorded ? (
            <KeyDisplay accel={recorded} />
          ) : (
            <Text type="secondary">尚未录入…</Text>
          )}
        </div>
        <Text type="secondary" style={{ display: "block", marginTop: 12, fontSize: 12 }}>
          需包含至少一个修饰键（{isMacPlatform() ? "⌘ / ⌃ / ⌥ / ⇧" : "Ctrl / Alt / Shift"}）+ 主键；
          F1–F12 / Escape 可单独使用。
        </Text>
      </div>
    </Modal>
  );
}
