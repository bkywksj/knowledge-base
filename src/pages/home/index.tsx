import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/store";
import {
  Card,
  Input,
  Typography,
  Statistic,
  Row,
  Col,
  List,
  Button,
  Tag,
  theme as antdTheme,
} from "antd";
import {
  FileText,
  FolderOpen,
  Tags,
  Link2,
  Calendar,
  Search,
  ArrowRight,
  PenLine,
  Pin,
  Bot,
  GitBranch,
  History,
  CheckSquare,
} from "lucide-react";
import { Tooltip as AntTooltip } from "antd";
import { noteApi, dailyApi, systemApi, taskApi } from "@/lib/api";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Note, DashboardStats, DailyWritingStat, TaskStats } from "@/types";

const { Text, Paragraph } = Typography;

export default function HomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trend, setTrend] = useState<DailyWritingStat[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [notesResult, dashStats, trendData, taskStatsData] = await Promise.all([
        noteApi.list({ page: 1, page_size: 8 }),
        systemApi.getDashboardStats(),
        systemApi.getWritingTrend(14),
        taskApi.stats().catch(() => null),
      ]);
      setRecentNotes(notesResult.items.filter((n) => !n.is_pinned));
      setPinnedNotes(notesResult.items.filter((n) => n.is_pinned));
      setStats(dashStats);
      setTrend(trendData);
      setTaskStats(taskStatsData);
    } catch (e) {
      console.error("加载首页数据失败:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const handleSearch = useCallback(() => {
    if (searchKeyword.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchKeyword.trim())}`);
    }
  }, [searchKeyword, navigate]);

  const handleTodayNote = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const note = await dailyApi.getOrCreate(today);
      navigate(`/notes/${note.id}`);
    } catch (e) {
      console.error("创建今日笔记失败:", e);
    }
  }, [navigate]);

  // 统计卡片配置（缓存）
  const statCards = useMemo(
    () => [
      {
        key: "notes",
        title: "笔记",
        value: stats?.total_notes ?? 0,
        icon: <FileText size={16} style={{ color: token.colorPrimary }} />,
        onClick: () => navigate("/notes"),
      },
      {
        key: "folders",
        title: "文件夹",
        value: stats?.total_folders ?? 0,
        icon: <FolderOpen size={16} style={{ color: token.colorSuccess }} />,
      },
      {
        key: "tags",
        title: "标签",
        value: stats?.total_tags ?? 0,
        icon: <Tags size={16} style={{ color: token.colorWarning }} />,
        onClick: () => navigate("/tags"),
      },
      {
        key: "links",
        title: "链接",
        value: stats?.total_links ?? 0,
        icon: <Link2 size={16} style={{ color: token.colorInfo }} />,
        onClick: () => navigate("/graph"),
      },
      {
        key: "today",
        title: "今日更新",
        value: stats?.today_updated ?? 0,
        icon: <Calendar size={16} style={{ color: token.colorError }} />,
        // 今日更新 = 今天被编辑的笔记数，跳笔记列表（默认按 updated_at DESC）
        // 今日日记入口挪到下方"今日笔记"按钮
        onClick: () => navigate("/notes"),
      },
      {
        key: "tasks",
        title: "待办",
        value: taskStats?.totalTodo ?? 0,
        icon: <CheckSquare size={16} style={{ color: token.colorError }} />,
        onClick: () => navigate("/tasks"),
        suffix:
          (taskStats?.urgentTodo ?? 0) > 0 ? (
            <AntTooltip title={`紧急 ${taskStats?.urgentTodo} 条`}>
              <span
                className="inline-block ml-1 rounded-full text-[10px] leading-none"
                style={{
                  background: token.colorError,
                  color: "#fff",
                  padding: "2px 5px",
                }}
              >
                {taskStats?.urgentTodo}
              </span>
            </AntTooltip>
          ) : (taskStats?.overdue ?? 0) > 0 ? (
            <span
              className="inline-block ml-1 text-[10px]"
              style={{ color: token.colorError }}
            >
              逾期 {taskStats?.overdue}
            </span>
          ) : undefined,
      },
    ],
    [stats, taskStats, token, navigate, handleTodayNote],
  );

  const displayedRecent = useMemo(() => recentNotes.slice(0, 6), [recentNotes]);

  return (
    <div className="max-w-4xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 快速搜索 */}
      <div>
        <Input
          size="large"
          placeholder="搜索笔记..."
          prefix={<Search size={18} style={{ color: token.colorTextQuaternary }} />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          onPressEnter={handleSearch}
          allowClear
          style={{ borderRadius: 8 }}
        />
      </div>

      {/* 统计卡片 */}
      <Row gutter={[12, 12]}>
        {statCards.map((item) => (
          <Col key={item.key} span={4}>
            <Card
              size="small"
              hoverable
              onClick={item.onClick}
              styles={{ body: { padding: "12px" } }}
            >
              <Statistic
                title={<span className="text-xs">{item.title}</span>}
                value={item.value}
                prefix={item.icon}
                suffix={"suffix" in item ? item.suffix : undefined}
                valueStyle={{ fontSize: 20 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* 快捷操作 */}
      <Row gutter={12}>
        <Col span={8}>
          <Button
            type="primary"
            icon={<PenLine size={15} />}
            onClick={() => useAppStore.getState().openCreateModal()}
            block
            style={{ borderRadius: 8, height: 40 }}
          >
            新建笔记
          </Button>
        </Col>
        <Col span={8}>
          <Button
            type="default"
            icon={<Calendar size={15} />}
            onClick={handleTodayNote}
            block
            style={{ borderRadius: 8, height: 40 }}
          >
            今日笔记
          </Button>
        </Col>
        <Col span={8}>
          <Button
            type="default"
            icon={<Bot size={15} />}
            onClick={() => navigate("/ai")}
            block
            style={{ borderRadius: 8, height: 40 }}
          >
            AI 问答
          </Button>
        </Col>
      </Row>

      {/* 写作趋势 */}
      {trend.length > 0 && (
        <Card
          size="small"
          title={
            <span className="flex items-center gap-2 text-sm">
              <Calendar size={14} />
              近两周写作趋势
            </span>
          }
          styles={{ body: { padding: "12px 16px" } }}
        >
          {(() => {
            const maxWords = Math.max(...trend.map((d) => d.word_count), 1);
            return (
              <div className="flex items-end gap-1" style={{ height: 80 }}>
                {trend.map((day) => {
                  const h = Math.max((day.word_count / maxWords) * 64, 2);
                  const dateLabel = day.date.slice(5); // MM-DD
                  return (
                    <AntTooltip
                      key={day.date}
                      title={`${day.date}: ${day.note_count} 篇, ${day.word_count} 字`}
                    >
                      <div className="flex flex-col items-center flex-1 min-w-0">
                        <div
                          style={{
                            width: "100%",
                            maxWidth: 28,
                            height: h,
                            borderRadius: 3,
                            background: token.colorPrimary,
                            opacity: day.word_count > 0 ? 0.7 : 0.15,
                            transition: "height 0.3s",
                          }}
                        />
                        <span
                          className="mt-1 truncate"
                          style={{
                            fontSize: 9,
                            color: token.colorTextQuaternary,
                            maxWidth: "100%",
                          }}
                        >
                          {dateLabel}
                        </span>
                      </div>
                    </AntTooltip>
                  );
                })}
              </div>
            );
          })()}
        </Card>
      )}

      {/* 置顶笔记 */}
      {pinnedNotes.length > 0 && (
        <Card
          size="small"
          title={
            <span className="flex items-center gap-2 text-sm">
              <Pin size={14} />
              置顶笔记
            </span>
          }
          styles={{ body: { padding: "4px 12px" } }}
        >
          <List
            size="small"
            dataSource={pinnedNotes}
            renderItem={(note) => (
              <List.Item
                className="cursor-pointer"
                style={{ padding: "6px 0" }}
                onClick={() => navigate(`/notes/${note.id}`)}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Pin size={12} style={{ color: token.colorWarning, flexShrink: 0 }} />
                  <Text ellipsis style={{ maxWidth: 300, fontSize: 13 }}>
                    {note.title}
                  </Text>
                  {note.is_daily && (
                    <Tag
                      color="blue"
                      style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px" }}
                    >
                      日记
                    </Tag>
                  )}
                </div>
                <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {relativeTime(note.updated_at)}
                </Text>
              </List.Item>
            )}
          />
        </Card>
      )}

      {/* 最近编辑 */}
      <Card
        size="small"
        title={
          <span className="flex items-center gap-2 text-sm">
            <History size={14} />
            最近编辑
          </span>
        }
        extra={
          <Button
            type="link"
            size="small"
            onClick={() => navigate("/notes")}
            style={{ padding: 0, fontSize: 12 }}
          >
            全部 <ArrowRight size={12} />
          </Button>
        }
        loading={loading}
        styles={{ body: { padding: "4px 12px" } }}
      >
        {displayedRecent.length > 0 ? (
          <List
            size="small"
            dataSource={displayedRecent}
            renderItem={(note) => (
              <List.Item
                className="cursor-pointer"
                style={{ padding: "6px 0" }}
                onClick={() => navigate(`/notes/${note.id}`)}
              >
                <div className="flex-1 min-w-0 mr-3">
                  <Text ellipsis style={{ maxWidth: 400, fontSize: 13 }}>
                    {note.title}
                  </Text>
                  {note.content && (
                    <Paragraph
                      type="secondary"
                      ellipsis={{ rows: 1 }}
                      style={{ marginBottom: 0, fontSize: 11 }}
                    >
                      {stripHtml(note.content).slice(0, 80)}
                    </Paragraph>
                  )}
                </div>
                <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {relativeTime(note.updated_at)}
                </Text>
              </List.Item>
            )}
          />
        ) : (
          <EmptyState
            description="还没有笔记"
            actionText="创建第一篇笔记"
            onAction={() => useAppStore.getState().openCreateModal()}
          />
        )}
      </Card>

      {/* 底部快捷入口 */}
      <Row gutter={12}>
        <Col span={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate("/graph")}
            styles={{ body: { padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 } }}
          >
            <GitBranch size={15} style={{ color: token.colorPrimary, flexShrink: 0 }} />
            <Text style={{ fontSize: 13 }}>知识图谱</Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate("/search")}
            styles={{ body: { padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 } }}
          >
            <Search size={15} style={{ color: token.colorPrimary, flexShrink: 0 }} />
            <Text style={{ fontSize: 13 }}>全文搜索</Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate("/tags")}
            styles={{ body: { padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 } }}
          >
            <Tags size={15} style={{ color: token.colorPrimary, flexShrink: 0 }} />
            <Text style={{ fontSize: 13 }}>标签管理</Text>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
