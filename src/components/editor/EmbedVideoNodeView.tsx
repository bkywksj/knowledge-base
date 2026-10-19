/**
 * EmbedVideoNode 的 React NodeView
 *
 * - 顶部条：平台名 + 原链接（点击在系统浏览器打开）+ 删除按钮
 * - 中部：16:9 响应式 iframe 容器
 * - 加载失败兜底：networkidle 后仍 0 高度，显示"无法加载，点击在浏览器打开"
 */
import { useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Button, Tooltip, message } from "antd";
import { Copy, ExternalLink, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EmbedProviderId } from "./embedVideoProviders";

import { useEditorEditable } from "./useEditorEditable";
const PROVIDER_DISPLAY: Record<EmbedProviderId, { label: string; icon: string }> = {
  bilibili: { label: "B站", icon: "📺" },
  youtube: { label: "YouTube", icon: "▶️" },
  qq: { label: "腾讯视频", icon: "🎬" },
  youku: { label: "优酷", icon: "🎞️" },
  vimeo: { label: "Vimeo", icon: "🎥" },
  twitch: { label: "Twitch", icon: "🎮" },
  dailymotion: { label: "Dailymotion", icon: "🎞️" },
  generic: { label: "网络视频", icon: "🌐" },
};

export function EmbedVideoNodeView({ node, editor, deleteNode }: NodeViewProps) {
  const src: string = (node.attrs.src as string | null) ?? "";
  const originalUrl: string =
    (node.attrs.originalUrl as string | null) ?? src;
  const provider: EmbedProviderId =
    (node.attrs.provider as EmbedProviderId | null) ?? "generic";
  const display = PROVIDER_DISPLAY[provider] ?? PROVIDER_DISPLAY.generic;

  const isEditable = useEditorEditable(editor);
  const [iframeError, setIframeError] = useState(false);

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  async function openInBrowser() {
    try {
      await openUrl(originalUrl);
    } catch {
      // opener 插件失败时兜底用 window.open（浏览器策略可能被拦，但聊胜于无）
      window.open(originalUrl, "_blank");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(originalUrl);
      message.success("已复制链接");
    } catch {
      message.error("复制失败");
    }
  }

  return (
    <NodeViewWrapper
      className="tiptap-embed-video-block"
      data-embed-provider={provider}
    >
      <div
        className="tiptap-embed-video-toolbar"
        contentEditable={false}
        onMouseDown={stopMouseDown}
      >
        <span className="tiptap-embed-video-label">
          {display.icon} {display.label}
        </span>

        <Tooltip title={originalUrl}>
          <button
            type="button"
            className="tiptap-embed-video-link"
            onClick={openInBrowser}
          >
            <ExternalLink size={12} />
            <span className="tiptap-embed-video-link-text">
              {truncateUrl(originalUrl)}
            </span>
          </button>
        </Tooltip>

        <div className="tiptap-embed-video-toolbar-spacer" />

        <Tooltip title="复制链接">
          <Button
            size="small"
            type="text"
            icon={<Copy size={14} />}
            onClick={copyLink}
          />
        </Tooltip>

        {isEditable && (
          <Tooltip title="移除嵌入视频">
            <Button
              size="small"
              type="text"
              danger
              icon={<Trash2 size={14} />}
              onClick={() => deleteNode()}
            />
          </Tooltip>
        )}
      </div>

      <div className="tiptap-embed-video-frame">
        {iframeError ? (
          <div className="tiptap-embed-video-error">
            视频加载失败 ·
            <Button type="link" size="small" onClick={openInBrowser}>
              在浏览器打开
            </Button>
          </div>
        ) : (
          <iframe
            src={src}
            title={`${display.label} 嵌入视频`}
            allow="fullscreen; encrypted-media; picture-in-picture; autoplay"
            loading="lazy"
            onError={() => setIframeError(true)}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

function truncateUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}
