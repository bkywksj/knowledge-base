import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, InputNumber, message } from "antd";
import { aiModelApi } from "@/lib/api";
import type { AiModel, AiModelInput } from "@/types";
import {
  findPreset,
  groupProviderOptions,
  modelOptions,
  modelPlaceholder,
  presetContextWindow,
  useAiProviderPresets,
} from "@/lib/aiProviderPresets";

/**
 * 移动端「新增 / 编辑 AI 模型」对话框（MobileAi 列表 chip 区 / MobileAiChat 顶栏 Drawer / 「我的」模型列表共用）。
 *
 * - 服务商清单来自 ai-profile crate（与桌面、Sigil 同一份，含 Anthropic 协议）
 * - 切换服务商 → 自动回填 名称 / API 地址 / 模型 ID（该服务商的默认模型）
 * - 模型 ID：有预设的走 Select（带搜索）；无预设的（本机服务 / 自定义）走 Input
 * - 上下文窗口：可留空，对话时回落到预置值
 * - 传 editing 即编辑：回填原值；Key 不回显，留空 = 不改；没动过的窗口不提交（后端三态，避免冲掉端点上报的来源）
 * - 保存成功后调 onSaved(model)，调用方可借此自动切换当前对话用这个新模型
 */
export function MobileAiModelModal({
  open,
  onClose,
  onSaved,
  okText = "保存",
  defaultProvider = "deepseek",
  editing = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (model: AiModel) => void;
  okText?: string;
  defaultProvider?: string;
  /** 要编辑的模型；null = 新建 */
  editing?: AiModel | null;
}) {
  const [form] = Form.useForm<AiModelInput>();
  const presets = useAiProviderPresets();
  const [provider, setProvider] = useState(defaultProvider);
  const preset = findPreset(presets, provider);
  const watchedModelId = Form.useWatch("model_id", form) as string | undefined;

  /** 按服务商回填 名称 / 地址 / 默认模型 */
  function fillFrom(p: string) {
    const pre = findPreset(presets, p);
    form.setFieldsValue({
      name: pre?.label ?? p,
      api_url: pre?.baseUrl ?? "",
      model_id: pre?.model || pre?.models[0]?.value || "",
    });
  }

  // 编辑：原值走 Form 的 initialValues（见下方）。不能在这里 setFieldsValue —— open 刚变 true 时
  // Modal（destroyOnClose）里的 Form 还没挂上，写进去的值会被挂载时的 initialValues 覆盖成空表单（实测）
  useEffect(() => {
    if (open && editing) setProvider(editing.provider);
  }, [open, editing]);

  // 新建：每次打开都重置到默认服务商。预置是异步加载的，加载完再回填一次
  useEffect(() => {
    if (!open || editing) return;
    setProvider(defaultProvider);
    form.setFieldsValue({ provider: defaultProvider });
    if (presets.length > 0) fillFrom(defaultProvider);
    // fillFrom 只读 presets / form，随它们变化即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProvider, presets, editing]);

  function onProviderChange(p: string) {
    setProvider(p);
    fillFrom(p);
  }

  async function submit() {
    try {
      const values = await form.validateFields();
      const ctx = values.max_context && values.max_context > 0 ? values.max_context : null;
      if (editing) {
        const payload: AiModelInput = { name: values.name, provider: values.provider, api_url: values.api_url, model_id: values.model_id };
        // Key 不回显，表单里是空的 = 没动 → 省略字段；传空串后端会当成「清除」
        const key = (values.api_key ?? "").trim();
        if (key) payload.api_key = key;
        // 窗口改了才提交；清空时若还有端点上报的输出上限，来源保留原值
        const oldCtx = editing.max_context > 0 ? editing.max_context : null;
        if (ctx !== oldCtx) {
          payload.max_context = ctx;
          payload.limits_source = ctx !== null ? "user" : editing.max_output != null ? editing.limits_source : null;
        }
        const updated = await aiModelApi.update(editing.id, payload);
        message.success(`已保存 ${updated.name}`);
        onSaved(updated);
        onClose();
        return;
      }
      const created = await aiModelApi.create({
        ...values,
        max_context: ctx,
        limits_source: ctx !== null ? "user" : null,
      });
      message.success(`已添加 ${created.name}`);
      onSaved(created);
      onClose();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`${editing ? "保存" : "添加"}失败: ${e}`);
    }
  }

  const presetOptions = modelOptions(preset);
  const presetWindow = presetContextWindow(preset, watchedModelId);

  return (
    <Modal
      title={editing ? "编辑模型服务" : "新建模型服务"}
      open={open}
      onOk={submit}
      onCancel={onClose}
      okText={okText}
      cancelText="取消"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          editing
            ? {
                name: editing.name,
                provider: editing.provider,
                api_url: editing.api_url,
                api_key: "",
                model_id: editing.model_id,
                // 0 = 未设置：回填 undefined，让占位符显示预置值
                max_context: editing.max_context > 0 ? editing.max_context : undefined,
              }
            : { provider: defaultProvider, api_key: "" }
        }
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: "请输入名称" }]}
        >
          <Input placeholder="模型展示名" />
        </Form.Item>
        <Form.Item
          name="provider"
          label="服务商"
          rules={[{ required: true }]}
        >
          {/* 移动端列表长、屏幕窄：开搜索并显示副文本，否则 20+ 条要滑很久 */}
          <Select
            showSearch
            onChange={onProviderChange}
            optionRender={(opt) => {
              const hint = (opt.data as { hint?: string | null }).hint;
              return (
                <div className="flex flex-col leading-tight py-0.5">
                  <span>{opt.data.label as string}</span>
                  {hint && <span className="text-xs whitespace-normal text-slate-400">{hint}</span>}
                </div>
              );
            }}
            filterOption={(input, option) => {
              const q = input.trim().toLowerCase();
              if (!q) return true;
              return ((option as { searchText?: string } | undefined)?.searchText ?? "").includes(q);
            }}
            optionLabelProp="title"
            options={groupProviderOptions(presets)}
          />
        </Form.Item>
        <Form.Item
          name="api_url"
          label="API 地址"
          extra="含 /v1 等版本段，不含 /chat/completions；原样使用，不会替你补"
          rules={[{ required: true, message: "请输入 API 地址" }]}
        >
          <Input placeholder={preset?.baseUrl || "https://你的服务地址/v1"} />
        </Form.Item>
        <Form.Item name="api_key" label="API Key">
          <Input.Password
            placeholder={editing?.has_api_key ? "已保存，留空 = 不修改" : preset?.isLocal ? "本机服务通常不需要" : "sk-..."}
          />
        </Form.Item>
        <Form.Item
          name="model_id"
          label="模型 ID"
          rules={[{ required: true, message: "请选择或输入模型 ID" }]}
        >
          {presetOptions.length > 0 ? (
            <Select
              showSearch
              options={presetOptions}
              placeholder={modelPlaceholder(preset)}
              optionFilterProp="label"
            />
          ) : (
            <Input placeholder={modelPlaceholder(preset)} />
          )}
        </Form.Item>
        <Form.Item
          name="max_context"
          label="上下文窗口 token（可选）"
          tooltip="影响发消息时拼接笔记的预算。留空 = 用预置值；没有预置值时按保守预算处理"
        >
          <InputNumber
            min={1024}
            max={10000000}
            step={1024}
            className="w-full"
            placeholder={presetWindow ? presetWindow.toLocaleString("en-US") : "未知"}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
