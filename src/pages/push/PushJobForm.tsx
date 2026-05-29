import { useEffect, useState } from "react";
import {
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Switch,
  TimePicker,
  message,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { aiModelApi, pushApi } from "@/lib/api";
import type {
  AiModel,
  CreatePushJobInput,
  PushJob,
  PushRepeatKind,
} from "@/types";

/** ISO 周几选项：1=Mon..7=Sun */
const WEEKDAY_OPTIONS = [
  { label: "一", value: 1 },
  { label: "二", value: 2 },
  { label: "三", value: 3 },
  { label: "四", value: 4 },
  { label: "五", value: 5 },
  { label: "六", value: 6 },
  { label: "日", value: 7 },
];

interface FormValues {
  name: string;
  prompt: string;
  model_id: number | null;
  time: Dayjs;
  repeat_kind: PushRepeatKind;
  weekdays: number[];
  channels: string[];
  enabled: boolean;
}

/** 投递方式选项 */
const CHANNEL_OPTIONS = [
  { label: "居中弹窗", value: "popup" },
  { label: "系统通知", value: "notification" },
];

interface Props {
  open: boolean;
  /** 编辑时传入；新建时为 null */
  editing: PushJob | null;
  onClose: () => void;
  /** 保存成功后回调（刷新列表） */
  onSaved: () => void;
}

export default function PushJobForm({ open, editing, onClose, onSaved }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [models, setModels] = useState<AiModel[]>([]);
  const [saving, setSaving] = useState(false);
  const repeatKind = Form.useWatch("repeat_kind", form);

  // 打开时加载模型列表 + 回填表单
  useEffect(() => {
    if (!open) return;
    aiModelApi.list().then(setModels).catch(() => setModels([]));
    if (editing) {
      let channels: string[] = ["popup", "notification"];
      try {
        const parsed = JSON.parse(editing.channels);
        if (Array.isArray(parsed) && parsed.length) channels = parsed;
      } catch {
        /* 脏数据回退默认 */
      }
      form.setFieldsValue({
        name: editing.name,
        prompt: editing.prompt,
        model_id: editing.model_id,
        time: dayjs(editing.schedule_time, "HH:mm"),
        repeat_kind: editing.repeat_kind,
        weekdays: editing.repeat_weekdays
          ? editing.repeat_weekdays.split(",").map((x) => Number(x.trim()))
          : [],
        channels,
        enabled: editing.enabled,
      });
    } else {
      form.setFieldsValue({
        name: "",
        prompt: "",
        model_id: null,
        time: dayjs("08:00", "HH:mm"),
        repeat_kind: "daily",
        weekdays: [1, 2, 3, 4, 5],
        channels: ["popup", "notification"],
        enabled: true,
      });
    }
  }, [open, editing, form]);

  async function handleOk() {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败，antd 已高亮
    }
    if (values.repeat_kind === "weekly" && values.weekdays.length === 0) {
      message.warning("每周重复至少选择一天");
      return;
    }
    if (!values.channels || values.channels.length === 0) {
      message.warning("至少选择一种推送方式");
      return;
    }
    const input: CreatePushJobInput = {
      name: values.name.trim(),
      prompt: values.prompt.trim(),
      model_id: values.model_id ?? null,
      schedule_time: values.time.format("HH:mm"),
      repeat_kind: values.repeat_kind,
      repeat_weekdays:
        values.repeat_kind === "weekly"
          ? values.weekdays.slice().sort((a, b) => a - b).join(",")
          : null,
      channels: JSON.stringify(values.channels),
      enabled: values.enabled,
    };
    setSaving(true);
    try {
      if (editing) {
        await pushApi.update(editing.id, input);
        message.success("已保存");
      } else {
        await pushApi.create(input);
        message.success("已创建");
      }
      onSaved();
      onClose();
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? "编辑推送" : "新建推送"}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      width={560}
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4">
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: "请输入名称" }]}
        >
          <Input placeholder="例如：每日励志" maxLength={60} />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="提示词"
          tooltip="到点时这段提示词会交给 AI 执行，把生成结果推送给你"
          rules={[{ required: true, message: "请输入提示词" }]}
        >
          <Input.TextArea
            rows={4}
            placeholder="例如：用一句话给我一句今天的励志格言，简洁有力，不要解释"
            maxLength={2000}
            showCount
          />
        </Form.Item>

        <Form.Item name="model_id" label="AI 模型" tooltip="留空使用默认模型">
          <Select
            allowClear
            placeholder="默认模型"
            options={models.map((m) => ({
              label: `${m.name}（${m.provider}）`,
              value: m.id,
            }))}
          />
        </Form.Item>

        <div className="flex gap-4">
          <Form.Item
            name="time"
            label="触发时间"
            rules={[{ required: true, message: "请选择时间" }]}
          >
            <TimePicker format="HH:mm" minuteStep={1} className="w-32" />
          </Form.Item>

          <Form.Item name="repeat_kind" label="重复" className="flex-1">
            <Select
              options={[
                { label: "每天", value: "daily" },
                { label: "每周", value: "weekly" },
              ]}
            />
          </Form.Item>
        </div>

        {repeatKind === "weekly" && (
          <Form.Item name="weekdays" label="星期">
            <Checkbox.Group options={WEEKDAY_OPTIONS} />
          </Form.Item>
        )}

        <Form.Item
          name="channels"
          label="推送方式"
          tooltip="居中弹窗 = 独立小窗口弹到屏幕中央，不打扰主窗；系统通知 = 右下角系统提示"
        >
          <Checkbox.Group options={CHANNEL_OPTIONS} />
        </Form.Item>

        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
