/**
 * 代码块增强：Docusaurus 风格的 toolbar（标题 / 语言 / 换行 / 复制）+ 行号 CSS counter
 *
 * 设计原则：
 * - 沿用 CodeBlockLowlight，只在它基础上加 attrs + ReactNodeView 包装，
 *   避免重写语法高亮逻辑
 * - 4 个新 attrs 持久化到 HTML 节点的 data-* 属性上，刷新页面 / 保存读回都能保留
 * - 行号用 CSS counter 实现（零 JS 开销，长代码块不卡）
 * - 自动识别语言：用户首次粘贴/输入时检测一次，仅作"建议"显示，不强制覆盖
 *
 * Markdown 序列化（Docusaurus / VitePress 风格）：
 *   ```python title="xxx" wrap no-line-numbers
 *   - 写：addStorage().markdown.serialize 拼接 fence info（见本文件下方）
 *   - 读：addStorage().markdown.parse.setup 接管 markdown-it 的 fence 渲染，把 info 里的
 *         attrs 补成 <pre> 上的 data-*，再由上面各 attr 的 parseHTML 读回。
 *
 *     🔴 为什么必须自己接管 fence：tiptap-markdown 走「markdown-it 渲染成 HTML → 解析进
 *     编辑器」，而 markdown-it 默认的 fence 渲染**只取 info 的第一个词**当语言名输出成
 *     class="language-xxx"，后面的 title/fontSize/wrap/no-line-numbers 全被丢弃：
 *         ```python title="X" wrap  →  <pre><code class="language-python">
 *     结果就是「代码块命名填了、存盘 .md 里也有，但重新打开就没了」。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Button, Input, Select, Switch, Tooltip, message } from "antd";
import { Copy, Check } from "lucide-react";
import { common, createLowlight } from "lowlight";
import { MermaidPreview } from "./MermaidPreview";

const lowlight = createLowlight(common);

/** 不属于 lowlight 高亮语言、但在编辑器中有特殊 NodeView 行为的"伪语言" */
const PSEUDO_LANGUAGES: { value: string; label: string }[] = [
  { value: "mermaid", label: "Mermaid 流程图" },
];

/** 推荐的常用语言（下拉前 N 项），其余按字母序排在后面 */
const POPULAR_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "bash",
  "sql",
  "json",
  "yaml",
  "html",
  "css",
  "markdown",
];

/** 把语言代码转成下拉显示文本 */
const LANG_LABEL: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  bash: "Bash",
  sql: "SQL",
  json: "JSON",
  yaml: "YAML",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
};

function labelOf(lang: string): string {
  return LANG_LABEL[lang] ?? lang;
}

function buildLanguageOptions(): { value: string; label: string }[] {
  const all = lowlight.listLanguages();
  const popular = POPULAR_LANGUAGES.filter((l) => all.includes(l));
  const others = all.filter((l) => !popular.includes(l)).sort();
  return [
    { value: "", label: "纯文本 / 未识别" },
    ...PSEUDO_LANGUAGES,
    ...popular.map((l) => ({ value: l, label: labelOf(l) })),
    ...others.map((l) => ({ value: l, label: labelOf(l) })),
  ];
}

/** 单代码块字号下拉选项。value=0 → null（跟随全局 --editor-code-font-size / 0.9em）。 */
const CODE_FONT_SIZE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "跟随" },
  { value: 12, label: "12" },
  { value: 13, label: "13" },
  { value: 14, label: "14" },
  { value: 15, label: "15" },
  { value: 16, label: "16" },
  { value: 18, label: "18" },
  { value: 20, label: "20" },
];

/**
 * 自定义代码块扩展。继承 CodeBlockLowlight 的 lowlight 高亮能力，
 * 加 title / wrap / showLineNumbers 三个 attrs（language 已有），用 ReactNodeView 渲染。
 */
