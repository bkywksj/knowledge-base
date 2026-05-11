/**
 * IDEA 风格的"对比 / 合并"弹窗：左右两栏 CodeMirror MergeView，中缝带 ▶（把左侧变更块覆盖到右侧）。
 *
 * 约定：**右侧 = 最终结果**。
 *  - 剪贴板对比：左 = 剪贴板（只读），右 = 当前笔记 markdown（可编辑），▶ 把剪贴板的块拉进笔记
 *  - 笔记 vs 笔记：左 = 另一篇（可编辑），右 = 当前/目标笔记（可编辑），▶ 把另一篇的块拉进目标
 *
 * 保存：onSave 提供时右下角出现「保存更改」，回调拿到两侧编辑后的最终文本，由调用方决定怎么写回。
 *
 * 踩过的坑（按 https://github.com/codemirror/merge + discuss.codemirror.net 上的讨论）：
 *  1. **不能换行**（不要 `EditorView.lineWrapping`）—— MergeView 用像素级 block spacer 把对齐行放到同一 Y，
 *     一旦某侧长行换行成多行、另一侧没换，两侧就错位（"左右内容效果不一致"）。IDEA 也是不换行 + 横向滚。
 *  2. **antd Modal 开场有 scale 动画**，CM 在动画里量到的是被缩放的尺寸 → 渲染区域不对 → "内容显示不全"。
 *     Modal `afterOpenChange(true)` 之后再 `view.requestMeasure()` 强制重新量一遍。
 *  3. **MergeView 自带内部滚动同步**且没配置项可关 —— 关掉「同步滚动」开关时反向抵消（鼠标在哪栏滚哪栏）。
 *  4. 两侧文本先把 `\r\n` 归一成 `\n`，否则一边带 `\r`、一边不带会被判成"整篇每行都变了"。
 *  5. MergeView 是命令式 DOM 库，要在 div **真正挂进 DOM** 后再 new —— 用 callback ref（不要 useEffect，
 *     antd Modal 内容是异步挂载的，useEffect 跑时 ref 还是 null → 整片空白）。
 */
import { useCallback, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Switch } from "antd";
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { useAppStore } from "@/store";

export interface DiffSide {
  label: string;
  value: string;
  editable: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  left: DiffSide;
  right: DiffSide;
  /** 提供则右下角显示「保存更改」按钮；回调拿到两侧编辑后的最终文本 */
  onSave?: (result: { left: string; right: string }) => Promise<void> | void;
  /** 「保存更改」下方的小字警告（如"将以 markdown 重新生成笔记内容，自定义块可能丢失"） */
  saveHint?: string;
}

const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

// CM 主题：填满外层固定高度的 host；不换行 → 横向滚（保证两侧行对齐）
const fillTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit", fontSize: "13px" },
});
const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "var(--ant-color-text, #ddd)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#888",
      borderRight: "1px solid rgba(255,255,255,0.08)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.06)" },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(80,150,255,0.30)",
    },
    ".cm-cursor": { borderLeftColor: "#ddd" },
  },
  { dark: true },
);
const lightTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--ant-color-text, #222)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#aaa",
    borderRight: "1px solid rgba(0,0,0,0.06)",
  },
});

function sideExtensions(editable: boolean, dark: boolean) {
  return [
    lineNumbers(),
    markdown(),
    fillTheme,
    dark ? darkTheme : lightTheme,
    EditorView.editable.of(editable),
    ...(editable ? [] : [EditorState.readOnly.of(true)]),
  ];
}

/**
 * 两侧 `.cm-scroller` 的滚动联动：
 *  - `syncRef.current === true`（同步）：哪侧滚就把另一侧镜像到同一 scrollTop/scrollLeft（MergeView 用
 *    spacer 把对齐行放在同一 Y，直接复制即行对齐）。
 *  - `syncRef.current === false`（不同步）：MergeView 内部那套滚动同步关不掉，这里反向抵消 —— 鼠标 hover
 *    哪一栏就让那栏自由滚，把另一栏钉回原位。
 * 用 `suppressUntil` 时间窗忽略"我们自己改 scrollTop 触发的 scroll 事件"，避免来回弹。
 */
