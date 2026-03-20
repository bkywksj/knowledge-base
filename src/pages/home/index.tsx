import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
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
  LetterText,
  Bot,
  GitBranch,
} from "lucide-react";
import { noteApi, dailyApi, systemApi } from "@/lib/api";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Note, DashboardStats } from "@/types";

const { Text, Paragraph } = Typography;

export default function HomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [notesResult, dashStats] = await Promise.all([
        noteApi.list({ page: 1, page_size: 8 }),
        systemApi.getDashboardStats(),
      ]);
      setRecentNotes(notesResult.items.filter((n) => !n.is_pinned));
      setPinnedNotes(notesResult.items.filter((n) => n.is_pinned));
      setStats(dashStats);
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
        onClick: handleTodayNote,
      },
      {
        key: "words",
        title: "总字数",
        value: stats?.total_words ?? 0,
        icon: <LetterText size={16} style={{ color: token.colorTextSecondary }} />,
      },
    ],
    [stats, token, navigate, handleTodayNote],
  );

  const displayedRecent = useMemo(() => recentNotes.slice(0, 6), [recentNotes]);

  return (
    <div className="max-w-4xl mx-auto">
      {/* 快速搜索 */}
      <div className="mb-5">
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
      <Row gutter={[12, 12]} className="mb-5">
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
                valueStyle={{ fontSize: 20 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* 快捷操作 */}
      <Row gutter={12} className="mb-5">
        <Col span={8}>
          <Button
            type="default"
            icon={<PenLine size={15} />}
            onClick={() => navigate("/notes")}
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
          className="mb-4"
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
            <FileText size={14} />
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
            onAction={() => navigate("/notes")}
          />
        )}
      </Card>

      {/* 底部快捷入口 */}
      <Row gutter={12} className="mt-5 mb-4">
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
