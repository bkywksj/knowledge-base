import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Modal,
  Form,
  Input,
  Tree,
  TreeSelect,
  message,
  theme as antdTheme,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  Plus,
  Tags as TagsIcon,
  Check,
  Edit3,
  Trash2,
  FolderUp,
  ChevronsDown,
  ChevronsUp,
  CornerDownRight,
} from "lucide-react";
import { tagApi } from "@/lib/api";
import { buildTagTreeSelectData } from "@/lib/tagTree";
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
 * v1.11 引入树形标签（parent_id）。本组件用 antd `<Tree>` 渲染层级，
 * 通过 `titleRender` 保留原有行内交互（inline 重命名 / 右键菜单 / 颜色色板）。
 *
 * 交互（与扁平版一致 + 拖拽）：
 *   · 单击 标签 → 选中 + 跳 /tags?tagId=...
 *   · 双击 标签 → 进入 inline 重命名（Enter 提交 / Esc 取消）
 *   · 右键 标签 → 菜单（重命名 / 颜色色板 / "提升为顶层" / 删除）
 *   · 拖拽 标签 → 改变父子关系（拖到节点上=作为子；拖到节点之间=作为兄弟）
 *
 * 删除父标签时，子标签**自动提升为顶层**（不会跟着删，避免误删）。
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
  const [form] = Form.useForm<{
    name: string;
    color: string;
    parent_id?: number | null;
  }>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

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

  // 按 name 过滤；过滤命中节点的所有祖先必须同时展开，否则用户看不到
  const { filteredTreeData, autoExpandKeys } = useMemo(
    () => buildTreeData(tags, filter.trim().toLowerCase()),
    [tags, filter],
  );

  // 新建弹窗"父标签"下拉用：完整层级（不带 filter），value 用数字 id
  const parentTreeData = useMemo(() => buildTagTreeSelectData(tags), [tags]);

  // 筛选时自动展开命中节点的祖先链；清空筛选恢复用户原状态
  useEffect(() => {
    if (filter.trim()) {
      setExpandedKeys((prev) => Array.from(new Set([...prev, ...autoExpandKeys])));
    }
  }, [filter, autoExpandKeys]);

  function handleSelect(tag: Tag) {
    if (editingId === tag.id) return; // 编辑态不响应点击
    navigate(`/tags?tagId=${tag.id}`);
  }

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setEditingName(tag.name);
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

  async function handleCreate(values: {
    name: string;
    color: string;
    parent_id?: number | null;
  }) {
    try {
      await tagApi.create(
        values.name,
        values.color,
        values.parent_id ?? null,
      );
      message.success("已创建");
      setModalOpen(false);
      form.resetFields();
      // 父节点要展开，让新建的子标签可见
      if (values.parent_id != null) {
        setExpandedKeys((prev) =>
          prev.includes(String(values.parent_id))
            ? prev
            : [...prev, String(values.parent_id)],
        );
      }
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 打开新建弹窗，可预设父标签（右键"新建子标签"/"新建同级"用） */
  function openCreateModal(parentId: number | null) {
    form.resetFields();
    form.setFieldsValue({ parent_id: parentId });
    setModalOpen(true);
  }

  /** 展开/折叠以 rootId 为根的整棵子树（含 rootId 本身） */
  function toggleExpandAll(rootId: number, expand: boolean) {
    const allKeys = [
      String(rootId),
      ...getDescendantIds(tags, rootId).map(String),
    ];
    setExpandedKeys((prev) => {
      if (expand) {
        return Array.from(new Set([...prev, ...allKeys]));
      }
      const set = new Set(allKeys);
      return prev.filter((k) => !set.has(k));
    });
  }

  /** 标签拖拽放置：
   * - dropToGap=false（落在节点上）→ 拖动项变为 dropNode 的子（sort_order 自动落新 parent 末尾）
   * - dropToGap=true 同 parent（落在节点之间）→ 纯同级排序，调 reorder
   * - dropToGap=true 跨 parent → 先 setParent 改归属，再 reorder 调整位置
   *
   * relativeDrop 用 antd 经典算法（dropPosition - dropNode 自身索引）：
   *   -1 = 放在 dropNode 上方, 0 = 作为子, +1 = 放在下方
   */
  async function handleDrop(info: {
    dragNode: { key: React.Key };
    node: { key: React.Key; pos: string };
    dropPosition: number;
    dropToGap: boolean;
  }) {
    const dragId = Number(info.dragNode.key);
    const dropId = Number(info.node.key);
    if (dragId === dropId) return; // 自环
    const dragTag = tags.find((t) => t.id === dragId);
    const dropTag = tags.find((t) => t.id === dropId);
    if (!dragTag || !dropTag) return;

    // 落在节点上 → 作为子（setParent 自动落新 parent 末尾，不需要 reorder）
    if (!info.dropToGap) {
      try {
        await tagApi.setParent(dragId, dropId);
        useAppStore.getState().bumpTagsRefresh();
      } catch (e) {
        message.error(`移动失败：${e}`);
      }
      return;
    }

    // 落在间隙 → 同级排序
    const newParentId = dropTag.parent_id;
    const oldParentId = dragTag.parent_id;

    // antd dropPosition 减去 dropNode 在父 children 中的索引 = "相对位置"（-1/0/+1）
    const dropPosArr = info.node.pos.split("-");
    const dropNodeIdx = Number(dropPosArr[dropPosArr.length - 1]);
    const relativeDrop = info.dropPosition - dropNodeIdx;

    // tags 已 ORDER BY parent_id, sort_order，按 parent 过滤即可得正确顺序
    const siblings = tags.filter(
      (t) =>
        (t.parent_id ?? null) === (newParentId ?? null) && t.id !== dragId,
    );
    const dropIdx = siblings.findIndex((t) => t.id === dropId);
    if (dropIdx === -1) {
      // 跨 parent 异常兜底：直接 setParent 让其落新 parent 末尾
      if (newParentId !== oldParentId) {
        try {
          await tagApi.setParent(dragId, newParentId);
          useAppStore.getState().bumpTagsRefresh();
        } catch (e) {
          message.error(`移动失败：${e}`);
        }
      }
      return;
    }

    // relativeDrop < 0 = 插到 dropTag 之前；>= 0 = 插到之后
    const insertIdx = relativeDrop < 0 ? dropIdx : dropIdx + 1;
    const newOrder = [
      ...siblings.slice(0, insertIdx),
      dragTag,
      ...siblings.slice(insertIdx),
    ].map((t) => t.id);

    try {
      // 跨 parent 拖：先 setParent 改归属，再 reorder 覆盖 sort_order 到正确位置
      if (newParentId !== oldParentId) {
        await tagApi.setParent(dragId, newParentId);
      }
      await tagApi.reorder(newOrder);
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(`移动失败：${e}`);
    }
  }

  // ─── 右键菜单 ────────────────────────────────
  const ctx = useContextMenu<{
    id: number;
    name: string;
    color: string | null;
    parentId: number | null;
  }>();

  async function setTagColor(id: number, color: string) {
    try {
      await tagApi.setColor(id, color);
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(`改色失败：${e}`);
    }
  }

  async function promoteToTop(id: number) {
    try {
      await tagApi.setParent(id, null);
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(`提升失败：${e}`);
    }
  }

  const tagMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];

    // 是否有子标签 + 当前子树是否已全展开（含 root 自身），决定"展开/折叠所有子标签"行为
    const hasKids = tags.some((t) => t.parent_id === p.id);
    const descendantIds = hasKids ? getDescendantIds(tags, p.id) : [];
    const allExpanded =
      hasKids &&
      expandedKeys.includes(String(p.id)) &&
      descendantIds.every((id) => expandedKeys.includes(String(id)));

    const items: ContextMenuEntry[] = [
      {
        key: "new-child",
        label: "在此下方新建子标签",
        icon: <CornerDownRight size={13} />,
        onClick: () => {
          ctx.close();
          openCreateModal(p.id);
        },
      },
      {
        key: "new-sibling",
        label: "新建同级标签",
        icon: <Plus size={13} />,
        onClick: () => {
          ctx.close();
          openCreateModal(p.parentId);
        },
      },
    ];

    if (hasKids) {
      items.push({
        key: "toggle-expand-all",
        label: allExpanded ? "折叠所有子标签" : "展开所有子标签",
        icon: allExpanded ? (
          <ChevronsUp size={13} />
        ) : (
          <ChevronsDown size={13} />
        ),
        onClick: () => {
          ctx.close();
          toggleExpandAll(p.id, !allExpanded);
        },
      });
    }

    items.push(
      { type: "divider" },
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
    );
    if (p.parentId != null) {
      items.push({
        key: "promote",
        label: "提升为顶层",
        icon: <FolderUp size={13} />,
        onClick: () => {
          ctx.close();
          void promoteToTop(p.id);
        },
      });
    }
    items.push(
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
                const isSelected =
                  (p.color || "").toLowerCase() === c.toLowerCase();
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
            content: "子标签会自动提升为顶层（不会跟着删除）。已关联的笔记保留。",
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
    );
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, tags, expandedKeys, selectedId, navigate, token]);

  /** Tree titleRender：单行 = 色块 + 名称（inline 编辑切换）+ 计数 + active 勾 */
  const renderTitle = (node: DataNode) => {
    const tag = tags.find((t) => t.id === Number(node.key));
    if (!tag) return null;
    const active = selectedId === tag.id;
    const ctxActive = ctx.state.payload?.id === tag.id;
    const isEditing = editingId === tag.id;
    // hover / 选中 / 右键背景统一交给 .tag-row CSS 画，确保形状一致（见 global.css）
    const rowClass = [
      "tag-row",
      active && "is-active",
      ctxActive && "is-ctx-active",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        className={rowClass}
        onClick={(e) => {
          if (isEditing) return;
          e.stopPropagation(); // antd Tree 默认会触发 selectable=false 的 onSelect 不必要副作用
          handleSelect(tag);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEdit(tag);
        }}
        onContextMenu={(e) => {
          if (isEditing) return;
          e.preventDefault();
          e.stopPropagation();
          ctx.open(e.nativeEvent, {
            id: tag.id,
            name: tag.name,
            color: tag.color,
            parentId: tag.parent_id,
          });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 6px",
          fontSize: 13,
          minHeight: 22,
        }}
      >
        <span
          aria-hidden
          // v4 原型：彩色圆点（原 10px 小方块）
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: tag.color || token.colorTextQuaternary,
            flexShrink: 0,
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
          <span
            className="truncate"
            style={{ flex: 1, minWidth: 0 }}
            title={tag.name}
          >
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
  };

  return (
    <div
      className="tags-tree-panel flex flex-col h-full"
      style={{ overflow: "hidden" }}
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
          onClick={() => openCreateModal(null)}
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

      {/* 标签树 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "2px 8px 8px" }}
      >
        {filteredTreeData.length === 0 ? (
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
                  onClick={() => openCreateModal(null)}
                >
                  + 新建标签
                </span>
              </>
            ) : (
              "无匹配标签"
            )}
          </div>
        ) : (
          <Tree
            treeData={filteredTreeData}
            titleRender={renderTitle}
            draggable={{ icon: false }}
            blockNode
            selectable={false}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys.map(String))}
            onDrop={handleDrop}
            // antd Tree 默认会把每行 padding 弄得很宽，压缩一下
            style={{ background: "transparent" }}
          />
        )}
        {/* v4 原型：右键操作提示（右键菜单本身不变） */}
        {tags.length > 0 && (
          <div className="kb-tag-hint">右键标签：新建子标签 / 同级标签 / 重命名 / 提升为顶层 / 删除</div>
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
            <Input placeholder="输入标签名称" autoFocus />
          </Form.Item>
          <Form.Item
            name="parent_id"
            label="父标签"
            tooltip="留空 = 顶层标签；选定后将作为该标签的子节点"
          >
            <TreeSelect
              allowClear
              placeholder="不选则为顶层标签"
              treeData={parentTreeData}
              treeDefaultExpandAll
              showSearch
              treeNodeFilterProp="title"
            />
          </Form.Item>
          <Form.Item name="color" label="颜色" initialValue="#722ed1">
            <TagColorPicker />
          </Form.Item>
        </Form>
      </Modal>

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

/**
 * 把扁平 Tag[] 组装成 antd Tree 的 DataNode[]，并按 filter 过滤。
 *
 * 过滤策略：节点 name 包含 filter（命中）或其任一后代命中 → 该节点出现在结果中。
 * 同时返回所有命中节点的祖先 keys，供调用方自动展开。
 *
 * 孤儿处理：parent_id 指向不存在的 id（数据清理不全 / 父被删的旧数据）→ 当作顶层。
 */
function buildTreeData(
  tags: Tag[],
  filterLower: string,
): { filteredTreeData: DataNode[]; autoExpandKeys: string[] } {
  const byId = new Map<number, Tag>();
  tags.forEach((t) => byId.set(t.id, t));
  const childrenMap = new Map<number | null, Tag[]>();
  for (const t of tags) {
    const parent = t.parent_id != null && byId.has(t.parent_id) ? t.parent_id : null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(t);
  }

  const autoExpand = new Set<string>();

  function build(tag: Tag, ancestors: string[]): DataNode | null {
    const children = (childrenMap.get(tag.id) ?? [])
      .map((c) => build(c, [...ancestors, String(tag.id)]))
      .filter((n): n is DataNode => n != null);
    const selfMatch =
      !filterLower || tag.name.toLowerCase().includes(filterLower);
    const hasChildHit = children.length > 0 && filterLower;
    if (!selfMatch && !hasChildHit && filterLower) return null;
    if (selfMatch && filterLower) {
      // 自身命中：标记所有祖先要展开
      ancestors.forEach((a) => autoExpand.add(a));
    }
    return {
      key: String(tag.id),
      title: tag.name, // 实际渲染走 titleRender
      children: children.length > 0 ? children : undefined,
    };
  }

  const roots = (childrenMap.get(null) ?? [])
    .map((t) => build(t, []))
    .filter((n): n is DataNode => n != null);

  return {
    filteredTreeData: roots,
    autoExpandKeys: Array.from(autoExpand),
  };
}

/** 收集 rootId 子树下所有后代 id（不含 rootId 自身）。迭代版避免深嵌套爆栈。 */
function getDescendantIds(tags: Tag[], rootId: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const t of tags) {
    if (t.parent_id == null) continue;
    if (!childrenByParent.has(t.parent_id)) childrenByParent.set(t.parent_id, []);
    childrenByParent.get(t.parent_id)!.push(t.id);
  }
  const result: number[] = [];
  const stack: number[] = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    result.push(id);
    const kids = childrenByParent.get(id);
    if (kids) stack.push(...kids);
  }
  return result;
}

