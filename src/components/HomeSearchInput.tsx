import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Input, Spin, theme as antdTheme } from "antd";
import {
  Search,
  NotebookText,
  CheckSquare,
  AlertTriangle,
  Check,
  CornerDownLeft,
} from "lucide-react";
import { useSearchSuggestions } from "@/hooks/useSearchSuggestions";
import { highlightText, highlightSnippet } from "@/lib/highlight";
import { MicButton } from "@/components/MicButton";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 回车行为：通常跳到 /search?q= 看完整结果 */
  onPressEnter: () => void;
  placeholder?: string;
}

/**
 * 首页搜索输入框 + 内联建议下拉
 *
 * 行为约定：
 * - 输入即触发建议（200ms 防抖，并发拉笔记 + 待办）
 * - 点击建议项 → 直接跳详情（笔记 → /notes/N；待办 → /tasks?taskId=N）
 * - 回车 → 调用 onPressEnter（通常跳 /search?q= 看完整结果，与下拉互不冲突）
 * - Esc / 点外部 / 选中项后 → 关闭下拉
 *
 * 不接管键盘 ↑↓ 选择：避免和 onPressEnter "回车去搜索页"语义冲突。
 * 用户要直跳详情就鼠标点；要看全量回结果回车——分工清晰。
 */
export function HomeSearchInput({
  value,
  onChange,
  onPressEnter,
  placeholder,
}: Props) {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();

  const wrapRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const { notes, tasks, loading } = useSearchSuggestions(
    focused ? value : "",
    { taskLimit: 5 },
  );

  const trimmed = value.trim();
  const dropdownOpen = focused && trimmed.length > 0;
  const hasAny = notes.length > 0 || tasks.length > 0;

  // 点击外部关闭
  useEffect(() => {
    if (!dropdownOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [dropdownOpen]);

  function selectNote(id: number) {
    setFocused(false);
    navigate(`/notes/${id}`);
  }

  function selectTask(id: number) {
    setFocused(false);
    navigate(`/tasks?taskId=${id}`);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setFocused(false);
      (e.target as HTMLInputElement).blur();
    }
  }

  // 显示前 5 条笔记预览（再多就让用户回车去 /search 看全量）
  const notesPreview = notes.slice(0, 5);

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1 }}>
      <Input
        size="large"
        placeholder={placeholder ?? "搜索笔记 / 待办…   (Ctrl+K 快速跳转)"}
        prefix={<Search size={16} style={{ color: token.colorTextQuaternary }} />}
        suffix={
          <MicButton
            size="small"
            stripTrailingPunctuation
            onTranscribed={(text) =>
              onChange(value ? `${value} ${text}` : text)
            }
          />
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPressEnter={() => {
          setFocused(false);
          onPressEnter();
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={handleKeyDown}
        allowClear
        style={{ borderRadius: 8 }}
      />

      {dropdownOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 1000,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 10,
            boxShadow: token.boxShadowSecondary,
            maxHeight: 420,
            overflowY: "auto",
            padding: "4px 6px",
          }}
        >
          {loading && (
            <div className="flex justify-center py-3">
              <Spin size="small" />
            </div>
          )}

          {!loading && !hasAny && (
            <div
              className="px-3 py-3 text-xs"
              style={{ color: token.colorTextTertiary }}
            >
              没有匹配的笔记或待办，按 <kbd>Enter</kbd> 试试完整搜索
            </div>
          )}

          {!loading && tasks.length > 0 && (
            <>
              <GroupLabel token={token}>待办</GroupLabel>
              {tasks.map((t) => (
                <TaskRow
                  key={`task-${t.id}`}
                  task={t}
                  token={token}
                  keyword={trimmed}
                  onClick={() => selectTask(t.id)}
                />
              ))}
            </>
          )}

          {!loading && notesPreview.length > 0 && (
            <>
              <GroupLabel token={token}>笔记</GroupLabel>
              {notesPreview.map((n) => (
                <NoteRow
                  key={`note-${n.id}`}
                  note={n}
                  token={token}
                  keyword={trimmed}
                  onClick={() => selectNote(n.id)}
                />
              ))}
            </>
          )}

          {!loading && hasAny && (
            <div
              className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer rounded-md"
              style={{ color: token.colorTextSecondary }}
              onClick={() => {
                setFocused(false);
                onPressEnter();
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = token.colorBgTextHover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <CornerDownLeft size={12} />
              <span>
                按 Enter 查看全部 {notes.length + tasks.length} 条结果
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroupLabel({
  children,
  token,
}: {
  children: React.ReactNode;
  token: ReturnType<typeof antdTheme.useToken>["token"];
}) {
  return (
    <div
      className="px-2 py-1 text-xs font-medium"
      style={{ color: token.colorTextQuaternary }}
    >
      {children}
    </div>
  );
}

function NoteRow({
  note,
  token,
  keyword,
  onClick,
}: {
  note: { id: number; title: string; snippet: string; updated_at: string };
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="flex items-start gap-2 px-3 py-2 rounded-md cursor-pointer"
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = token.colorBgTextHover)
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
    >
      <NotebookText
        size={14}
        style={{ color: token.colorTextSecondary, marginTop: 2, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="truncate text-sm"
          style={{ color: token.colorText }}
        >
          {note.title ? highlightText(note.title, keyword) : "无标题"}
        </div>
        {note.snippet && (
          <div
            className="text-xs"
            style={{
              color: token.colorTextDescription,
              // 2 行截断让高亮大概率落在可见区域，避免单行 truncate 把关键字推到右边截掉
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word",
              lineHeight: "1.4",
            }}
          >
            {highlightSnippet(note.snippet, keyword)}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  token,
  keyword,
  onClick,
}: {
  task: {
    id: number;
    title: string;
    snippet: string;
    status: number;
    priority: number;
    dueDate: string | null;
  };
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  const done = task.status === 1;
  const urgent = task.priority === 0;
  const due = task.dueDate?.slice(0, 10) ?? null;
  return (
    <div
      onClick={onClick}
      className="flex items-start gap-2 px-3 py-2 rounded-md cursor-pointer"
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = token.colorBgTextHover)
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
    >
      {done ? (
        <Check size={14} style={{ color: token.colorSuccess, marginTop: 2, flexShrink: 0 }} />
      ) : urgent ? (
        <AlertTriangle
          size={14}
          style={{ color: token.colorError, marginTop: 2, flexShrink: 0 }}
        />
      ) : (
        <CheckSquare
          size={14}
          style={{ color: token.colorTextSecondary, marginTop: 2, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="truncate text-sm"
          style={{
            color: done ? token.colorTextTertiary : token.colorText,
            textDecoration: done ? "line-through" : undefined,
          }}
        >
          {task.title ? highlightText(task.title, keyword) : "无标题"}
        </div>
        {(due || task.snippet) && (
          <div
            className="truncate text-xs"
            style={{ color: token.colorTextDescription }}
          >
            {due && <span style={{ marginRight: 8 }}>📅 {due}</span>}
            {task.snippet}
          </div>
        )}
      </div>
    </div>
  );
}
