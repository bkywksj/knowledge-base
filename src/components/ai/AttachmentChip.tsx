import { Tag, Tooltip } from "antd";
import {
  FileSpreadsheet,
  FileText,
  FileType2,
  X,
  AlertTriangle,
} from "lucide-react";

import type { AttachmentPreview } from "@/types";

interface Props {
  attachment: AttachmentPreview;
  /** 移除按钮回调；不传则不显示移除按钮（用于只读展示场景） */
  onRemove?: () => void;
}

/**
 * AI 会话输入区的附件芯片：图标 · 文件名 · 元信息 · 截断徽标 · ❌ 移除。
 * 按 kind 切图标和元信息：Excel→行数、Text→行数、PDF→字符数。
 *
 * 单文件 chars_estimated > 30k 时变橙色，提醒用户「这个附件占了不少上下文」。
 */
export function AttachmentChip({ attachment, onRemove }: Props) {
  const heavy = attachment.charsEstimated > 30_000;
  const kb = Math.round(attachment.charsEstimated / 1000);

  const iconNode = pickIcon(attachment);
  const meta = pickMeta(attachment);
  const truncated = isTruncated(attachment);
  const truncatedHint = pickTruncatedHint(attachment);

  return (
    <Tag
      color={heavy ? "warning" : "blue"}
      icon={iconNode}
      closable={!!onRemove}
      closeIcon={<X size={12} />}
      onClose={(e) => {
        e.preventDefault();
        onRemove?.();
      }}
      className="flex items-center gap-1 py-1 px-2"
    >
      <Tooltip title={attachment.filePath}>
        <span className="font-medium">{attachment.displayName}</span>
      </Tooltip>
      <span className="text-xs opacity-70">{meta}</span>
      <span className="text-xs opacity-70">· ~{kb}k 字符</span>
      {truncated && (
        <Tooltip title={truncatedHint}>
          <AlertTriangle size={12} className="inline-block text-amber-500" />
        </Tooltip>
      )}
    </Tag>
  );
}

function pickIcon(a: AttachmentPreview) {
  switch (a.kind) {
    case "excel":
      return <FileSpreadsheet size={12} className="inline-block mr-1" />;
    case "pdf":
      return <FileType2 size={12} className="inline-block mr-1" />;
    case "text":
    default:
      return <FileText size={12} className="inline-block mr-1" />;
  }
}

function pickMeta(a: AttachmentPreview): string {
  switch (a.kind) {
    case "excel":
      return `· ${a.totalRows} 行`;
    case "text":
      return `· ${a.totalLines} 行`;
    case "pdf":
      return "· PDF 文字层";
  }
}

function isTruncated(a: AttachmentPreview): boolean {
  if (a.kind === "excel") return a.truncatedSheets.length > 0;
  return a.truncated;
}

function pickTruncatedHint(a: AttachmentPreview): string {
  if (a.kind === "excel") {
    return `已自动截断 sheet：${a.truncatedSheets.join("、")}`;
  }
  return "尾部已截断（单文件超过 60k 字符上限）";
}
