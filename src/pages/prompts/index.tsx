import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag as AntTag,
  Tooltip,
  message,
  theme as antdTheme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Copy as CopyIcon,
  Edit3,
  Plus,
  Power,
  Sparkles,
  Trash2,
} from "lucide-react";
import { promptApi } from "@/lib/api";
import { MicButton } from "@/components/MicButton";
import type {
  PromptOutputMode,
  PromptTemplate,
  PromptTemplateInput,
} from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

const OUTPUT_MODE_OPTIONS: Array<{
  value: PromptOutputMode;
  label: string;
  desc: string;
}> = [
  {
    value: "replace",
    label: "替换选区",
    desc: "用结果替换选中的文本（改写/扩展/翻译）",
  },
  {
    value: "append",
    label: "追加到末尾",
    desc: "在选区后面拼接结果（续写）",
  },
  {
    value: "popup",
    label: "仅展示",
    desc: "只弹窗显示结果，不自动插入（总结）",
  },
];

const VAR_HINTS = [
  { key: "{{selection}}", desc: "用户选中的文本" },
  { key: "{{context}}", desc: "选区前后的上下文（自动裁剪到 500 字）" },
  { key: "{{title}}", desc: "当前笔记标题（v1 暂未接入）" },
  { key: "{{language}}", desc: "用户语言，如 zh-CN" },
];

interface FormValues {
  title: string;
  description: string;
  prompt: string;
  outputMode: PromptOutputMode;
  icon: string | null;
  enabled: boolean;
}

