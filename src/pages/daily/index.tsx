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
import type { Note, NoteInput } from "@/types";

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

export default function DailyPage() {
  const [date, setDate] = useState(todayStr);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recentDates, setRecentDates] = useState<string[]>([]);

  const isToday = date === todayStr();

  const loadDaily = useCallback(async (d: string) => {
    setLoading(true);
    setDirty(false);
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

  const loadRecentDates = useCallback(async () => {
    try {
      const now = new Date();
      const dates = await dailyApi.listDates(now.getFullYear(), now.getMonth() + 1);
      setRecentDates(dates);
    } catch (e) {
      console.error("加载日记日期失败:", e);
    }
  }, []);

  useEffect(() => {
    loadDaily(date);
    loadRecentDates();
  }, [date, loadDaily, loadRecentDates]);

  function handleTitleChange(value: string) {
    setTitle(value);
    setDirty(true);
  }

  function handleContentChange(value: string) {
    setContent(value);
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      let currentNote = note;
      // 如果还没有数据库记录，先创建
      if (!currentNote) {
        currentNote = await dailyApi.getOrCreate(date);
        setNote(currentNote);
      }
      const input: NoteInput = { title, content };
      await noteApi.update(currentNote.id, input);
      setDirty(false);
      message.success("保存成功");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S 保存：用 ref 引用最新 handleSave，避免 useEffect 重复订阅
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = handleSave;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function goToDate(d: string) {
    if (dirty) {
      message.warning("当前内容未保存");
    }
    setDate(d);
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
            <Button size="small" onClick={() => setDate(todayStr())}>
              今天
            </Button>
          )}
          {dirty ? (
            <Badge status="warning" text="未保存" />
          ) : (
            <Badge status="success" text="已保存" />
          )}
        </Space>
        <Space align="center">
          <Button
            type="primary"
            icon={<Save size={16} />}
            onClick={handleSave}
            loading={saving}
            disabled={!dirty && note !== null}
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
                onChange={(e) => handleTitleChange(e.target.value)}
                placeholder="日记标题"
                variant="borderless"
                className="editor-title"
              />

              {/* 内容编辑区 */}
              <TiptapEditor
                content={content}
                onChange={handleContentChange}
                placeholder="写点什么..."
              />

              {/* 最近日记 */}
              {recentDates.length > 0 && (
                <div className="mt-8 pt-4" style={{ borderTop: "1px solid var(--ant-color-border-secondary, #f0f0f0)" }}>
                  <Title level={5} style={{ margin: "0 0 8px" }}>
                    <span className="flex items-center gap-2">
                      <FileText size={16} />
                      最近日记
                    </span>
                  </Title>
                  <List
                    dataSource={recentDates.filter((d) => d !== date).slice(0, 10)}
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
