import { useState } from "react";
import { Modal, Input, Alert, Typography, message } from "antd";
import { Globe } from "lucide-react";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { useNavigate } from "react-router-dom";

const { Text } = Typography;

interface Props {
  open: boolean;
  /** 把笔记落到哪个文件夹（不传 = 根目录） */
  folderId?: number | null;
  onClose: () => void;
}

/**
 * T-014 网页剪藏 Modal
 *
 * 输入 URL → 后端直连原网页、readability 提正文转 markdown → 创建笔记 → 跳转到编辑器。
 * 失败时保留输入框，提示用户重试或换 URL。
 */
export function ClipUrlModal({ open, folderId, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  function reset() {
    setUrl("");
    setLoading(false);
  }

  async function handleSubmit() {
    const trimmed = url.trim();
    if (!trimmed) {
      message.warning("请输入网页 URL");
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      message.warning("URL 必须以 http:// 或 https:// 开头");
      return;
    }
    setLoading(true);
    try {
      const note = await noteApi.clipUrl(trimmed, folderId ?? null);
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
      message.success(`剪藏成功：${note.title}`);
      reset();
      onClose();
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`剪藏失败：${e}`);
      setLoading(false);
    }
  }

  return (
    <Modal
      title={
        <span className="inline-flex items-center gap-2">
          <Globe size={16} />
          剪藏网页到笔记
        </span>
      }
      open={open}
      onOk={handleSubmit}
      onCancel={() => {
        if (loading) return;
        reset();
        onClose();
      }}
      okText={loading ? "抓取中…" : "剪藏"}
      cancelText="取消"
      confirmLoading={loading}
      destroyOnHidden
      width={520}
    >
      <div className="flex flex-col gap-3">
        <Alert
          type="info"
          showIcon
          message={
            <span className="text-[12px]">
              直连原网页提取正文为 markdown，自动剥离侧栏 / 广告；正文图片一并下载到本地，离线可看。需联网。
            </span>
          }
        />
        <Input.TextArea
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴 URL，例如 https://example.com/article"
          autoFocus
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={loading}
          onPressEnter={(e) => {
            // 支持 Cmd/Ctrl+Enter 提交（普通回车留给换行 / 长 URL 折行）
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          快捷键：<Text code style={{ fontSize: 11 }}>Ctrl/⌘ + Enter</Text> 直接提交
        </Text>
      </div>
    </Modal>
  );
}
