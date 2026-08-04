/**
 * 编辑器右上角字数统计 popover
 *
 * 触发器：显示当前字数（"1234 字"），hover/click 弹 Popover
 * Popover 内容：字数、字符（含/不含空格）、段落数、阅读时长
 *
 * 算法实现统一在 src/lib/textStats.ts，与底部 stats 共用，避免数字不一致。
 */
import { useEffect, useState } from "react";
import { Popover, Typography } from "antd";
import type { Editor } from "@tiptap/react";
import { calcEditorStats, calcTextStats, type EditorTextStats } from "@/lib/textStats";

const { Text } = Typography;

/**
 * 两种数据源二选一：
 * - `editor`：富文本模式，走文档树统计（段落数准确）
 * - `text`：源码模式没有 Editor 实例，直接统计 markdown 原文
 */
type Props = { editor: Editor; text?: undefined } | { editor?: undefined; text: string };

export function EditorStats(props: Props) {
  const { editor, text } = props;
  const [stats, setStats] = useState<EditorTextStats>(() =>
    editor ? calcEditorStats(editor) : calcTextStats(text ?? ""),
  );

  useEffect(() => {
    // 源码模式：没有 editor 事件可订阅，text 变了直接重算。
    // 输入频率由父组件的 content state 节流决定，这里不再叠一层防抖。
    if (!editor) {
      setStats(calcTextStats(text ?? ""));
      return;
    }
    let timer: number | null = null;
    const update = () => {
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setStats(calcEditorStats(editor));
      }, 300);
    };
    editor.on("update", update);
    editor.on("create", update);
    return () => {
      editor.off("update", update);
      editor.off("create", update);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [editor, text]);

  return (
    <Popover
      placement="bottomRight"
      mouseEnterDelay={0.3}
      content={
        <div className="space-y-1.5 text-sm" style={{ minWidth: 180 }}>
          <Row label="字数" value={`${stats.words} 字`} />
          <Row label="字符（含空格）" value={`${stats.chars}`} />
          <Row label="字符（不含空格）" value={`${stats.charsNoSpace}`} />
          <Row label="段落数" value={`${stats.paragraphs}`} />
          <Row label="阅读时长" value={`约 ${stats.readMinutes} 分钟`} />
        </div>
      }
    >
      <span
        className="tiptap-toolbar-stats"
        style={{ cursor: "default", padding: "0 8px" }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {stats.words} 字
        </Text>
      </span>
    </Popover>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center" style={{ gap: 12 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Text strong style={{ fontSize: 12 }}>{value}</Text>
    </div>
  );
}
