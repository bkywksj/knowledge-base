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
  Image as ImageIcon,
  Layers,
  Maximize2,
  Minimize2,
  PenLine,
} from "lucide-react";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import {
  findWikiLinkAtPos,
  type WikiLinkRange,
} from "./WikiLinkDecoration";
import { systemApi, linkApi, imageApi, cardApi } from "@/lib/api";
import { parseKbAsset } from "@/lib/assetUrl";
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
  // pos：右键落点对应的文档位置。「修改链接」要靠它反查整段 `[[...]]` 的范围再替换；
  // posAtCoords 偶尔解析不出位置（点在边缘），此时为 null，菜单里就不显示该项。
  | { kind: "wiki"; title: string; el: HTMLElement; pos: number | null }
  | { kind: "image"; src: string; el: HTMLElement }
  | { kind: "video"; src: string; el: HTMLElement }
  | { kind: "file"; href: string; el: HTMLElement }
  | { kind: "annotation"; comment: string; el: HTMLElement }
  | { kind: "toggle"; el: HTMLElement };

/**
 * Tiptap MutationObserver 渲染期会把 `kb-asset://` 替换成 Tauri 的 asset 协议 URL，
 * 形如 `http://asset.localhost/<encoded-abs>` (Windows) 或 `asset://localhost/<encoded-abs>` (macOS/Linux)。
 * 路径部分是 `convertFileSrc(abs)` 编码出来的，decodeURIComponent 即得绝对路径。
 */
const ASSET_HOST_PREFIXES = [
  "http://asset.localhost/",
  "https://asset.localhost/",
  "asset://localhost/",
];

