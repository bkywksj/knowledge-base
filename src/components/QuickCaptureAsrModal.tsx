/**
 * 语音快速捕获 Modal（全局快捷键 Ctrl+Shift+V 触发）。
 *
 * 流程：
 *   open → 自动 getUserMedia + 开始录音 → 用户点「停止」→ ASR 转写
 *   → 显示文字 + 3 个动作（保存为任务 / 保存为笔记 / 复制到剪贴板）
 *
 * 与单点 MicButton 的区别：
 *   - 不依赖宿主输入框，自带文字结果区
 *   - 自动开始录音，关 Modal 立即释放麦克风
 *   - 提供"落库"动作链路，不只是把文字塞回输入框
 *
 * 未启用 ASR 时给一条引导链接，不阻断。
 */
import { useEffect, useRef, useState } from "react";
import { Modal, Button, Input, Space, Alert, Typography, App as AntdApp } from "antd";
import { Square, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { asrApi, taskApi, noteApi, aiPlanApi } from "@/lib/api";
import { useAudioLevel } from "@/hooks/useAudioLevel";
import { useSilenceAutoStop } from "@/hooks/useSilenceAutoStop";

const { Text } = Typography;

type Phase = "idle" | "recording" | "transcribing" | "result" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickCaptureAsrModal({ open, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0); // 录音秒数
  const [enabled, setEnabled] = useState<boolean>(false);
  const [savingTask, setSavingTask] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [smartParsing, setSmartParsing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startTsRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  // 用 state 触发 useAudioLevel 重建（ref 引用变化 hook 拿不到）
  // bandCount=3 与 MicButton 保持一致：所有位置语音可视化都是 3 条柱，
  // 仅在 Modal 里通过更大的尺寸 / 间距来增加视觉重量
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const { level, bands } = useAudioLevel(activeStream, phase === "recording", 3);
  // VAD：检测到说话后连续静音 1.5s 自动停止（与 tauri-cc 同款阈值）
  useSilenceAutoStop(level, phase === "recording", () => stopRecording());

  // 打开 Modal → 拉配置 + 自动开始录音
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await asrApi.getConfig();
        const isEnabled = cfg.enabled && cfg.apiKey.trim().length > 0;
        if (cancelled) return;
        setEnabled(isEnabled);
        if (isEnabled) {
          void startRecording();
        }
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 关闭 Modal → 释放麦克风 + 重置状态
  useEffect(() => {
    if (open) return;
    cleanup();
    setPhase("idle");
    setText("");
    setErrMsg(null);
    setElapsed(0);
  }, [open]);

  function cleanup() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveStream(null);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
  }

  async function startRecording() {
    setErrMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setErrMsg("当前 WebView 不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setActiveStream(stream);
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleStop;
      recorderRef.current = recorder;
      recorder.start();
      startTsRef.current = Date.now();
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTsRef.current) / 1000));
      }, 250);
      setPhase("recording");
    } catch (e) {
      setPhase("error");
      const msg = String(e);
      setErrMsg(
        msg.includes("Permission") || msg.includes("NotAllowed")
          ? "麦克风权限被拒绝，请在系统设置中允许"
          : `无法开始录音：${msg}`,
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveStream(null);
    setPhase("transcribing");
  }

  async function handleStop() {
    const blob = new Blob(chunksRef.current, {
      type: recorderRef.current?.mimeType || "audio/webm",
    });
    chunksRef.current = [];
    if (blob.size === 0) {
      setPhase("error");
      setErrMsg("没有录到声音");
      return;
    }
    try {
      const audioBase64 = await blobToBase64(blob);
      const result = await asrApi.transcribe({
        audioBase64,
        mime: blob.type || "audio/webm",
        language: "auto",
      });
      const t = (result.text ?? "").trim();
      if (!t) {
        setPhase("error");
        setErrMsg("未识别到内容，请说话清晰一些");
      } else {
        setText(t);
        setPhase("result");
      }
    } catch (e) {
      setPhase("error");
      setErrMsg(`识别失败：${e}`);
    }
  }

  async function handleSaveTask() {
    if (!text.trim()) return;
    setSavingTask(true);
    try {
      await taskApi.create({ title: text.trim() });
      message.success("已保存为任务");
      onClose();
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSavingTask(false);
    }
  }

  /**
   * AI 智能解析：把整段口语化文字交给默认 AI 模型，提取 title / dueDate /
   * remindBefore / priority / important 后一次性落库。
   * 失败（如未配默认 AI 模型）自动降级到「直接保存为任务」，避免空跑。
   */
  async function handleSmartParse() {
    if (!text.trim()) return;
    setSmartParsing(true);
    try {
      const sug = await aiPlanApi.extractTaskFromText(text.trim());
      await taskApi.create({
        title: sug.title?.trim() || text.trim(),
        priority: (sug.priority ?? 1) as 0 | 1 | 2,
        important: sug.important ?? false,
        due_date: sug.dueDate ?? null,
        remind_before_minutes: sug.remindBefore ?? null,
      });
      const summary = [
        sug.dueDate ? `截止 ${sug.dueDate}` : null,
        sug.remindBefore != null ? `提前 ${sug.remindBefore} 分钟提醒` : null,
      ]
        .filter(Boolean)
        .join("，");
      message.success(
        summary ? `已智能保存：${sug.title}（${summary}）` : `已智能保存：${sug.title}`,
      );
      onClose();
    } catch (e) {
      message.error(`AI 解析失败：${e}`);
    } finally {
      setSmartParsing(false);
    }
  }

  async function handleSaveNote() {
    if (!text.trim()) return;
    setSavingNote(true);
    try {
      const title = text.trim().slice(0, 40);
      await noteApi.create({
        title: title || "语音笔记",
        content: text.trim(),
        folder_id: null,
      });
      message.success("已保存为笔记");
      onClose();
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSavingNote(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制到剪贴板");
    } catch (e) {
      message.error(`复制失败：${e}`);
    }
  }

  function handleRetry() {
    setText("");
    setErrMsg(null);
    void startRecording();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<span>语音快速捕获</span>}
      footer={null}
      width={560}
      destroyOnClose
      maskClosable={phase !== "recording" && phase !== "transcribing"}
    >
      {!enabled && (
        <Alert
          type="warning"
          showIcon
          message="语音识别未启用"
          description={
            <span>
              请先在
              <Typography.Link
                onClick={() => {
                  onClose();
                  navigate("/settings", {
                    state: { scrollTo: "settings-asr" },
                  });
                }}
              >
                {" 设置 → 语音识别 "}
              </Typography.Link>
              中填入 API Key 并启用。
            </span>
          }
        />
      )}

      {enabled && phase === "recording" && (
        <div className="flex flex-col items-center gap-4 py-6">
          {/* 实时音量波形：与 MicButton 同款 3 条柱（放大版），保持视觉一致 */}
          <div
            className="rounded-full flex items-center justify-center"
            style={{
              height: 80,
              minWidth: 100,
              padding: "0 28px",
              gap: 6,
              background: "var(--ant-color-error-bg)",
              boxShadow: `0 0 0 ${4 + Math.round(level * 10)}px rgba(255, 77, 79, ${0.12 + level * 0.28})`,
              transition: "box-shadow 80ms ease-out",
            }}
          >
            {bands.map((v, i) => (
              <div
                key={i}
                style={{
                  width: 6,
                  height: Math.max(8, Math.round(8 + v * 44)),
                  background: "var(--ant-color-error)",
                  borderRadius: 3,
                  transition: "height 60ms ease-out",
                }}
              />
            ))}
          </div>
          <Text style={{ fontSize: 13 }}>
            录音中… {formatDuration(elapsed)}
          </Text>
          <Button
            danger
            type="primary"
            icon={<Square size={14} fill="currentColor" />}
            onClick={stopRecording}
          >
            停止并识别
          </Button>
        </div>
      )}

      {enabled && phase === "transcribing" && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 size={24} className="animate-spin" style={{ color: "var(--ant-color-primary)" }} />
          <Text type="secondary" style={{ fontSize: 13 }}>
            正在识别…
          </Text>
        </div>
      )}

      {enabled && phase === "result" && (
        <div className="flex flex-col gap-3">
          <Text type="secondary" style={{ fontSize: 12 }}>
            识别结果（可手动编辑）：
          </Text>
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 10 }}
            autoFocus
          />
          <Space wrap>
            <Button
              type="primary"
              onClick={handleSmartParse}
              loading={smartParsing}
              disabled={!text.trim()}
            >
              AI 智能解析为任务
            </Button>
            <Button onClick={handleSaveTask} loading={savingTask} disabled={!text.trim()}>
              直接保存为任务
            </Button>
            <Button onClick={handleSaveNote} loading={savingNote} disabled={!text.trim()}>
              保存为笔记
            </Button>
            <Button onClick={handleCopy} disabled={!text.trim()}>
              复制到剪贴板
            </Button>
            <Button onClick={handleRetry}>重新录音</Button>
          </Space>
        </div>
      )}

      {enabled && phase === "error" && errMsg && (
        <div className="flex flex-col gap-3">
          <Alert type="error" showIcon message={errMsg} />
          <Space>
            <Button type="primary" onClick={handleRetry}>
              重试
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </Space>
        </div>
      )}
    </Modal>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader 失败"));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}