function linkScrollers(a: HTMLElement, b: HTMLElement, syncRef: React.MutableRefObject<boolean>) {
  let hovered: HTMLElement | null = null;
  let suppressUntil = 0;
  const savedTop = new Map<HTMLElement, number>([
    [a, a.scrollTop],
    [b, b.scrollTop],
  ]);
  const now = () => performance.now();

  const onEnterA = () => {
    hovered = a;
  };
  const onEnterB = () => {
    hovered = b;
  };
  a.addEventListener("mouseenter", onEnterA);
  b.addEventListener("mouseenter", onEnterB);

  const handle = (self: HTMLElement, other: HTMLElement) => () => {
    if (now() < suppressUntil) return;
    if (syncRef.current) {
      suppressUntil = now() + 50;
      other.scrollTop = self.scrollTop;
      other.scrollLeft = self.scrollLeft;
      savedTop.set(self, self.scrollTop);
      savedTop.set(other, other.scrollTop);
      return;
    }
    if (hovered === self || hovered == null) {
      // 用户在 self 上滚 → 记 self 的新位置，把 other 钉回去（抵消 MergeView 内部同步）
      savedTop.set(self, self.scrollTop);
      suppressUntil = now() + 50;
      other.scrollTop = savedTop.get(other) ?? 0;
    } else {
      // 鼠标不在 self 上却滚了 → 是内部同步的副作用，撤销
      suppressUntil = now() + 50;
      self.scrollTop = savedTop.get(self) ?? 0;
    }
  };

  const onA = handle(a, b);
  const onB = handle(b, a);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });

  return () => {
    a.removeEventListener("mouseenter", onEnterA);
    b.removeEventListener("mouseenter", onEnterB);
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
  };
}

export function DiffMergeModal({ open, onClose, left, right, onSave, saveHint }: Props) {
  const dark = useAppStore((s) => s.themeCategory) === "dark";
  const mvRef = useRef<MergeView | null>(null);
  const unlinkRef = useRef<(() => void) | null>(null);
  // callback ref 的 [] 依赖闭包读不到最新 props，用 ref 兜住
  const latest = useRef({ left, right, dark });
  latest.current = { left, right, dark };
  const [saving, setSaving] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const syncScrollRef = useRef(true);
  syncScrollRef.current = syncScroll;

  const remeasure = () => {
    mvRef.current?.a.requestMeasure();
    mvRef.current?.b.requestMeasure();
  };

  const teardown = () => {
    unlinkRef.current?.();
    unlinkRef.current = null;
    mvRef.current?.destroy();
    mvRef.current = null;
  };

  // div 挂载 → 创建 MergeView + 装滚动联动 + 重新量尺寸；卸载（destroyOnClose）→ 全部销毁
  const setHostEl = useCallback((el: HTMLDivElement | null) => {
    teardown();
    if (!el) return;
    const { left, right, dark } = latest.current;
    const mv = new MergeView({
      a: { doc: normalizeEol(left.value), extensions: sideExtensions(left.editable, dark) },
      b: { doc: normalizeEol(right.value), extensions: sideExtensions(right.editable, dark) },
      parent: el,
      orientation: "a-b",
      revertControls: "a-to-b", // 中缝 ▶：把左(a)的变更块覆盖到右(b)。右侧 = 最终结果。
      highlightChanges: true,
      gutter: true,
    });
    mvRef.current = mv;
    // 双 rAF：等 Modal 布局/动画稳定后，装滚动监听 + 强制 CM 重量尺寸（不然内容显示不全）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (mvRef.current !== mv) return;
        unlinkRef.current = linkScrollers(mv.a.scrollDOM, mv.b.scrollDOM, syncScrollRef);
        remeasure();
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!onSave || !mvRef.current) return;
    const leftDoc = mvRef.current.a.state.doc.toString();
    const rightDoc = mvRef.current.b.state.doc.toString();
    setSaving(true);
    try {
      await onSave({ left: leftDoc, right: rightDoc });
      onClose();
    } catch (e) {
      console.error("[DiffMergeModal] onSave 失败:", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      destroyOnClose
      // Modal 开场 scale 动画结束后再让 CM 重新量一遍尺寸 —— 否则内容渲染区域不对
      afterOpenChange={(o) => {
        if (o) requestAnimationFrame(remeasure);
      }}
      title={`${left.label}  ↔  ${right.label}`}
      width="92vw"
      style={{ top: 16, maxWidth: 1400 }}
      styles={{ body: { paddingTop: 8 } }}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          {onSave && (
            <Button type="primary" loading={saving} onClick={handleSave}>
              保存更改
            </Button>
          )}
        </Space>
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--ant-color-text-secondary, #888)",
          marginBottom: 6,
        }}
      >
        <span>
          左 = {left.label}
          {left.editable ? "" : "（只读）"}，右 = {right.label}
          {right.editable ? "" : "（只读）"}。中缝 ▶ 把左侧变更块覆盖到右侧；两栏均可直接编辑（行不换行，可横向滚）。
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span>同步滚动</span>
          <Switch size="small" checked={syncScroll} onChange={setSyncScroll} />
        </span>
      </div>
      <div
        ref={setHostEl}
        style={{
          height: "64vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--ant-color-border-secondary, #eee)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
      {saveHint && onSave && (
        <Alert type="warning" showIcon banner style={{ marginTop: 8 }} message={saveHint} />
      )}
    </Modal>
  );
}
