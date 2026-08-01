/**
 * 编辑器底部「链接状态条」—— 常驻显示当前笔记的链接情况。
 *
 * 为什么是常驻状态条而不是工具栏按钮：
 * 用户要的是「随时知道这篇跟别的笔记怎么连着」，那就该一眼扫到，而不是点一下才出现。
 * 工具栏已经很挤，再塞按钮不划算；而编辑区底部是块闲置的横条，放三个计数正合适。
 *
 * 三类信息（一次 IPC 取回，见 linkApi.getLinkSummary）：
 *   · 链出 —— 本篇引用了谁
 *   · 链入 —— 谁引用了本篇（原来只有这个，在正文最末尾，长笔记要滚很久）
 *   · 断链 —— 写了 [[X]] 但 X 不存在 / 已删 / 已隐藏，能发现打错的链接
 *
 * 点任一计数展开明细浮层，可点条目跳转。断链那格只在真有断链时出现，
 * 平时不占位、不打扰。
 */
import { useState, useEffect, useCallback } from "react";
import { Popover, Empty, Typography } from "antd";
import { Link2, ArrowUpRight, ArrowDownLeft, Unlink } from "lucide-react";
import { linkApi } from "@/lib/api";
import type { NoteLinkSummary, LinkedNote } from "@/types";

const { Text } = Typography;

interface Props {
  /** 当前笔记 id；无效值（新建未落库）时整条不渲染 */
  noteId?: number;
  /** 点击条目跳转到目标笔记 */
  onNavigate: (id: number) => void;
  /**
   * 外部刷新信号：值一变就重新拉取。
   * 调用方在「保存完成」后 bump 它 —— 出链是保存时才同步进 note_links 的，
   * 不 bump 的话用户刚写完 [[X]] 状态条还是旧数字。
   */
  refreshKey?: number;
  /**
   * 大纲列占掉的横向空间（大纲宽 + 6px 分隔条）；大纲关闭时传 0。
   *
   * 为什么需要它：状态条挂在 .editor-body **外面**（内容区有 10vh padding-bottom，
   * 挂里面会被推离视觉底部），于是它的 100% 是整页宽，而卡片的 100% 是 grid
   * 正文轨道宽 —— 两者差的正是大纲列。dock 先用 padding 把这段吃掉，里层
   * 状态条的包含块宽度就与卡片轨道一致，再套同一份宽度公式即可严格对齐。
   */
  outlineSpace?: number;
  /** 大纲在左还是在右；关闭时传 undefined（dock 不加 padding） */
  outlinePos?: "left" | "right";
}

const EMPTY: NoteLinkSummary = { outgoing: [], incoming: [], broken: [] };

export function LinkStatusBar({
  noteId,
  onNavigate,
  refreshKey = 0,
  outlineSpace = 0,
  outlinePos,
}: Props) {
  const [summary, setSummary] = useState<NoteLinkSummary>(EMPTY);

  const load = useCallback(async () => {
    if (!Number.isFinite(noteId) || !noteId) {
      setSummary(EMPTY);
      return;
    }
    try {
      setSummary(await linkApi.getLinkSummary(noteId));
    } catch {
      // 状态条是辅助信息，拉不到就显示 0，不打扰用户
      setSummary(EMPTY);
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!Number.isFinite(noteId) || !noteId) return null;

  const { outgoing, incoming, broken } = summary;

  return (
    <div
      className="kb-link-status-dock"
      data-outline-pos={outlinePos}
      style={
        { "--kb-status-outline-space": `${outlineSpace}px` } as React.CSSProperties
      }
    >
      <div className="kb-link-status-bar">
        <Link2 size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
        <LinkCount
          icon={<ArrowUpRight size={12} />}
          label="链出"
          items={outgoing}
          emptyHint="这篇还没有引用别的笔记。在正文里输入 [[ 就能链接过去。"
          onNavigate={onNavigate}
        />
        <LinkCount
          icon={<ArrowDownLeft size={12} />}
          label="链入"
          items={incoming}
          emptyHint="还没有别的笔记引用这篇。在其他笔记里写 [[本篇标题]] 即可。"
          onNavigate={onNavigate}
        />
        {/* 断链只在真有的时候出现 —— 平时不占位、不制造焦虑 */}
        {broken.length > 0 && (
          <Popover
            trigger="click"
            placement="topLeft"
            title="断链"
            content={
              <div style={{ maxWidth: 320 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  这些 <Text code style={{ fontSize: 11 }}>[[…]]</Text>{" "}
                  找不到对应笔记（可能标题打错了，或目标已删除 / 已隐藏）：
                </Text>
                <div className="mt-2 max-h-48 overflow-auto">
                  {broken.map((t) => (
                    <div key={t} style={{ fontSize: 12, padding: "2px 0" }}>
                      · {t}
                    </div>
                  ))}
                </div>
              </div>
            }
          >
            <button
              className="kb-link-status-item kb-link-status-broken"
              type="button"
            >
              <Unlink size={12} />
              断链 {broken.length}
            </button>
          </Popover>
        )}
      </div>
    </div>
  );
}

/** 一格计数 + 点击展开的明细浮层 */
function LinkCount({
  icon,
  label,
  items,
  emptyHint,
  onNavigate,
}: {
  icon: React.ReactNode;
  label: string;
  items: LinkedNote[];
  emptyHint: string;
  onNavigate: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      title={`${label}（${items.length}）`}
      content={
        <div style={{ width: 280 }}>
          {items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {emptyHint}
                </Text>
              }
            />
          ) : (
            <div className="max-h-64 overflow-auto">
              {items.map((n) => (
                <div
                  key={n.id}
                  className="kb-link-status-row"
                  onClick={() => {
                    setOpen(false);
                    onNavigate(n.id);
                  }}
                >
                  {n.title}
                </div>
              ))}
            </div>
          )}
        </div>
      }
    >
      {/* 不挂 Tooltip：它和 Popover 是同一个触发元素，点开明细后 hover 提示会浮出来
          盖住浮层内容。计数本身已经自解释（「链出 3」），提示没有额外信息量。 */}
      <button className="kb-link-status-item" type="button">
        {icon}
        {label} {items.length}
      </button>
    </Popover>
  );
}
