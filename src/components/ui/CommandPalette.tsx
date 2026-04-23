import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, Input, Empty, Spin, theme as antdTheme } from "antd";
import {
  Search,
  FileText,
  Home,
  Calendar,
  Tags,
  GitBranch,
  Bot,
  Settings,
  Info,
  Trash2,
  CornerDownLeft,
  Keyboard,
} from "lucide-react";
import { searchApi } from "@/lib/api";
import type { SearchResult } from "@/types";

/** 快速导航页面 */
const pages = [
  { path: "/", icon: <Home size={14} />, label: "首页" },
  { path: "/notes", icon: <FileText size={14} />, label: "笔记列表" },
  { path: "/search", icon: <Search size={14} />, label: "搜索" },
  { path: "/daily", icon: <Calendar size={14} />, label: "每日笔记" },
  { path: "/tags", icon: <Tags size={14} />, label: "标签" },
  { path: "/graph", icon: <GitBranch size={14} />, label: "知识图谱" },
  { path: "/ai", icon: <Bot size={14} />, label: "AI 助手" },
  { path: "/trash", icon: <Trash2 size={14} />, label: "回收站" },
  { path: "/settings", icon: <Settings size={14} />, label: "设置" },
  { path: "/about", icon: <Info size={14} />, label: "关于" },
  { path: "#shortcuts", icon: <Keyboard size={14} />, label: "快捷键 (F1)" },
];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts?: () => void;
}

export function CommandPalette({ open, onClose, onOpenShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 关闭时清空状态
  useEffect(() => {
    if (!open) {
      setKeyword("");
      setResults([]);
      setSelectedIndex(0);
    }
  }, [open]);

  // 搜索笔记（防抖）
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!keyword.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchApi.search(keyword.trim());
        setResults(res);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [keyword]);

  // 匹配的页面
  const kw = keyword.trim().toLowerCase();
  const filteredPages = kw
    ? pages.filter(
        (p) =>
          p.label.toLowerCase().includes(kw) ||
          p.path.toLowerCase().includes(kw),
      )
    : pages;

  // 总条目数
  const totalItems = filteredPages.length + results.length;

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % totalItems);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + totalItems) % totalItems);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex < filteredPages.length) {
          const page = filteredPages[selectedIndex];
          if (page.path === "#shortcuts") {
            onClose();
            onOpenShortcuts?.();
            return;
          }
          navigate(page.path);
        } else {
          const note = results[selectedIndex - filteredPages.length];
          if (note) navigate(`/notes/${note.id}`);
        }
        onClose();
      }
    },
    [totalItems, selectedIndex, filteredPages, results, navigate, onClose, onOpenShortcuts],
  );

  // 滚动到选中项
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function selectPage(path: string) {
    if (path === "#shortcuts") {
      onClose();
      onOpenShortcuts?.();
      return;
    }
    navigate(path);
    onClose();
  }

  function selectNote(id: number) {
    navigate(`/notes/${id}`);
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={520}
      styles={{
        body: { padding: 0 },
        wrapper: { borderRadius: 12, overflow: "hidden" },
      }}
      centered
      destroyOnClose
    >
      <div
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          padding: "8px 12px",
        }}
      >
        <Input
          prefix={<Search size={16} style={{ color: token.colorTextQuaternary }} />}
          placeholder="搜索笔记或跳转页面..."
          variant="borderless"
          size="large"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
      </div>

      <div
        ref={listRef}
        style={{
          maxHeight: 360,
          overflowY: "auto",
          padding: "4px 6px",
        }}
      >
        {/* 页面导航 */}
        {filteredPages.length > 0 && (
          <>
            <div
              className="px-2 py-1 text-xs font-medium"
              style={{ color: token.colorTextQuaternary }}
            >
              页面
            </div>
            {filteredPages.map((page, i) => (
              <div
                key={page.path}
                data-index={i}
                onClick={() => selectPage(page.path)}
                className="flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer"
                style={{
                  background:
                    selectedIndex === i ? token.colorBgTextHover : "transparent",
                  color: token.colorText,
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span style={{ color: token.colorTextSecondary }}>{page.icon}</span>
                <span className="flex-1">{page.label}</span>
                {selectedIndex === i && (
                  <CornerDownLeft size={12} style={{ color: token.colorTextQuaternary }} />
                )}
              </div>
            ))}
          </>
        )}

        {/* 笔记搜索结果 */}
        {loading && (
          <div className="flex justify-center py-4">
            <Spin size="small" />
          </div>
        )}

        {!loading && results.length > 0 && (
          <>
            <div
              className="px-2 py-1 mt-1 text-xs font-medium"
              style={{ color: token.colorTextQuaternary }}
            >
              笔记
            </div>
            {results.map((note, i) => {
              const idx = filteredPages.length + i;
              return (
                <div
                  key={note.id}
                  data-index={idx}
                  onClick={() => selectNote(note.id)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer"
                  style={{
                    background:
                      selectedIndex === idx
                        ? token.colorBgTextHover
                        : "transparent",
                    color: token.colorText,
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <FileText size={14} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm">{note.title || "无标题"}</div>
                    {note.snippet && (
                      <div
                        className="truncate text-xs"
                        style={{ color: token.colorTextDescription }}
                      >
                        {note.snippet}
                      </div>
                    )}
                  </div>
                  {selectedIndex === idx && (
                    <CornerDownLeft size={12} style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* 空状态 */}
        {!loading && keyword.trim() && results.length === 0 && filteredPages.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="未找到匹配结果"
            style={{ padding: "20px 0" }}
          />
        )}
      </div>

      {/* 底部提示 */}
      <div
        className="flex items-center gap-4 px-3 py-2 text-xs"
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorTextQuaternary,
        }}
      >
        <span>
          <kbd className="px-1 py-0.5 rounded" style={{ background: token.colorBgTextHover }}>
            ↑↓
          </kbd>{" "}
          导航
        </span>
        <span>
          <kbd className="px-1 py-0.5 rounded" style={{ background: token.colorBgTextHover }}>
            Enter
          </kbd>{" "}
          打开
        </span>
        <span>
          <kbd className="px-1 py-0.5 rounded" style={{ background: token.colorBgTextHover }}>
            Esc
          </kbd>{" "}
          关闭
        </span>
      </div>
    </Modal>
  );
}
