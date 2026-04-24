import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Modal,
  Form,
  Input,
  message,
  theme as antdTheme,
} from "antd";
import { Plus, Tags as TagsIcon, Check } from "lucide-react";
import { tagApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { TagColorPicker } from "@/components/TagColorPicker";
import type { Tag } from "@/types";

/**
 * TagsPanel —— Activity Bar 模式下"标签"视图的主面板。
 *
 * 职责：
 *   · 顶部：视图标题 + 新建按钮
 *   · 搜索框：按名称筛选
 *   · 列表：每行 color + name + count，点击跳 /tags?tagId=...
 *
 * 选中态来源是 URL 的 tagId，不在组件内维护，保证主区（pages/tags）
 * 同源同步。
 */
export function TagsPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedId = (() => {
    const raw = searchParams.get("tagId");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const tagsRefreshTick = useAppStore((s) => s.tagsRefreshTick);
  const { token } = antdTheme.useToken();

  const [tags, setTags] = useState<Tag[]>([]);
  const [filter, setFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; color: string }>();

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagsRefreshTick]);

  async function load() {
    try {
      const list = await tagApi.list();
      setTags(list);
    } catch (e) {
      message.error(String(e));
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, filter]);

  function handleSelect(tag: Tag) {
    navigate(`/tags?tagId=${tag.id}`);
  }

  async function handleCreate(values: { name: string; color: string }) {
    try {
      await tagApi.create(values.name, values.color);
      message.success("已创建");
      setModalOpen(false);
      form.resetFields();
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
    >
      {/* 视图标题 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <TagsIcon size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          标签
        </span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
            marginLeft: 2,
          }}
        >
          · {tags.length}
        </span>
        <div style={{ flex: 1 }} />
        <Button
          type="text"
          size="small"
          icon={<Plus size={14} />}
          onClick={() => {
            form.resetFields();
            setModalOpen(true);
          }}
          style={{ width: 24, height: 24, padding: 0 }}
          title="新建标签"
        />
      </div>

      {/* 搜索框 */}
      <div style={{ padding: "8px 12px", flexShrink: 0 }}>
        <Input
          size="small"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选标签..."
          allowClear
        />
      </div>

      {/* 标签列表 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "2px 8px 8px" }}
      >
        {filtered.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            {tags.length === 0 ? (
              <>
                暂无标签
                <br />
                <span
                  className="cursor-pointer"
                  style={{ color: token.colorPrimary, fontSize: 11 }}
                  onClick={() => {
                    form.resetFields();
                    setModalOpen(true);
                  }}
                >
                  + 新建标签
                </span>
              </>
            ) : (
              "无匹配标签"
            )}
          </div>
        ) : (
          filtered.map((tag) => {
            const active = selectedId === tag.id;
            return (
              <div
                key={tag.id}
                onClick={() => handleSelect(tag)}
                className="cursor-pointer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: active
                    ? `${token.colorPrimary}14`
                    : "transparent",
                  color: active ? token.colorPrimary : token.colorText,
                  fontWeight: active ? 500 : undefined,
                  fontSize: 13,
                  transition: "background .15s",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: tag.color || token.colorTextQuaternary,
                    flexShrink: 0,
                    border: `1px solid ${token.colorBorderSecondary}`,
                  }}
                />
                <span className="truncate" style={{ flex: 1 }}>
                  {tag.name}
                </span>
                {active && <Check size={12} strokeWidth={3} />}
                <span
                  style={{
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    flexShrink: 0,
                  }}
                >
                  {tag.note_count}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* 新建标签弹窗 */}
      <Modal
        title="新建标签"
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
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