export default function PromptsPage() {
  const { token } = antdTheme.useToken();
  const [list, setList] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  /**
   * Modal 打开时要填充的初始值。
   *
   * 用 initialValues + 递增的 formKey 让 Form 每次"打开"都重新挂载，
   * 这样 AntD 的 initialValues 首次 mount 生效规则天然对齐"每次打开填
   * 不同值"。这条路比 setFieldsValue 更稳——不用关心 Modal 懒挂载 +
   * Form.Item 注册时序，initialValues 随 Form 本次 mount 直接进字段。
   */
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  /** 递增计数：每次 open* 自增，触发 Form 重挂载吃新 initialValues */
  const [formKey, setFormKey] = useState(0);
  const [form] = Form.useForm<FormValues>();

  useEffect(() => {
    void loadList();
  }, []);

  async function loadList() {
    setLoading(true);
    try {
      const data = await promptApi.list(false);
      setList(data);
    } catch (e) {
      message.error(`加载提示词失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setPendingValues({
      title: "",
      description: "",
      prompt: "",
      outputMode: "replace",
      icon: null,
      enabled: true,
    });
    setFormKey((k) => k + 1);
    setModalOpen(true);
  }

  function openEdit(record: PromptTemplate) {
    setEditing(record);
    setPendingValues({
      title: record.title,
      description: record.description,
      prompt: record.prompt,
      outputMode: record.outputMode,
      icon: record.icon,
      enabled: record.enabled,
    });
    setFormKey((k) => k + 1);
    setModalOpen(true);
  }

  function openClone(record: PromptTemplate) {
    setEditing(null);
    setPendingValues({
      title: `${record.title} 副本`,
      description: record.description,
      prompt: record.prompt,
      outputMode: record.outputMode,
      icon: record.icon,
      enabled: true,
    });
    setFormKey((k) => k + 1);
    setModalOpen(true);
  }

  async function handleSubmit() {
    try {
      const values = await form.validateFields();
      const input: PromptTemplateInput = {
        title: values.title.trim(),
        description: values.description?.trim() || "",
        prompt: values.prompt,
        outputMode: values.outputMode,
        icon: values.icon || null,
        enabled: values.enabled,
      };
      if (editing) {
        await promptApi.update(editing.id, input);
        message.success("已更新");
      } else {
        await promptApi.create(input);
        message.success("已创建");
      }
      setModalOpen(false);
      void loadList();
    } catch (e) {
      // form.validateFields 失败会抛出对象（非 Error），这里宽松处理
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败：${e}`);
    }
  }

  async function handleDelete(record: PromptTemplate) {
    Modal.confirm({
      title: record.isBuiltin ? "删除内置提示词？" : "删除这个提示词？",
      content: record.isBuiltin
        ? '这是内置模板，删除后需要重新创建才能恢复。建议改用"禁用"。'
        : `将删除"${record.title}"，操作不可撤销。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      async onOk() {
        try {
          await promptApi.delete(record.id);
          message.success("已删除");
          void loadList();
        } catch (e) {
          message.error(`删除失败：${e}`);
          throw e;
        }
      },
    });
  }

  async function handleToggleEnabled(record: PromptTemplate, enabled: boolean) {
    try {
      await promptApi.setEnabled(record.id, enabled);
      // 乐观更新：不 reload 整个列表，避免禁用开关闪动
      setList((prev) =>
        prev.map((p) => (p.id === record.id ? { ...p, enabled } : p)),
      );
    } catch (e) {
      message.error(`切换失败：${e}`);
    }
  }

  // ─── 右键菜单 ────────────────────────────────
  const ctx = useContextMenu<PromptTemplate>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "edit",
        label: "编辑",
        icon: <Edit3 size={13} />,
        onClick: () => {
          ctx.close();
          openEdit(p);
        },
      },
      {
        key: "clone",
        label: "复制为新模板",
        icon: <CopyIcon size={13} />,
        onClick: () => {
          ctx.close();
          openClone(p);
        },
      },
      {
        key: "toggle",
        label: p.enabled ? "禁用" : "启用",
        icon: <Power size={13} />,
        onClick: () => {
          ctx.close();
          void handleToggleEnabled(p, !p.enabled);
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          void handleDelete(p);
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload]);

  const columns = useMemo<ColumnsType<PromptTemplate>>(
    () => [
      {
        title: "标题",
        dataIndex: "title",
        key: "title",
        render: (_, r) => (
          <div className="flex items-center gap-2">
            <span style={{ color: token.colorText, fontWeight: 500 }}>
              {r.title}
            </span>
            {r.isBuiltin && (
              <AntTag color="blue" style={{ margin: 0, fontSize: 11 }}>
                内置
              </AntTag>
            )}
          </div>
        ),
      },
      {
        title: "说明",
        dataIndex: "description",
        key: "description",
        render: (v: string) => (
          <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
            {v || "—"}
          </span>
        ),
      },
      {
        title: "模式",
        dataIndex: "outputMode",
        key: "outputMode",
        width: 110,
        render: (v: PromptOutputMode) => {
          const opt = OUTPUT_MODE_OPTIONS.find((o) => o.value === v);
          return <AntTag>{opt?.label ?? v}</AntTag>;
        },
      },
      {
        title: "排序",
        dataIndex: "sortOrder",
        key: "sortOrder",
        width: 70,
      },
      {
        title: "启用",
        dataIndex: "enabled",
        key: "enabled",
        width: 70,
        render: (_, r) => (
          <Switch
            size="small"
            checked={r.enabled}
            onChange={(v) => handleToggleEnabled(r, v)}
          />
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 180,
        render: (_, r) => (
          <Space size={4}>
            <Tooltip title="编辑">
              <Button
                type="text"
                size="small"
                icon={<Edit3 size={14} />}
                onClick={() => openEdit(r)}
              />
            </Tooltip>
            <Tooltip title="复制为新模板">
              <Button
                type="text"
                size="small"
                icon={<CopyIcon size={14} />}
                onClick={() => openClone(r)}
              />
            </Tooltip>
            <Tooltip title="删除">
              <Button
                type="text"
                size="small"
                danger
                icon={<Trash2 size={14} />}
                onClick={() => handleDelete(r)}
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [token],
  );

  return (
    <div
      className="p-6 max-w-5xl mx-auto"
      onContextMenu={(e) => {
        // 顶层兜底：表格行有自己的 onContextMenu 会先 preventDefault；
        // 其他位置吞 WebView 默认菜单。input/textarea 白名单留给表单输入
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      <Card
        title={
          <div className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: token.colorPrimary }} />
            <span>AI 提示词库</span>
          </div>
        }
        extra={
          <Button type="primary" icon={<Plus size={14} />} onClick={openCreate}>
            新建提示词
          </Button>
        }
      >
        <p
          style={{
            color: token.colorTextSecondary,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          在笔记编辑器选中文本后，AI 菜单会列出所有启用的提示词。
          你可以修改内置模板的文案，也可以新建自己的模板；变量见下方占位符列表。
        </p>

        {list.length === 0 && !loading ? (
          <Empty description="还没有提示词" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={list}
            pagination={false}
            onRow={(record) => ({
              onContextMenu: (e) => {
                e.preventDefault();
                ctx.open(e.nativeEvent, record);
              },
              style:
                ctx.state.payload?.id === record.id
                  ? { background: token.colorPrimaryBg }
                  : undefined,
            })}
          />
        )}
      </Card>

      <Modal
        title={editing ? "编辑提示词" : "新建提示词"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        okText="保存"
        cancelText="取消"
        width={640}
        centered
        // 注：不要用 destroyOnHidden。openEdit() 是先 setFieldsValue 再 setModalOpen(true),
        // 若 Modal 关闭态 Form 被销毁，这一瞬间 setFieldsValue 会丢失全部赋值,导致编辑
        // 内置模板时所有字段都是空白。保留 Form 实例后，赋值可稳定生效。
        styles={{
          // Prompt 内容 textarea + 变量说明比较长，小屏会超出屏幕导致保存按钮看不见。
          // 用 70vh 限高并让 body 独立滚动，底部 OK/Cancel 行永远可见。
          body: { maxHeight: "70vh", overflowY: "auto", paddingRight: 12 },
        }}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          // 每次打开 Modal 递增 formKey → Form 重新挂载 → initialValues 被读取一次
          // 吃进字段（避开 setFieldsValue 需要等 Form.Item 注册完成的时序坑）
          key={formKey}
          initialValues={pendingValues ?? undefined}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请输入标题" }]}
          >
            <Input
              placeholder="如：润色公众号文案"
              maxLength={40}
              allowClear
              suffix={
                <MicButton
                  size="small"
                  stripTrailingPunctuation
                  onTranscribed={(text) => {
                    const cur: string = form.getFieldValue("title") || "";
                    form.setFieldValue("title", cur ? `${cur} ${text}` : text);
                  }}
                />
              }
            />
          </Form.Item>
          <Form.Item name="description" label="说明（可选）">
            <Input
              placeholder="一句话描述这个 Prompt 的用途"
              maxLength={80}
              allowClear
              suffix={
                <MicButton
                  size="small"
                  stripTrailingPunctuation
                  onTranscribed={(text) => {
                    const cur: string = form.getFieldValue("description") || "";
                    form.setFieldValue(
                      "description",
                      cur ? `${cur} ${text}` : text,
                    );
                  }}
                />
              }
            />
          </Form.Item>
          <Form.Item
            name="prompt"
            label={
              <div className="flex items-center justify-between w-full">
                <span>Prompt 内容</span>
                <span
                  style={{
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    fontWeight: "normal",
                  }}
                >
                  可用变量：{VAR_HINTS.map((v) => v.key).join(" / ")}
                </span>
              </div>
            }
            rules={[{ required: true, message: "请输入 Prompt 内容" }]}
            extra={
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  marginTop: 4,
                  lineHeight: 1.7,
                }}
              >
                {VAR_HINTS.map((v) => (
                  <div key={v.key}>
                    <code
                      style={{
                        background: token.colorFillTertiary,
                        padding: "1px 4px",
                        borderRadius: 3,
                      }}
                    >
                      {v.key}
                    </code>{" "}
                    {v.desc}
                  </div>
                ))}
              </div>
            }
          >
            <Input.TextArea
              rows={8}
              placeholder={
                "你是一个写作助手。请……\n\n【原文】\n{{selection}}"
              }
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}
            />
          </Form.Item>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="outputMode" label="结果插入方式">
              <Select
                options={OUTPUT_MODE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: (
                    <div>
                      <div>{o.label}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: token.colorTextTertiary,
                        }}
                      >
                        {o.desc}
                      </div>
                    </div>
                  ),
                }))}
              />
            </Form.Item>
            <Form.Item
              name="enabled"
              label="启用"
              valuePropName="checked"
              tooltip="禁用后编辑器菜单不显示，但保留数据"
            >
              <Switch />
            </Form.Item>
          </div>
          <Form.Item
            name="icon"
            label="图标（可选）"
            tooltip="Lucide 图标名，如 Sparkles / Languages / FileText"
          >
            <Input placeholder="Lucide 图标名（可留空）" maxLength={40} />
          </Form.Item>
        </Form>
      </Modal>

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
