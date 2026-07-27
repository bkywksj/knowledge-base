/**
 * 让 tiptap-markdown 的 markdown-it 实例放行 file:// 协议链接与内联图片 data URI
 *
 * Why：markdown-it 默认 validateLink 把 file: 列入黑名单（markdown-it#108），
 * 导致笔记里的 [📎 附件](file://...) 第二次打开时被解析器拒绝，整段降级成
 * 纯 markdown 文本。
 *
 * 实现：onBeforeCreate 时 Markdown 扩展的 onBeforeCreate 已经跑过（因为本扩展
 * 在 extensions 数组里位于 Markdown 之后），parser.md 已就绪 → 直接 monkey-patch
 * validateLink。这样初始 setContent 时 md 已经能放行 file://。
 *
 * 还在 storage 注入 setup 钩子作为兜底（每次后续 parse 前重设，防被覆盖）。
 */
import { Extension } from "@tiptap/core";

/**
 * 安全的内联图片 data URI 白名单。
 *
 * 🔴 曾经的 bug：本文件早先直接把整个 `data:` 协议拉黑，比 markdown-it 的默认实现
 * 还严 —— 默认是允许 `data:image/(gif|png|jpeg|webp)` 的。结果粘贴含 base64 内联图的
 * markdown（`![](data:image/png;base64,…)`）时，markdown-it 拒绝生成 <img>，原样吐出
 * 一大坨字面源码；而走「导入 .md」时 Rust 侧（import_attachments.rs）会先把 base64
 * 解码落盘再改写路径，所以同样的内容导入正常、粘贴就成源码 —— 两条路径行为不一致。
 *
 * 放行后 <img src="data:image/…"> 能正常生成，粘贴处理里既有的
 * localizeRemoteImagesInEditor 会随即把它落盘换成 kb-asset://，最终与导入路径一致
 * （正文里不会长期留着超大 base64 撑爆 DB）。
 *
 * 只放行光栅格式：svg+xml 可携带脚本，markdown-it 默认也不放行，这里保持一致。
 */
const SAFE_IMAGE_DATA_URI = /^data:image\/(gif|png|jpe?g|webp|avif|bmp);/i;
/** 能执行脚本的协议，永久拉黑 */
const BAD_PROTO = /^(javascript|vbscript|data):/i;

/** 导出供单测：这条判定决定了「粘贴的内联图能否渲染」，回归代价高，必须锁住 */
export const allowAllExceptDangerous = (url: string): boolean => {
  const trimmed = String(url).trim();
  if (SAFE_IMAGE_DATA_URI.test(trimmed)) return true;
  return !BAD_PROTO.test(trimmed);
};

export const AllowFileLink = Extension.create({
  name: "allowFileLink",

  onBeforeCreate() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (this.editor.storage as any).markdown?.parser?.md as
      | { validateLink?: (url: string) => boolean }
      | undefined;
    if (md) {
      md.validateLink = allowAllExceptDangerous;
    }
  },

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: { validateLink?: (url: string) => boolean }) {
            md.validateLink = allowAllExceptDangerous;
          },
        },
      },
    };
  },
});
