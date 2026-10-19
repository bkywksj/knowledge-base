/**
 * 设置 → 待办提醒：「粘贴识别方式」。
 * 新建待办时粘贴通知文字，用本地规则 / AI 哪种方式识别标题和时间。
 */
import { useEffect, useState } from "react";
import { App as AntdApp, Select, Typography } from "antd";

import { configApi } from "@/lib/api";

const { Text } = Typography;

export const TASK_RECOGNIZE_MODE_KEY = "task_recognize_mode";
export type TaskRecognizeMode = "local" | "auto" | "ai";

export function normalizeRecognizeMode(
  v: string | null | undefined,
): TaskRecognizeMode {
  return v === "local" || v === "ai" ? v : "auto";
}

export default function TaskRecognizeModeRow() {
  const { message } = AntdApp.useApp();
  const [mode, setMode] = useState<TaskRecognizeMode>("auto");

  useEffect(() => {
    configApi
      .get(TASK_RECOGNIZE_MODE_KEY)
      .then((v) => setMode(normalizeRecognizeMode(v)))
      .catch(() => {});
  }, []);

  async function change(v: TaskRecognizeMode) {
    setMode(v);
    try {
      await configApi.set(TASK_RECOGNIZE_MODE_KEY, v);
    } catch (e) {
      message.error(`保存失败：${e}`);
    }
  }

  return (
    <div
      className="flex items-center justify-between py-1"
      style={{
        borderTop: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
        marginTop: 8,
        paddingTop: 12,
      }}
    >
      <div>
        <div>粘贴识别方式</div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          新建待办时往标题粘贴一段通知，自动识别标题、时间、子任务。
          AI 会把原文发给所配置的模型服务（选 Ollama 等本地模型则不出本机）
        </Text>
      </div>
      <Select
        value={mode}
        onChange={(v) => void change(v)}
        style={{ width: 200 }}
        options={[
          { value: "local", label: "仅本地规则（不联网）" },
          { value: "auto", label: "本地优先，不确定时用 AI" },
          { value: "ai", label: "总是用 AI" },
        ]}
      />
    </div>
  );
}
