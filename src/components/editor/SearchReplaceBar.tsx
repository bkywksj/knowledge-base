/**
 * 编辑器查找/替换浮条 —— 浮在编辑器顶部右上角的搜索条。
 *
 * 行为：
 * - Ctrl+F：打开（仅查找模式，replace 行折叠）
 * - Ctrl+H：打开（含 replace 行）
 * - F3 / Enter：下一个；Shift+F3 / Shift+Enter：上一个
 * - Esc：关闭并清空高亮
 * - 切大小写 / 全词后即时重搜
 *
 * 用 Ant Design Input + Button 组合，TailwindCSS 浮动定位。
 */
import { useEffect, useRef, useState } from "react";
import { theme as antdTheme, Button, Input, Tooltip, message } from "antd";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Repeat2,
  WholeWord,
  X,
} from "lucide-react";
import type { Editor } from "@tiptap/react";
import { getSearchState, type SearchOptions, type TermStat } from "./SearchAndReplace";

interface Props {
  editor: Editor | null;
  /** 浮条是否展开 */
  open: boolean;
  /** 是否展开 replace 行（Ctrl+H 进入时为 true） */
  showReplace: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /**
   * 外部预填的查询词（如从搜索结果点进笔记时携带的关键词）。
   * 浮条打开时自动填入查询框并定位到首个命中；用户随后正常增删该词。
   */
  initialQuery?: string;
}

