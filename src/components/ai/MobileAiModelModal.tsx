import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, InputNumber, message } from "antd";
import { aiModelApi } from "@/lib/api";
import type { AiModel, AiModelInput } from "@/types";
import {
  PROVIDERS,
  DEFAULT_URLS,
  MODEL_ID_PLACEHOLDERS,
  MODEL_PRESETS,
  PROVIDER_NAME_MAP,
  DEFAULT_MAX_CONTEXT,
} from "@/lib/aiProviderPresets";

/**
 * 移动端「新增 AI 模型」对话框（MobileAi 列表 chip 区 / MobileAiChat 顶栏 Drawer 共用）。
 *
 * - 提供商切换 → 自动回填 名称 / API 地址 / 模型 ID（取该 provider 下第一个预设）
 * - 模型 ID：有预设的走 Select（带搜索）；无预设的（lmstudio/custom）走 Input
 * - 最大上下文 token：默认 32000，与桌面一致
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
  const [provider, setProvider] = useState(defaultProvider);

  // 每次打开都把 provider state 重置为 default（与 Form initialValues 同步）
  useEffect(() => {
    if (open) setProvider(defaultProvider);
  }, [open, defaultProvider]);

  function onProviderChange(p: string) {
    setProvider(p);
    const presets = MODEL_PRESETS[p] ?? [];
    form.setFieldsValue({
      name: PROVIDER_NAME_MAP[p] ?? p,
      api_url: DEFAULT_URLS[p] ?? "",
      model_id: presets[0]?.value ?? "",
    });
  }

  async function submit() {
    try {
      const values = await form.validateFields();
      const created = await aiModelApi.create(values);
      message.success(`已添加 ${created.name}`);
      onSaved(created);
      onClose();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`添加失败: ${e}`);
    }
  }

  const presetOptions = MODEL_PRESETS[provider] ?? [];

  return (
    <Modal
      title="新增 AI 模型"
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
        initialValues={{
          name: PROVIDER_NAME_MAP[defaultProvider] ?? defaultProvider,
          provider: defaultProvider,
          api_url: DEFAULT_URLS[defaultProvider] ?? "",
          api_key: "",
          model_id: MODEL_PRESETS[defaultProvider]?.[0]?.value ?? "",
          max_context: DEFAULT_MAX_CONTEXT,
        }}
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
          label="提供商"
          rules={[{ required: true }]}
        >
          {/* 移动端列表长、屏幕窄：开搜索并显示副文本，否则 20+ 条要滑很久 */}
          <Select
            showSearch
            onChange={onProviderChange}
            optionRender={(opt) => {
              const p = PROVIDERS.find((x) => x.value === opt.value);
              return (
                <div className="flex flex-col leading-tight py-0.5">
                  <span>{p?.label ?? opt.label}</span>
                  {p?.desc && (
                    <span className="text-xs text-slate-400">{p.desc}</span>
                  )}
                </div>
              );
            }}
            filterOption={(input, option) => {
              const q = input.trim().toLowerCase();
              if (!q) return true;
              const p = PROVIDERS.find((x) => x.value === option?.value);
              return (
                String(option?.value ?? "").toLowerCase().includes(q) ||
                (p?.label ?? "").toLowerCase().includes(q) ||
                (p?.desc ?? "").toLowerCase().includes(q)
              );
            }}
            options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Form.Item>
        <Form.Item
          name="api_url"
          label="API 地址"
          rules={[{ required: true, message: "请输入 API 地址" }]}
        >
          <Input placeholder={DEFAULT_URLS[provider] || "https://..."} />
        </Form.Item>
        <Form.Item name="api_key" label="API Key">
          <Input.Password placeholder="sk-..." />
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
              placeholder={MODEL_ID_PLACEHOLDERS[provider]}
              optionFilterProp="label"
            />
          ) : (
            <Input placeholder={MODEL_ID_PLACEHOLDERS[provider]} />
          )}
        </Form.Item>
        <Form.Item
          name="max_context"
          label="最大上下文 token"
          tooltip="影响发消息时拼接附加笔记的预算"
        >
          <InputNumber
            min={1024}
            max={1000000}
            step={1024}
            className="w-full"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
