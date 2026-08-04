/**
 * Markdown 源码编辑器 —— 绕开富文本层，直接编辑 .md 原文。
 *
 * ## 为什么要有它
 *
 * 主编辑器是 Tiptap（所见即所得），正文要经 ProseMirror schema 往返序列化。
 * schema 是白名单制：没有对应 `parseHTML` 规则的标签会被静默丢弃，
 * `<span style>` 也只保留 font-size / color / font-family / line-height 几个属性。
 * 于是这些场景在富文本模式下都别扭：
 *
 * - 写 YAML front-matter（`---` 包起来的元数据）
 * - 手写 schema 不认的 HTML（`<kbd>` / `<audio>` / 自定义 class 的 div）
 * - 从别处粘一段 markdown 原文，想原样保留
 * - 单纯想看看这篇笔记的 markdown 到底长什么样
 *
 * 源码模式下 content 字符串**原样进出、零解析**，上面这些全部不受影响。
 *
 * ## 为什么是 textarea 而不是 CodeMirror
 *
 * 引 CodeMirror 要多 ~200KB 依赖，而这里的诉求是"能可靠地改原文"，
 * 不是"再造一个 IDE"。textarea 天然拥有：原生撤销栈、输入法友好、
 * 无障碍支持、零依赖。语法高亮属于锦上添花，等用户真提了再说。
 *
 * 补齐的两个体验缺口（textarea 默认没有、但写 markdown 必用）：
 * - **Tab 键插入缩进**而不是跳走焦点（列表缩进、代码块都要）
 * - **保存快捷键透传**：不拦 Ctrl+S，交给页面级快捷键处理
 */
import { useCallback, useEffect, useRef } from "react";
import { theme } from "antd";

interface Props {
  /** markdown 原文；与富文本模式共用同一份 content state */
  value: string;
  /** 内容变化回调；与 TiptapEditor.onChange 同签名，父组件无需区分来源 */
  onChange: (value: string) => void;
}

/** Tab 插入的缩进。用两个空格：markdown 列表的通用缩进单位，也和编辑器序列化一致 */
const INDENT = "  ";

export function MarkdownSourceEditor({ value, onChange }: Props) {
  const { token } = theme.useToken();
  const ref = useRef<HTMLTextAreaElement>(null);

  // 自适应高度：textarea 默认固定行数，内容长了自己出滚动条，
  // 会和外层 .editor-content-area 的滚动打架（两层滚动条，滚起来很怪）。
  // 这里把高度撑到内容实际高度，让滚动只发生在外层容器，与富文本模式观感一致。
  const fitHeight = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    fitHeight();
  }, [value, fitHeight]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd 组合键一律放行：Ctrl+S 保存、Ctrl+F 查找等由页面级快捷键接管
      if (e.ctrlKey || e.metaKey) return;

      if (e.key !== "Tab") return;
      // Tab 默认是"跳到下一个可聚焦元素"，在代码/列表编辑里必然是误操作
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;

      if (e.shiftKey) {
        // Shift+Tab：把光标所在行行首的一层缩进去掉（多行选区则逐行去）
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const head = value.slice(lineStart, end);
        const dedented = head
          .split("\n")
          .map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line))
          .join("\n");
        if (dedented === head) return; // 本来就没缩进，不产生一次无意义的 undo 记录
        const next = value.slice(0, lineStart) + dedented + value.slice(end);
        onChange(next);
        // 光标位置按实际删掉的字符数回退，避免跳到行首
        const removed = head.length - dedented.length;
        queueMicrotask(() => {
          el.selectionStart = Math.max(lineStart, start - INDENT.length);
          el.selectionEnd = Math.max(lineStart, end - removed);
        });
        return;
      }

      // Tab：无选区时插入缩进；有选区时把选中的每一行都缩进一层
      if (start === end) {
        const next = value.slice(0, start) + INDENT + value.slice(end);
        onChange(next);
        queueMicrotask(() => {
          el.selectionStart = el.selectionEnd = start + INDENT.length;
        });
      } else {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const block = value.slice(lineStart, end);
        const indented = block
          .split("\n")
          .map((line) => INDENT + line)
          .join("\n");
        const next = value.slice(0, lineStart) + indented + value.slice(end);
        onChange(next);
        const added = indented.length - block.length;
        queueMicrotask(() => {
          el.selectionStart = start + INDENT.length;
          el.selectionEnd = end + added;
        });
      }
    },
    [value, onChange],
  );

  return (
    <textarea
      ref={ref}
      className="markdown-source-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      // 关掉输入法之外的一切自动纠正：源码里 `*` `_` `--` 都是语法，不能被"智能"替换
      autoCorrect="off"
      autoCapitalize="off"
      placeholder="直接编辑 Markdown 原文…"
      style={{
        width: "100%",
        flex: 1,
        minHeight: 320,
        resize: "none",
        border: "none",
        outline: "none",
        background: "transparent",
        color: token.colorText,
        // 等宽字体：源码模式下对齐比美观重要（表格、缩进、代码块）
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 14,
        lineHeight: 1.7,
        // 长行不换行会逼出横向滚动条，写作时很难受；统一软换行
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflow: "hidden", // 高度已自适应，滚动交给外层容器
        padding: 0,
      }}
    />
  );
}