export function SearchReplaceBar({ editor, open, showReplace, onClose, initialQuery }: Props) {
  const { token } = antdTheme.useToken();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
  });
  const [stats, setStats] = useState<{
    total: number;
    current: number;
    perTerm: TermStat[];
  }>({ total: 0, current: -1, perTerm: [] });
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  // 上次已预填的 initialQuery：编辑器不随笔记 remount（路由无 key），用「上次词」
  // 而非布尔标记，才能在同一实例下「换个关键词再搜」时重新预填；用户手敲改词不受影响
  // （手敲只改本地 query，不动 initialQuery，effect 不重跑）。
  const lastSeededRef = useRef<string | undefined>(undefined);
  // 待定位标记：seed 后等命中算出（stats.total>0）再滚动到首个命中
  const [pendingJump, setPendingJump] = useState(false);

  // ─── 打开时聚焦查询输入框 ───────────────────
  useEffect(() => {
    if (open) {
      // 等下一帧 DOM mount 完成
      requestAnimationFrame(() => queryInputRef.current?.select());
    }
  }, [open]);

  // ─── 打开且带「新的」initialQuery：预填查询框并标记待定位 ───
  useEffect(() => {
    if (!open) {
      setPendingJump(false);
      return;
    }
    // 仅当 initialQuery 与上次预填的不同才重填：新关键词进来即更新，
    // 同一关键词反复打开（如 Esc 关掉再 Ctrl+F）不再强行覆盖用户当前查询。
    if (initialQuery && initialQuery !== lastSeededRef.current) {
      lastSeededRef.current = initialQuery;
      setQuery(initialQuery);
      setPendingJump(true);
    }
  }, [open, initialQuery]);

  // ─── 命中算出后定位到首个命中（仅 seed 触发，用户手敲不自动滚） ───
  useEffect(() => {
    if (!editor || !pendingJump) return;
    if (stats.total > 0) {
      editor.chain().scrollToCurrent().run();
      setPendingJump(false);
    }
  }, [editor, pendingJump, stats.total]);

  // ─── query / options 变化 → 触发搜索 ────────
  useEffect(() => {
    if (!editor || !open) return;
    editor.chain().setSearchTerm(query, options).run();
    // 同步状态显示
    const ps = getSearchState(editor.state);
    if (ps) setStats({ total: ps.total, current: ps.current, perTerm: ps.perTerm });
  }, [editor, open, query, options]);

  // ─── 监听 editor transactions：文档变更 / 跳转后更新 stats ───
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const ps = getSearchState(editor.state);
      if (ps) setStats({ total: ps.total, current: ps.current, perTerm: ps.perTerm });
    };
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  // ─── 关闭时清空高亮 ─────────────────────────
  useEffect(() => {
    if (!editor) return;
    if (!open) {
      editor.chain().clearSearch().run();
    }
  }, [editor, open]);

  if (!open) return null;

  const handleClose = () => {
    onClose();
  };

  const handleNext = () => {
    if (!editor) return;
    if (stats.total === 0) return;
    editor.chain().searchNext().run();
  };

  const handlePrev = () => {
    if (!editor) return;
    if (stats.total === 0) return;
    editor.chain().searchPrev().run();
  };

  const handleReplaceCurrent = () => {
    if (!editor || stats.total === 0) return;
    editor.chain().replaceCurrent(replacement).run();
  };

  const handleReplaceAll = () => {
    if (!editor || stats.total === 0) return;
    const replaced = stats.total;
    editor.chain().replaceAll(replacement).run();
    message.success(`已替换 ${replaced} 处`);
  };

  // 计数显示："3/15" 或 "无结果"
  const counterText =
    query === ""
      ? ""
      : stats.total === 0
        ? "无结果"
        : `${stats.current + 1}/${stats.total}`;

  return (
    // 外层 sticky 0 高度容器：吸附在滚动视口顶部、不占据文档流高度，
    // 让内部浮条始终停在编辑器可视区右上角，长文档往下滚也不会被顶走。
    // （工具栏用同样的 sticky top:0 吸顶方案，这里保持一致的交互。）
    <div
      className="sticky z-30 flex-shrink-0"
      style={{ top: 0, height: 0 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
    <div
      className="absolute flex flex-col gap-1.5 rounded-md p-2"
      style={{
        top: 8,
        right: 12,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        boxShadow: token.boxShadowSecondary,
        minWidth: 360,
      }}
    >
      {/* ─── 查找行 ─────────────────────────── */}
      <div className="flex items-center gap-1.5">
        <Input
          ref={queryInputRef as never}
          size="small"
          placeholder="查找"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) handlePrev();
              else handleNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              handleClose();
            }
          }}
          suffix={
            <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>
              {counterText}
            </span>
          }
          style={{ flex: 1 }}
        />
        <Tooltip title="区分大小写">
          <Button
            size="small"
            type={options.caseSensitive ? "primary" : "text"}
            icon={<CaseSensitive size={13} />}
            onClick={() =>
              setOptions((o) => ({ ...o, caseSensitive: !o.caseSensitive }))
            }
          />
        </Tooltip>
        <Tooltip title="全词匹配">
          <Button
            size="small"
            type={options.wholeWord ? "primary" : "text"}
            icon={<WholeWord size={13} />}
            onClick={() =>
              setOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))
            }
          />
        </Tooltip>
        <Tooltip title="上一个 (Shift+Enter)">
          <Button
            size="small"
            type="text"
            icon={<ChevronUp size={13} />}
            disabled={stats.total === 0}
            onClick={handlePrev}
          />
        </Tooltip>
        <Tooltip title="下一个 (Enter)">
          <Button
            size="small"
            type="text"
            icon={<ChevronDown size={13} />}
            disabled={stats.total === 0}
            onClick={handleNext}
          />
        </Tooltip>
        <Tooltip title="关闭 (Esc)">
          <Button
            size="small"
            type="text"
            icon={<X size={13} />}
            onClick={handleClose}
          />
        </Tooltip>
      </div>

      {/* ─── 多词分项行：仅当输入了 2+ 个 term 时显示 ─── */}
      {stats.perTerm.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1"
          style={{ fontSize: 11, color: token.colorTextTertiary }}
        >
          {stats.perTerm.map((t, i) => (
            <span
              key={`${t.term}-${i}`}
              className="kb-search-chip"
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background:
                  t.count > 0
                    ? `var(--kb-search-chip-bg-${i % 6})`
                    : token.colorFillTertiary,
                color: t.count > 0 ? token.colorText : token.colorTextDisabled,
                whiteSpace: "nowrap",
              }}
              title={`${t.term}: ${t.count} 处命中`}
            >
              {t.term} · {t.count}
            </span>
          ))}
        </div>
      )}

      {/* ─── 替换行（Ctrl+H 时显示） ────────── */}
      {showReplace && (
        <div className="flex items-center gap-1.5">
          <Input
            size="small"
            placeholder="替换为"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleReplaceCurrent();
              } else if (e.key === "Escape") {
                e.preventDefault();
                handleClose();
              }
            }}
            style={{ flex: 1 }}
          />
          <Tooltip title="替换当前">
            <Button
              size="small"
              type="text"
              icon={<Repeat2 size={13} />}
              disabled={stats.total === 0}
              onClick={handleReplaceCurrent}
            >
              替换
            </Button>
          </Tooltip>
          <Tooltip title="全部替换">
            <Button
              size="small"
              type="text"
              disabled={stats.total === 0}
              onClick={handleReplaceAll}
            >
              全部
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
    </div>
  );
}
