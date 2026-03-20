import { useState, useEffect, useCallback } from "react";
import {
  Card,
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
      const n = await dailyApi.getOrCreate(d);
      setNote(n);
      setTitle(n.title);
      setContent(n.content);
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
    if (!note) return;
    setSaving(true);
    try {
      const input: NoteInput = { title, content };
      await noteApi.update(note.id, input);
      setDirty(false);
      message.success("保存成功");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  function goToDate(d: string) {
    if (dirty) {
      message.warning("当前内容未保存");
    }
    setDate(d);
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          <span className="flex items-center gap-2">
            <Calendar size={22} />
            每日笔记
          </span>
        </Title>
        {!isToday && (
          <Button type="primary" onClick={() => setDate(todayStr())}>
            今天
          </Button>
        )}
      </div>

      {/* 日期导航 */}
      <div className="flex items-center justify-center gap-4 mb-4">
        <Button
          icon={<ChevronLeft size={16} />}
          onClick={() => goToDate(offsetDate(date, -1))}
        />
        <Title level={4} style={{ margin: 0 }}>
          {formatDateCN(date)}
        </Title>
        <Button
          icon={<ChevronRight size={16} />}
          onClick={() => goToDate(offsetDate(date, 1))}
          disabled={isToday}
        />
      </div>

      {/* 编辑区 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" />
        </div>
      ) : (
        <Card className="mb-4">
          <Input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="日记标题"
            variant="borderless"
            style={{ fontSize: 20, fontWeight: 600, marginBottom: 12, padding: 0 }}
          />
          <TiptapEditor
            content={content}
            onChange={handleContentChange}
            placeholder="写点什么..."
          />
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
            <Space>
              {dirty ? (
                <Badge status="warning" text="未保存" />
              ) : (
                <Badge status="success" text="已保存" />
              )}
            </Space>
            <Button
              type="primary"
              icon={<Save size={16} />}
              onClick={handleSave}
              loading={saving}
              disabled={!dirty}
            >
              保存
            </Button>
          </div>
        </Card>
      )}

      {/* 最近日记 */}
      {recentDates.length > 0 && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <FileText size={16} />
              最近日记
            </span>
          }
          size="small"
        >
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
        </Card>
      )}
    </div>
  );
}
