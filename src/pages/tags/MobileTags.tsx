import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal, message } from "antd";
import { tagApi } from "@/lib/api";
import type { Tag } from "@/types";
import { TAG_COLORS } from "@/components/TagColorPicker";
import { MGroup, MNavBar, MRow, MSectionHeader } from "@/components/mobile/primitives";
import { MSheet } from "@/components/mobile/MSheet";
import { TextPromptModal } from "@/components/mobile/TextPromptModal";

/**
 * 移动端标签管理页（v4 样式，交互同原版）
 *
 * 路由 /tags —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * - 顶栏：返回 + 「标签」 + 新增
 * - 标签云（按 note_count 降序，字号随使用频率）
 * - 标签列表：点名字看相关笔记（暂跳搜索 ?q=#tag）；右侧调色盘 → 底部面板：颜色 / 重命名 / 查看笔记 / 删除
 *
 * 颜色与 PC 统一用十六进制（TAG_COLORS）：旧版手机端写的是 blue / green 这类名字，PC 认不出、显示成无色；
 * 读的时候两种都认（tagDot），写入一律十六进制。
 */

/** 手机面板里给的色板：取 PC 色板第一排 10 色，够挑又不至于一屏放不下 */
const PALETTE = TAG_COLORS.slice(0, 10);

/** 旧版手机端存的颜色名 → 对应的 PC 色值 */
const LEGACY_COLOR: Record<string, string> = {
  blue: "#1677ff",
  green: "#52c41a",
  orange: "#fa8c16",
  purple: "#722ed1",
  pink: "#eb2f96",
  yellow: "#faad14",
  red: "#f5222d",
  cyan: "#13c2c2",
  slate: "#8c8c8c",
};

function tagDot(color: string | null): string {
  if (!color) return "var(--m-ink4)";
  return LEGACY_COLOR[color] ?? color;
}

/** 按 note_count 决定标签云字号（最小 13，保持 ≥12 的可读下限） */
function fontByCount(n: number, maxCount: number): { fontSize: number; fontWeight: number } {
  if (maxCount === 0) return { fontSize: 14, fontWeight: 500 };
  const ratio = n / maxCount;
  if (ratio >= 0.7) return { fontSize: 16, fontWeight: 700 };
  if (ratio >= 0.4) return { fontSize: 14, fontWeight: 600 };
  return { fontSize: 13, fontWeight: 500 };
}

