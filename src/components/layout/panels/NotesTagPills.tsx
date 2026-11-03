import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { tagApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import type { Tag } from "@/types";

/** 面板里最多露出的标签数：再多就成了第二棵标签树，完整列表交给「标签」页签 / 标签页 */
const MAX_PILLS = 8;
const DEFAULT_DOT = "var(--kb-primary)";

/**
 * 笔记面板「文件夹」页签底部的常用标签胶囊（v4 原型 .tagrow）：
 * 按笔记数取前 8 个，点击跳到该标签的笔记列表；齿轮进标签管理。
 * 标签模块被关闭或一个标签都没有时整块不渲染。
 */
export function NotesTagPills() {
  const navigate = useNavigate();
  const tagsEnabled = useFeatureEnabled("tags");
  const tagsRefreshTick = useAppStore((s) => s.tagsRefreshTick);
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    if (!tagsEnabled) return;
    let cancelled = false;
    tagApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setTags(
          [...list]
            .filter((t) => t.note_count > 0)
            .sort((a, b) => b.note_count - a.note_count)
            .slice(0, MAX_PILLS),
        );
      })
      .catch(() => {
        // 拉不到标签只是少一块快捷入口，不打扰用户
      });
    return () => {
      cancelled = true;
    };
  }, [tagsEnabled, tagsRefreshTick, notesRefreshTick]);

  if (!tagsEnabled || tags.length === 0) return null;

  return (
    <div className="kb-tagpills-wrap">
      <div className="kb-panel-sec">
        <span>标签</span>
        <button
          type="button"
          className="kb-ph-btn"
          title="管理标签"
          onClick={() => navigate("/tags")}
        >
          <Settings2 size={13} />
        </button>
      </div>
      <div className="kb-tagpills">
        {tags.map((t) => (
          <button
            key={t.id}
            type="button"
            className="kb-tagpill"
            title={`${t.name} · ${t.note_count} 篇`}
            onClick={() => navigate(`/tags?tagId=${t.id}`)}
          >
            <i style={{ background: t.color || DEFAULT_DOT }} />
            <span>{t.name}</span>
            <small>{t.note_count}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
