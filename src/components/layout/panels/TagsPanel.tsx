import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Modal,
  Form,
  Input,
  message,
  theme as antdTheme,
} from "antd";
import {
  Plus,
  Tags as TagsIcon,
  Check,
  Edit3,
  Trash2,
} from "lucide-react";
import { tagApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { TagColorPicker, TAG_COLORS } from "@/components/TagColorPicker";
import { MicButton } from "@/components/MicButton";
import type { Tag } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/**
 * TagsPanel —— Activity Bar 模式下"标签"视图的主面板。
 *
 * 交互：
 *   · 单击 标签条目 → 选中 + 跳 /tags?tagId=...
 *   · 双击 标签条目 → 进入 inline 重命名（Enter 提交 / Esc 取消）
 *   · 右键 标签条目 → 菜单（重命名 / 颜色色板 inline / 删除）
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

  // ─── Inline 重命名状态 ────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

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
    if (editingId === tag.id) return; // 编辑态不响应点击
    navigate(`/tags?tagId=${tag.id}`);
  }

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setEditingName(tag.name);
    // 等下一帧 input mount 后聚焦
    requestAnimationFrame(() => {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName("");
  }

  async function submitEdit() {
    if (editingId == null) return;
    const tag = tags.find((t) => t.id === editingId);
    if (!tag) {
      cancelEdit();
      return;
    }
    const name = editingName.trim();
    if (!name) {
      message.warning("标签名不能为空");
      // 不退出编辑态，让用户继续改
      return;
    }
    if (name === tag.name) {
      cancelEdit();
      return;
    }
    try {
      await tagApi.rename(tag.id, name);
      message.success("已重命名");
      cancelEdit();
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(`重命名失败：${e}`);
    }
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

  // ─── 右键菜单 ────────────────────────────────
  const ctx = useContextMenu<{ id: number; name: string; color: string | null }>();

  /** 改色（菜单内嵌色板的 swatch click 直接调） */
  async function setTagColor(id: number, color: string) {
    try {
      await tagApi.setColor(id, color);
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(`改色失败：${e}`);
    }
  }

  const tagMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "rename",
        label: "重命名",
        icon: <Edit3 size={13} />,
        onClick: () => {
          ctx.close();
          const tag = tags.find((t) => t.id === p.id);
          if (tag) startEdit(tag);
        },
      },
      { type: "divider" },
      {
        key: "color-grid",
        type: "custom",
        render: () => (
          <div
            style={{
              padding: "6px 10px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: token.colorTextTertiary,
                letterSpacing: 0.3,
              }}
            >
              颜色
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(10, 1fr)",
                gap: 4,
              }}
            >
              {TAG_COLORS.map((c) => {
                const isSelected = (p.color || "").toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void setTagColor(p.id, c);
                      ctx.close();
                    }}
                    style={{
                      width: 16,
                      height: 16,
                      padding: 0,
                      borderRadius: 4,
                      backgroundColor: c,
                      border: isSelected
                        ? `2px solid ${token.colorText}`
                        : `1px solid ${token.colorBorderSecondary}`,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transform: isSelected ? "scale(1.1)" : undefined,
                      transition: "transform 80ms",
                    }}
                    title={c}
                  >
                    {isSelected && <Check size={9} color="#fff" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>
        ),
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除标签",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          Modal.confirm({
            title: `删除标签「${p.name}」？`,
            content: "删除标签不会删除关联的笔记。",
            okText: "删除",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await tagApi.delete(p.id);
                message.success("已删除");
                useAppStore.getState().bumpTagsRefresh();
                if (selectedId === p.id) navigate("/tags");
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
  }, [ctx, tags, selectedId, navigate, token]);

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 顶层兜底吞 WebView 默认菜单。input/textarea 白名单，让搜索框右键
      // 仍可用浏览器原生剪切/复制/粘贴
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
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
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                setFilter((prev) => (prev ? `${prev} ${text}` : text))
              }
            />
          }
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
            const ctxActive = ctx.state.payload?.id === tag.id;
            const isEditing = editingId === tag.id;
            return (
              <div
                key={tag.id}
                onClick={() => handleSelect(tag)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEdit(tag);
                }}
                onContextMenu={(e) => {
                  if (isEditing) return; // 编辑态不弹菜单
                  e.preventDefault();
                  ctx.open(e.nativeEvent, {
                    id: tag.id,
                    name: tag.name,
                    color: tag.color,
                  });
                }}
                className={isEditing ? "" : "cursor-pointer"}
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
                  outline: ctxActive ? `1px solid ${token.colorPrimary}` : "none",
                  outlineOffset: -1,
                  transition: "background .15s, outline .1s",
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
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onBlur={() => {
                      // 失焦提交（与"Enter 提交"一致）；空值会保持编辑态
                      void submitEdit();
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: `1px solid ${token.colorPrimary}`,
                      borderRadius: 3,
                      padding: "1px 6px",
                      fontSize: 13,
                      lineHeight: "18px",
                      outline: "none",
                      background: token.colorBgContainer,
                      color: token.colorText,
                    }}
                    maxLength={32}
                  />
                ) : (
                  <span className="truncate" style={{ flex: 1 }}>
                    {tag.name}
                  </span>
                )}
                {!isEditing && active && <Check size={12} strokeWidth={3} />}
                {!isEditing && (
                  <span
                    style={{
                      fontSize: 11,
                      color: token.colorTextTertiary,
                      flexShrink: 0,
                    }}
                  >
                    {tag.note_count}
                  </span>
                )}
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
        destroyOnHidden
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

      {/* 标签右键菜单（重命名 / 颜色色板 inline / 删除） */}
      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={tagMenuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
