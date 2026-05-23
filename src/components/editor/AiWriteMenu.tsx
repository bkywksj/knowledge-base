import { useState, useEffect, useRef, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Button, Input, Popover, Tooltip, message, theme as antdTheme } from "antd";
import {
  Sparkles,
  ArrowRight,
  FileText,
  RefreshCw,
  Languages,
  Expand,
  Shrink,
  X,
  Check,
  Loader2,
  StopCircle,
  Wand2,
  PenLine,
  Copy,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiWriteApi, promptApi } from "@/lib/api";
import type { PromptOutputMode, PromptTemplate } from "@/types";

interface AiWriteMenuProps {
  editor: Editor;
  /**
   * 选中文本时浮起按钮行的「leading 按钮」回调（即「问 AI 这段」）。
   * 不传时不渲染该按钮；按钮跟着同一个浮动菜单出现，不会和右侧续写/总结/改写
   * 等工具按钮重叠。点击时携带选中纯文本作为参数；调用方负责打开抽屉 / 预填问题。
   */
  onAskAi?: (selectedText: string) => void;
}

// Lucide 图标名 → React 元素工厂，保持和管理页"图标名"字段一致
const ICON_MAP: Record<string, (size: number) => React.ReactNode> = {
  ArrowRight: (s) => <ArrowRight size={s} />,
  FileText: (s) => <FileText size={s} />,
  RefreshCw: (s) => <RefreshCw size={s} />,
  Languages: (s) => <Languages size={s} />,
  Expand: (s) => <Expand size={s} />,
  Shrink: (s) => <Shrink size={s} />,
  Sparkles: (s) => <Sparkles size={s} />,
  Wand2: (s) => <Wand2 size={s} />,
};

function renderIcon(name: string | null, size: number): React.ReactNode {
  if (name && ICON_MAP[name]) return ICON_MAP[name](size);
  return <Wand2 size={size} />; // 用户自定义没填图标时的默认占位
}

/**
 * 修复 R-016：AI 写作处理选区时丢图片。
 *
 * 旧实现 `editor.state.doc.textBetween(from, to, " ")` 只取纯文本，所有
 * `image / video / embedVideo` 这类 block 节点会在 step 1 就被丢弃，AI 看不到，
 * 替换阶段 `deleteRange + insertContentAt(纯文本)` 又把原选区里的节点删了，
 * 导致图片永久丢失。
 *
 * 修复策略：物理隔离，不依赖模型守规矩。
 *   1. 扫描选区时，遇到媒体节点把 `node.toJSON()` 存档，文本里塞 [IMG_N] 占位符。
 *   2. 占位符随选区文字一起喂给 AI；模型保留就按原位回填，模型吞掉就追加末尾兜底。
 *   3. 替换/追加阶段按占位符切分 result，分段交替插入 text 与 nodeJSON。
 */
const MEDIA_NODE_TYPES = new Set(["image", "video", "embedVideo"]);
// 占位符设计：
// - 必须人类/模型都能识别为"占位符"（用大写英文 + 下划线 + 数字，不是常见词汇）
// - 必须在最终结果中容易精确切分（前后加方括号，配合正则 \[IMG_\d+\]）
// - 不能是零宽字符：测试中部分模型会"清理空白"把零宽吞掉，可见 token 反而更稳
const PLACEHOLDER_PREFIX = "[IMG_";
const PLACEHOLDER_SUFFIX = "]";
const PLACEHOLDER_REGEX = /\[IMG_(\d+)\]/g;

interface MediaNodeSnapshot {
  index: number;
  nodeJSON: unknown;
}

interface SelectionPayload {
  /** 含 [IMG_N] 占位符的纯文本，喂给 AI */
  text: string;
  /** 按 index 顺序存放的媒体节点快照 */
  mediaNodes: MediaNodeSnapshot[];
}

/**
 * 扫描选区，把媒体节点替换为占位符。
 * 遵循 ProseMirror nodesBetween 语义：parent 内的 inline 节点逐个回调。
 * 性能：O(n)，n = 选区内节点数；不会克隆全文档。
 */