export const CodeBlockEnhanced = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      // 继承父扩展的 language attr
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title") || null,
        renderHTML: (attrs) =>
          attrs.title ? { "data-title": attrs.title } : {},
      },
      wrap: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-wrap") === "true",
        renderHTML: (attrs) => (attrs.wrap ? { "data-wrap": "true" } : {}),
      },
      showLineNumbers: {
        default: true,
        parseHTML: (el) => el.getAttribute("data-line-numbers") !== "false",
        renderHTML: (attrs) =>
          attrs.showLineNumbers === false
            ? { "data-line-numbers": "false" }
            : {},
      },
      // 单代码块字号（px）。null = 跟随全局（CSS 变量 --editor-code-font-size，回退 0.9em）。
      // 导出 HTML / 打印路径额外写 inline style，让脱离 NodeView 的 <pre> 也带上字号。
      fontSize: {
        default: null,
        parseHTML: (el) => {
          const n = parseInt(el.getAttribute("data-font-size") || "", 10);
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attrs) =>
          attrs.fontSize
            ? {
                "data-font-size": String(attrs.fontSize),
                style: `font-size:${attrs.fontSize}px`,
              }
            : {},
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },

  /**
   * Markdown 序列化 / 反序列化：fence info 写成 Docusaurus / VitePress 风格
   *   ```python title="xxx" wrap no-line-numbers
   *
   * parse.setup 接管 markdown-it 的 fence 渲染把 attrs 补回 <pre>（详见文件头注释）。
   */
  addStorage() {
    const parent = (this.parent?.() as Record<string, unknown> | undefined) ?? {};
    return {
      ...parent,
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const lang = (node.attrs.language as string | null) ?? "";
          const title = node.attrs.title as string | null;
          const wrap = Boolean(node.attrs.wrap);
          const noLN = node.attrs.showLineNumbers === false;
          const fontSize = node.attrs.fontSize as number | null;
          // title 里如果用户填了双引号，转义掉避免破坏 fence info 解析
          const titlePart = title
            ? ` title="${String(title).replace(/"/g, '\\"')}"`
            : "";
          const fontSizePart = fontSize ? ` fontSize=${fontSize}` : "";
          const wrapPart = wrap ? " wrap" : "";
          const lnPart = noLN ? " no-line-numbers" : "";
          const info = `${lang}${titlePart}${fontSizePart}${wrapPart}${lnPart}`;
          state.write("```" + info + "\n");
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write("```");
          state.closeBlock(node);
        },
        parse: {
          /**
           * 接管 fence 渲染，修两件事（都是 markdown-it 默认行为造成的）：
           *
           * ① attrs 被丢弃：默认只把 info 首词当语言名，title / fontSize / wrap /
           *    no-line-numbers 存得进 .md 却读不回来。→ 在 <pre> 上补 data-*，
           *    被各 attr 的 parseHTML 接住（CodeBlock 的 parse 规则是 { tag: "pre" }）。
           *
           * ② 没选语言时命名会"串"进语言框：info 形如 ` title="X"`，默认把首词
           *    `title="X"` 整个当语言名输出成 class="language-title=&quot;X&quot;"，
           *    语言下拉里就显示一串 title="..."（命名却是空的）。命名带空格时更糟，
           *    会被截断成 `language-title=&quot;工具`。→ 判定首词是属性时删掉这个假 class。
           */
          setup(markdownit: MarkdownItLike) {
            // 默认 spec 的 setup 会被本对象整体覆盖（getMarkdownSpec 是浅合并），
            // 所以它设的 langPrefix 要在这里补回，否则语言 class 前缀可能不对。
            markdownit.set({ langPrefix: "language-" });

            const renderFence = markdownit.renderer.rules.fence;
            if (!renderFence) return; // 理论不会发生；真没有就退回默认行为，不硬崩
            markdownit.renderer.rules.fence = (tokens, idx, options, env, self) => {
              const info = tokens[idx]?.info ?? "";
              let html = renderFence(tokens, idx, options, env, self);
              // ② 先清掉假语言 class（此时 <code> 上的 class 整个都是伪造的，直接删）
              if (fenceInfoHasNoLanguage(info)) {
                html = html.replace(
                  /^(<pre[^>]*><code)\s+class="language-[^"]*"/,
                  "$1",
                );
              }
              // ① 再把 attrs 补成 <pre> 上的 data-*
              const dataAttrs = codeFenceInfoToDataAttrs(info);
              // 默认输出必定以 <pre 开头（带/不带 class 都是）；插在标签名之后
              return dataAttrs ? html.replace(/^<pre/, `<pre${dataAttrs}`) : html;
            };
          },
          /**
           * 默认 spec 的 updateDOM 同样被覆盖了，必须原样带回：markdown-it 输出的是
           * "代码\n</code></pre>"，不去掉这个换行，每个代码块末尾都会多出一个空行。
           */
          updateDOM(element: HTMLElement) {
            element.innerHTML = element.innerHTML.replace(
              /\n<\/code><\/pre>/g,
              "</code></pre>",
            );
          },
        },
      },
    };
  },
});

