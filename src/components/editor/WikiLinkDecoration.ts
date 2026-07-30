import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { findWikiLinks, wikiLinkAtOffset } from "@/lib/wikiLinkMatch";

export interface WikiLinkOptions {
  /**
   * 点击 wiki 链接时触发。
   * 优先用 `id`（候选下拉选中的稳定锚点，永不失效）；
   * 没有 `id` 时（用户手敲的 `[[标题]]`）回退按 title 查。
   */
  onClick: (title: string, id?: number) => void;
  /**
   * 是否处于阅读模式（不可编辑）。函数式取值，保证编辑器实例只创建一次时仍能拿到实时态。
   * 注：双链点击已统一为「普通单击即跳转」（编辑态/阅读态一致），此项当前不再用于点击门槛，
   * 保留以兼容调用方与未来按模式差异化的需求。
   */
  isReadingMode?: () => boolean;
}

/** 双链在文档里的位置与内容（`from`/`to` 覆盖整段 `[[标题|123]]`，含首尾方括号） */
export interface WikiLinkRange {
  from: number;
  to: number;
  title: string;
  id?: number;
}

/**
 * 从文档位置反查该处是否落在某条双链上，并给出它的完整范围。
 *
 * 只依赖文档内容，不看 DOM —— 这正是它存在的意义：表格 / 分栏 / Callout 这类带 NodeView
 * 的容器会替换点击事件的 target，DOM 反查会失效，而 pos 始终准确。
 *
 * 导出的原因：右键菜单的「修改链接」要拿 `from`/`to` 去替换整段双链文本，
 * 与点击跳转共用同一套定位口径，避免两处各写一份把边界算歪。
 */
export function findWikiLinkAtPos(
  doc: PMNode,
  pos: number,
): WikiLinkRange | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  // 与 buildDecorations 用同一套取文本方式，保证偏移口径一致
  const text = parent.textBetween(0, parent.content.size, undefined, "\ufffc");
  const blockStart = $pos.start();
  const hit = wikiLinkAtOffset(text, pos - blockStart);
  if (!hit) return null;
  const id = hit.id ? Number(hit.id) : undefined;
  return {
    from: blockStart + hit.start,
    to: blockStart + hit.end,
    title: hit.title,
    id: Number.isFinite(id) ? id : undefined,
  };
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    // 按**块级节点**（段落 / 标题 / 表格单元格内的段落…）整块取文本再匹配。
    //
    // 🔴 不能按 text node 匹配：ProseMirror 在 mark 边界切分 text node，`[[标题]]` 里
    // 只要夹了一处格式差异（局部加粗 / 颜色 / 高亮，或粘贴表格、Word 时带进来的
    // textStyle），这串字符就会落进两个以上 node，逐 node 的正则永远匹配不到 —— 双链
    // 不变蓝、点击也无反应。详见 lib/wikiLinkMatch 的说明。
    if (!node.isTextblock) return true; // 非文本块（table / blockquote / list…）继续下钻

    // leafText 传 U+FFFC（对象替换符）占位：图片 / 公式等 atom 节点在文档里各占 1 个
    // 位置，不补占位符会让其后所有偏移前移，decoration 落错位置。
    const text = node.textBetween(0, node.content.size, undefined, "\ufffc");

    for (const hit of findWikiLinks(text)) {
      // +1 跳过块级节点自身的开始标记，把块内偏移换算成文档绝对位置
      const from = pos + 1 + hit.start;
      const to = pos + 1 + hit.end;

      // 整段 `[[标题|123]]` 加 wiki-link class（含 [[ 和 ]]，方便点击命中）
      decorations.push(
        Decoration.inline(from, to, {
          class: "wiki-link",
          "data-wiki-link": hit.title,
          ...(hit.id ? { "data-wiki-link-id": hit.id } : {}),
          title: `点击跳转到「${hit.title}」`,
        }),
      );

      // 带 ID 形式：单独标记 `|123` 段，靠 CSS 视觉隐藏（font-size:0）。
      // 字符仍在文档里、选中复制时一并带走，仅渲染时不可见 → 视觉上等同 `[[标题]]`。
      if (hit.id) {
        // raw 形如 `[[标题|123]]`，结尾 `]]` 占 2 个 char，
        // 倒推：`|123` 段从 `to - 2 - (1 + id.length)` 到 `to - 2`
        const pipeTo = to - 2;
        const pipeFrom = pipeTo - (1 + hit.id.length);
        decorations.push(
          Decoration.inline(pipeFrom, pipeTo, {
            class: "wiki-link-id-anchor",
          }),
        );
      }
    }
    return false; // 文本块内部已整体处理，不再下钻其 inline 子节点
  });
  return DecorationSet.create(doc, decorations);
}

export const WikiLinkDecoration = Extension.create<WikiLinkOptions>({
  name: "wikiLinkDecoration",

  addOptions() {
    return { onClick: () => {}, isReadingMode: () => false };
  },

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey<DecorationSet>("wikiLinkDecoration");
    const onClick = this.options.onClick;

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, oldSet) => {
            if (!tr.docChanged) return oldSet.map(tr.mapping, tr.doc);
            return buildDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state) ?? DecorationSet.empty;
          },
          // 双链普通单击即跳转（编辑态、阅读态一致）。
          // 历史上编辑态要求 Ctrl/Cmd+点击以保留光标定位，但 .wiki-link 的 cursor:pointer 手型
          // 暗示「可直接点」，普通左键却没反应 → 用户高频反馈「双链点击无效」。改为普通单击即跳。
          // 注：仅点中双链文本本身才跳；点击双链以外位置仍正常定位光标，不影响编辑其它文字。
          handleClick(view, pos, event) {
            // 只响应**左键**。右键要留给上下文菜单（打开 / 复制 / 修改双链）——
            // ProseMirror 的 handleClick 对任意键都会触发，不拦的话右键会「菜单刚弹出来
            // 就已经跳走了」。中键同理留给未来的「新标签打开」。
            if (event.button !== 0) return false;

            // ① DOM 路径：点在 decoration span 上时最直接
            const target = event.target as HTMLElement | null;
            const el = target?.closest("[data-wiki-link]") as HTMLElement | null;
            if (el) {
              const title = el.getAttribute("data-wiki-link");
              if (title) {
                // 有 ID 锚点优先用 ID（标题改了也能跳到正确笔记）；否则交给上层按 title 查
                const idAttr = el.getAttribute("data-wiki-link-id");
                const id = idAttr ? Number(idAttr) : undefined;
                event.preventDefault();
                onClick(title, Number.isFinite(id) ? id : undefined);
                return true;
              }
            }

            // ② 位置路径：DOM 拿不到时用 ProseMirror 给的 pos 反查文档。
            // 🔴 必须有这条兜底 —— 表格是带 NodeView 的容器，点在单元格里时 event.target
            // 会被换成外层 <div class="tableWrapper">，closest 找不到 decoration span，于是
            // 表格里的双链看着是蓝的却点不动，表格外同款双链却一点就跳（用户实测现象）。
            // pos 是真实文档位置，不受 DOM 包裹结构影响。
            const hit = findWikiLinkAtPos(view.state.doc, pos);
            if (hit) {
              event.preventDefault();
              onClick(hit.title, hit.id);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
