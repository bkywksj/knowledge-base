import { useEffect, useState } from "react";
import { Modal, theme as antdTheme, Tag } from "antd";
import { Keyboard } from "lucide-react";
import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  accelToKeys,
  type ShortcutDef,
} from "@/lib/shortcuts/registry";
import { shortcutsApi } from "@/lib/api";
import type { ShortcutBinding } from "@/types";

interface ShortcutsPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 快捷键帮助面板（F1）。
 *
 * 数据来源：
 * - global scope：每次打开都从 `shortcutsApi.list()` 拿（用户改键后立即可见）
 * - app/editor scope：直接用 `registry.SHORTCUTS` 的 defaultAccel
 */
export function ShortcutsPanel({ open, onClose }: ShortcutsPanelProps) {
  const { token } = antdTheme.useToken();
  const [bindings, setBindings] = useState<Map<string, ShortcutBinding>>(new Map());

  useEffect(() => {
    if (!open) return;
    shortcutsApi
      .list()
      .then((list) => {
        const map = new Map<string, ShortcutBinding>();
        for (const b of list) map.set(b.id, b);
        setBindings(map);
      })
      .catch(() => {
        // 拿不到就退化为 defaultAccel，不阻塞 UI
      });
  }, [open]);

  /** 解析单条要显示的 accel：global 走 binding，否则用 defaultAccel */
  function resolveAccel(def: ShortcutDef): string {
    if (def.scope === "global") {
      const b = bindings.get(def.id);
      return b ? b.accel : def.defaultAccel;
    }
    return def.defaultAccel;
  }

  // 按 group 渲染
  const grouped = SHORTCUT_GROUPS
    .map((title) => ({ title, items: SHORTCUTS.filter((s) => s.group === title) }))
    .filter((g) => g.items.length > 0);

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
      width={560}
      styles={{ body: { maxHeight: 520, overflowY: "auto", padding: "12px 20px" } }}
    >
      {grouped.map((group) => (
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
          {group.items.map((item) => {
            const accel = resolveAccel(item);
            const keys = accelToKeys(accel);
            const disabled = !accel;
            return (
              <div
                key={item.id}
                className="flex items-center justify-between py-1.5 gap-3"
              >
                <span
                  className="text-sm flex items-center gap-2"
                  style={{ color: disabled ? token.colorTextQuaternary : token.colorText }}
                >
                  {item.desc}
                  {item.scope === "global" && (
                    <Tag
                      color={disabled ? "default" : "blue"}
                      style={{ fontSize: 10, marginInlineEnd: 0, lineHeight: "16px" }}
                    >
                      {disabled ? "已禁用" : "系统级"}
                    </Tag>
                  )}
                </span>
                <span className="flex items-center gap-1 flex-shrink-0">
                  {keys.map((key, i) => (
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
            );
          })}
        </div>
      ))}
    </Modal>
  );
}
