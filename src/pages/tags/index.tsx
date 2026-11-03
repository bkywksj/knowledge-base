import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Input,
  Popconfirm,
  Spin,
  TreeSelect,
  message,
} from "antd";
import { Tags, FileText, Edit3, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { folderApi, tagApi } from "@/lib/api";
import { buildFolderPath } from "@/lib/folderPath";
import { relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { TagColorPicker } from "@/components/TagColorPicker";
import { useAppStore } from "@/store";
import type { Tag, Note, PageResult, Folder } from "@/types";

/** 笔记列表单行高度估算（标题 + 文件夹路径两行 + 上下 padding） */
const NOTE_ROW_HEIGHT = 62;

/** 关联笔记每次拉多少条（「加载更多」再翻下一页） */
const NOTES_PAGE_SIZE = 20;

/**
 * TagsPage —— Activity Bar 模式下"标签"视图的主区。
 *
 * 只负责：展示 URL `?tagId=...` 选中标签下的笔记 + 编辑（名称 / 父标签 / 颜色）/ 删除。
 * 标签列表、筛选、新建、右键菜单在 src/components/layout/panels/TagsPanel.tsx。
 *
 * v4 原型布局：页头（色块图标 · 名称 · 路径与笔记数 ｜ 删除）+ 左「关联笔记」卡片 + 右「编辑标签」常驻表单。
 */
function DesktopTagsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedId = (() => {
    const raw = searchParams.get("tagId");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const tagsRefreshTick = useAppStore((s) => s.tagsRefreshTick);

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: NOTES_PAGE_SIZE,
  });
  const [notesLoading, setNotesLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 虚拟滚动容器：某些热门标签可能关联几百条笔记
  const notesScrollRef = useRef<HTMLDivElement | null>(null);
  const notesVirtualizer = useVirtualizer({
    count: notes.items.length,
    getScrollElement: () => notesScrollRef.current,
    estimateSize: () => NOTE_ROW_HEIGHT,
    overscan: 6,
  });

  const selectedTag = useMemo(
    () => allTags.find((t) => t.id === selectedId) ?? null,
    [allTags, selectedId],
  );

  useEffect(() => {
    loadAllTags();
  }, [tagsRefreshTick]);

  // 关联笔记行要显示文件夹路径
  useEffect(() => {
    folderApi.list().then(setFolders).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setNotes({ items: [], total: 0, page: 1, page_size: NOTES_PAGE_SIZE });
      return;
    }
    loadNotes(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tagsRefreshTick]);

  async function loadAllTags() {
    try {
      setAllTags(await tagApi.list());
    } catch (e) {
      message.error(String(e));
    }
  }

  async function loadNotes(tagId: number) {
    setNotesLoading(true);
    try {
      setNotes(await tagApi.listNotesByTag(tagId, 1, NOTES_PAGE_SIZE));
    } catch (e) {
      message.error(String(e));
    } finally {
      setNotesLoading(false);
    }
  }

  /** 原来只拉第一页（20 条）却显示「共 N 条」，多出来的看不到 —— 这里接着翻页追加 */
  async function loadMore() {
    if (selectedId == null) return;
    setLoadingMore(true);
    try {
      const next = await tagApi.listNotesByTag(selectedId, notes.page + 1, NOTES_PAGE_SIZE);
      setNotes((prev) => ({ ...next, items: [...prev.items, ...next.items] }));
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(tag: Tag) {
    try {
      await tagApi.delete(tag.id);
      message.success("删除成功");
      useAppStore.getState().bumpTagsRefresh();
      // 删完回到空态
      navigate("/tags");
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 标签路径：父 / 子（父标签可能多级） */
  const tagPath = useMemo(() => {
    if (!selectedTag) return "";
    const chain: string[] = [];
    let cur: Tag | undefined = selectedTag;
    const guard = new Set<number>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift(cur.name);
      cur = cur.parent_id != null ? allTags.find((t) => t.id === cur!.parent_id) : undefined;
    }
    return chain.join(" / ");
  }, [selectedTag, allTags]);

  if (!selectedTag) {
    return (
      <div className="kb-tags-page">
        <div className="kb-tag-head">
          <span className="kb-tag-ico">
            <Tags size={20} />
          </span>
          <div>
            <h1>标签</h1>
            <div className="kb-tag-sub">共 {allTags.length} 个标签</div>
          </div>
        </div>
        <section className="kb-cards-panel">
          <EmptyState
            description={
              allTags.length === 0
                ? "还没有任何标签。左侧面板点 + 新建一个。"
                : "在左侧选择一个标签，查看它关联的笔记"
            }
          />
        </section>
      </div>
    );
  }

  const tint = selectedTag.color || "var(--kb-primary)";

  return (
    <div className="kb-tags-page">
      {/* 页头：标签色图标块 · 名称 · 路径与笔记数 ｜ 删除 */}
      <div className="kb-tag-head">
        <span
          className="kb-tag-ico"
          style={{
            color: tint,
            background: `color-mix(in srgb, ${tint} 14%, transparent)`,
          }}
        >
          <Tags size={20} />
        </span>
        <div className="min-w-0">
          <h1>{selectedTag.name}</h1>
          <div className="kb-tag-sub">
            {/* 用列表接口的 total（排除回收站 / 隐藏笔记）；tag.note_count 把它们也算进去了，会和下面列表对不上 */}
            {tagPath} · 关联 {notesLoading ? selectedTag.note_count : notes.total} 篇笔记
          </div>
        </div>
        <span className="flex-1" />
        <Popconfirm
          title="确认删除此标签？"
          description="删除标签不会删除关联的笔记"
          onConfirm={() => handleDelete(selectedTag)}
        >
          <Button className="kb-danger-soft" icon={<Trash2 size={14} />}>
            删除
          </Button>
        </Popconfirm>
      </div>

      <div className="kb-tags-main">
        {/* 关联笔记 */}
        <section className="kb-cards-panel kb-tag-notes">
          <div className="kb-cl-head">
            <span className="kb-card-stat-ico">
              <FileText size={14} />
            </span>
            <b>关联笔记</b>
            <span className="kb-cl-count">{notes.total}</span>
          </div>
          {notesLoading ? (
            <div className="flex justify-center py-8">
              <Spin />
            </div>
          ) : notes.items.length > 0 ? (
            <>
              {/* 虚拟滚动：只渲染可见行，热门标签（几百条笔记）切换也保持流畅
                  注：用 contain:content 而不是 contain:strict — 后者含 size 规则
                  会让仅设 maxHeight 的容器被计算为 0 高度导致一条不渲染 */}
              <div
                ref={notesScrollRef}
                style={{ maxHeight: "calc(100vh - 300px)", overflowY: "auto", contain: "content" }}
              >
                <div
                  style={{
                    height: notesVirtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {notesVirtualizer.getVirtualItems().map((vItem) => {
                    const note = notes.items[vItem.index];
                    const folderPath =
                      note.folder_id != null
                        ? buildFolderPath(folders, note.folder_id).map((f) => f.name).join(" / ")
                        : "";
                    return (
                      <div
                        key={note.id}
                        data-index={vItem.index}
                        ref={notesVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem.start}px)`,
                        }}
                      >
                        <div className="kb-sr-row" onClick={() => navigate(`/notes/${note.id}`)}>
                          <span className="kb-sr-ico">
                            <FileText size={15} />
                          </span>
                          <div className="kb-sr-main">
                            <div className="kb-sr-title">{note.title || "未命名"}</div>
                            <div className="kb-sr-snippet is-one">{folderPath || "未分类"}</div>
                          </div>
                          <span className="kb-sr-time" title={note.updated_at.slice(0, 16)}>
                            {relativeTime(note.updated_at)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {notes.items.length < notes.total && (
                <div className="flex justify-center pt-3">
                  <Button loading={loadingMore} onClick={() => void loadMore()}>
                    加载更多（已显示 {notes.items.length} / {notes.total}）
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState description="该标签下暂无笔记" />
          )}
        </section>

        {/* 编辑标签：常驻表单（原弹窗），多了「父标签」 */}
        <TagEditPanel key={selectedTag.id} tag={selectedTag} allTags={allTags} />
      </div>
    </div>
  );
}

/** 某标签自身 + 全部子孙的 id（父标签下拉里要排除，避免把自己挂到自己下面形成环） */
function subtreeIdsOf(tags: Tag[], rootId: number): Set<number> {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tags) {
      if (t.parent_id != null && out.has(t.parent_id) && !out.has(t.id)) {
        out.add(t.id);
        grew = true;
      }
    }
  }
  return out;
}

type TagTreeOption = { value: number; title: string; children?: TagTreeOption[] };

function TagEditPanel({ tag, allTags }: { tag: Tag; allTags: Tag[] }) {
  const [name, setName] = useState(tag.name);
  // 没设过颜色就保持「无颜色」，不要预填默认色——否则一打开保存按钮就可点，点了会把颜色悄悄改掉
  const [color, setColor] = useState<string | null>(tag.color || null);
  const [parentId, setParentId] = useState<number | null>(tag.parent_id);
  const [saving, setSaving] = useState(false);

  // 父标签候选：树形，排除自己和自己的子孙
  const parentTree = useMemo<TagTreeOption[]>(() => {
    const banned = subtreeIdsOf(allTags, tag.id);
    const build = (pid: number | null): TagTreeOption[] =>
      allTags
        .filter((t) => (t.parent_id ?? null) === pid && !banned.has(t.id))
        .map((t) => {
          const children = build(t.id);
          return { value: t.id, title: t.name, children: children.length ? children : undefined };
        });
    return build(null);
  }, [allTags, tag.id]);

  const dirty =
    name.trim() !== tag.name ||
    (color || null) !== (tag.color || null) ||
    (parentId ?? null) !== (tag.parent_id ?? null);

  async function save() {
    const n = name.trim();
    if (!n) {
      message.warning("请输入标签名称");
      return;
    }
    setSaving(true);
    try {
      if (n !== tag.name) await tagApi.rename(tag.id, n);
      if ((color || null) !== (tag.color || null)) await tagApi.setColor(tag.id, color || null);
      if ((parentId ?? null) !== (tag.parent_id ?? null)) await tagApi.setParent(tag.id, parentId ?? null);
      message.success("已更新");
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="kb-cards-panel kb-qc kb-tag-edit">
      <div className="kb-qc-head">
        <span className="kb-qc-ico">
          <Edit3 size={14} />
        </span>
        编辑标签
      </div>
      <div className="kb-rv-lb">标签名称</div>
      <Input
        value={name}
        maxLength={32}
        onChange={(e) => setName(e.target.value)}
        onPressEnter={() => dirty && void save()}
      />
      <div className="kb-rv-lb">父标签</div>
      <TreeSelect
        allowClear
        showSearch
        treeDefaultExpandAll
        placeholder="顶层标签"
        value={parentId ?? undefined}
        onChange={(v) => setParentId(v ?? null)}
        treeData={parentTree}
        treeNodeFilterProp="title"
        style={{ width: "100%" }}
      />
      <div className="kb-tag-tip">不选则为顶层标签</div>
      <div className="kb-rv-lb">颜色</div>
      <TagColorPicker value={color} onChange={setColor} allowClear />
      <Button type="primary" block loading={saving} disabled={!dirty} onClick={() => void save()} style={{ marginTop: 14 }}>
        保存
      </Button>
    </section>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileTags } from "./MobileTags";

export default function TagsPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileTags /> : <DesktopTagsPage />;
}
