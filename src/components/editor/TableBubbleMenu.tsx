import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { CellSelection } from "@tiptap/pm/tables";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Button, Tooltip, message, theme as antdTheme } from "antd";
import { toPng } from "html-to-image";
import {
  BoxSelect,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Columns3,
  Copy,
  ImageDown,
  PanelLeft,
  PanelTop,
  RectangleHorizontal,
  RectangleVertical,
  Rows3,
  Combine,
  Split,
  Trash2,
} from "lucide-react";

interface Props {
  editor: Editor | null;
}

/**
 * 表格浮动菜单：光标进入 table 单元格时，在表格上方弹出一条按钮。
 * 解决"工具栏 → 表格下拉 → 删除当前列"路径过深的入口可见性问题。
 *
 * 实现要点：
 * - 监听 editor 的 selectionUpdate / transaction，动态计算位置
 * - mousedown preventDefault 防止点击按钮丢失编辑器选区
 * - createPortal 到 body，避开父级 overflow:hidden / transform 截断
 * - 滚动 / resize 时重算位置（监听 capture 阶段抓所有滚动容器）
 */
export function TableBubbleMenu({ editor }: Props) {
  const { token } = antdTheme.useToken();
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const update = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setVisible(false);
      return;
    }
    if (!editor.isActive("table")) {
      setVisible(false);
      return;
    }
    // 从选区起点 DOM 向上找最近的 table 元素
    const { from } = editor.state.selection;
    let node: Node | null = editor.view.domAtPos(from).node;
    let tableEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.tagName === "TABLE") {
        tableEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!tableEl) {
      setVisible(false);
      return;
    }
    const rect = tableEl.getBoundingClientRect();
    setPos({
      top: window.scrollY + rect.top - 38,
      left: window.scrollX + rect.left,
    });
    setVisible(true);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor, update]);

  useEffect(() => {
    if (!visible) return;
    const handler = () => update();
    // capture 阶段抓内层滚动容器（笔记内容区往往有自己的 overflow:auto）
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [visible, update]);

  if (!visible || !editor) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    // 防止点击按钮时 ProseMirror 失焦丢选区
    e.preventDefault();
  };

  // 从当前选区向上找到所在 <table> DOM 元素
  const findTableEl = (): HTMLElement | null => {
    const { from } = editor.state.selection;
    let node: Node | null = editor.view.domAtPos(from).node;
    while (node) {
      if (node instanceof HTMLElement && node.tagName === "TABLE") return node;
      node = node.parentNode;
    }
    return null;
  };

  const selectWholeTable = () => {
    const $from = editor.state.selection.$from;
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === "table") {
        const pos = $from.before(d);
        editor.chain().focus().setNodeSelection(pos).run();
        return;
      }
    }
  };

  // 选中当前光标所在的整行 / 整列。
  // TipTap 没有内置 selectRow/selectColumn 命令，直接用 ProseMirror tables 的
  // CellSelection.rowSelection / colSelection：传入当前单元格的解析位置即可，
  // 第二个 headCell 省略时默认等于 anchorCell，会自动扩展成整行/整列。
  const selectRowOrColumn = (kind: "row" | "column") => {
    editor.commands.command(({ state, dispatch, tr }) => {
      const $from = state.selection.$from;
      // 向上找到最近的单元格层级（tableRole 为 cell / header_cell）
      let cellDepth = -1;
      for (let d = $from.depth; d > 0; d--) {
        const role = $from.node(d).type.spec.tableRole;
        if (role === "cell" || role === "header_cell") {
          cellDepth = d;
          break;
        }
      }
      if (cellDepth === -1) return false;
      const $cell = state.doc.resolve($from.before(cellDepth));
      const sel =
        kind === "row"
          ? CellSelection.rowSelection($cell)
          : CellSelection.colSelection($cell);
      if (dispatch) dispatch(tr.setSelection(sel));
      return true;
    });
    editor.view.focus();
  };

  const exportTableAsImage = async () => {
    const tableEl = findTableEl();
    if (!tableEl) {
      message.error("未找到表格");
      return;
    }

    // 先弹"另存为"对话框，用户取消就直接退出
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const targetPath = await save({
      defaultPath: `table-${ts}.png`,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (!targetPath) return;

    try {
      // 截原始表格 DOM（保留 ProseMirror 作用域内的 CSS）
      const rawUrl = await toPng(tableEl, {
        pixelRatio: 2,
        backgroundColor: token.colorBgContainer,
        cacheBust: true,
      });

      // 加一圈 padding，避免边框紧贴图片边
      const img = new Image();
      img.src = rawUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("图片加载失败"));
      });
      const PAD = 32;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth + PAD * 2;
      canvas.height = img.naturalHeight + PAD * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 上下文创建失败");
      ctx.fillStyle = token.colorBgContainer;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, PAD, PAD);
      const finalUrl = canvas.toDataURL("image/png");

      await invoke("export_png_to_file", {
        targetPath,
        base64Data: finalUrl,
      });
      message.success(`已保存：${targetPath}`);
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  };

  const copyWholeTable = async () => {
    const tableEl = findTableEl();
    if (!tableEl) {
      message.error("未找到表格");
      return;
    }
    const html = tableEl.outerHTML;

    // 为不支持 HTML 粘贴的目标（终端 / 纯文本编辑器）构造 Markdown 兜底
    const rows = Array.from(tableEl.querySelectorAll("tr"));
    const mdLines: string[] = [];
    rows.forEach((row, ri) => {
      const cells = Array.from(row.querySelectorAll("th,td"));
      const cellTexts = cells.map((c) =>
        (c.textContent ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim(),
      );
      mdLines.push("| " + cellTexts.join(" | ") + " |");
      if (ri === 0) {
        mdLines.push("| " + cells.map(() => "---").join(" | ") + " |");
      }
    });
    const md = mdLines.join("\n");

    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([md], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(md);
      }
      message.success("表格已复制");
    } catch {
      try {
        await navigator.clipboard.writeText(md);
        message.success("表格已复制（纯文本）");
      } catch (e2) {
        message.error(`复制失败: ${e2}`);
      }
    }
  };

  const Btn = ({
    icon,
    title,
    onClick,
    danger,
    disabled,
  }: {
    icon: React.ReactNode;
    title: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }) => (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <Button
        type="text"
        size="small"
        icon={icon}
        danger={danger}
        disabled={disabled}
        onClick={onClick}
        style={{ minWidth: 28, height: 28, padding: 0 }}
      />
    </Tooltip>
  );

  const VDivider = () => (
    <div
      style={{
        width: 1,
        background: token.colorBorderSecondary,
        margin: "4px 2px",
      }}
    />
  );

  const can = editor.can();

  return createPortal(
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        zIndex: 100,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        boxShadow: token.boxShadowSecondary,
        padding: "2px 4px",
        display: "flex",
        alignItems: "center",
        gap: 0,
      }}
    >
      <Btn
        icon={<BoxSelect size={14} />}
        title="选中整张表格"
        onClick={selectWholeTable}
      />
      <Btn
        icon={<RectangleHorizontal size={14} />}
        title="选中整行"
        onClick={() => selectRowOrColumn("row")}
      />
      <Btn
        icon={<RectangleVertical size={14} />}
        title="选中整列"
        onClick={() => selectRowOrColumn("column")}
      />
      <VDivider />
      <Btn
        icon={<Copy size={14} />}
        title="复制整张表格（HTML + Markdown）"
        onClick={() => {
          void copyWholeTable();
        }}
      />
      <Btn
        icon={<ImageDown size={14} />}
        title="导出表格为 PNG 图片"
        onClick={() => {
          void exportTableAsImage();
        }}
      />
      <VDivider />
      <Btn
        icon={<ChevronLeft size={14} />}
        title="在左侧加列"
        disabled={!can.addColumnBefore()}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      />
      <Btn
        icon={<ChevronRight size={14} />}
        title="在右侧加列"
        disabled={!can.addColumnAfter()}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      />
      <Btn
        icon={<Columns3 size={14} />}
        title="删除当前列"
        danger
        disabled={!can.deleteColumn()}
        onClick={() => editor.chain().focus().deleteColumn().run()}
      />
      <VDivider />
      <Btn
        icon={<ChevronUp size={14} />}
        title="在上方加行"
        disabled={!can.addRowBefore()}
        onClick={() => editor.chain().focus().addRowBefore().run()}
      />
      <Btn
        icon={<ChevronDown size={14} />}
        title="在下方加行"
        disabled={!can.addRowAfter()}
        onClick={() => editor.chain().focus().addRowAfter().run()}
      />
      <Btn
        icon={<Rows3 size={14} />}
        title="删除当前行"
        danger
        disabled={!can.deleteRow()}
        onClick={() => editor.chain().focus().deleteRow().run()}
      />
      <VDivider />
      <Btn
        icon={<PanelTop size={14} />}
        title="设置/取消标题行"
        disabled={!can.toggleHeaderRow()}
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
      />
      <Btn
        icon={<PanelLeft size={14} />}
        title="设置/取消标题列"
        disabled={!can.toggleHeaderColumn()}
        onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
      />
      <VDivider />
      <Btn
        icon={<Combine size={14} />}
        title="合并单元格"
        disabled={!can.mergeCells()}
        onClick={() => editor.chain().focus().mergeCells().run()}
      />
      <Btn
        icon={<Split size={14} />}
        title="拆分单元格"
        disabled={!can.splitCell()}
        onClick={() => editor.chain().focus().splitCell().run()}
      />
      <VDivider />
      <Btn
        icon={<Trash2 size={14} />}
        title="删除整张表"
        danger
        disabled={!can.deleteTable()}
        onClick={() => editor.chain().focus().deleteTable().run()}
      />
    </div>,
    document.body,
  );
}
