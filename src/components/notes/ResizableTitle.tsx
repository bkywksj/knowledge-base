import type { ThHTMLAttributes } from "react";

import { clampColumnWidth } from "@/lib/notesListColumns";

interface Props extends ThHTMLAttributes<HTMLTableCellElement> {
  /** 该列当前宽度；不传 = 这一列不可拖，退化成普通表头 */
  width?: number;
  /** 拖动过程中实时回调（用于让表格跟手） */
  onResize?: (width: number) => void;
  /** 松手时回调一次（用于持久化，避免拖动过程中每个像素都写盘） */
  onResizeEnd?: (width: number) => void;
}

/**
 * 可拖动调宽的表头单元格，通过 antd Table 的 `components.header.cell` 接入。
 *
 * antd 没有原生的列宽拖动。这里在表头右缘放一个 7px 的把手，按下后监听 window 的
 * mousemove / mouseup —— 挂在 window 而不是把手上，鼠标拖出表头也不会丢。
 */
export function ResizableTitle({
  width,
  onResize,
  onResizeEnd,
  children,
  style,
  ...rest
}: Props) {
  if (!width || !onResize) {
    return (
      <th {...rest} style={style}>
        {children}
      </th>
    );
  }

  function handleMouseDown(e: React.MouseEvent) {
    // 不能冒泡：表头自己可能挂着排序 / 点击行为
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width as number;
    let latest = startWidth;

    function onMove(ev: MouseEvent) {
      latest = clampColumnWidth(startWidth + ev.clientX - startX);
      onResize?.(latest);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.(latest);
    }

    // 拖动期间全局固定光标并禁选文字，否则划过表格内容会选中一大片
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <th
      {...rest}
      className={[rest.className, "kb-resizable-th"].filter(Boolean).join(" ")}
      style={{ ...style, position: "relative" }}
    >
      {children}
      <span
        className="kb-col-resize-handle"
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </th>
  );
}
