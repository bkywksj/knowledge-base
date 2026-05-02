import { useCallback, useEffect, useMemo } from "react";
import { type Editor } from "@tiptap/react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import {
  Copy,
  Trash2,
  ExternalLink,
  FolderOpen,
  Hash,
  MessageSquare,
} from "lucide-react";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { useContextMenu } from "@/hooks/useContextMenu";
import { systemApi, linkApi } from "@/lib/api";
import {
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/**
 * Tiptap 编辑器节点右键菜单 hook。
 *
 * 设计：
 * - 只接入 wiki 链接 / 图片 / 视频 / 附件链接 这 4 类**浏览器原生菜单做不到**的节点
 * - 普通文本 / 列表 / 表格右键继续走浏览器原生剪切/复制/粘贴菜单（不 preventDefault）
 * - DOM 检测分发：通过 e.target.closest 识别节点类型，比 ProseMirror posAtCoords
 *   更稳定，不依赖内部 API
 *
 * 使用：
 * ```tsx
 * const { ctx, menuItems } = useEditorContextMenu(editor);
 * // ...
 * <ContextMenuOverlay open={!!ctx.state.payload} ... items={menuItems} ... />
 * ```
 */

type EditorMenuPayload =
  | { kind: "wiki"; title: string; el: HTMLElement }
  | { kind: "image"; src: string; el: HTMLElement }
  | { kind: "video"; src: string; el: HTMLElement }
  | { kind: "file"; href: string; el: HTMLElement }
  | { kind: "annotation"; comment: string; el: HTMLElement };

/** 把 kb-asset:// / file:// / 相对路径解析成系统绝对路径 */
async function resolveAbsolute(urlOrSrc: string): Promise<string | null> {
  if (!urlOrSrc) return null;
  // file:// → 转文件系统路径
  if (urlOrSrc.startsWith("file://")) {
    try {
      const u = new URL(urlOrSrc);
      // Windows 上 url.pathname 形如 "/C:/foo"，去掉前导 "/"
      return decodeURIComponent(u.pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    } catch {
      return null;
    }
  }
  // kb-asset://<rel> → 后端 resolveAssetAbsolute
  if (urlOrSrc.startsWith("kb-asset://")) {
    const rel = urlOrSrc.slice("kb-asset://".length);
    try {
      return await systemApi.resolveAssetAbsolute(rel);
    } catch {
      return null;
    }
  }
  // 相对路径 → 也走 resolveAssetAbsolute 兜底
  if (!urlOrSrc.startsWith("http") && !urlOrSrc.startsWith("/")) {
    try {
      return await systemApi.resolveAssetAbsolute(urlOrSrc);
    } catch {
      return null;
    }
  }
  // 远程 URL（http/https）保留原样
  return urlOrSrc;
}

export function useEditorContextMenu(editor: Editor | null) {
  const ctx = useContextMenu<EditorMenuPayload>();
  const navigate = useNavigate();

  /** 删除指定 DOM 对应的节点（用于图片 / 视频右键的"删除"项） */
  const deleteNodeAtElement = useCallback(
    (el: HTMLElement) => {
      if (!editor) return;
      try {
        const pos = editor.view.posAtDOM(el, 0);
        if (pos < 0) {
          message.error("无法定位节点");
          return;
        }
        editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
      } catch (e) {
        message.error(`删除失败：${e}`);
      }
    },
    [editor],
  );

  /** 监听编辑器 DOM 上的 contextmenu，按节点类型分发自定义菜单 */
  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      if (!editor) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 检测顺序：先具体后通用 —— wiki 装饰嵌在普通文本里，必须先查它
      // 0. 批注 mark：点中已批注文字时弹"编辑/删除/复制批注"菜单
      const annotEl = target.closest<HTMLElement>("span[data-comment]");
      if (annotEl) {
        const comment = annotEl.getAttribute("data-comment") ?? "";
        e.preventDefault();
        ctx.open(
          { clientX: e.clientX, clientY: e.clientY },
          { kind: "annotation", comment, el: annotEl },
        );
        return;
      }

      // 1. wiki 链接装饰
      const wikiEl = target.closest<HTMLElement>("[data-wiki-link]");
      if (wikiEl) {
        const title = wikiEl.getAttribute("data-wiki-link") ?? "";
        if (title) {
          e.preventDefault();
          ctx.open(
            { clientX: e.clientX, clientY: e.clientY },
            { kind: "wiki", title, el: wikiEl },
          );
          return;
        }
      }

      // 2. 视频块
      const videoEl = target.closest<HTMLElement>(".tiptap-video-block");
      if (videoEl) {
        const inner = videoEl.querySelector("video");
        const src = inner?.getAttribute("src") ?? "";
        e.preventDefault();
        ctx.open(
          { clientX: e.clientX, clientY: e.clientY },
          { kind: "video", src, el: videoEl },
        );
        return;
      }

      // 3. 图片（含 figure 内的 img）
      const imgEl = target.closest<HTMLElement>("img");
      if (imgEl) {
        const src = imgEl.getAttribute("src") ?? "";
        e.preventDefault();
        ctx.open(
          { clientX: e.clientX, clientY: e.clientY },
          { kind: "image", src, el: imgEl },
        );
        return;
      }

      // 4. 附件链接（kb-asset:// / file:// 协议；http 网页链接走默认菜单）
      const linkEl = target.closest<HTMLElement>("a[href]");
      if (linkEl) {
        const href = linkEl.getAttribute("href") ?? "";
        if (href.startsWith("kb-asset://") || href.startsWith("file://")) {
          e.preventDefault();
          ctx.open(
            { clientX: e.clientX, clientY: e.clientY },
            { kind: "file", href, el: linkEl },
          );
          return;
        }
      }

      // 其他位置（普通文本 / 列表 / 表格等）→ 不拦，走浏览器原生菜单
    },
    [editor, ctx],
  );

  // 用 capture-phase 原生 listener，比 React 合成事件先触发
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      dom.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, [editor, handleContextMenu]);

  // ─── 菜单项构造（按节点类型派发） ───────────────
  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    const p = ctx.state.payload;
    if (!p) return [];

    // 通用工具
    const copyText = (text: string, label = "已复制") => {
      navigator.clipboard
        .writeText(text)
        .then(() => message.success(label))
        .catch((err) => message.error(`复制失败：${err}`));
    };
    const revealAt = async (urlOrSrc: string) => {
      const abs = await resolveAbsolute(urlOrSrc);
      if (!abs) {
        message.warning("无法解析路径");
        return;
      }
      try {
        await revealItemInDir(abs);
      } catch (err) {
        message.error(`打开文件管理器失败：${err}`);
      }
    };
    const openByDefaultApp = async (urlOrSrc: string) => {
      const abs = await resolveAbsolute(urlOrSrc);
      if (!abs) {
        message.warning("无法解析路径");
        return;
      }
      try {
        await openPath(abs);
      } catch (err) {
        message.error(`打开失败：${err}`);
      }
    };

    if (p.kind === "wiki") {
      return [
        {
          key: "open",
          label: "打开笔记",
          icon: <ExternalLink size={13} />,
          onClick: async () => {
            ctx.close();
            try {
              const id = await linkApi.findIdByTitle(p.title);
              if (id) navigate(`/notes/${id}`);
              else message.warning(`找不到笔记「${p.title}」`);
            } catch (err) {
              message.error(`跳转失败：${err}`);
            }
          },
        },
        {
          key: "copy-link",
          label: "复制 wiki 链接",
          icon: <Copy size={13} />,
          onClick: () => {
            ctx.close();
            copyText(`[[${p.title}]]`);
          },
        },
        {
          key: "copy-title",
          label: "复制标题",
          icon: <Hash size={13} />,
          onClick: () => {
            ctx.close();
            copyText(p.title);
          },
        },
      ];
    }

    if (p.kind === "image") {
      return [
        {
          key: "copy-path",
          label: "复制路径",
          icon: <Copy size={13} />,
          onClick: () => {
            ctx.close();
            copyText(p.src);
          },
        },
        {
          key: "reveal",
          label: "在文件管理器中显示",
          icon: <FolderOpen size={13} />,
          onClick: () => {
            ctx.close();
            void revealAt(p.src);
          },
        },
        { type: "divider" },
        {
          key: "delete",
          label: "删除图片",
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => {
            ctx.close();
            deleteNodeAtElement(p.el);
          },
        },
      ];
    }

    if (p.kind === "video") {
      return [
        {
          key: "copy-path",
          label: "复制路径",
          icon: <Copy size={13} />,
          onClick: () => {
            ctx.close();
            copyText(p.src);
          },
        },
        {
          key: "reveal",
          label: "在文件管理器中显示",
          icon: <FolderOpen size={13} />,
          onClick: () => {
            ctx.close();
            void revealAt(p.src);
          },
        },
        { type: "divider" },
        {
          key: "delete",
          label: "删除视频",
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => {
            ctx.close();
            deleteNodeAtElement(p.el);
          },
        },
      ];
    }

    if (p.kind === "annotation") {
      return [
        {
          key: "edit",
          label: "编辑批注",
          icon: <MessageSquare size={13} />,
          onClick: () => {
            ctx.close();
            if (!editor) return;
            // 把光标定位进 mark span，再广播 → AnnotationButton 监听到后弹 Modal
            try {
              const pos = editor.view.posAtDOM(p.el, 0);
              if (pos < 0) return;
              editor.chain().focus().setTextSelection(pos).run();
            } catch {
              /* 定位失败也无碍：Modal 自己取 isActive，会显示"添加" */
            }
            document.dispatchEvent(new CustomEvent("kb-annotation-shortcut"));
          },
        },
        {
          key: "copy",
          label: "复制批注内容",
          icon: <Copy size={13} />,
          onClick: () => {
            ctx.close();
            copyText(p.comment, "已复制批注内容");
          },
        },
        { type: "divider" },
        {
          key: "delete",
          label: "删除批注",
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => {
            ctx.close();
            if (!editor) return;
            try {
              const pos = editor.view.posAtDOM(p.el, 0);
              if (pos < 0) return;
              // 先把光标放进 mark，再 extendMarkRange 扩到 mark 全范围，最后 unset
              editor
                .chain()
                .focus()
                .setTextSelection(pos)
                .extendMarkRange("annotation")
                .unsetMark("annotation")
                .run();
            } catch (err) {
              message.error(`删除失败：${err}`);
            }
          },
        },
      ];
    }

    // kind === "file"
    return [
      {
        key: "open",
        label: "用默认应用打开",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          void openByDefaultApp(p.href);
        },
      },
      {
        key: "reveal",
        label: "在文件管理器中显示",
        icon: <FolderOpen size={13} />,
        onClick: () => {
          ctx.close();
          void revealAt(p.href);
        },
      },
      {
        key: "copy-link",
        label: "复制链接",
        icon: <Copy size={13} />,
        onClick: () => {
          ctx.close();
          copyText(p.href);
        },
      },
    ];
  }, [ctx, navigate, deleteNodeAtElement, editor]);

  return { ctx, menuItems };
}
