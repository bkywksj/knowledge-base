/**
 * VideoTimestamp 的 React NodeView：渲染成可点 chip
 *
 * - 显示 attrs.label（如 "📹 视频 1 · 01:40"）
 * - 点击 → jumpToVideoTimestamp 找视频 + 跳秒数 + autoplay
 * - 视频不存在时 chip 变灰显示「视频已删除」（保留原 label 让用户能看出原本指向）
 * - 在编辑模式可被作为整体选中删除（atom node 默认行为）
 */
import { useEffect, useMemo, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { message } from "antd";
import { jumpToVideoTimestamp } from "./VideoTimestamp";

export function VideoTimestampNodeView({ node }: NodeViewProps) {
  const videoId: string = String(node.attrs.videoId ?? "");
  const seconds: number = Number(node.attrs.seconds ?? 0);
  const endSeconds: number = Number(node.attrs.endSeconds ?? 0);
  const label: string = String(node.attrs.label ?? "");
  const isRange = endSeconds > seconds;

  const [exists, setExists] = useState(true);

  // 视频是否存在：mount 时 + DOM 变化时检测一次（用 MutationObserver 监听 doc-level 增删）
  useEffect(() => {
    const check = () => {
      const found = !!document.querySelector(`[data-video-id="${cssEscape(videoId)}"]`);
      setExists((prev) => (prev === found ? prev : found));
    };
    check();
    // 编辑器挂载/视频删除等 DOM 变化时重检；observe 整个 body 太重，
    // 限制到 .ProseMirror 范围（编辑器挂载点）
    const root = document.querySelector(".ProseMirror") ?? document.body;
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-video-id"] });
    return () => observer.disconnect();
  }, [videoId]);

  const displayText = useMemo(() => {
    if (!exists) return label || "📹 视频已删除";
    if (label) return label;
    return isRange
      ? `📹 ${formatTime(seconds)}→${formatTime(endSeconds)}`
      : `📹 ${formatTime(seconds)}`;
  }, [exists, label, seconds, endSeconds, isRange]);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!exists) {
      message.warning("绑定的视频已被删除");
      return;
    }
    const result = jumpToVideoTimestamp(videoId, seconds, document, endSeconds);
    if (!result.ok) {
      message.warning(`跳转失败：${result.reason ?? "unknown"}`);
    }
  }

  const titleText = exists
    ? isRange
      ? `播放 ${formatTime(seconds)}→${formatTime(endSeconds)}（到终点自动暂停）`
      : `跳转到 ${formatTime(seconds)}`
    : "视频已删除";

  return (
    <NodeViewWrapper
      as="span"
      className={`video-ts-chip${isRange ? " video-ts-chip-range" : ""}${exists ? "" : " video-ts-chip-broken"}`}
      data-video-id={videoId}
      data-seconds={seconds}
      data-end-seconds={isRange ? endSeconds : undefined}
      onClick={handleClick}
      title={titleText}
    >
      {displayText}
    </NodeViewWrapper>
  );
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
