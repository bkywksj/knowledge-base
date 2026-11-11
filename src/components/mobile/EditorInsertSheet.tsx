import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Camera, Link, Paperclip } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { buildSlashCommandItems, type SlashCommandItem } from "@/components/editor/slashCommandItems";
import { MOBILE_INSERT_GROUPS, type MobileInsertGroupKey } from "@/lib/mobileInsertGroups";
import { MSheet } from "./MSheet";

/**
 * 手机编辑页的插入面板（v4 原型第 05 屏）：分组胶囊横滑切换 + 4 列图标格。
 *
 * 清单与 PC 斜杠命令同一份（buildSlashCommandItems），分组见 lib/mobileInsertGroups。
 * 有几项在手机上走不同实现，由编辑页通过 overrides 接管：
 * - 图片 / 本地视频 / 附件：PC 用系统文件对话框拿路径，安卓返回的是 content:// 地址按路径存会失败，
 *   改用 <input type=file> 读内容再存（和原来格式条的「插图」同一条路）
 * - 表格：PC 唤起工具栏里的行列选择浮层，手机隐藏了工具栏，直接插 3×3（表格内可再增删行列）
 * - 拍照 / 链接：斜杠清单里没有，手机额外加
 */

export type InsertOverride = () => void;

export function EditorInsertSheet({
  open,
  onClose,
  editor,
  noteId,
  requestEmbedUrl,
  overrides,
}: {
  open: boolean;
  onClose: () => void;
  editor: Editor | null;
  noteId: number;
  /** 「网络视频」的链接输入框（斜杠清单里的同名项要用） */
  requestEmbedUrl: () => Promise<string | null>;
  /** 按 key 接管插入动作（image / camera / video / attachment / table / link） */
  overrides: Record<string, InsertOverride>;
}) {
  const [group, setGroup] = useState<MobileInsertGroupKey>("common");

  const slashByKey = useMemo(() => {
    const items = buildSlashCommandItems({ getNoteId: () => noteId, ensureNoteId: () => undefined, requestEmbedUrl });
    return new Map<string, SlashCommandItem>(items.map((it) => [it.key, it]));
  }, [noteId, requestEmbedUrl]);

  const current = MOBILE_INSERT_GROUPS.find((g) => g.key === group) ?? MOBILE_INSERT_GROUPS[0];

  function run(key: string) {
    onClose();
    const ov = overrides[key];
    if (ov) {
      ov();
      return;
    }
    const item = slashByKey.get(key);
    if (!item || !editor) return;
    // 斜杠命令第一步是删掉「/查询词」那段；这里没有触发字符，传光标处的空区间即可（选中的文字也不会被删）
    const at = editor.state.selection.from;
    void item.command({ editor, range: { from: at, to: at } });
  }

  return (
    <MSheet open={open} title="插入" aside="正文里输入 / 也能调出" onClose={onClose}>
      <div className="m-hscroll -mx-4 flex gap-2 px-4 pb-1" role="tablist" aria-label="插入分组">
        {MOBILE_INSERT_GROUPS.map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={g.key === group} className={g.key === group ? "m-chip is-on" : "m-chip"} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="m-group mt-3 grid grid-cols-4 py-2" role="tabpanel">
        {current.entries.map((en) => {
          const slash = slashByKey.get(en.key);
          const label = en.label ?? slash?.title ?? en.key;
          const icon = slash ? <slash.icon size={20} /> : EXTRA_ICON[en.key];
          // 原型：图标一律中性色，只有「双链笔记」用主色
          const accent = en.key === "wikiLink";
          return (
            <button
              key={en.key}
              type="button"
              className="flex min-h-[70px] flex-col items-center justify-center gap-2 rounded-[var(--m-r-l)] px-1 py-3 active:bg-[var(--m-accent-soft)]"
              style={{ color: accent ? "var(--m-accent-ink)" : "var(--m-ink2)" }}
              onClick={() => run(en.key)}
            >
              {icon}
              <span className={accent ? "text-center text-[12px] font-semibold leading-[18px]" : "text-center text-[12px] leading-[18px]"}>{label}</span>
            </button>
          );
        })}
      </div>
    </MSheet>
  );
}

const EXTRA_ICON: Record<string, ReactNode> = {
  camera: <Camera size={20} />,
  attachment: <Paperclip size={20} />,
  link: <Link size={20} />,
};
