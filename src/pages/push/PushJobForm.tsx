import { useEffect, useState } from "react";
import { Button, Form, Input, Segmented, Select, Switch, TimePicker, message } from "antd";
import { Edit3, Plus } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { pushApi } from "@/lib/api";
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

/** 投递方式选项（可多选：两种可以同时开） */
export const CHANNEL_OPTIONS = [
  { label: "居中弹窗", value: "popup", desc: "独立小窗口弹到屏幕中央，不打扰主窗" },
  { label: "系统通知", value: "notification", desc: "右下角系统提示" },
];

/** 推送的 channels 是 JSON 字符串；脏数据回退成两种都开 */
export function parseChannels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* 脏数据回退默认 */
  }
  return ["popup", "notification"];
}

function toValues(job: PushJob | null): FormValues {
  if (!job) {
    return {
      name: "",
      prompt: "",
      model_id: null,
      time: dayjs("08:00", "HH:mm"),
      repeat_kind: "daily",
      weekdays: [1, 2, 3, 4, 5],
      channels: ["popup", "notification"],
      enabled: true,
    };
  }
  return {
    name: job.name,
    prompt: job.prompt,
    model_id: job.model_id,
    time: dayjs(job.schedule_time, "HH:mm"),
    repeat_kind: job.repeat_kind,
    // 每天重复的推送没存星期：给个周一到周五的默认，切到「每周」时不是一排空圆点
    weekdays: job.repeat_weekdays
      ? job.repeat_weekdays.split(",").map((x) => Number(x.trim()))
      : [1, 2, 3, 4, 5],
    channels: parseChannels(job.channels),
    enabled: job.enabled,
  };
}

interface Props {
  /** 编辑时传入；新建时为 null */
  editing: PushJob | null;
  /** 切换编辑对象时自增：表单按它重挂载、吃新的初始值 */
  formKey: number;
  models: AiModel[];
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** 保存成功后回调（刷新列表并停在这条上）；新建时带回新 id */
  onSaved: (id: number) => void;
  /** 新建态点取消：交给页面回到第一条 */
  onCancelNew: () => void;
}

/**
 * 推送编辑表单（v4：右侧常驻面板，原为弹窗）。
 * 字段、校验、保存逻辑与原弹窗一致；重复改分段 + 星期圆点，推送方式改两个可多选的切换块。
 */
export default function PushJobForm({
  editing,
  formKey,
  models,
  dirty,
  onDirtyChange,
  onSaved,
  onCancelNew,
}: Props) {
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const repeatKind = Form.useWatch("repeat_kind", form);
  const weekdays: number[] = Form.useWatch("weekdays", form) ?? [];
  const channels: string[] = Form.useWatch("channels", form) ?? [];

  // 切换编辑对象：回填表单（formKey 变化即重填）
  useEffect(() => {
    form.setFieldsValue(toValues(editing));
    onDirtyChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  /** 多选圆点 / 切换块：从表单实时取当前值再增删（连点时不吃渲染前的旧数组） */
  function toggleIn(k: "weekdays" | "channels", v: number | string) {
    const cur: Array<number | string> = form.getFieldValue(k) ?? [];
    form.setFieldValue(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
    onDirtyChange(true);
  }

  async function handleSave() {
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
      let id: number;
      if (editing) {
        await pushApi.update(editing.id, input);
        id = editing.id;
        message.success("已保存");
      } else {
        id = await pushApi.create(input);
        message.success("已创建");
      }
      onDirtyChange(false);
      onSaved(id);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (!editing) {
      onCancelNew();
      return;
    }
    form.setFieldsValue(toValues(editing));
    onDirtyChange(false);
  }

  return (
    <section className="kb-cards-panel kb-qc kb-prompt-edit">
      <div className="kb-qc-head">
        <span className="kb-qc-ico">{editing ? <Edit3 size={14} /> : <Plus size={14} />}</span>
        {editing ? "编辑推送" : "新建推送"}
      </div>
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={toValues(editing)}
        onValuesChange={() => onDirtyChange(true)}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
          <Input placeholder="例如：每日励志" maxLength={60} />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="提示词"
          tooltip="到点时这段提示词会交给 AI 执行，把生成结果推送给你"
          rules={[{ required: true, message: "请输入提示词" }]}
        >
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder="例如：用一句话给我一句今天的励志格言，简洁有力，不要解释"
            maxLength={2000}
            showCount
          />
        </Form.Item>

        <Form.Item name="model_id" label="模型服务" tooltip="留空使用默认的模型服务">
          <Select
            allowClear
            placeholder="默认模型服务"
            options={models.map((m) => ({
              label: `${m.name}（${m.provider}）`,
              value: m.id,
            }))}
          />
        </Form.Item>

        <Form.Item name="time" label="触发时间" rules={[{ required: true, message: "请选择时间" }]}>
          <TimePicker format="HH:mm" minuteStep={1} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item name="repeat_kind" label="重复">
          <Segmented
            block
            options={[
              { label: "每天", value: "daily" },
              { label: "每周", value: "weekly" },
            ]}
          />
        </Form.Item>
        {/* 星期圆点（原复选框组）：只在每周时出现 */}
        {/* 只注册字段（值是数组，由下方圆点 / 切换块写入），不渲染控件 */}
        <Form.Item name="weekdays" noStyle />
        {repeatKind === "weekly" && (
          <div className="kb-weekday-row">
            {WEEKDAY_OPTIONS.map((d) => {
              const on = weekdays.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  className={on ? "kb-weekday is-on" : "kb-weekday"}
                  onClick={() => toggleIn("weekdays", d.value)}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        )}

        {/* 推送方式：两种可以同时开（原型画成二选一，这里保留多选能力） */}
        {/* 只注册字段（值是数组，由下方圆点 / 切换块写入），不渲染控件 */}
        <Form.Item name="channels" noStyle />
        <div className="ant-form-item-label">
          <label>推送方式</label>
        </div>
        <div className="kb-channel-row">
          {CHANNEL_OPTIONS.map((c) => {
            const on = channels.includes(c.value);
            return (
              <button
                key={c.value}
                type="button"
                title={c.desc}
                className={on ? "kb-channel is-on" : "kb-channel"}
                onClick={() => toggleIn("channels", c.value)}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="kb-prompt-enable">
          <Form.Item name="enabled" valuePropName="checked" noStyle>
            <Switch />
          </Form.Item>
          <span>启用</span>
        </div>
      </Form>
      <div className="kb-prompt-actions">
        {/* 原型 .btn-o / .btn-p：30 高、圆角 6；关掉 antd 两字间自动空格（「取 消」「保 存」） */}
        <Button
          className="kb-bar-btn"
          autoInsertSpace={false}
          disabled={(!dirty && !!editing) || saving}
          onClick={handleCancel}
        >
          取消
        </Button>
        <Button
          type="primary"
          className="kb-bar-btn-p"
          autoInsertSpace={false}
          loading={saving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          {editing ? "保存" : "保存推送"}
        </Button>
      </div>
    </section>
  );
}
