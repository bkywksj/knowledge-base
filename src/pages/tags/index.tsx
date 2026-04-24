import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Card,
  Button,
  Space,
  Typography,
  Modal,
  Form,
  Input,
  Popconfirm,
  message,
} from "antd";
import { Tags, FileText, Edit3, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tagApi } from "@/lib/api";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { TagColorPicker } from "@/components/TagColorPicker";
import { useAppStore } from "@/store";
import type { Tag, Note, PageResult } from "@/types";

/** 笔记列表单行高度估算（title + 一行 snippet） */
const NOTE_ROW_HEIGHT = 62;

const { Title, Text, Paragraph } = Typography;

/**
 * TagsPage —— Activity Bar 模式下"标签"视图的主区。
 *
 * 重构后只负责：展示 URL `?tagId=...` 选中标签下的笔记列表 + 重命名/删除。
 * 标签列表、筛选、新建已搬入 src/components/layout/panels/TagsPanel.tsx。
 */
export default function TagsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedId = (() => {
    const raw = searchParams.get("tagId");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const tagsRefreshTick = useAppStore((s) => s.tagsRefreshTick);

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [notes, setNotes] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  });
  const [notesLoading, setNotesLoading] = useState(false);

  // 重命名弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; color: string }>();

  // 虚拟滚动容器：某些热门标签可能关联几百条笔记
  const notesScrollRef = useRef<HTMLDivElement | null>(null);
  const notesVirtualizer = useVirtualizer({
    count: notes.items.length,
    getScrollElement: () => notesScrollRef.current,
    estimateSize: () => NOTE_ROW_HEIGHT,
    overscan: 6,
  });

  const selectedTag = useMemo(
    () => allTags.find((t) => t.id === selectedId) ?? null,
    [allTags, selectedId],
  );

  useEffect(() => {
    loadAllTags();
  }, [tagsRefreshTick]);

  useEffect(() => {
    if (selectedId == null) {
      setNotes({ items: [], total: 0, page: 1, page_size: 20 });
      return;
    }
    loadNotes(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tagsRefreshTick]);

  async function loadAllTags() {
    try {
      const list = await tagApi.list();
      setAllTags(list);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function loadNotes(tagId: number) {
    setNotesLoading(true);
    try {
      const result = await tagApi.listNotesByTag(tagId, 1, 20);
      setNotes(result);
    } catch (e) {
      message.error(String(e));
    } finally {
      setNotesLoading(false);
    }
  }

  function openEditModal(tag: Tag) {
    form.setFieldsValue({ name: tag.name, color: tag.color || "#1677ff" });
    setModalOpen(true);
  }

  async function handleSubmit(values: { name: string; color: string }) {
    if (!selectedTag) return;
    try {
      if (values.name !== selectedTag.name) {
        await tagApi.rename(selectedTag.id, values.name);
      }
      if ((values.color || null) !== (selectedTag.color || null)) {
        await tagApi.setColor(selectedTag.id, values.color || null);
      }
      message.success("已更新");
      setModalOpen(false);
      form.resetFields();
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleDelete(tag: Tag) {
    try {
      await tagApi.delete(tag.id);
      message.success("删除成功");
      useAppStore.getState().bumpTagsRefresh();
      // 删完回到空态
      navigate("/tags");
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div
      className="max-w-4xl mx-auto"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* 顶部标题 */}
      <div className="flex items-center justify-between">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          <span className="flex items-center gap-2">
            <Tags size={22} />
            {selectedTag ? `标签「${selectedTag.name}」` : "标签"}
          </span>
        </Title>
      </div>

      {/* 未选态 */}
      {!selectedTag && (
        <Card>
          <EmptyState
            description={
              allTags.length === 0
                ? "还没有任何标签。左侧面板点 + 新建一个。"
                : "在左侧选择一个标签，查看它关联的笔记"
            }
          />
        </Card>
      )}

      {/* 选中态：笔记列表 + 操作 */}
      {selectedTag && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <FileText size={16} />
              关联笔记
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                共 {notes.total} 条
              </Text>
            </span>
          }
          extra={
            <Space>
              <Button
                size="small"
                icon={<Edit3 size={14} />}
                onClick={() => openEditModal(selectedTag)}
              >
                编辑
              </Button>
              <Popconfirm
                title="确认删除此标签？"
                description="删除标签不会删除关联的笔记"
                onConfirm={() => handleDelete(selectedTag)}
              >
                <Button size="small" danger icon={<Trash2 size={14} />}>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          }
          loading={notesLoading}
        >
          {notes.items.length > 0 ? (
            // 虚拟滚动：只渲染可见行，热门标签（几百条笔记）切换也保持流畅
            // 注：用 contain:content 而不是 contain:strict — 后者含 size 规则
            // 会让仅设 maxHeight 的容器被计算为 0 高度导致一条不渲染
            <div
              ref={notesScrollRef}
              style={{
                maxHeight: 480,
                overflowY: "auto",
                contain: "content",
              }}
            >
              <div
                style={{
                  height: notesVirtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {notesVirtualizer.getVirtualItems().map((vItem) => {
                  const note = notes.items[vItem.index];
                  return (
                    <div
                      key={note.id}
                      data-index={vItem.index}
                      ref={notesVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vItem.start}px)`,
                        padding: "8px 0",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 12,
                        borderBottom: "1px solid rgba(0,0,0,0.06)",
                      }}
                      onClick={() => navigate(`/notes/${note.id}`)}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text ellipsis style={{ display: "block", maxWidth: 400 }}>
                          {note.title}
                        </Text>
                        {note.content ? (
                          <Paragraph
                            type="secondary"
                            ellipsis={{ rows: 1 }}
                            style={{
                              marginBottom: 0,
                              fontSize: 12,
                              marginTop: 2,
                            }}
                          >
                            {stripHtml(note.content).slice(0, 100)}
                          </Paragraph>
                        ) : null}
                      </div>
                      <Text
                        type="secondary"
                        style={{ fontSize: 12, flexShrink: 0 }}
                      >
                        {relativeTime(note.updated_at)}
                      </Text>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <EmptyState description="该标签下暂无笔记" />
          )}
        </Card>
      )}

      {/* 编辑标签（名称 + 颜色） */}
      <Modal
        title="编辑标签"
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="name"
            label="标签名称"
            rules={[{ required: true, message: "请输入标签名称" }]}
          >
            <Input placeholder="输入标签名称" />
          </Form.Item>
          <Form.Item name="color" label="颜色" initialValue="#1677ff">
            <TagColorPicker />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
