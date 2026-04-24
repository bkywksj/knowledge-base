import { useState, useEffect, useCallback, useRef } from "react";
import {
  Button,
  Input,
  Typography,
  Space,
  List,
  Badge,
  message,
  Spin,
} from "antd";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Save,
  FileText,
} from "lucide-react";
import { dailyApi, noteApi } from "@/lib/api";
import { TiptapEditor } from "@/components/editor";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { Note } from "@/types";

const { Title, Text } = Typography;

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
  const [date, setDate] = useState(todayStr);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [recentDates, setRecentDates] = useState<string[]>([]);

  const isToday = date === todayStr();

  // 让自动保存的 save 闭包能拿到最新 note / date
  const noteRef = useRef<Note | null>(note);
  noteRef.current = note;
  const dateRef = useRef(date);
  dateRef.current = date;

  const loadRecentDates = useCallback(async () => {
    try {
      const now = new Date();
      const dates = await dailyApi.listDates(now.getFullYear(), now.getMonth() + 1);
      setRecentDates(dates);
    } catch (e) {
      console.error("加载日记日期失败:", e);
    }
  }, []);

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
    loadRecentDates();
  }, [date, loadDaily, loadRecentDates]);

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
        void loadRecentDates();
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
    setDate(d);
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
              />

              {/* 内容编辑区 */}
              <TiptapEditor
                content={content}
                onChange={setContent}
                placeholder="写点什么..."
              />

              {/* 最近日记 */}
              {recentDates.length > 0 && (
                <div
                  className="mt-8 pt-4"
                  style={{
                    borderTop:
                      "1px solid var(--ant-color-border-secondary, #f0f0f0)",
                  }}
                >
                  <Title level={5} style={{ margin: "0 0 8px" }}>
                    <span className="flex items-center gap-2">
                      <FileText size={16} />
                      最近日记
                    </span>
                  </Title>
                  <List
                    dataSource={recentDates
                      .filter((d) => d !== date)
                      .slice(0, 10)}
                    renderItem={(d) => (
                      <List.Item
                        className="cursor-pointer"
                        style={{ padding: "6px 0" }}
                        onClick={() => goToDate(d)}
                      >
                        <Text>{formatDateCN(d)}</Text>
                      </List.Item>
                    )}
                    locale={{ emptyText: "暂无其他日记" }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
