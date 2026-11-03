import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Spin,
  Switch,
  Tooltip,
  message,
  theme as antdTheme,
} from "antd";
import {
  Copy as CopyIcon,
  Edit3,
  Plus,
  Power,
  Search,
  Trash2,
} from "lucide-react";
import { promptApi } from "@/lib/api";
import { MicButton } from "@/components/MicButton";
import { PROMPT_ICON_NAMES, renderPromptIcon } from "@/lib/promptIcons";
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

const EMPTY_VALUES: FormValues = {
  title: "",
  description: "",
  prompt: "",
  outputMode: "replace",
  icon: null,
  enabled: true,
};

function toValues(p: PromptTemplate): FormValues {
  return {
    title: p.title,
    description: p.description,
    prompt: p.prompt,
    outputMode: p.outputMode,
    icon: p.icon,
    enabled: p.enabled,
  };
}

/**
 * AI 提示词库（v4 原型）：顶栏（标题 · 说明 ｜ 搜索 · 新建）+ 左卡片网格 + 右侧常驻编辑表单。
 *
 * 编辑表单的三种状态：
 * - 编辑：editing = 某条提示词（点卡片 / 右键「编辑」）
 * - 新建：editing = null（点「新建提示词」/ 右键「复制为新模板」，后者预填副本）
 * 原来是弹窗编辑；表单逻辑（initialValues + formKey 重挂载）原样保留。
 */
