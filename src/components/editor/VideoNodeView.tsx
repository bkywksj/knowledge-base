/**
 * VideoNode 的 React NodeView
 *
 * - 顶部条：显示「视频名」（auto-numbered: 视频 1 / 视频 2 ...）+ 改名 + 📍 加时间戳按钮
 * - 中部：原生 <video controls preload="metadata">
 * - 视频块带 data-video-id="<id>" 属性，VideoTimestamp 跳转时通过此选择器定位
 * - 改名后写入 attrs.label；自动编号通过遍历 doc 拿"本节点是第几个 video"
 *
 * 跳转高亮：外部触发 setAttribute("data-highlight","true") 后 1.2s 自动移除（CSS 动画）
 */
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Button, Input, Tooltip, message } from "antd";
import { MapPin, Pencil, Check, X, Scissors } from "lucide-react";
import { insertVideoTimestamp } from "./VideoTimestamp";

export function VideoNodeView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const src: string = (node.attrs.src as string | null) ?? "";
  const id: string = (node.attrs.id as string | null) ?? "";
  const label: string = (node.attrs.label as string | null) ?? "";

  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(label);
  // 区间时间戳「两次打点」的待定起点：null=未开始；数字=已记起点 A，等第二次点记终点 B
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /** 自动编号：本节点在 doc 中是第几个 video（从 1 开始） */
  const autoIndex = useMemo(() => {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (typeof pos !== "number") return 1;
    let count = 0;
    let myIndex = 1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "video") {
        count += 1;
        if (p === pos) myIndex = count;
      }
      return true;
    });
    return myIndex;
  }, [editor.state.doc, getPos]);

  const displayLabel = label || `视频 ${autoIndex}`;
  const isEditable = editor?.isEditable !== false;

  function handleSaveLabel() {
    const trimmed = labelInput.trim();
    updateAttributes({ label: trimmed || null });
    setEditingLabel(false);
  }

  function handleCancelLabel() {
    setLabelInput(label);
    setEditingLabel(false);
  }

  function handleAddTimestamp() {
    const v = videoRef.current;
    if (!v) {
      message.error("视频还未加载，请稍后再试");
      return;
    }
    if (!id) {
      message.error("视频缺少 ID，请重新插入视频");
      return;
    }
    const seconds = Math.floor(v.currentTime);
    insertVideoTimestamp(editor, {
      videoId: id,
      seconds,
      label: `📹 ${displayLabel} · ${formatTime(seconds)}`,
    });
    message.success(`已插入时间戳：${formatTime(seconds)}`);
  }

  /**
   * 区间时间戳「两次打点」：
   *  - 第一次点击：记当前播放位置为起点 A
   *  - 第二次点击：记当前播放位置为终点 B，插入 A→B 区间 chip（点它会从 A 播到 B 自动暂停）
   * 终点早于起点时自动对调容错；终点==起点时提示。
   */
  function handleAddRange() {
    const v = videoRef.current;
    if (!v) {
      message.error("视频还未加载，请稍后再试");
      return;
    }
    if (!id) {
      message.error("视频缺少 ID，请重新插入视频");
      return;
    }
    const now = Math.floor(v.currentTime);

    // 第一次点击：记起点
    if (rangeStart === null) {
      setRangeStart(now);
      message.info(`已标记区间起点 ${formatTime(now)}，播到终点后再点一次`);
      return;
    }

    // 第二次点击：记终点并插入区间
    let start = rangeStart;
    let end = now;
    if (end === start) {
      message.warning("终点与起点相同，请播放一段后再标记终点");
      return;
    }
    if (end < start) {
      [start, end] = [end, start]; // 终点在起点前 → 对调容错
    }
    insertVideoTimestamp(editor, {
      videoId: id,
      seconds: start,
      endSeconds: end,
      label: `📹 ${displayLabel} · ${formatTime(start)}→${formatTime(end)}`,
    });
    message.success(`已插入区间：${formatTime(start)}→${formatTime(end)}`);
    setRangeStart(null);
  }

  // 阻止 toolbar mousedown 把焦点给 ProseMirror（点选项时光标乱跳）
  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <NodeViewWrapper
      className="tiptap-video-block"
      data-video-id={id || undefined}
    >
      <div className="tiptap-video-toolbar" contentEditable={false} onMouseDown={stopMouseDown}>
        {editingLabel ? (
          <span className="tiptap-video-label-edit">
            <Input
              size="small"
              value={labelInput}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setLabelInput(e.target.value)}
              onPressEnter={handleSaveLabel}
              autoFocus
              maxLength={32}
              style={{ width: 140 }}
            />
            <Button size="small" type="text" icon={<Check size={14} />} onClick={handleSaveLabel} />
            <Button size="small" type="text" icon={<X size={14} />} onClick={handleCancelLabel} />
          </span>
        ) : (
          <span className="tiptap-video-label" title={label ? "" : "自动编号"}>
            📹 {displayLabel}
          </span>
        )}

        <div className="tiptap-video-toolbar-spacer" />

        {isEditable && !editingLabel && (
          <>
            <Tooltip title="改名">
              <Button
                size="small"
                type="text"
                icon={<Pencil size={14} />}
                onClick={() => {
                  setLabelInput(label);
                  setEditingLabel(true);
                }}
              />
            </Tooltip>
            <Tooltip title="📍 在此插入当前播放位置的时间戳">
              <Button
                size="small"
                type="text"
                icon={<MapPin size={14} />}
                onClick={handleAddTimestamp}
              >
                加时间戳
              </Button>
            </Tooltip>
            {rangeStart === null ? (
              <Tooltip title="🎬 标记区间起点，播到终点后再点一次，生成 A→B 区间时间戳">
                <Button
                  size="small"
                  type="text"
                  icon={<Scissors size={14} />}
                  onClick={handleAddRange}
                >
                  加区间
                </Button>
              </Tooltip>
            ) : (
              <span className="tiptap-video-range-pending">
                <Tooltip title={`起点已记 ${formatTime(rangeStart)}，播到终点后点此结束`}>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<Scissors size={14} />}
                    onClick={handleAddRange}
                  >
                    标记终点（{formatTime(rangeStart)}→）
                  </Button>
                </Tooltip>
                <Tooltip title="取消区间标记">
                  <Button
                    size="small"
                    type="text"
                    icon={<X size={14} />}
                    onClick={() => setRangeStart(null)}
                  />
                </Tooltip>
              </span>
            )}
          </>
        )}
      </div>

      <video
        ref={videoRef}
        src={src}
        controls
        preload="metadata"
        className="tiptap-video"
      />
    </NodeViewWrapper>
  );
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${pad(m)}:${pad(sec)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
