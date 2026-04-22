import { create } from "zustand";

export interface NoteTab {
  id: number;
  title: string;
  /** 是否有未保存改动（编辑器标记脏状态时反映出来） */
  dirty?: boolean;
  /** 关联源文件类型：pdf / docx / doc，用于 Tab 图标区分；纯笔记为 null */
  sourceFileType?: string | null;
}

/** 编辑器卸载后保留的草稿快照（按 noteId 索引） */
export interface NoteDraft {
  title: string;
  content: string;
}

interface TabsStore {
  tabs: NoteTab[];
  activeId: number | null;
  /**
   * 草稿缓存：按 noteId 保存"用户已修改但尚未持久化到 DB"的内容。
   * 用途：
   *  1) 切 tab / wiki 跳转 → editor 卸载，下次回来从这里恢复（避免内容丢失）
   *  2) 关闭 dirty tab / 退出应用时 → 用 draft 内容批量保存到 DB
   * 写入：editor.tsx 在 dirty 时 debounce 写入；保存成功后 clearDraft 清掉
   */
  drafts: Record<number, NoteDraft>;

  /** 打开一个笔记 tab；已存在则不重复，background=true 时不切换激活 */
  openTab: (tab: NoteTab, opts?: { background?: boolean }) => void;
  /** 激活指定 tab（不新增） */
  activateTab: (id: number) => void;
  /** 关闭 tab；返回关闭后应该激活的邻居 ID（null 表示没有剩余 tab） */
  closeTab: (id: number) => number | null;
  /** 批量关闭 tab（删除多条笔记后用），返回新的 activeId */
  closeTabsByIds: (ids: number[]) => number | null;
  /** 关闭所有 tab */
  closeAllTabs: () => void;
  /** 关闭除指定 tab 外的全部 */
  closeOtherTabs: (keepId: number) => void;
  /** 关闭指定 tab 右侧所有 */
  closeTabsToRight: (id: number) => void;
  /** 同步 tab 标题（笔记重命名后调用） */
  updateTabTitle: (id: number, title: string) => void;
  /** 同步脏状态 */
  setTabDirty: (id: number, dirty: boolean) => void;
  /** 写入/更新草稿（编辑器内容变化时调用，建议 debounce） */
  setDraft: (id: number, draft: NoteDraft) => void;
  /** 读取草稿（无则返回 undefined） */
  getDraft: (id: number) => NoteDraft | undefined;
  /** 清除草稿（保存成功 / 用户放弃 / 关闭 tab 后调用） */
  clearDraft: (id: number) => void;
  /** 返回所有 dirty tab 列表（用于关闭/退出确认） */
  getDirtyTabs: () => NoteTab[];
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  tabs: [],
  activeId: null,
  drafts: {},

  openTab: (tab, opts) => {
    const { tabs, activeId } = get();
    const existIdx = tabs.findIndex((t) => t.id === tab.id);
    if (existIdx !== -1) {
      // 已存在：同步可变属性（title / sourceFileType），保留 dirty
      const next = tabs.slice();
      next[existIdx] = { ...next[existIdx], title: tab.title, sourceFileType: tab.sourceFileType };
      set({
        tabs: next,
        activeId: opts?.background ? activeId : tab.id,
      });
      return;
    }
    set({
      tabs: [...tabs, tab],
      activeId: opts?.background ? activeId : tab.id,
    });
  },

  activateTab: (id) => set({ activeId: id }),

  closeTab: (id) => {
    const { tabs, activeId, drafts } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return activeId;
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      // 优先激活右邻，没有则左邻
      const neighbor = next[idx] ?? next[idx - 1] ?? null;
      nextActive = neighbor ? neighbor.id : null;
    }
    // 关闭 tab 时一并清掉草稿（dirty 处理由调用方负责，到这一步认为已确认放弃/已保存）
    const nextDrafts = { ...drafts };
    delete nextDrafts[id];
    set({ tabs: next, activeId: nextActive, drafts: nextDrafts });
    return nextActive;
  },

  closeTabsByIds: (ids) => {
    const idSet = new Set(ids);
    const { tabs, activeId, drafts } = get();
    const next = tabs.filter((t) => !idSet.has(t.id));
    let nextActive: number | null = activeId;
    if (activeId !== null && idSet.has(activeId)) {
      // 原激活被关掉，挑剩余里最接近原位置的一个
      const oldIdx = tabs.findIndex((t) => t.id === activeId);
      const candidate =
        next.find((_, i, arr) => i + (tabs.length - arr.length) >= oldIdx) ??
        next[next.length - 1] ??
        null;
      nextActive = candidate ? candidate.id : null;
    }
    const nextDrafts = { ...drafts };
    for (const id of ids) delete nextDrafts[id];
    set({ tabs: next, activeId: nextActive, drafts: nextDrafts });
    return nextActive;
  },

  closeAllTabs: () => set({ tabs: [], activeId: null, drafts: {} }),

  closeOtherTabs: (keepId) => {
    const { tabs } = get();
    const kept = tabs.find((t) => t.id === keepId);
    if (!kept) return;
    set({ tabs: [kept], activeId: keepId });
  },

  closeTabsToRight: (id) => {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.slice(0, idx + 1);
    const stillPresent = next.some((t) => t.id === activeId);
    set({ tabs: next, activeId: stillPresent ? activeId : id });
  },

  updateTabTitle: (id, title) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    }));
  },

  setTabDirty: (id, dirty) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    }));
  },

  setDraft: (id, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [id]: draft } })),

  getDraft: (id) => get().drafts[id],

  clearDraft: (id) =>
    set((s) => {
      if (!(id in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[id];
      return { drafts: next };
    }),

  getDirtyTabs: () => get().tabs.filter((t) => t.dirty),
}));