export default function PromptsPage() {
  const { token } = antdTheme.useToken();
  const [list, setList] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  /**
   * 表单要填充的初始值。
   *
   * 用 initialValues + 递增的 formKey 让 Form 每次切换都重新挂载，
   * 这样 AntD 的 initialValues 首次 mount 生效规则天然对齐"每次切换填
   * 不同值"。这条路比 setFieldsValue 更稳——不用关心 Form.Item 注册时序。
   */
  const [pendingValues, setPendingValues] = useState<FormValues>(EMPTY_VALUES);
  /** 递增计数：每次切换编辑对象自增，触发 Form 重挂载吃新 initialValues */
  const [formKey, setFormKey] = useState(0);
  /** 表单有没有改动：没改动时「保存」置灰，「取消」也不需要 */
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const iconValue = Form.useWatch("icon", form);

  useEffect(() => {
    void loadList(true);
  }, []);

  async function loadList(selectFirst = false) {
    setLoading(true);
    try {
      const data = await promptApi.list(false);
      setList(data);
      // 首次进来默认选中第一条，右侧表单不空着
      if (selectFirst && data.length > 0) openEdit(data[0]);
    } catch (e) {
      message.error(`加载提示词失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  function load(target: PromptTemplate | null, values: FormValues) {
    setEditing(target);
    setPendingValues(values);
    setFormKey((k) => k + 1);
    setDirty(false);
  }

  function openCreate() {
    load(null, EMPTY_VALUES);
  }

  function openEdit(record: PromptTemplate) {
    load(record, toValues(record));
  }

  function openClone(record: PromptTemplate) {
    load(null, { ...toValues(record), title: `${record.title} 副本`, enabled: true });
    // 预填了副本内容，算已改动：可以直接保存
    setDirty(true);
  }

  /** 切到别的卡片前，有未保存改动就先问一下 */
  function confirmLeave(next: () => void) {
    if (!dirty) {
      next();
      return;
    }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: "右侧表单里的改动还没保存。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      onOk: next,
    });
  }

  async function handleSubmit() {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const input: PromptTemplateInput = {
        title: values.title.trim(),
        description: values.description?.trim() || "",
        prompt: values.prompt,
        outputMode: values.outputMode,
        icon: values.icon || null,
        enabled: values.enabled,
      };
      const saved = editing
        ? await promptApi.update(editing.id, input)
        : await promptApi.create(input);
      message.success(editing ? "已更新" : "已创建");
      const data = await promptApi.list(false);
      setList(data);
      // 保存后停在刚保存的这条上（新建的也切成编辑态）
      openEdit(data.find((p) => p.id === saved.id) ?? saved);
    } catch (e) {
      // form.validateFields 失败会抛出对象（非 Error），这里宽松处理
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    // 新建态（含「复制为新模板」）点取消 = 放弃这条，回到第一张卡片；
    // 只重置表单的话会停在一张保存不了的空白 / 副本表单上
    if (!editing && shown.length > 0) {
      openEdit(shown[0]);
      return;
    }
    // 编辑态：回到打开时的原值
    form.resetFields();
    setDirty(false);
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
          const data = await promptApi.list(false);
          setList(data);
          // 删的正是右侧在编辑的这条 → 换到第一条（没有了就进新建态）
          if (editing?.id === record.id) {
            if (data.length > 0) openEdit(data[0]);
            else openCreate();
          }
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
      // 右侧正在编辑这条且没有改动时，表单里的「启用」跟着变
      if (editing?.id === record.id && !dirty) {
        load({ ...record, enabled }, { ...toValues(record), enabled });
      }
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
          confirmLeave(() => openEdit(p));
        },
      },
      {
        key: "clone",
        label: "复制为新模板",
        icon: <CopyIcon size={13} />,
        onClick: () => {
          ctx.close();
          confirmLeave(() => openClone(p));
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
  }, [ctx.state.payload, dirty, editing]);

  /** 卡片按排序值排（与编辑器 AI 菜单的顺序一致）；搜索只按标题 / 说明前端过滤 */
  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return [...list]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter(
        (p) =>
          !kw ||
          p.title.toLowerCase().includes(kw) ||
          (p.description || "").toLowerCase().includes(kw),
      );
  }, [list, keyword]);

  return (
    <div
      className="kb-prompts-page"
      onContextMenu={(e) => {
        // 整页兜底：卡片外空白右键不弹 WebView 默认菜单
        e.preventDefault();
      }}
    >
      {/* 顶栏（原型 .bar）：AI 提示词库 · 说明 ｜ 搜索 · 新建 */}
      <div className="kb-page-bar">
        <h1>AI 提示词库</h1>
        <span className="kb-page-sub">
          笔记编辑器选中文本后，「AI 写作」菜单里直接调用已启用的提示词
        </span>
        <span className="flex-1" />
        <Input
          className="kb-bar-search"
          allowClear
          prefix={<Search size={14} />}
          placeholder="搜索提示词"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button
          type="primary"
          icon={<Plus size={14} />}
          onClick={() => confirmLeave(openCreate)}
        >
          新建提示词
        </Button>
      </div>

      <div className="kb-prompts-main">
        {/* 卡片网格 */}
        <div className="kb-prompt-grid">
          {loading && list.length === 0 ? (
            <div className="flex justify-center py-12" style={{ gridColumn: "1 / -1" }}>
              <Spin />
            </div>
          ) : shown.length === 0 ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Empty description={keyword ? "没有匹配的提示词" : "还没有提示词"} />
            </div>
          ) : (
            shown.map((p) => {
              const mode = OUTPUT_MODE_OPTIONS.find((o) => o.value === p.outputMode);
              const active = editing?.id === p.id;
              return (
                <div
                  key={p.id}
                  className={
                    "kb-prompt-card" +
                    (active ? " is-active" : "") +
                    (p.enabled ? "" : " is-off") +
                    (ctx.state.payload?.id === p.id ? " is-ctx" : "")
                  }
                  onClick={() => {
                    if (!active) confirmLeave(() => openEdit(p));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctx.open(e.nativeEvent, p);
                  }}
                >
                  <div className="kb-prompt-card-head">
                    <span className="kb-prompt-ico">{renderPromptIcon(p.icon, 15)}</span>
                    <b className="kb-prompt-title">{p.title}</b>
                    {p.isBuiltin && <span className="kb-prompt-builtin">内置</span>}
                    <span onClick={(e) => e.stopPropagation()}>
                      <Switch
                        size="small"
                        checked={p.enabled}
                        onChange={(v) => void handleToggleEnabled(p, v)}
                      />
                    </span>
                  </div>
                  <div className="kb-prompt-desc">{p.description || "—"}</div>
                  <div className="kb-prompt-foot">
                    <span className="kb-prompt-mode" title={mode?.desc}>
                      {mode?.label ?? p.outputMode}
                    </span>
                    <span className="kb-prompt-order" title="排序值：编辑器 AI 菜单按它从小到大排">
                      排序 {p.sortOrder}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 右侧常驻编辑表单（原弹窗） */}
        <section className="kb-cards-panel kb-qc kb-prompt-edit">
          <div className="kb-qc-head">
            <span className="kb-qc-ico">
              {editing ? <Edit3 size={14} /> : <Plus size={14} />}
            </span>
            {editing ? "编辑提示词" : "新建提示词"}
          </div>
          <Form
            form={form}
            layout="vertical"
            preserve={false}
            requiredMark={false}
            // 每次切换编辑对象递增 formKey → Form 重新挂载 → initialValues 被读取一次
            // 吃进字段（避开 setFieldsValue 需要等 Form.Item 注册完成的时序坑）
            key={formKey}
            initialValues={pendingValues}
            onValuesChange={() => setDirty(true)}
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
                      setDirty(true);
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
                      form.setFieldValue("description", cur ? `${cur} ${text}` : text);
                      setDirty(true);
                    }}
                  />
                }
              />
            </Form.Item>
            {/* 图标：点选编辑器 AI 菜单能显示的那几个；也能手填（名字不在表里时菜单里显示默认魔杖） */}
            <Form.Item label="图标（可选）">
              <div className="kb-icon-grid">
                {PROMPT_ICON_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    className={iconValue === name ? "kb-icon-opt is-on" : "kb-icon-opt"}
                    onClick={() => {
                      form.setFieldValue("icon", iconValue === name ? null : name);
                      setDirty(true);
                    }}
                  >
                    {renderPromptIcon(name, 15)}
                  </button>
                ))}
              </div>
              <Form.Item name="icon" noStyle>
                <Input
                  size="small"
                  allowClear
                  maxLength={40}
                  placeholder="或填 Lucide 图标名（可留空）"
                  style={{ marginTop: 8 }}
                />
              </Form.Item>
            </Form.Item>
            <Form.Item
              name="prompt"
              label={
                <span>
                  Prompt 内容
                  <span className="kb-prompt-vars">
                    · 支持 {VAR_HINTS.map((v) => v.key).join(" ")}
                  </span>
                </span>
              }
              rules={[{ required: true, message: "请输入 Prompt 内容" }]}
              extra={
                <div className="kb-prompt-var-list">
                  {VAR_HINTS.map((v) => (
                    <div key={v.key}>
                      <code style={{ background: token.colorFillTertiary }}>{v.key}</code> {v.desc}
                    </div>
                  ))}
                </div>
              }
            >
              <Input.TextArea
                autoSize={{ minRows: 5, maxRows: 14 }}
                placeholder={"你是一个写作助手。请……\n\n【原文】\n{{selection}}"}
                style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}
              />
            </Form.Item>
            <Form.Item name="outputMode" label="结果插入方式">
              <Segmented
                block
                options={OUTPUT_MODE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: (
                    <Tooltip title={o.desc} mouseEnterDelay={0.4}>
                      <span>{o.label}</span>
                    </Tooltip>
                  ),
                }))}
              />
            </Form.Item>
            <div className="kb-prompt-enable">
              <Form.Item name="enabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <span>启用</span>
              <span className="kb-prompt-enable-tip">禁用后编辑器菜单不显示，但保留数据</span>
            </div>
          </Form>
          <div className="kb-prompt-actions">
            <Button disabled={!dirty || saving} onClick={handleCancel}>
              取消
            </Button>
            <Button type="primary" loading={saving} disabled={!dirty} onClick={() => void handleSubmit()}>
              保存
            </Button>
          </div>
        </section>
      </div>

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