function decodeAssetLocalhost(url: string): string | null {
  for (const prefix of ASSET_HOST_PREFIXES) {
    if (url.startsWith(prefix)) {
      try {
        return decodeURIComponent(url.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 把 kb-asset:// / file:// / asset.localhost / 相对路径解析成系统绝对路径 */
async function resolveAbsolute(urlOrSrc: string): Promise<string | null> {
  if (!urlOrSrc) return null;
  // Tauri asset 协议（Tiptap 渲染期注入到 DOM 的 src）→ 反解出原绝对路径
  const fromAssetHost = decodeAssetLocalhost(urlOrSrc);
  if (fromAssetHost) return fromAssetHost;
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
  // 用 parseKbAsset 而不是手动 slice：前者会 decodeURIComponent，
  // 处理 markdown 序列化往返后 attrs.src 变成 `kb-asset://%E4%B8%AD%E6%96%87.png` 的情况。
  {
    const rel = parseKbAsset(urlOrSrc);
    if (rel !== null) {
      try {
        return await systemApi.resolveAssetAbsolute(rel);
      } catch {
        return null;
      }
    }
  }
  // blob: → 加密素材运行期生成的 Blob URL，无从反解到磁盘路径
  if (urlOrSrc.startsWith("blob:")) return null;
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

export function useEditorContextMenu(
  editor: Editor | null,
  noteId?: number | null,
  /** 右键双链 →「修改链接」：把待改双链的范围交给调用方弹选择器 */
  onEditWikiLink?: (range: WikiLinkRange) => void,
) {
  const ctx = useContextMenu<EditorMenuPayload>();
  const navigate = useNavigate();
  // 设置里关闭"卡片复习"模块时，annotation 右键的"转为闪卡"项整条隐藏
  const cardsEnabled = useFeatureEnabled("cards");

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

  /** 改图片节点属性（1:1 / 适应页宽）：定位 DOM → 选中节点 → updateAttributes */
  const updateImageAtElement = useCallback(
    (el: HTMLElement, attrs: Record<string, unknown>) => {
      if (!editor) return;
      try {
        const pos = editor.view.posAtDOM(el, 0);
        if (pos < 0) {
          message.error("无法定位图片");
          return;
        }
        editor
          .chain()
          .focus()
          .setNodeSelection(pos)
          .updateAttributes("imageResize", attrs)
          .run();
      } catch (e) {
        message.error(`操作失败：${e}`);
      }
    },
    [editor],
  );

  /**
   * 取节点的原始 src：MutationObserver 会把 `<img src="kb-asset://...">` 重写成
   * `http://asset.localhost/<encoded>` 用于渲染，但 ProseMirror state 里的 attrs.src
   * 始终是原始的 `kb-asset://...`。"在文件管理器中显示" / "用默认应用打开" 必须拿原始值
   * 走后端解析，否则会把 asset 协议 URL 当成路径喂给系统 API → OS error 123。
   */
  const getOriginalSrc = useCallback(
    (el: HTMLElement, fallback: string): string => {
      if (!editor) return fallback;
      try {
        const pos = editor.view.posAtDOM(el, 0);
        if (pos < 0) return fallback;
        const node = editor.state.doc.nodeAt(pos);
        const src = node?.attrs?.src;
        if (typeof src === "string" && src.length > 0) return src;
      } catch {
        // posAtDOM 偶尔会抛（比如节点已被卸载）—— 退回 DOM src
      }
      return fallback;
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
          const at = editor.view.posAtCoords({
            left: e.clientX,
            top: e.clientY,
          });
          ctx.open(
            { clientX: e.clientX, clientY: e.clientY },
            { kind: "wiki", title, el: wikiEl, pos: at?.pos ?? null },
          );
          return;
        }
      }

      // 2. 视频块
      const videoEl = target.closest<HTMLElement>(".tiptap-video-block");
      if (videoEl) {
        const inner = videoEl.querySelector("video");
        const domSrc = inner?.getAttribute("src") ?? "";
        const src = getOriginalSrc(videoEl, domSrc);
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
        const domSrc = imgEl.getAttribute("src") ?? "";
        const src = getOriginalSrc(imgEl, domSrc);
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

      // 5. 折叠块：放在最后让块内的图片/视频/链接/批注先匹配各自的菜单，
      // 落到 summary 文本 / content 空白 / 三角图标 时才弹折叠块菜单
      const toggleEl = target.closest<HTMLElement>(".tiptap-toggle");
      if (toggleEl) {
        e.preventDefault();
        ctx.open(
          { clientX: e.clientX, clientY: e.clientY },
          { kind: "toggle", el: toggleEl },
        );
        return;
      }

      // 其他位置（普通文本 / 列表 / 表格等）→ 不拦，走浏览器原生菜单
    },
    [editor, ctx, getOriginalSrc],
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
    /**
     * 复制可在系统资源管理器 / 终端使用的绝对路径。
     * 笔记 content 里 src 是 `kb-asset://...` 内部 URL，对用户没意义；
     * 这里走 resolveAbsolute 转成 OS 原生绝对路径再写剪贴板。
     * 远程 http(s) URL 原样复制（resolveAbsolute 对其透传）。
     */
    const copyAbsolutePath = async (urlOrSrc: string) => {
      const abs = await resolveAbsolute(urlOrSrc);
      if (!abs) {
        message.warning("无法解析路径");
        return;
      }
      copyText(abs, "已复制路径");
    };
    /**
     * 取图片原始字节。
     * - `kb-asset://<rel>` → 走后端 IPC（加密图也能拿到明文 bytes）
     * - 其它（http 外链 / blob: / data:）→ fetch DOM 上的渲染 URL 兜底
     *
     * 不能直接 `canvas.drawImage(imgEl)` 再 toBlob：`<img>` 加载自 `http://asset.localhost`，
     * 与主窗 origin 不同源，canvas 会被污染（tainted）→ toBlob 抛 SecurityError。
     */
    const fetchImageBytes = async (
      src: string,
      el: HTMLElement,
    ): Promise<Uint8Array | null> => {
      const kbRel = parseKbAsset(src);
      if (kbRel !== null) {
        try {
          return await imageApi.getBlob(kbRel);
        } catch {
          // IPC 失败（vault 锁定 / 文件丢失等）→ fall through 到 fetch
        }
      }
      const imgEl = (
        el.tagName === "IMG" ? el : el.querySelector("img")
      ) as HTMLImageElement | null;
      const url = imgEl?.currentSrc || imgEl?.src || src;
      if (!url) return null;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    };

    /**
     * 把图片字节转成 PNG Blob。
     *
     * `createImageBitmap` 的 source 是 Blob（同源数据），canvas 不会被污染，
     * 所以 toBlob 不会抛 SecurityError。ClipboardItem 在 Chromium 上只稳定支持
     * image/png，统一转 PNG 最保险。
     */
    const toPngBlob = async (bytes: Uint8Array): Promise<Blob> => {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D 上下文不可用");
        ctx.drawImage(bitmap, 0, 0);
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 返回 null"))),
            "image/png",
          );
        });
      } finally {
        bitmap.close();
      }
    };

    /**
     * 把图片复制到系统剪贴板，三级降级。
     *
     * 之所以不直接用 `navigator.clipboard.write()`：WebView 的 Async Clipboard API 要求
     * 调用时**用户手势仍未过期**（Chromium 约 5 秒）。而这里必须先取字节、解码、再编 PNG，
     * 大图走完这套手势早没了 → 权限检查退回 permission 询问，WebView2 里无人应答 →
     * `NotAllowedError: The request is not allowed by the user agent...`。
     * 用户看到的是"没权限"，但跟 Tauri Capabilities 毫无关系，配权限也修不好。
     *
     * 1. 笔记内素材（kb-asset://）→ Rust 侧直接读盘 + 写系统剪贴板，零字节过 IPC，最快也最稳
     * 2. 外链图 / 第 1 步失败 → 取字节转 PNG 后交给 clipboard-manager 插件（仍走 Rust，不吃手势）
     * 3. 插件也不行（移动端 write_image 返回 Unsupported）→ 回退 Web Clipboard API
     */
    const copyImageBlob = async (rawSrc: string, el: HTMLElement) => {
      const kbRel = parseKbAsset(rawSrc);
      if (kbRel !== null) {
        try {
          await imageApi.copyToClipboard(kbRel);
          message.success("已复制图片");
          return;
        } catch {
          // vault 锁定 / 文件丢失 / 移动端不支持 → 继续走下面的通用路径
        }
      }

      try {
        const bytes = await fetchImageBytes(rawSrc, el);
        if (!bytes || bytes.length === 0) {
          message.error("无法获取图片数据");
          return;
        }
        const pngBlob = await toPngBlob(bytes);
        try {
          await writeImage(new Uint8Array(await pngBlob.arrayBuffer()));
        } catch {
          // 插件不可用（移动端）→ 最后回退 Web Clipboard；此路径受手势限制，可能仍失败
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": pngBlob }),
          ]);
        }
        message.success("已复制图片");
      } catch (err) {
        message.error(`复制图片失败：${err}`);
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
          // 想把这条双链改指到别的笔记时，不用手工逐字改 `[[旧标题]]`
          key: "edit-link",
          label: "修改链接",
          icon: <PenLine size={13} />,
          // posAtCoords 没解析出位置就没法定位要替换的范围，此时隐藏该项
          disabled: p.pos == null || !editor || !onEditWikiLink,
          onClick: () => {
            ctx.close();
            if (p.pos == null || !editor || !onEditWikiLink) return;
            const range = findWikiLinkAtPos(editor.state.doc, p.pos);
            if (!range) {
              message.warning("没能定位到这条双链，请重试");
              return;
            }
            onEditWikiLink(range);
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
          key: "actual-size",
          label: "原始比例 (1:1)",
          icon: <Maximize2 size={13} />,
          onClick: () => {
            ctx.close();
            const img = (
              p.el.tagName === "IMG" ? p.el : p.el.querySelector("img")
            ) as HTMLImageElement | null;
            const nat = img?.naturalWidth ?? 0;
            if (nat > 0) {
              // 受 1200 上限钳制（与 FigureImage.configure 的 maxWidth 一致）
              updateImageAtElement(p.el, {
                width: String(Math.min(nat, 1200)),
                height: null,
              });
            } else {
              message.warning("图片尚未加载完成，请稍后再试");
            }
          },
        },
        {
          key: "fit-width",
          label: "适应页宽",
          icon: <Minimize2 size={13} />,
          onClick: () => {
            ctx.close();
            updateImageAtElement(p.el, { width: null, height: null });
          },
        },
        { type: "divider" },
        {
          key: "copy-image",
          label: "复制图片",
          icon: <ImageIcon size={13} />,
          onClick: () => {
            ctx.close();
            void copyImageBlob(p.src, p.el);
          },
        },
        {
          key: "copy-path",
          label: "复制路径",
          icon: <Copy size={13} />,
          onClick: () => {
            ctx.close();
            void copyAbsolutePath(p.src);
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
            void copyAbsolutePath(p.src);
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
        // 仅在"卡片复习"模块启用时展示"转为闪卡"
        ...(cardsEnabled
          ? [
              {
                key: "to-card",
                label: "转为闪卡",
                icon: <Layers size={13} />,
                onClick: async () => {
                  ctx.close();
                  // 正面 = 原文（被批注的文字），反面 = 批注内容
                  const front = (p.el.textContent ?? "").trim();
                  const back = p.comment.trim();
                  if (!front || !back) {
                    message.warning("原文或批注为空，无法生成闪卡");
                    return;
                  }
                  try {
                    await cardApi.create({
                      front,
                      back,
                      noteId: noteId ?? null,
                    });
                    message.success("已生成闪卡，前往「卡片复习」查看");
                  } catch (err) {
                    message.error(`生成失败：${err}`);
                  }
                },
              } as ContextMenuEntry,
            ]
          : []),
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

    if (p.kind === "toggle") {
      return [
        {
          key: "delete",
          label: "删除折叠块",
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => {
            ctx.close();
            deleteNodeAtElement(p.el);
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
  }, [
    ctx,
    navigate,
    deleteNodeAtElement,
    updateImageAtElement,
    editor,
    noteId,
    cardsEnabled,
  ]);

  return { ctx, menuItems };
}
