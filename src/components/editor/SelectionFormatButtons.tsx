/**
 * 选中文字后浮条里的格式按钮：加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 行内代码。
 *
 * 放在 AI 划词浮条最前面，跟 AI 提示词共用一条：选中文字后最常做的就是改格式，
 * 不用再回到顶部工具栏去找。AI 功能关掉时浮条只剩这一组。
 */
import type { ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Tooltip, theme as antdTheme } from "antd";
import {
  Bold,
  Code,
  Highlighter,
  Italic,
  Strikethrough,
  Underline as UnderlineIcon,
} from "lucide-react";

interface FormatItem {
  key: "bold" | "italic" | "underline" | "strike" | "highlight" | "code";
  label: string;
  icon: ReactNode;
  run: (editor: Editor) => void;
}

const ITEMS: FormatItem[] = [
  {
    key: "bold",
    label: "加粗 Ctrl+B",
    icon: <Bold size={13} />,
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    key: "italic",
    label: "斜体 Ctrl+I",
    icon: <Italic size={13} />,
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    key: "underline",
    label: "下划线 Ctrl+U",
    icon: <UnderlineIcon size={13} />,
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
  {
    key: "strike",
    label: "删除线",
    icon: <Strikethrough size={13} />,
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    key: "highlight",
    label: "高亮",
    icon: <Highlighter size={13} />,
    run: (e) => e.chain().focus().toggleHighlight().run(),
  },
  {
    key: "code",
    label: "行内代码",
    icon: <Code size={13} />,
    run: (e) => e.chain().focus().toggleCode().run(),
  },
];

export function SelectionFormatButtons({ editor }: { editor: Editor }) {
  const { token } = antdTheme.useToken();
  // 只订阅这几个激活态：点按钮后选区不变，不订阅的话按下态不会刷新
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      highlight: e.isActive("highlight"),
      code: e.isActive("code"),
    }),
  });

  return (
    <>
      {ITEMS.map((it) => {
        const on = active[it.key];
        return (
          <Tooltip key={it.key} title={it.label} mouseEnterDelay={0.3}>
            <button
              type="button"
              aria-label={it.label}
              aria-pressed={on}
              className="flex items-center justify-center rounded hover:bg-black/5 transition-colors"
              style={{
                width: 24,
                height: 24,
                // 浮条是 nowrap + 横向滚动，不禁止收缩会被 AI 按钮挤成一条缝
                flexShrink: 0,
                border: "none",
                cursor: "pointer",
                color: on ? token.colorPrimary : token.colorText,
                background: on ? token.colorPrimaryBg : "transparent",
              }}
              // mousedown 先于 blur：阻止默认行为，选区不会在点击瞬间丢失
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => it.run(editor)}
            >
              {it.icon}
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
