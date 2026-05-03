import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Input,
  Modal,
  Segmented,
  Spin,
  message,
  theme as antdTheme,
} from "antd";
import Markdown from "react-markdown";
import {
  Sparkles,
  RefreshCcw,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { aiPlanApi, folderApi, noteApi } from "@/lib/api";
import type { TargetLength } from "@/types";
import { MicButton } from "@/components/MicButton";

interface DraftNoteModalProps {
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调；参数是新笔记 id */
  onSaved?: (noteId: number) => void;
}

interface DraftState {
  title: string;
  content: string;
  folderPath: string;
  reason: string | null;
}

const LENGTH_OPTIONS: Array<{ value: TargetLength; label: string }> = [
  { value: "short", label: "简短" },
  { value: "medium", label: "中等" },
  { value: "long", label: "长篇" },
];

/**
 * T-006 AI 写笔记并归档 Modal
 *
 * 三阶段：
 * 1. idle     用户填主题 / 参考材料 / 目标长度 → 生成
 * 2. loading  等待 AI 响应（5~20s）
 * 3. review   三栏：左原始输入；中 Markdown 预览；右 标题 + 目录路径编辑
 *
 * 保存时先调 `folderApi.ensurePath(folderPath)` 递归建目录（路径不存在则创建），
 * 再 `noteApi.create` 新建笔记，成功后跳转到编辑器。
 */
export function DraftNoteModal({ open, onClose, onSaved }: DraftNoteModalProps) {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"idle" | "loading" | "review">("idle");
  const [topic, setTopic] = useState("");
  const [reference, setReference] = useState("");
  const [targetLength, setTargetLength] = useState<TargetLength>("medium");
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setPhase("idle");
    setDraft(null);
    setReasonOpen(false);
    setErrorText(null);
  }

  async function handleGenerate() {
    if (!topic.trim()) {
      setErrorText("请填写笔记主题");
      return;
    }
    setPhase("loading");
    setErrorText(null);
    try {
      const resp = await aiPlanApi.draftNote({
        topic: topic.trim(),
        reference: reference.trim() || null,
        targetLength,
      });
      setDraft({
        title: resp.title,
        content: resp.content,
        folderPath: resp.folderPath ?? "",
        reason: resp.reason ?? null,
      });
      setPhase("review");
    } catch (e) {
      setErrorText(String(e));
      setPhase("idle");
    }
  }

  async function handleSave() {
    if (!draft) return;
    if (!draft.title.trim()) {
      message.warning("标题不能为空");
      return;
    }
    setSaving(true);
    try {
      const folderId = await folderApi.ensurePath(draft.folderPath.trim());
      const note = await noteApi.create({
        title: draft.title.trim(),
        content: draft.content,
        folder_id: folderId,
      });
      message.success("已保存");
      onSaved?.(note.id);
      reset();
      onClose();
      // 跳到编辑器继续打磨
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    if (saving) return;
    reset();
    setTopic("");
    setReference("");
    setTargetLength("medium");
    onClose();
  }

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <Sparkles size={16} style={{ color: token.colorPrimary }} />
          <span>AI 写笔记</span>
        </div>
      }
      open={open}
      onCancel={handleClose}
      width={phase === "review" ? 960 : 640}
      centered
      destroyOnHidden
      footer={null}
      styles={{ body: { maxHeight: "75vh", overflowY: "auto" } }}
    >
      {/* idle 阶段 */}
      {phase === "idle" && (
        <div className="flex flex-col gap-3">
          {errorText && (
            <Alert
              type="error"
              showIcon
              message={errorText}
              closable
              onClose={() => setErrorText(null)}
            />
          )}
          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 6,
              }}
            >
              主题 <span style={{ color: token.colorError }}>*</span>
            </div>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="要写什么？例：Rust 所有权入门 / 周报 2026-W17"
              maxLength={80}
              showCount
              allowClear
              suffix={
                <MicButton
                  stripTrailingPunctuation
                  onTranscribed={(text) =>
                    setTopic((prev) => (prev ? `${prev} ${text}` : text))
                  }
                />
              }
            />
          </div>

          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>参考材料（可选）</span>
              <MicButton
                onTranscribed={(text) =>
                  setReference((prev) => (prev ? `${prev}\n${text}` : text))
                }
              />
            </div>
            <Input.TextArea
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="贴进背景信息、要点、链接等，AI 会参考。留空则完全靠主题推断。"
              autoSize={{ minRows: 3, maxRows: 8 }}
              maxLength={2000}
              showCount
            />
          </div>

          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 6,
              }}
            >
              目标长度
            </div>
            <Segmented
              value={targetLength}
              onChange={(v) => setTargetLength(v as TargetLength)}
              options={LENGTH_OPTIONS}
            />
          </div>

          <div
            style={{
              fontSize: 12,
              color: token.colorTextTertiary,
              lineHeight: 1.7,
            }}
          >
            AI 会参考你的目录结构建议归档路径；不会读取笔记正文内容，不上传云端。
            <br />
            <strong>仅 OpenAI / DeepSeek / 智谱 / Claude 兼容模型可用；Ollama 暂不支持。</strong>
          </div>

          <div className="flex justify-end gap-2 mt-2">
            <Button onClick={handleClose}>取消</Button>
            <Button
              type="primary"
              icon={<Sparkles size={14} />}
              onClick={handleGenerate}
              disabled={!topic.trim()}
            >
              生成草稿
            </Button>
          </div>
        </div>
      )}

      {/* loading 阶段 */}
      {phase === "loading" && (
        <div className="flex flex-col items-center justify-center py-12">
          <Spin size="large" />
          <div
            style={{
              marginTop: 16,
              color: token.colorTextSecondary,
              fontSize: 13,
            }}
          >
            AI 正在写作中（通常需要 5~20 秒）…
          </div>
        </div>
      )}

      {/* review 阶段：三栏 */}
      {phase === "review" && draft && (
        <div className="flex flex-col gap-3">
          {draft.reason && (
            <div
              className="rounded-md"
              style={{
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              <button
                className="flex items-center gap-1.5"
                style={{ color: token.colorTextSecondary }}
                onClick={() => setReasonOpen(!reasonOpen)}
              >
                {reasonOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                AI 归档理由
              </button>
              {reasonOpen && (
                <div
                  style={{
                    marginTop: 6,
                    color: token.colorText,
                    lineHeight: 1.7,
                  }}
                >
                  {draft.reason}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            {/* 左栏：回顾输入 */}
            <div
              className="rounded-md p-3"
              style={{
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  marginBottom: 6,
                }}
              >
                你的输入
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: token.colorText,
                  marginBottom: 8,
                }}
              >
                <strong>主题：</strong>
                {topic}
              </div>
              {reference && (
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextSecondary,
                    whiteSpace: "pre-wrap",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                >
                  <strong>参考：</strong>
                  {reference}
                </div>
              )}
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  marginTop: 8,
                }}
              >
                长度：{LENGTH_OPTIONS.find((o) => o.value === targetLength)?.label}
              </div>
            </div>

            {/* 中栏：Markdown 预览 */}
            <div
              className="rounded-md p-3 ai-markdown"
              style={{
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                maxHeight: 420,
                overflowY: "auto",
                fontSize: 13,
              }}
            >
              <Markdown>{draft.content}</Markdown>
            </div>

            {/* 右栏：标题 + 目录编辑 */}
            <div className="flex flex-col gap-2">
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    marginBottom: 4,
                  }}
                >
                  标题
                </div>
                <Input
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                  placeholder="笔记标题"
                />
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    marginBottom: 4,
                  }}
                >
                  归档路径
                </div>
                <Input
                  value={draft.folderPath}
                  onChange={(e) =>
                    setDraft({ ...draft, folderPath: e.target.value })
                  }
                  placeholder="工作/周报  （空串 = 根目录；不存在会自动创建）"
                />
              </div>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    marginBottom: 4,
                  }}
                >
                  正文（直接编辑）
                </div>
                <Input.TextArea
                  value={draft.content}
                  onChange={(e) =>
                    setDraft({ ...draft, content: e.target.value })
                  }
                  autoSize={{ minRows: 8, maxRows: 12 }}
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 12,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button
              icon={<RefreshCcw size={14} />}
              onClick={() => setPhase("idle")}
              disabled={saving}
            >
              重新生成
            </Button>
            <div className="flex gap-2">
              <Button onClick={handleClose} disabled={saving}>
                取消
              </Button>
              <Button
                type="primary"
                icon={<CheckCircle2 size={14} />}
                onClick={handleSave}
                loading={saving}
              >
                保存并打开
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