export function MobileTags() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tagApi.list();
      setTags(list);
      // 面板开着时同步最新数据（改颜色后勾选要跟着变）
      setEditing((cur) => (cur ? list.find((t) => t.id === cur.id) ?? null : null));
    } catch (e) {
      console.error("[MobileTags] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = [...tags].sort((a, b) => b.note_count - a.note_count);
  const maxCount = sorted[0]?.note_count ?? 0;

  async function createNew(name: string) {
    try {
      await tagApi.create(name);
      message.success("已创建");
      await load();
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  async function setColor(t: Tag, color: string | null) {
    try {
      await tagApi.setColor(t.id, color);
      message.success("颜色已更新");
      await load();
    } catch (e) {
      message.error(`更新失败: ${e}`);
    }
  }

  async function submitRename(name: string) {
    if (!editing) return;
    try {
      await tagApi.rename(editing.id, name);
      message.success("已重命名");
      await load();
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  }

  function deleteTag(t: Tag) {
    Modal.confirm({
      title: `删除「#${t.name}」？`,
      content: "关联的笔记会失去这个标签。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        try {
          await tagApi.delete(t.id);
          message.success("已删除");
          setEditing(null);
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  function gotoTagNotes(t: Tag) {
    // 暂用搜索关键字代替专门的 tag 过滤路由
    navigate(`/search?q=${encodeURIComponent("#" + t.name)}`);
  }

  return (
    <div className="mx-auto w-full max-w-[860px] pb-12">
      <MNavBar
        onBack={() => navigate(-1)}
        title="标签"
        actions={
          <button type="button" aria-label="新增标签" className="m-icon-btn" style={{ color: "var(--m-accent-ink)" }} onClick={() => setCreateOpen(true)}>
            <Plus size={22} />
          </button>
        }
      />

      {/* 标签云 */}
      <div className="m-px mt-2">
        <MSectionHeader className="mb-2 px-1" title="标签云" action={<span className="m-t-cap">按使用频率</span>} />
        <MGroup className="p-3">
          {loading ? (
            <div className="m-t-meta py-4 text-center">加载中…</div>
          ) : sorted.length === 0 ? (
            <div className="m-t-meta py-4 text-center">还没有标签，点右上 + 新建</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sorted.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => gotoTagNotes(t)}
                  className="m-chip gap-1.5"
                  style={{ background: "var(--m-well)", color: "var(--m-ink)", ...fontByCount(t.note_count, maxCount) }}
                >
                  <span className="m-dot" style={{ background: tagDot(t.color) }} />#{t.name}
                  <span className="m-num" style={{ color: "var(--m-ink3)", fontWeight: 500 }}>
                    {t.note_count}
                  </span>
                </button>
              ))}
            </div>
          )}
        </MGroup>
      </div>

      {/* 标签列表 */}
      {sorted.length > 0 && (
        <div className="m-px mt-6">
          <MSectionHeader className="mb-2 px-1" title="全部" count={`${sorted.length} 个标签`} />
          <MGroup>
            {sorted.map((t, i) => (
              <div key={t.id} className="relative flex min-h-[52px] items-center gap-3 pr-1 pl-4">
                {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-[44px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
                <span className="m-dot" style={{ background: tagDot(t.color) }} />
                <button type="button" onClick={() => gotoTagNotes(t)} className="min-w-0 flex-1 self-stretch truncate text-left text-[15px] font-medium" style={{ color: "var(--m-ink)" }}>
                  #{t.name}
                </button>
                <span className="m-t-meta m-num">{t.note_count}</span>
                <button type="button" onClick={() => setEditing(t)} aria-label={`编辑「#${t.name}」`} className="m-icon-btn shrink-0" style={{ color: "var(--m-ink3)" }}>
                  <Palette size={18} />
                </button>
              </div>
            ))}
          </MGroup>
        </div>
      )}

      {/* 编辑面板：颜色 / 重命名 / 查看笔记 / 删除 */}
      <MSheet open={!!editing} title={editing ? `#${editing.name}` : ""} caption={editing ? `${editing.note_count} 篇笔记` : undefined} onClose={() => setEditing(null)}>
        {editing && (
          <>
            <div className="m-t-cap mb-2 px-1">选择颜色</div>
            <div className="m-group grid grid-cols-6 justify-items-center gap-y-1 px-2 py-2">
              {PALETTE.map((c) => {
                const on = tagDot(editing.color).toLowerCase() === c.toLowerCase();
                return (
                  <button key={c} type="button" aria-label={`颜色 ${c}`} aria-pressed={on} className="flex h-11 w-11 items-center justify-center" onClick={() => void setColor(editing, c)}>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full text-white" style={{ background: c, boxShadow: on ? "0 0 0 2px var(--m-surface), 0 0 0 4px var(--m-ink2)" : undefined }}>
                      {on && <Check size={16} strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
              <button type="button" aria-label="清除颜色" aria-pressed={!editing.color} className="flex h-11 w-11 items-center justify-center" onClick={() => void setColor(editing, null)}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold" style={{ boxShadow: "inset 0 0 0 1.5px var(--m-ink4)", color: "var(--m-ink2)" }}>
                  清
                </span>
              </button>
            </div>
            <MGroup className="mt-3">
              <MRow icon={<ChevronRight size={20} style={{ color: "var(--m-ink2)" }} />} onClick={() => gotoTagNotes(editing)}>
                查看相关笔记
              </MRow>
              <MRow icon={<Pencil size={20} style={{ color: "var(--m-ink2)" }} />} onClick={() => setRenameOpen(true)}>
                重命名
              </MRow>
            </MGroup>
            <MGroup className="mt-3">
              <MRow icon={<Trash2 size={20} />} danger onClick={() => deleteTag(editing)}>
                删除标签
              </MRow>
            </MGroup>
          </>
        )}
      </MSheet>

      <TextPromptModal
        open={renameOpen}
        title={`重命名 #${editing?.name ?? ""}`}
        initialValue={editing?.name ?? ""}
        placeholder="新名称"
        okText="保存"
        onOk={submitRename}
        onClose={() => setRenameOpen(false)}
      />
      <TextPromptModal open={createOpen} title="新建标签" placeholder="标签名" okText="创建" onOk={createNew} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
