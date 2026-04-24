import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Input,
  Typography,
  Space,
  Divider,
  Badge,
  message,
  Spin,
} from "antd";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Save,
} from "lucide-react";
import { dailyApi, noteApi } from "@/lib/api";
import { TiptapEditor } from "@/components/editor";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useAppStore } from "@/store";
import type { Note } from "@/types";

const { Text } = Typography;

/** 格式化日期为中文显示 */
function formatDateCN(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 日期偏移 */
function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 获取今天日期字符串 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** HH:mm 格式化保存时间 */
function formatSavedAt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function DailyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // URL 是 date 的真相源；缺省时用今天，同时补写进 URL 让 SidePanel 高亮今天
  const urlDate = searchParams.get("date");
  const date = urlDate ?? todayStr();

  useEffect(() => {
    if (!urlDate) {
      navigate(`/daily?date=${todayStr()}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDate]);

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  const isToday = date === todayStr();

  // 让自动保存的 save 闭包能拿到最新 note / date
  const noteRef = useRef<Note | null>(note);
  noteRef.current = note;
  const dateRef = useRef(date);
  dateRef.current = date;

  const loadDaily = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const n = await dailyApi.get(d);
      if (n) {
        setNote(n);
        setTitle(n.title);
        setContent(n.content);
      } else {
        // 该日期还没有日记，仅设置默认标题，不创建数据库记录
        setNote(null);
        setTitle(`${d} 的日记`);
        setContent("");
      }
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDaily(date);
  }, [date, loadDaily]);

  /**
   * 自动保存：内容变化后 1.2s 防抖入库。
   *
   * 创建策略：
   *  - 还没 DB 记录 & 内容为空 → 什么都不做（避免空草稿污染数据库）
   *  - 还没 DB 记录 & 内容非空 → getOrCreate 建记录再 update
   *  - 已有记录 → 直接 update（包括删到空，允许保存）
   */
  const autoSave = useAutoSave({
    value: { title, content },
    enabled: !loading,
    save: async ({ title: t, content: c }) => {
      const d = dateRef.current;
      let current = noteRef.current;
      if (!current) {
        if (c.trim().length === 0) return;
        current = await dailyApi.getOrCreate(d);
        setNote(current);
        noteRef.current = current;
        // 新建了一条日记 → 通知 SidePanel 重拉本月日期列表
        useAppStore.getState().bumpNotesRefresh();
      }
      await noteApi.update(current.id, { title: t, content: c });
    },
  });

  // Ctrl/Cmd + S → 立即保存（跳过防抖）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        void autoSave.flush();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoSave]);

  // 切日期前先把当前日期未保存的内容落库，避免跨日期丢失
  async function goToDate(d: string) {
    await autoSave.flush();
    navigate(`/daily?date=${d}`);
  }

  function renderStatus() {
    switch (autoSave.status) {
      case "saving":
        return <Badge status="processing" text="保存中..." />;
      case "dirty":
        return <Badge status="warning" text="编辑中" />;
      case "saved":
        return (
          <Badge
            status="success"
            text={
              autoSave.lastSavedAt
                ? `已保存 ${formatSavedAt(autoSave.lastSavedAt)}`
                : "已保存"
            }
          />
        );
      case "error":
        return (
          <span
            className="cursor-pointer"
            style={{ color: "#ff4d4f", fontSize: 13 }}
            onClick={() => void autoSave.flush()}
            title={autoSave.error ?? ""}
          >
            ⚠ 保存失败，点击重试
          </span>
        );
      default:
        return null;
    }
  }

  return (
    <div className="editor-page">
      {/* 顶部工具栏 */}
      <div className="editor-topbar">
        <Space align="center">
          <Calendar size={18} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>每日笔记</span>
          <Divider
            type="vertical"
            style={{ height: 18, margin: "0 8px" }}
          />
          <Button
            size="small"
            icon={<ChevronLeft size={14} />}
            onClick={() => goToDate(offsetDate(date, -1))}
          />
          <Text strong>{formatDateCN(date)}</Text>
          <Button
            size="small"
            icon={<ChevronRight size={14} />}
            onClick={() => goToDate(offsetDate(date, 1))}
            disabled={isToday}
          />
          {!isToday && (
            <Button size="small" onClick={() => goToDate(todayStr())}>
              今天
            </Button>
          )}
          {renderStatus()}
        </Space>
        <Space align="center">
          <Button
            type="primary"
            icon={<Save size={16} />}
            onClick={() => void autoSave.flush()}
            loading={autoSave.status === "saving"}
            disabled={
              autoSave.status === "saved" || autoSave.status === "idle"
            }
          >
            保存
          </Button>
        </Space>
      </div>

      {/* 可滚动的编辑主体 */}
      <div className="editor-body">
        <div className="editor-content-area">
          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <Spin size="large" />
            </div>
          ) : (
            <>
              {/* 标题 */}
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="日记标题"
                variant="borderless"
                className="editor-title"
                // 和下面的 Tiptap 工具栏拉开距离，避免标题与 H1/H2/B 图标紧贴
                style={{ marginBottom: 12 }}
              />

              {/* 内容编辑区 */}
              <TiptapEditor
                content={content}
                onChange={setContent}
                placeholder="写点什么..."
                noteId={note?.id}
                // 拖/粘贴图片时若日记还没创建，按需建档再插入（无需用户手动"保存"）
                ensureNoteId={async () => {
                  if (noteRef.current) return noteRef.current.id;
                  const created = await dailyApi.getOrCreate(dateRef.current);
                  setNote(created);
                  noteRef.current = created;
                  useAppStore.getState().bumpNotesRefresh();
                  return created.id;
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
