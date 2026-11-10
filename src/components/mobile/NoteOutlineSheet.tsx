import { useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { getHeadingNumberMap } from "@/components/editor/HeadingNumber";
import { MSheet } from "./MSheet";

/**
 * 手机编辑页「更多 → 大纲」：列出正文所有标题，按层级缩进，点一下滚到那里。
 *
 * 与 PC 右侧大纲（EditorOutline）同一套取数：遍历文档 heading 节点、编号取 HeadingNumber 插件算好的那份，
 * 跳转按节点位置（pos）而不是文字，同名标题不会跳错。打开时取一次就够 —— 面板开着时正文改不了。
 */

interface OutlineItem {
  pos: number;
  level: number;
  text: string;
  label: string | null;
}

export function NoteOutlineSheet({ open, onClose, editor }: { open: boolean; onClose: () => void; editor: Editor | null }) {
  const items = useMemo<OutlineItem[]>(() => {
    if (!open || !editor) return [];
    const byPos = getHeadingNumberMap(editor.state);
    const list: OutlineItem[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        list.push({ pos, level: node.attrs.level ?? 1, text: node.textContent || "（无标题）", label: byPos.get(pos) ?? null });
        return false;
      }
      return true;
    });
    return list;
  }, [open, editor]);

  // 缩进按文中出现的最高层级起算：全文只用二、三级标题时不会整体空出一格
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 6);

  function jump(it: OutlineItem) {
    onClose();
    if (!editor) return;
    // 只移光标不 focus：跳过去是为了看，不该把键盘弹起来
    editor.commands.setTextSelection(it.pos + 1);
    const dom = editor.view.nodeDOM(it.pos) as HTMLElement | null;
    dom?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return (
    <MSheet open={open} title="大纲" caption={items.length > 0 ? `${items.length} 个标题` : undefined} onClose={onClose}>
      {items.length === 0 ? (
        <div className="m-group px-4 py-8 text-center">
          <div className="m-t-body" style={{ color: "var(--m-ink2)" }}>这篇笔记还没有标题</div>
          <div className="m-t-cap mt-1">用格式条的「H」或插入面板「格式」加标题后，这里会列出目录</div>
        </div>
      ) : (
        <div className="m-group max-h-[55vh] overflow-y-auto">
          {items.map((it) => (
            <button
              key={it.pos}
              type="button"
              className="m-row"
              style={{ paddingLeft: 16 + (it.level - minLevel) * 16 }}
              onClick={() => jump(it)}
            >
              {it.label && <span className="m-num shrink-0 text-[13px]" style={{ color: "var(--m-ink3)" }}>{it.label}</span>}
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontSize: it.level === minLevel ? 15 : 14, fontWeight: it.level === minLevel ? 600 : 400, color: it.level === minLevel ? "var(--m-ink)" : "var(--m-ink2)" }}
              >
                {it.text}
              </span>
            </button>
          ))}
        </div>
      )}
    </MSheet>
  );
}
