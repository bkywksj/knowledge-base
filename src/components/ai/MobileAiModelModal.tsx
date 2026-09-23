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
 * 移动端「新增 AI 模型」对话框（MobileAi 列表 chip 区 / MobileAiChat 顶栏 Drawer 共用）。
 *
 * - 服务商清单来自 ai-profile crate（与桌面同一份，只含 OpenAI 兼容协议）
 * - 切换服务商 → 自动回填 名称 / API 地址 / 模型 ID（该服务商的默认模型）
 * - 模型 ID：有预设的走 Select（带搜索）；无预设的（本机服务 / 自定义）走 Input
 * - 上下文窗口：可留空，对话时回落到预置值
 * - 保存成功后调 onSaved(model)，调用方可借此自动切换当前对话用这个新模型
 */
export function MobileAiModelModal({
  open,
  onClose,
  onSaved,
  okText = "保存",
  defaultProvider = "deepseek",
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (model: AiModel) => void;
  okText?: string;
  defaultProvider?: string;
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

  // 每次打开都重置到默认服务商。预置是异步加载的，加载完再回填一次
  useEffect(() => {
    if (!open) return;
    setProvider(defaultProvider);
    form.setFieldsValue({ provider: defaultProvider });
    if (presets.length > 0) fillFrom(defaultProvider);
    // fillFrom 只读 presets / form，随它们变化即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProvider, presets]);

  function onProviderChange(p: string) {
    setProvider(p);
    fillFrom(p);
  }

  async function submit() {
    try {
      const values = await form.validateFields();
      const ctx = values.max_context && values.max_context > 0 ? values.max_context : null;
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
      message.error(`添加失败: ${e}`);
    }
  }

  const presetOptions = modelOptions(preset);
  const presetWindow = presetContextWindow(preset, watchedModelId);

  return (
    <Modal
      title="新建模型服务"
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
        initialValues={{ provider: defaultProvider, api_key: "" }}
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
          <Input.Password placeholder={preset?.isLocal ? "本机服务通常不需要" : "sk-..."} />
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
