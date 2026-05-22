import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { theme as antdTheme } from "antd";
import { NotebookText, Folder as FolderIcon } from "lucide-react";

export interface WikiSuggestionItem {
  id: number;
  title: string;
  /** 直接父文件夹名；用于重名标题的消歧义提示 */
  folderName?: string | null;
}

export interface WikiLinkSuggestionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface Props {
  items: WikiSuggestionItem[];
  command: (item: WikiSuggestionItem) => void;
}

export const WikiLinkSuggestionList = forwardRef<WikiLinkSuggestionListRef, Props>(
  function WikiLinkSuggestionListInner({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const { token } = antdTheme.useToken();

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div
          style={{
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            boxShadow: token.boxShadowSecondary,
            padding: "8px 12px",
            fontSize: 13,
            color: token.colorTextTertiary,
          }}
        >
          无匹配笔记
        </div>
      );
    }

    return (
      <div
        style={{
          background: token.colorBgElevated,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
          boxShadow: token.boxShadowSecondary,
          padding: 4,
          minWidth: 240,
          maxHeight: 280,
          overflowY: "auto",
        }}
      >
        {items.map((item, i) => {
          const isActive = i === selectedIndex;
          return (
            <div
              key={`${item.id}-${item.title}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => {
                // 阻止编辑器失焦（失焦会让 suggestion 关闭）
                e.preventDefault();
                command(item);
              }}
              style={{
                padding: "6px 10px",
                fontSize: 13,
                borderRadius: 4,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: isActive ? token.controlItemBgActive : "transparent",
                color: token.colorText,
              }}
            >
              <NotebookText size={14} style={{ flexShrink: 0 }} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
              </span>
              {/* 直接父文件夹名：让重名标题在视觉上可区分（如「张三 · 项目A」） */}
              {item.folderName && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    flexShrink: 0,
                    maxWidth: 100,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <FolderIcon size={10} />
                  {item.folderName}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  },
);
