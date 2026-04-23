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
  Sparkles,
  Trash2,
} from "lucide-react";
import { promptApi } from "@/lib/api";
import type {
  PromptOutputMode,
  PromptTemplate,
  PromptTemplateInput,
} from "@/types";

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
    form.setFieldsValue({
      title: "",
      description: "",
      prompt: "",
      outputMode: "replace",
      icon: null,
      enabled: true,
    });
    setModalOpen(true);
  }

  function openEdit(record: PromptTemplate) {
    setEditing(record);
    form.setFieldsValue({
      title: record.title,
      description: record.description,
      prompt: record.prompt,
      outputMode: record.outputMode,
      icon: record.icon,
      enabled: record.enabled,
    });
    setModalOpen(true);
  }

  function openClone(record: PromptTemplate) {
    setEditing(null);
    form.setFieldsValue({
      title: `${record.title} 副本`,
      description: record.description,
      prompt: record.prompt,
      outputMode: record.outputMode,
      icon: record.icon,
      enabled: true,
    });
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
    <div className="p-6 max-w-5xl mx-auto">
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
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请输入标题" }]}
          >
            <Input placeholder="如：润色公众号文案" maxLength={40} />
          </Form.Item>
          <Form.Item name="description" label="说明（可选）">
            <Input placeholder="一句话描述这个 Prompt 的用途" maxLength={80} />
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
    </div>
  );
}
