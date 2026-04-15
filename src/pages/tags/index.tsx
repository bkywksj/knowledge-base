import { useState, useEffect } from "react";
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
  List,
  Popconfirm,
  message,
  theme as antdTheme,
} from "antd";
import { Plus, Tags, FileText, Edit3, Trash2, Check } from "lucide-react";
import { tagApi } from "@/lib/api";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Tag, Note, PageResult } from "@/types";

const { Title, Text, Paragraph } = Typography;

const TAG_COLORS = [
  "#1677ff", "#722ed1", "#eb2f96", "#f5222d", "#fa541c",
  "#fa8c16", "#faad14", "#a0d911", "#52c41a", "#13c2c2",
  "#2f54eb", "#531dab", "#c41d7f", "#cf1322", "#d4380d",
  "#d46b08", "#d48806", "#7cb305", "#389e0d", "#08979c",
];

function PresetColors({ value, onChange }: { value?: string; onChange?: (v: string) => void }) {
  const { token } = antdTheme.useToken();
  return (
    <div className="flex flex-wrap gap-2">
      {TAG_COLORS.map((c) => (
        <div
          key={c}
          className="flex items-center justify-center cursor-pointer rounded-md transition-all"
          style={{
            width: 28,
            height: 28,
            backgroundColor: c,
            border: value === c ? `2px solid ${token.colorText}` : "2px solid transparent",
            transform: value === c ? "scale(1.15)" : undefined,
          }}
          onClick={() => onChange?.(c)}
        >
          {value === c && <Check size={14} color="#fff" strokeWidth={3} />}
        </div>
      ))}
    </div>
  );
}

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
        await tagApi.rename(editingTag.id, values.name);
        message.success("重命名成功");
      } else {
        await tagApi.create(values.name, values.color);
        message.success("创建成功");
      }
      setModalOpen(false);
      form.resetFields();
      await loadTags();
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
            {tags.map((tag) => (
              <AntTag
                key={tag.id}
                color={
                  selectedTag?.id === tag.id
                    ? "processing"
                    : tag.color || undefined
                }
                className="cursor-pointer"
                style={{ padding: "4px 12px", fontSize: 14 }}
                onClick={() => handleSelectTag(tag)}
              >
                {tag.name}
                <Text
                  type="secondary"
                  style={{ fontSize: 12, marginLeft: 4 }}
                >
                  {tag.note_count}
                </Text>
              </AntTag>
            ))}
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
            <List
              dataSource={notes.items}
              renderItem={(note) => (
                <List.Item
                  className="cursor-pointer"
                  style={{ padding: "8px 0" }}
                  onClick={() => navigate(`/notes/${note.id}`)}
                  actions={[
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {relativeTime(note.updated_at)}
                    </Text>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Text ellipsis style={{ maxWidth: 400 }}>
                        {note.title}
                      </Text>
                    }
                    description={
                      note.content ? (
                        <Paragraph
                          type="secondary"
                          ellipsis={{ rows: 1 }}
                          style={{ marginBottom: 0, fontSize: 12 }}
                        >
                          {stripHtml(note.content).slice(0, 100)}
                        </Paragraph>
                      ) : null
                    }
                  />
                </List.Item>
              )}
            />
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
          {!editingTag && (
            <Form.Item name="color" label="颜色" initialValue="#1677ff">
              <PresetColors />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
