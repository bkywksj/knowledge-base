import { useState } from "react";
import { Modal, Input, Alert, Typography, message } from "antd";
import { Globe } from "lucide-react";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { useNavigate } from "react-router-dom";
import { extractFirstUrl } from "@/lib/extractUrl";

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

  // 实时识别粘贴文本里的链接：既用于回显确认，也用于禁用提交按钮
  const detected = extractFirstUrl(url.trim());

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
    // 允许直接粘贴「标题 - 站点 - 作者 https://...」这类分享文本，自动把链接捞出来
    const target = extractFirstUrl(trimmed);
    if (!target) {
      message.warning("没找到链接，请粘贴以 http:// 或 https:// 开头的网址");
      return;
    }
    setLoading(true);
    try {
      const note = await noteApi.clipUrl(target, folderId ?? null);
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
      message.success(`剪藏成功：${note.title}`);
      reset();
      onClose();
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`剪藏失败：${e}`);
      // 只关 loading、不关弹窗：URL 还留在输入框里，用户直接再点一次就是重试。
      // 剪藏失败多是临时的（对方限流 / 需要登录 / 网络抖动），不需要额外的排队机制。
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
              <br />
              可直接粘贴「标题 + 链接」的整段分享文本，会自动识别其中的网址。
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
        {/* 粘了整段文本时回显识别结果，让用户提交前就能确认抓的是不是那条链接 */}
        {detected && detected !== url.trim() && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            将剪藏：<Text code style={{ fontSize: 11 }}>{detected}</Text>
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          快捷键：<Text code style={{ fontSize: 11 }}>Ctrl/⌘ + Enter</Text> 直接提交
        </Text>
      </div>
    </Modal>
  );
}