/**
 * markdown-it 的最小结构签名（只用到 set + renderer.rules.fence）。
 * markdown-it 只是 tiptap-markdown 的传递依赖，本项目没有直接依赖它，
 * 也没装 @types/markdown-it —— 故用结构化类型描述，不引入新依赖。
 */
interface MarkdownItLike {
  set(options: Record<string, unknown>): void;
  renderer: {
    rules: Record<
      string,
      | ((
          tokens: { info?: string }[],
          idx: number,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          options: any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          env: any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          self: any,
        ) => string)
      | undefined
    >;
  };
}

/** HTML 属性值转义：title 是用户自由输入，不转义能直接破坏 <pre> 标签结构 */
function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 把 fence info（如 `python title="X" fontSize=14 wrap no-line-numbers`）转成可直接拼进
 * `<pre>` 开标签的 data-* 串（含前导空格）；没有任何附加 attr 时返回空串。
 *
 * 抽成纯函数是为了能单测 —— 这段是「代码块命名存得进读不回」的修复核心。
 */
/**
 * 该 fence 是否"没有语言名"（info 以属性开头，如 ` title="X"` / ` wrap`）。
 *
 * 这种 info 会让 markdown-it 把首词当语言名，渲染出 class="language-title=&quot;X&quot;"，
 * 表现为「命名串进了旁边的语言框，命名框反而空了」。用它判定后把假 class 删掉。
 */
export function fenceInfoHasNoLanguage(info: string): boolean {
  const trimmed = (info ?? "").trim();
  if (!trimmed) return false; // 空 info：markdown-it 本就不加 class，无需处理
  return isFenceAttrToken(trimmed.split(/\s+/)[0] ?? "");
}

export function codeFenceInfoToDataAttrs(info: string): string {
  const trimmed = (info ?? "").trim();
  if (!trimmed) return "";

  // 直接对整串扫属性：不能用"无空格 = 纯语言名"这种捷径提前返回 ——
  // 「没选语言只填了命名」时 info 就是 `title="X"`（整串无空格），会被误判跳过。
  const parsed = scanFenceAttrs(trimmed);
  const attrs: string[] = [];
  if (parsed.title) attrs.push(`data-title="${escapeAttrValue(parsed.title)}"`);
  if (parsed.fontSize) attrs.push(`data-font-size="${parsed.fontSize}"`);
  if (parsed.wrap) attrs.push('data-wrap="true"');
  if (parsed.noLineNumbers) attrs.push('data-line-numbers="false"');
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

/**
 * 兜底：把误塞进 language attr 的整段 fence info（"python title=\"X\" wrap"）拆回各 attr，
 * 并把 language 还原成干净的语言名 —— 否则 lowlight 拿它查语言必然找不到，高亮失效。
 *
 * ⚠️ 这**不是**主解析路径。主路径是 addStorage().markdown.parse.setup（把 info 补成 <pre>
 * 上的 data-*）。此前本函数被当成主路径，但它的前提不成立：markdown-it 压根不会把整段
 * info 交出来，language 永远是干净的首词 → 下面的 /\s/ 判断恒为假，函数从未真正生效，
 * title 等属性也就一直丢失。现保留作兜底（成本极低），覆盖直接灌入脏 language 的场景。
 *
 * 调用时机：外部 setContent（载入笔记 / 拖入 .md）之后调一次即可，
 * 用户在编辑器里手动改 attrs 走的是 updateAttributes，不会引入混合 language。
 */
export function normalizeCodeBlockFenceAttrs(editor: Editor): void {
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return;
    const lang = node.attrs.language as string | null;
    if (!lang) return;
    // 脏 language 有两种形态：① 混了空格（"python title=..."）；
    // ② 整串就是一个属性且无空格（'title="中文命名"' —— 命名不含空格时正是这种，
    //    只判空格会漏掉，用户看到的就是语言框里挂着一串 title="..."）。
    if (!/\s/.test(lang) && !isFenceAttrToken(lang)) return; // 纯净语言名，跳过

    const parsed = parseCodeFenceInfo(lang);
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language: parsed.language || null,
      title: parsed.title ?? node.attrs.title ?? null,
      fontSize: parsed.fontSize ?? (node.attrs.fontSize as number | null) ?? null,
      wrap: parsed.wrap || Boolean(node.attrs.wrap),
      showLineNumbers: parsed.noLineNumbers
        ? false
        : node.attrs.showLineNumbers !== false,
    });
    changed = true;
  });
  if (changed) {
    editor.view.dispatch(tr.setMeta("addToHistory", false));
  }
}

