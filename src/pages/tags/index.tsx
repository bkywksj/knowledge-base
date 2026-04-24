import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  Tag as AntTag,
  Button,
  Space,
  Typography,
  Modal,
  Form,
  Input,
  Popconfirm,
  message,
} from "antd";
import { Plus, Tags, FileText, Edit3, Trash2, Check } from "lucide-react";
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

export default function TagsPage() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);
  const [notes, setNotes] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  });
  const [notesLoading, setNotesLoading] = useState(false);

  // 新建/重命名弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [form] = Form.useForm<{ name: string; color: string }>();

  // 虚拟滚动容器：某些热门标签可能关联几百条笔记，一次性渲染会让切换标签卡顿
  const notesScrollRef = useRef<HTMLDivElement | null>(null);
  const notesVirtualizer = useVirtualizer({
    count: notes.items.length,
    getScrollElement: () => notesScrollRef.current,
    estimateSize: () => NOTE_ROW_HEIGHT,
    overscan: 6,
  });

  useEffect(() => {
    loadTags();
  }, []);

  async function loadTags() {
    setLoading(true);
    try {
      const list = await tagApi.list();
      setTags(list);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectTag(tag: Tag) {
    setSelectedTag(tag);
    setNotesLoading(true);
    try {
      const result = await tagApi.listNotesByTag(tag.id, 1, 20);
      setNotes(result);
    } catch (e) {
      message.error(String(e));
    } finally {
      setNotesLoading(false);
    }
  }

  function openCreateModal() {
    setEditingTag(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openRenameModal(tag: Tag) {
    setEditingTag(tag);
    form.setFieldsValue({ name: tag.name, color: tag.color || "#1677ff" });
    setModalOpen(true);
  }

  async function handleSubmit(values: { name: string; color: string }) {
    try {
      if (editingTag) {
        // 名称变更才调 rename；颜色变更才调 setColor —— 避免空请求
        if (values.name !== editingTag.name) {
          await tagApi.rename(editingTag.id, values.name);
        }
        if ((values.color || null) !== (editingTag.color || null)) {
          await tagApi.setColor(editingTag.id, values.color || null);
        }
        // 若当前选中的就是被编辑的那个标签，同步更新 selectedTag
        // 否则顶部"标签「xxx」下的笔记"标题、rename/delete 按钮都还拿着旧对象
        if (selectedTag?.id === editingTag.id) {
          setSelectedTag({
            ...selectedTag,
            name: values.name,
            color: values.color || null,
          });
        }
        message.success("已更新");
      } else {
        await tagApi.create(values.name, values.color);
        message.success("创建成功");
      }
      setModalOpen(false);
      form.resetFields();
      await loadTags();
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleDelete(tag: Tag) {
    try {
      await tagApi.delete(tag.id);
      message.success("删除成功");
      if (selectedTag?.id === tag.id) {
        setSelectedTag(null);
        setNotes({ items: [], total: 0, page: 1, page_size: 20 });
      }
      await loadTags();
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div className="max-w-4xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          <span className="flex items-center gap-2">
            <Tags size={22} />
            标签管理
          </span>
        </Title>
        <Button type="primary" icon={<Plus size={16} />} onClick={openCreateModal}>
          新建标签
        </Button>
      </div>

      {/* 标签云 */}
      <Card loading={loading}>
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const active = selectedTag?.id === tag.id;
              return (
                <AntTag
                  key={tag.id}
                  color={tag.color || undefined}
                  className="cursor-pointer"
                  style={{
                    padding: "4px 12px",
                    fontSize: 14,
                    // Material 3 / GitHub Labels 风格的选中态：保留本色 +
                    // ✓ 勾 + 字重加粗 + 轻微浮起。比外环 ring 更干净、语义更明确。
                    fontWeight: active ? 600 : undefined,
                    boxShadow: active
                      ? "0 3px 10px rgba(0,0,0,0.18)"
                      : undefined,
                    transform: active ? "translateY(-1px)" : undefined,
                    transition: "box-shadow .15s, transform .15s, font-weight .15s",
                  }}
                  onClick={() => handleSelectTag(tag)}
                >
                  {/* 内容包 inline-flex 容器：lucide Check 是 block SVG，
                      直接散着放进 AntTag 会占整行导致名称换行 */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {active && <Check size={12} strokeWidth={3.5} />}
                    <span>{tag.name}</span>
                    <Text
                      type="secondary"
                      style={{ fontSize: 12, marginLeft: 6 }}
                    >
                      {tag.note_count}
                    </Text>
                  </span>
                </AntTag>
              );
            })}
          </div>
        ) : (
          <EmptyState
            description="还没有标签"
            actionText="创建第一个标签"
            onAction={openCreateModal}
          />
        )}
      </Card>

      {/* 选中标签的操作和笔记列表 */}
      {selectedTag && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <FileText size={16} />
              标签「{selectedTag.name}」下的笔记
            </span>
          }
          extra={
            <Space>
              <Button
                size="small"
                icon={<Edit3 size={14} />}
                onClick={() => openRenameModal(selectedTag)}
              >
                重命名
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
            <div
              ref={notesScrollRef}
              style={{
                maxHeight: 480,
                overflowY: "auto",
                contain: "strict",
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
                            style={{ marginBottom: 0, fontSize: 12, marginTop: 2 }}
                          >
                            {stripHtml(note.content).slice(0, 100)}
                          </Paragraph>
                        ) : null}
                      </div>
                      <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
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

      {/* 新建/重命名标签弹窗 */}
      <Modal
        title={editingTag ? "重命名标签" : "新建标签"}
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