function extractSelectionWithMedia(
  editor: Editor,
  from: number,
  to: number,
): SelectionPayload {
  const mediaNodes: MediaNodeSnapshot[] = [];
  let text = "";
  let lastBlockEnd = -1;

  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    // 媒体节点：替换为占位符，不再下钻
    if (MEDIA_NODE_TYPES.has(node.type.name)) {
      const idx = mediaNodes.length;
      mediaNodes.push({ index: idx, nodeJSON: node.toJSON() });
      text += `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
      return false;
    }
    // 文本节点：按选区裁剪后拼接
    if (node.isText && node.text) {
      const nodeFrom = Math.max(pos, from);
      const nodeTo = Math.min(pos + node.nodeSize, to);
      if (nodeTo > nodeFrom) {
        text += node.text.slice(nodeFrom - pos, nodeTo - pos);
      }
      return false;
    }
    // block 节点（段落/标题/列表项等）边界：补一个换行，跟 textBetween(" ") 行为接近
    // 但用 \n 而不是空格，让 AI 看到段落结构
    if (node.isBlock && pos >= from && pos !== lastBlockEnd) {
      if (text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
      }
      lastBlockEnd = pos + node.nodeSize;
    }
    return true;
  });

  return { text, mediaNodes };
}

interface ResultSegment {
  type: "text" | "node";
  value: string;
  nodeJSON?: unknown;
}

/**
 * 解析 AI 返回结果，按 [IMG_N] 占位符切分。
 *
 * 兜底规则（按优先级）：
 *   1. 占位符按出现顺序对应到 mediaNodes[N]，N 越界则丢弃占位符
 *   2. 同一图片占位符在 result 中重复出现 → 第一次插入节点，后续保留为字面文字
 *      （不复制节点，避免 ProseMirror 节点 id 冲突）
 *   3. 全部占位符被 AI 删掉 → 调用方在 applyResult 里把剩余节点追加到末尾
 *
 * @returns segments + 已使用的 media index 集合
 */
function parseResultWithPlaceholders(
  result: string,
  mediaNodes: MediaNodeSnapshot[],
): { segments: ResultSegment[]; usedIndices: Set<number> } {
  const segments: ResultSegment[] = [];
  const usedIndices = new Set<number>();
  let lastIndex = 0;
  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(result)) !== null) {
    const before = result.slice(lastIndex, match.index);
    if (before) segments.push({ type: "text", value: before });
    const idx = Number(match[1]);
    const media = mediaNodes[idx];
    if (media && !usedIndices.has(idx)) {
      segments.push({ type: "node", value: match[0], nodeJSON: media.nodeJSON });
      usedIndices.add(idx);
    } else {
      // 越界或重复出现：保留为文字，避免静默丢内容
      segments.push({ type: "text", value: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  const tail = result.slice(lastIndex);
  if (tail) segments.push({ type: "text", value: tail });
  return { segments, usedIndices };
}

/**
 * 伪选区 Plugin：在 AI 菜单弹出（流式中 / 结果区显示 / 自定义 Popover 打开）时，
 * 给当前选区位置加一个 inline class，靠 CSS 渲染高亮。
 *
 * 解决的问题：弹窗 / Popover 里的输入框抢焦点后，编辑器失焦，浏览器原生
 * `::selection` 蓝底就消失了，用户视觉上"看不到自己选的什么"。本 plugin
 * 维持一个独立于浏览器原生 selection 的视觉装饰，焦点不在编辑器也仍可见。
 */
const FAKE_SELECTION_KEY = new PluginKey<DecorationSet>("ai-write-fake-selection");

function createFakeSelectionPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: FAKE_SELECTION_KEY,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const meta = tr.getMeta(FAKE_SELECTION_KEY);
        if (meta === "clear") return DecorationSet.empty;
        if (meta && typeof meta === "object" && "from" in meta) {
          const { from, to } = meta as { from: number; to: number };
          if (from === to) return DecorationSet.empty;
          return DecorationSet.create(tr.doc, [
            Decoration.inline(from, to, { class: "kb-fake-selection" }),
          ]);
        }
        // 文档变化时同步映射坐标，避免编辑后高亮范围错位
        return deco.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return FAKE_SELECTION_KEY.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

export function AiWriteMenu({ editor, onAskAi }: AiWriteMenuProps) {
  const { token } = antdTheme.useToken();
  // 设置里关闭"AI 问答"模块时，整个浮动菜单不挂载（不监听选区，零开销）
  const aiEnabled = useFeatureEnabled("ai");
  const [visible, setVisible] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const [selectedText, setSelectedText] = useState("");
  // 浮动 AI 工具栏：贴近选区下方，一行展示所有提示词按钮（横向滚动，不换行）
  // 直接展开整条工具栏，不再走"先点小按钮→再展开菜单"的二段交互
  const [triggerPos, setTriggerPos] = useState<{ x: number; y: number } | null>(null);
  // 正在执行的 Prompt（用于决定结果插入模式 / 菜单标题）
  const [activePrompt, setActivePrompt] = useState<PromptTemplate | null>(null);
  // DB 里的提示词列表，AI 菜单从这里渲染；为空时显示"去添加提示词"占位
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  // 自定义提示词弹窗
  const [customOpen, setCustomOpen] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  // AI 给这段选区提的"建议指令"：每次打开 Popover 都重新拉一次
  // null = 还未发起 / 已关闭；"" = 加载中；非空 = 已就绪；undefined = 失败/不可用
  const [suggestion, setSuggestion] = useState<string | undefined | null>(null);
  const suggestSeqRef = useRef(0); // 选区/Popover 切换时丢弃过期请求
  // 当前用户选区范围：用于 fake-selection 装饰；selectionUpdate 时同步更新
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null);
  // R-016：选区采集时存档的图片/视频节点；replace/append 阶段按占位符回填，避免丢图
  const mediaNodesRef = useRef<MediaNodeSnapshot[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 首次挂载时拉一次提示词；管理页增删后由用户重新选中触发刷新（下面 selectionUpdate 里刷）。
  // 不做全局事件订阅：管理页和编辑器通常不同时打开，多拉一次成本可以忽略。
  useEffect(() => {
    void reloadPrompts();
  }, []);

  // 动态测量 EditorToolbar 高度，写入 CSS 变量 --kb-toolbar-h 到 .tiptap-wrapper，
  // 让 .kb-ai-bar 的 sticky `top` 永远贴在 toolbar 正下方。
  // 处理两种动态高度场景：
  //   1) 窄屏 / 按钮多 → toolbar flex-wrap 换行，高度从 40 变 70+
  //   2) 用户切换视图导致 toolbar 渲染内容变化
  useEffect(() => {
    if (!menuRef.current) return;
    const wrapper = menuRef.current.closest(".tiptap-wrapper") as HTMLElement | null;
    if (!wrapper) return;
    const toolbar = wrapper.querySelector(".tiptap-toolbar") as HTMLElement | null;
    if (!toolbar) return;

    const sync = () => {
      // offsetHeight 含 padding+border，正好是 sticky 需要避让的高度
      wrapper.style.setProperty("--kb-toolbar-h", `${toolbar.offsetHeight}px`);
    };
    sync(); // 初始同步一次

    const ro = new ResizeObserver(sync);
    ro.observe(toolbar);
    return () => ro.disconnect();
  }, []);

  async function reloadPrompts() {
    try {
      const list = await promptApi.list(true);
      setPrompts(list);
    } catch (e) {
      console.error("加载提示词失败:", e);
    } finally {
      setPromptsLoaded(true);
    }
  }

  // 监听编辑器选区变化，显示/隐藏 AI bar
  // bar 本身是钉在 EditorToolbar 正下方的 sticky 横条（CSS 控制 max-height + opacity 过渡），
  // 这里只切换 visible 标志位，不再做任何坐标计算——位置完全静态，跟豆包/划词翻译这类
  // 系统级浮窗物理错开（它们贴选区，咱钉顶部，z-index 也争不过它们，只能位置避开）。
  //
  // ⚠️ 鼠标拖选期间不展开 bar（Notion / Google Docs 一致行为）：
  // bar 是 sticky + 占 40px 布局空间，拖选过程中突然展开会把光标下方的目标行往下挤，
  // 用户原本指向的字被挤走，选不准。改为：mousedown 期间忽略 selectionUpdate，
  // mouseup 后再统一判断一次。键盘 shift+方向键选择不走这条路径（无 mousedown），
  // 保持原来的"边选边显示"行为，没有挤压问题。
  useEffect(() => {
    let isDragging = false;

    function evaluateSelection() {
      const { from, to } = editor.state.selection;
      if (from === to) {
        // 无选区 & 不在流式中 → 折叠
        if (!streaming) {
          setVisible(false);
          setResult("");
          setTriggerPos(null);
        }
        return;
      }

      const text = editor.state.doc.textBetween(from, to, " ");
      if (text.trim().length < 2) return;

      setSelectedText(text);
      selectionRangeRef.current = { from, to };
      // 选区结束位置的视口坐标 → 把 ✨ 按钮贴在选区右下方 4px 处
      // coordsAtPos 返回的就是视口坐标（getBoundingClientRect 体系），fixed 定位直接可用
      try {
        const coords = editor.view.coordsAtPos(to);
        setTriggerPos({ x: coords.left, y: coords.bottom + 4 });
      } catch {
        setTriggerPos(null);
      }

      if (!streaming) {
        setResult("");
        setActivePrompt(null);
        setVisible(true);
      }
    }

    function handleSelectionUpdate() {
      if (isDragging) return; // 拖选过程中不动，避免布局抖动
      evaluateSelection();
    }

    const dom = editor.view.dom;
    function handleMouseDown() {
      isDragging = true;
    }
    // 用 document 监听 mouseup：用户可能拖出编辑器才松开
    function handleMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      evaluateSelection();
    }

    // 编辑器滚动 / 窗口 resize 时重新算一遍 trigger 坐标
    // 用 ProseMirror dom 找最近的可滚动祖先；fallback 用 window
    function reposition() {
      if (!selectionRangeRef.current) return;
      try {
        const coords = editor.view.coordsAtPos(selectionRangeRef.current.to);
        setTriggerPos({ x: coords.left, y: coords.bottom + 4 });
      } catch {
        /* ignore */
      }
    }

    editor.on("selectionUpdate", handleSelectionUpdate);
    dom.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    // capture=true：捕获阶段，能监听任何祖先元素的 scroll（编辑器外层容器多半在滚）
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
      dom.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [editor, streaming]);

  // 点击外部关闭（流式中 / 自定义弹窗打开时不响应，避免误关）
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (streaming || customOpen) return;
      const target = e.target as HTMLElement | null;
      // antd Popover/Dropdown/message 走 Portal 渲染在 body 下，命中这些容器时不关菜单
      if (
        target &&
        target.closest(
          ".ant-popover, .ant-popover-inner, .ant-popover-content, .ant-dropdown, .ant-message",
        )
      ) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVisible(false);
        setResult("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [streaming, customOpen]);

  // 注册 / 注销伪选区 Plugin（生命周期跟随组件 mount）
  useEffect(() => {
    const plugin = createFakeSelectionPlugin();
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(FAKE_SELECTION_KEY);
    };
  }, [editor]);

  // 编辑器失焦的场景下（Popover 打开 / 流式中 / 结果区可见）维持伪选区高亮，
  // 让用户视觉上仍能看到 "AI 在处理哪段文字"
  useEffect(() => {
    const shouldShow = customOpen || streaming || !!result;
    const range = selectionRangeRef.current;
    if (shouldShow && range && range.from !== range.to) {
      editor.view.dispatch(
        editor.state.tr.setMeta(FAKE_SELECTION_KEY, {
          from: range.from,
          to: range.to,
        }),
      );
    } else {
      editor.view.dispatch(
        editor.state.tr.setMeta(FAKE_SELECTION_KEY, "clear"),
      );
    }
  }, [customOpen, streaming, result, editor]);

  // Popover 打开时根据选区 + 上下文拉一条 AI 建议指令；关闭时清空
  // 失败（未配置模型 / 离线 / 限流等）静默：suggestion=undefined → UI 不渲染建议区
  useEffect(() => {
    if (!customOpen) {
      setSuggestion(null);
      return;
    }
    if (!selectedText.trim()) return;
    const seq = ++suggestSeqRef.current;
    setSuggestion(""); // 加载态

    const { from, to } = editor.state.selection;
    const fullText = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      " ",
    );
    const ctxBefore = fullText.slice(Math.max(0, from - 200), from);
    const ctxAfter = fullText.slice(to, Math.min(fullText.length, to + 200));
    const ctx = ctxBefore + ctxAfter;

    aiWriteApi
      .suggestPrompt(selectedText, ctx)
      .then((s) => {
        if (suggestSeqRef.current !== seq) return; // 已切换
        setSuggestion(s && s.trim() ? s.trim() : undefined);
      })
      .catch(() => {
        if (suggestSeqRef.current !== seq) return;
        setSuggestion(undefined);
      });
  }, [customOpen, selectedText, editor]);

  const cleanup = useCallback(async () => {
    for (const fn of unlistenRefs.current) {
      fn();
    }
    unlistenRefs.current = [];
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  /**
   * 通用：发起一次 AI 写作辅助流式请求。
   * `action` 直接交给后端：`prompt:{id}` / `custom:{指令}` / 内置 builtin_code。
   * `display` 用作结果标题栏显示（自定义路径不在 DB，没有 PromptTemplate 可用）。
   */
  async function runAssist(
    action: string,
    display: PromptTemplate,
  ): Promise<void> {
    if (streaming) return;

    setStreaming(true);
    setResult("");
    setActivePrompt(display);
    await cleanup();

    // R-016：用 extractSelectionWithMedia 替代 textBetween，把图片节点变成 [IMG_N] 占位符。
    // selectedText state 此时仍是 selectionUpdate 里算的纯文本（用于显示长度判定/Popover 上下文），
    // 这里要重新提取一份"含占位符"的 payload 喂给 AI，并把节点存档供 applyResult 回填。
    const { from, to } = editor.state.selection;
    const payload = extractSelectionWithMedia(editor, from, to);
    mediaNodesRef.current = payload.mediaNodes;
    const promptSelectedText = payload.text;

    // 上下文继续用 textBetween 即可（300 字符上下文里出现媒体节点的概率很低，
    // 且 AI 看到上下文中有 [IMG_N] 反而可能误以为要回写图片，得不偿失）
    const fullText = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      " ",
    );
    const contextBefore = fullText.slice(Math.max(0, from - 300), from);
    const contextAfter = fullText.slice(to, Math.min(fullText.length, to + 300));
    const context = contextBefore + contextAfter;

    const tokenUnlisten = await listen<string>("ai-write:token", (event) => {
      setResult((prev) => prev + event.payload);
    });
    const doneUnlisten = await listen("ai-write:done", async () => {
      setStreaming(false);
      await cleanup();
    });
    const errorUnlisten = await listen<string>("ai-write:error", async (event) => {
      setStreaming(false);
      setResult(`错误: ${event.payload}`);
      await cleanup();
    });

    unlistenRefs.current = [tokenUnlisten, doneUnlisten, errorUnlisten];

    try {
      await aiWriteApi.assist(action, promptSelectedText, context);
    } catch (e) {
      setStreaming(false);
      setResult(`错误: ${e}`);
      await cleanup();
    }
  }

  function handlePrompt(prompt: PromptTemplate) {
    void runAssist(`prompt:${prompt.id}`, prompt);
  }

  async function handleCustomSubmit() {
    const instruction = customInstruction.trim();
    if (!instruction) {
      message.warning("请输入提示词");
      return;
    }
    // 伪 PromptTemplate：仅供结果标题栏显示和 applyResult 默认 mode 用
    const ephemeral: PromptTemplate = {
      id: -1,
      title: "自定义",
      description: instruction,
      prompt: instruction,
      outputMode: "replace",
      icon: "PenLine",
      isBuiltin: false,
      builtinCode: null,
      sortOrder: 0,
      enabled: true,
      createdAt: "",
      updatedAt: "",
    };
    setCustomOpen(false);
    setCustomInstruction("");
    await runAssist(`custom:${instruction}`, ephemeral);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      message.success("已复制");
    } catch {
      message.error("复制失败");
    }
  }

  async function handleCancel() {
    try {
      await aiWriteApi.cancel();
    } catch {
      // ignore
    }
    setStreaming(false);
    await cleanup();
  }

  /**
   * 应用结果：按 Prompt 的 output_mode 选择插入策略
   * - append：在选区末尾追加（续写）
   * - popup：只展示不插入；用户确实想插入会手动选"替换"/"追加"
   * - replace（默认）：删选区再插入
   *
   * R-016：选区里如果有 image/video 节点，runAssist 已把它们存档到 mediaNodesRef 并
   * 在喂给 AI 的文本中标记 [IMG_N] 占位符。这里按占位符切分 result，分段交替插入
   * text 和 nodeJSON，保证图片不丢。
   */
  function applyResult(mode: PromptOutputMode) {
    if (!result) return;
    const { from, to } = editor.state.selection;
    const mediaNodes = mediaNodesRef.current;

    // 无媒体节点：走旧的快速路径，避免无谓的解析开销
    if (mediaNodes.length === 0) {
      if (mode === "append") {
        editor.chain().focus().insertContentAt(to, result).run();
      } else {
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContentAt(from, result)
          .run();
      }
    } else {
      const { segments, usedIndices } = parseResultWithPlaceholders(
        result,
        mediaNodes,
      );
      // 兜底：AI 完全或部分丢弃了占位符，把没用上的图片追加到结果末尾
      const orphanNodes = mediaNodes.filter((m) => !usedIndices.has(m.index));

      // ProseMirror chain 要按"先删再插"的顺序；插入位置随 chain 自动右移，
      // 这里收集成 contentArray 一次性 insertContent，让 PM 内部计算位置
      const contentArray: unknown[] = [];
      for (const seg of segments) {
        if (seg.type === "text") {
          if (seg.value) contentArray.push(seg.value);
        } else {
          contentArray.push(seg.nodeJSON);
        }
      }
      for (const orphan of orphanNodes) {
        // 孤儿节点前补换行，避免和上一段文字粘在一起
        contentArray.push("\n");
        contentArray.push(orphan.nodeJSON);
      }

      if (mode === "append") {
        editor
          .chain()
          .focus()
          .insertContentAt(to, contentArray as never)
          .run();
      } else {
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContentAt(from, contentArray as never)
          .run();
      }
    }

    mediaNodesRef.current = [];
    setVisible(false);
    setResult("");
    setActivePrompt(null);
  }

  function handleDiscard() {
    mediaNodesRef.current = [];
    setResult("");
    setVisible(false);
    setActivePrompt(null);
  }

  if (!aiEnabled) return null;

  const defaultMode: PromptOutputMode = activePrompt?.outputMode ?? "replace";

  // ===== AI 工具栏内容（一行，按钮太多时横向滚动，不换行）=====
  const promptsContent = (
    <div
      className="kb-ai-floating-toolbar"
      style={{
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {/* leading：问 AI 这段（蓝色 CTA） */}
      {onAskAi && (
        <>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap"
            style={{
              background: token.colorPrimary,
              color: "#fff",
              border: "none",
              cursor: "pointer",
            }}
            onMouseDown={(e) => {
              // mousedown 先于 blur，避免点击瞬间选区丢失
              e.preventDefault();
              onAskAi(selectedText);
            }}
          >
            🤖 问AI
          </button>
          <span
            style={{
              width: 1,
              height: 18,
              background: token.colorBorderSecondary,
              margin: "0 4px",
            }}
          />
        </>
      )}
      {!onAskAi && (
        <Sparkles
          size={13}
          style={{ color: token.colorPrimary, marginRight: 4 }}
        />
      )}
      {prompts.length === 0 && promptsLoaded && (
        <span
          style={{
            color: token.colorTextTertiary,
            fontSize: 12,
            padding: "2px 6px",
          }}
        >
          无可用提示词，去"提示词"页添加
        </span>
      )}
      {prompts.map((p) => (
        <Tooltip
          key={p.id}
          title={p.description || p.title}
          mouseEnterDelay={0.3}
        >
          <button
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-black/5 transition-colors whitespace-nowrap"
            style={{ color: token.colorText }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handlePrompt(p)}
          >
            {renderIcon(p.icon, 13)}
            {p.title}
          </button>
        </Tooltip>
      ))}
      {/* 自定义提示词：嵌套 Popover 输入即兴指令 */}
      <Popover
        open={customOpen}
        onOpenChange={(o) => {
          setCustomOpen(o);
          if (!o) setCustomInstruction("");
        }}
        trigger="click"
        placement="bottomLeft"
        destroyTooltipOnHide
        content={
          <div style={{ width: 320 }}>
            <Input.TextArea
              autoFocus
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder="例如：翻译为日文，并解释每个词的含义"
              autoSize={{ minRows: 2, maxRows: 6 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleCustomSubmit();
                }
              }}
            />
            {suggestion === "" && (
              <div
                className="flex items-center gap-1.5 mt-2 text-xs"
                style={{ color: token.colorTextTertiary }}
              >
                <Loader2 size={11} className="animate-spin" />
                AI 正在为这段文本想建议…
              </div>
            )}
            {typeof suggestion === "string" && suggestion.length > 0 && (
              <Tooltip title="点击填入输入框" mouseEnterDelay={0.3}>
                <button
                  type="button"
                  className="flex items-start gap-1.5 mt-2 px-2 py-1.5 rounded text-xs text-left w-full transition-colors"
                  style={{
                    background: token.colorFillQuaternary,
                    border: `1px dashed ${token.colorBorderSecondary}`,
                    color: token.colorText,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      token.colorPrimaryBg;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      token.colorFillQuaternary;
                  }}
                  onClick={() => setCustomInstruction(suggestion)}
                >
                  <Sparkles
                    size={12}
                    style={{
                      color: token.colorPrimary,
                      marginTop: 2,
                      flexShrink: 0,
                    }}
                  />
                  <span className="flex-1">{suggestion}</span>
                </button>
              </Tooltip>
            )}
            <div className="flex items-center justify-between mt-2">
              <span
                className="text-xs"
                style={{ color: token.colorTextTertiary }}
              >
                Enter 发送 / Shift+Enter 换行
              </span>
              <Button
                type="primary"
                size="small"
                onClick={handleCustomSubmit}
              >
                发送
              </Button>
            </div>
          </div>
        }
      >
        <Tooltip title="输入自定义指令" mouseEnterDelay={0.3}>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-black/5 transition-colors whitespace-nowrap"
            style={{
              color: customOpen ? token.colorPrimary : token.colorText,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <PenLine size={13} />
            自定义
          </button>
        </Tooltip>
      </Popover>
    </div>
  );

  return (
    <>
      {/* AI 工具栏：直接浮在选区右下方一整条（fixed 定位 + selectionRange 坐标）。
          不再走"先点 ✨ → 再展开菜单"的两段交互——选段立刻看到所有提示词，
          按钮太多时容器内部横向滚动，永远一行不换行。
          原 sticky 横条钉工具栏下方视线要回顶部找按钮，体验差，改为跟随选区。
          系统级划词浮窗（豆包等）通常出在选区上方，本工具栏在选区下方物理错开。*/}
      {visible && !streaming && !result && triggerPos && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            left: triggerPos.x,
            top: triggerPos.y,
            zIndex: 999,
            maxWidth: "min(720px, calc(100vw - 24px))",
          }}
          // 阻止 mousedown 冒泡到 document → 避免编辑器选区被清掉
          onMouseDown={(e) => e.preventDefault()}
        >
          {promptsContent}
        </div>
      )}

      {/* 结果面板：保留原 sticky bar 位置（钉在 EditorToolbar 正下方）。
          理由：流式输出 + 替换/追加按钮需要稳定的容器，跟选区漂移反而难点；
          也不会和系统级浮窗冲突。 */}
      {(streaming || result) && (
        <div
          ref={menuRef}
          className="kb-ai-bar"
          data-visible="true"
          data-mode="result"
        >
          <div
            className="kb-ai-bar-result-overlay"
            style={{
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {/* 结果标题栏 */}
            <div
              className="flex items-center justify-between px-3 py-1.5 text-xs"
              style={{
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
              }}
            >
              <span className="flex items-center gap-1.5">
                <Sparkles size={12} style={{ color: token.colorPrimary }} />
                {activePrompt ? activePrompt.title : "AI 写作辅助"}
                {streaming && (
                  <Loader2
                    size={12}
                    className="animate-spin"
                    style={{ color: token.colorPrimary }}
                  />
                )}
              </span>
              {streaming && (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopCircle size={12} />}
                  onClick={handleCancel}
                  style={{ height: 20, padding: "0 4px", fontSize: 11 }}
                >
                  停止
                </Button>
              )}
            </div>

            {/* 结果内容 */}
            <div
              className="px-3 py-2 text-sm whitespace-pre-wrap max-h-60 overflow-auto"
              style={{ color: token.colorText }}
            >
              {result}
              {streaming && !result && (
                <span style={{ color: token.colorTextQuaternary }}>
                  生成中...
                </span>
              )}
              {streaming && result && (
                <span
                  className="inline-block w-1.5 h-3.5 ml-0.5 animate-pulse"
                  style={{ background: token.colorPrimary }}
                />
              )}
            </div>

            {/* 操作按钮 */}
            {!streaming && result && (
              <div
                className="flex items-center justify-end gap-2 px-3 py-1.5"
                style={{
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Tooltip title="复制到剪贴板">
                  <Button
                    size="small"
                    icon={<Copy size={12} />}
                    onClick={handleCopy}
                  >
                    复制
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  icon={<X size={12} />}
                  onClick={handleDiscard}
                >
                  丢弃
                </Button>
                <Button
                  type={defaultMode === "append" ? "primary" : "default"}
                  size="small"
                  onClick={() => applyResult("append")}
                >
                  追加
                </Button>
                <Button
                  type={defaultMode === "append" ? "default" : "primary"}
                  size="small"
                  icon={<Check size={12} />}
                  onClick={() => applyResult("replace")}
                >
                  替换
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
