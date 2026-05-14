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
 *   - 读：tiptap-markdown 默认会把整段 info 当作 language attr 塞进去，
 *         由 TiptapEditor 在 setContent 完成后调 normalizeCodeBlockFenceAttrs 拆分
 *         （把 title/wrap/showLineNumbers 提取出来，language 还原成干净的语言名）
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
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },

  /**
   * Markdown 序列化：fence info 写成 Docusaurus / VitePress 风格
   *   ```python title="xxx" wrap no-line-numbers
   *
   * 反序列化（parse）在 TiptapEditor setContent 之后由 normalizeCodeBlockFenceAttrs
   * 统一处理 —— tiptap-markdown 把 fence 整段 info 当 language 塞进来，需要后处理拆分。
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
          // title 里如果用户填了双引号，转义掉避免破坏 fence info 解析
          const titlePart = title
            ? ` title="${String(title).replace(/"/g, '\\"')}"`
            : "";
          const wrapPart = wrap ? " wrap" : "";
          const lnPart = noLN ? " no-line-numbers" : "";
          const info = `${lang}${titlePart}${wrapPart}${lnPart}`;
          state.write("```" + info + "\n");
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write("```");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/**
 * 反序列化辅助：把 fence info 字符串里的 title="..." / wrap / no-line-numbers
 * 拆回各 attr，并把 language 还原成干净的语言名。
 *
 * tiptap-markdown 解析 ```python title="X" wrap``` 时，会把整段 info 塞进 language attr
 * （= "python title=\"X\" wrap"），lowlight 拿这个去查语言肯定找不到 → 没高亮 + UI 异常。
 * 这里在 setContent 完成后扫一遍，恢复正确的 attr 分布。
 *
 * 调用时机：仅在外部 setContent（载入笔记 / 拖入 .md）之后调用一次即可，
 * 用户在编辑器里手动编辑 attrs 不会引入混合 language —— 那条路径直接走 updateAttributes。
 */
export function normalizeCodeBlockFenceAttrs(editor: Editor): void {
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return;
    const lang = node.attrs.language as string | null;
    if (!lang || !/\s/.test(lang)) return; // 没空格 = 纯净的语言名 / 空，跳过

    const parsed = parseCodeFenceInfo(lang);
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language: parsed.language || null,
      title: parsed.title ?? node.attrs.title ?? null,
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
  wrap?: boolean;
  noLineNumbers?: boolean;
}

function parseCodeFenceInfo(info: string): ParsedFenceInfo {
  const trimmed = info.trim();
  // 第一个空格之前是 language；之后是 attrs
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) return { language: trimmed };
  const language = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);

  // title="..." 或 title='...'，支持转义的引号
  const titleMatch = rest.match(/title=(["'])((?:\\.|(?!\1).)*)\1/);
  const title = titleMatch ? titleMatch[2].replace(/\\"/g, '"').replace(/\\'/g, "'") : undefined;

  // 独立 keyword：wrap / no-line-numbers（前后是空格或边界）
  const wrap = /(^|\s)wrap(\s|$)/.test(rest);
  const noLineNumbers = /(^|\s)no-line-numbers(\s|$)/.test(rest);

  return { language, title, wrap, noLineNumbers };
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
        style={showMermaidPreview ? { display: "none" } : undefined}
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