interface ParsedFenceInfo {
  language: string;
  title?: string;
  fontSize?: number;
  wrap?: boolean;
  noLineNumbers?: boolean;
}

/** 首词是附加属性而非语言名？（用户没选语言只填了命名时，info 就以 title= 开头） */
function isFenceAttrToken(token: string): boolean {
  return (
    token.startsWith("title=") ||
    token.startsWith("fontSize=") ||
    token === "wrap" ||
    token === "no-line-numbers"
  );
}

/**
 * 扫描 fence info 里的附加属性。正则一律按词边界锚定，所以**对整串扫描**即可，
 * 不依赖"第一个空格之后才是 attrs"这个前提 —— 那个前提在「没选语言只填了命名」
 * （info = ` title="X"`，整串无空格）时会失效，正是命名丢失的一个分支。
 */
function scanFenceAttrs(info: string): Omit<ParsedFenceInfo, "language"> {
  // title="..." 或 title='...'，支持转义的引号
  const titleMatch = info.match(/title=(["'])((?:\\.|(?!\1).)*)\1/);
  const title = titleMatch
    ? titleMatch[2].replace(/\\"/g, '"').replace(/\\'/g, "'")
    : undefined;

  // fontSize=14（仅数字）
  const fsMatch = info.match(/(^|\s)fontSize=(\d+)(\s|$)/);
  const fsNum = fsMatch ? parseInt(fsMatch[2], 10) : NaN;
  const fontSize = Number.isFinite(fsNum) && fsNum > 0 ? fsNum : undefined;

  // 独立 keyword：wrap / no-line-numbers（前后是空格或边界，避免命中 "wrapper"）
  const wrap = /(^|\s)wrap(\s|$)/.test(info);
  const noLineNumbers = /(^|\s)no-line-numbers(\s|$)/.test(info);

  return { title, fontSize, wrap, noLineNumbers };
}

function parseCodeFenceInfo(info: string): ParsedFenceInfo {
  const trimmed = info.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  // 首词是属性 → 该代码块没有语言名（如 ```` ``` title="备注" ````）
  const language = isFenceAttrToken(firstToken) ? "" : firstToken;
  return { language, ...scanFenceAttrs(trimmed) };
}

/** React NodeView — toolbar + 代码内容（PM 管） + 行号 */
function CodeBlockNodeView({
  node,
  updateAttributes,
  editor,
  getPos,
}: NodeViewProps) {
  const language: string = (node.attrs.language as string | null) ?? "";
  const title: string = (node.attrs.title as string | null) ?? "";
  const wrap: boolean = Boolean(node.attrs.wrap);
  const showLineNumbers: boolean = node.attrs.showLineNumbers !== false;
  const fontSize: number | null = (node.attrs.fontSize as number | null) ?? null;

  const [copied, setCopied] = useState(false);
  const [autoDetected, setAutoDetected] = useState<string | null>(null);
  const detectTimerRef = useRef<number | null>(null);

  const languageOptions = useMemo(buildLanguageOptions, []);

  // ── Mermaid 模式：判断光标是否在本块内，决定显示源码还是预览 ─────────
  const isMermaid = language === "mermaid";
  const [cursorInBlock, setCursorInBlock] = useState(false);
  useEffect(() => {
    if (!isMermaid) return;
    const recompute = () => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos !== "number") {
        setCursorInBlock(false);
        return;
      }
      const { from, to } = editor.state.selection;
      const start = pos;
      const end = pos + node.nodeSize;
      setCursorInBlock(
        editor.isFocused && from >= start && to <= end,
      );
    };
    recompute();
    editor.on("selectionUpdate", recompute);
    editor.on("focus", recompute);
    editor.on("blur", recompute);
    return () => {
      editor.off("selectionUpdate", recompute);
      editor.off("focus", recompute);
      editor.off("blur", recompute);
    };
  }, [editor, getPos, node, isMermaid]);

  // 空内容时强制显示源码（否则预览空白会让用户不知道点哪进入编辑）
  const codeText = node.textContent;
  const showMermaidPreview = isMermaid && !cursorInBlock && codeText.trim().length > 0;

  /** 点击预览：把光标聚焦到本块内部 */
  const focusIntoBlock = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (typeof pos !== "number") return;
    editor.chain().focus().setTextSelection(pos + 1).run();
  };

  // 自动识别语言：仅在 attrs.language 为空时跑，debounce 800ms
  useEffect(() => {
    if (language) {
      setAutoDetected(null);
      return;
    }
    const code = node.textContent;
    if (code.trim().length < 10) {
      setAutoDetected(null);
      return;
    }
    if (detectTimerRef.current != null) {
      window.clearTimeout(detectTimerRef.current);
    }
    detectTimerRef.current = window.setTimeout(() => {
      try {
        const result = lowlight.highlightAuto(code);
        const detected = (result.data as { language?: string } | undefined)
          ?.language;
        if (detected && lowlight.listLanguages().includes(detected)) {
          setAutoDetected(detected);
        }
      } catch {
        // 检测失败静默
      }
    }, 800);
    return () => {
      if (detectTimerRef.current != null) {
        window.clearTimeout(detectTimerRef.current);
      }
    };
  }, [language, node.textContent]);

  const handleTitleChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateAttributes({ title: e.target.value || null });
  };

  const handleLanguageChange = (value: string) => {
    updateAttributes({ language: value || null });
  };

  const handleAcceptDetection = () => {
    if (autoDetected) {
      updateAttributes({ language: autoDetected });
      setAutoDetected(null);
    }
  };

  const handleWrapToggle = (checked: boolean) => {
    updateAttributes({ wrap: checked });
  };

  /** 改本块字号：0 → null（跟随全局），否则写绝对 px */
  const handleFontSizeChange = (value: number) => {
    updateAttributes({ fontSize: value > 0 ? value : null });
  };

  /**
   * 「应用到全文」：把当前代码块的字号刷给本文档全部代码块（语雀式一键同步）。
   * size=null 时即把全文代码块统一恢复为"跟随全局"。一次事务批量改，单步可撤销。
   */
  const applyFontSizeToAll = () => {
    const size = (node.attrs.fontSize as number | null) ?? null;
    const { state } = editor;
    const tr = state.tr;
    let count = 0;
    state.doc.descendants((n, pos) => {
      if (n.type.name === "codeBlock") {
        tr.setNodeMarkup(pos, undefined, { ...n.attrs, fontSize: size });
        count += 1;
      }
    });
    if (count > 0) editor.view.dispatch(tr);
    message.success(
      size
        ? `已将全文 ${count} 个代码块字号设为 ${size}px`
        : `已将全文 ${count} 个代码块字号恢复为跟随正文`,
    );
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      message.success("已复制到剪贴板");
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      message.error(`复制失败：${err}`);
    }
  };

  // 选中 select 时阻止 ProseMirror 抢焦点把光标插回代码里
  const stopMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const isEditable = editor?.isEditable !== false;

  return (
    <NodeViewWrapper
      className="code-block-enhanced"
      data-wrap={wrap ? "true" : undefined}
      data-line-numbers={showLineNumbers ? undefined : "false"}
    >
      <div
        className="code-block-toolbar"
        contentEditable={false}
        onMouseDown={stopMouseDown}
      >
        <Input
          className="code-block-title"
          size="small"
          placeholder="未命名（可选）"
          value={title}
          onChange={handleTitleChange}
          variant="borderless"
          disabled={!isEditable}
          maxLength={64}
        />
        <Select
          className="code-block-lang"
          size="small"
          value={language || ""}
          onChange={handleLanguageChange}
          options={languageOptions}
          showSearch
          variant="borderless"
          styles={{ popup: { root: { minWidth: 200 } } }}
          disabled={!isEditable}
        />
        {autoDetected && (
          <Tooltip title={`点击采用：${labelOf(autoDetected)}`}>
            <Button
              size="small"
              type="link"
              onClick={handleAcceptDetection}
              style={{ padding: "0 6px", fontSize: 12 }}
            >
              建议: {labelOf(autoDetected)}
            </Button>
          </Tooltip>
        )}
        <div className="code-block-toolbar-spacer" />
        <span className="code-block-fontsize-control">
          <span className="code-block-wrap-label">字号</span>
          <Select
            className="code-block-fontsize"
            size="small"
            value={fontSize ?? 0}
            onChange={handleFontSizeChange}
            options={CODE_FONT_SIZE_OPTIONS}
            variant="borderless"
            disabled={!isEditable}
            popupMatchSelectWidth={false}
          />
        </span>
        {fontSize != null && isEditable && (
          <Tooltip title="把当前代码块字号应用到本文全部代码块">
            <Button
              size="small"
              type="link"
              onClick={applyFontSizeToAll}
              style={{ padding: "0 4px", fontSize: 12 }}
            >
              应用到全文
            </Button>
          </Tooltip>
        )}
        <span className="code-block-wrap-control">
          <span className="code-block-wrap-label">自动换行</span>
          <Switch
            size="small"
            checked={wrap}
            onChange={handleWrapToggle}
            disabled={!isEditable}
          />
        </span>
        <Tooltip title="复制全部">
          <Button
            size="small"
            type="text"
            icon={
              copied ? (
                <Check size={14} style={{ color: "#52c41a" }} />
              ) : (
                <Copy size={14} />
              )
            }
            onClick={handleCopy}
          />
        </Tooltip>
      </div>
      {showMermaidPreview && (
        <MermaidPreview code={codeText} onClick={focusIntoBlock} />
      )}
      {/* NodeViewContent 必须始终挂载在 DOM 中，否则 ProseMirror 无法把内容写入；
          mermaid 预览态下用 display:none 隐藏，但保留 PM 的 contentDOM 锚点 */}
      <pre
        className={`hljs language-${language || "plaintext"}`}
        style={{
          // 单块字号优先于全局 --editor-code-font-size；inline style 覆盖 .tiptap pre 的字号
          ...(fontSize ? { fontSize: `${fontSize}px` } : {}),
          ...(showMermaidPreview ? { display: "none" } : {}),
        }}
      >
        {showLineNumbers && !showMermaidPreview && (
          <CodeLineGutter text={node.textContent} contentEditable={false} />
        )}
        {/* NodeViewContent 类型签名只列了 div/span，但 Tiptap 实际接受任何标签；
            codeBlock 必须用 <code> 才能让 .tiptap pre code .hljs-* 选择器生效 */}
        <NodeViewContent as={"code" as unknown as "div"} />
      </pre>
    </NodeViewWrapper>
  );
}

/**
 * 行号侧栏：根据代码 \n 数量渲染数字列。
 * - lowlight 渲染时不按行包裹 DOM，所以纯 CSS counter 无锚点；改用 JS 按 \n 数行
 * - contentEditable=false 让 PM 把这个 div 当 widget 不参与编辑模型
 * - 跟代码区共享同一个 line-height（1.6em）保证数字行对齐
 */
function CodeLineGutter({
  text,
  contentEditable,
}: {
  text: string;
  contentEditable: boolean;
}) {
  const lineCount = useMemo(() => {
    // textContent 不一定以 \n 结尾；至少 1 行
    const n = (text.match(/\n/g) || []).length + 1;
    return Math.max(1, n);
  }, [text]);

  const numbers: string[] = [];
  for (let i = 1; i <= lineCount; i++) numbers.push(String(i));

  return (
    <div className="code-block-line-gutter" contentEditable={contentEditable}>
      {numbers.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  );
}
