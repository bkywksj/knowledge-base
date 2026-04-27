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
 * Markdown 序列化兼容（后续 v2 做）：
 *   ```python title="xxx" wrap showLineNumbers   ← Docusaurus / VitePress 风格
 *   现阶段 attrs 仅在应用内编辑/查看时保留，导出 markdown 暂只保留 language
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Button, Input, Select, Switch, Tooltip, message } from "antd";
import { Copy, Check } from "lucide-react";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

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
});

/** React NodeView — toolbar + 代码内容（PM 管） + 行号 */
function CodeBlockNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const language: string = (node.attrs.language as string | null) ?? "";
  const title: string = (node.attrs.title as string | null) ?? "";
  const wrap: boolean = Boolean(node.attrs.wrap);
  const showLineNumbers: boolean = node.attrs.showLineNumbers !== false;

  const [copied, setCopied] = useState(false);
  const [autoDetected, setAutoDetected] = useState<string | null>(null);
  const detectTimerRef = useRef<number | null>(null);

  const languageOptions = useMemo(buildLanguageOptions, []);

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
          dropdownStyle={{ minWidth: 200 }}
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
      <pre className={`hljs language-${language || "plaintext"}`}>
        {showLineNumbers && (
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
