import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { message } from "antd";
import { promptApi } from "@/lib/api";
import type { PromptOutputMode, PromptTemplate } from "@/types";
import { MGroup, MNavBar, MSectionHeader } from "@/components/mobile/primitives";
import { MSheet } from "@/components/mobile/MSheet";

/**
 * 移动端提示词库（路由 /prompts）
 *
 * 手机上只看和开关：列表分「内置 / 自定义」，右侧开关 = 启用 / 停用（停用后编辑器 AI 菜单和 AI 对话的提示词里不再出现）；
 * 点一行看完整提示词。新建、编辑、删除在桌面端「提示词」页做 —— 提示词正文动辄几百字，手机上改不方便也容易误删。
 */

const OUTPUT_LABEL: Record<PromptOutputMode, string> = {
  replace: "替换选中内容",
  append: "追加在后面",
  popup: "弹窗显示结果",
};

export function MobilePrompts() {
  const navigate = useNavigate();
  const [list, setList] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<PromptTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await promptApi.list();
      setList(all);
      setDetail((cur) => (cur ? all.find((p) => p.id === cur.id) ?? null : null));
    } catch (e) {
      message.error(`加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const sorted = [...list].sort((a, b) => a.sortOrder - b.sortOrder);
    return { builtin: sorted.filter((p) => p.isBuiltin), custom: sorted.filter((p) => !p.isBuiltin) };
  }, [list]);

  async function toggle(p: PromptTemplate) {
    try {
      await promptApi.setEnabled(p.id, !p.enabled);
      await load();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  const enabledCount = list.filter((p) => p.enabled).length;

  return (
    <div className="mx-auto w-full max-w-[860px] pb-12">
      <MNavBar onBack={() => navigate(-1)} title="提示词" subtitle={loading ? undefined : `${list.length} 条 · 已启用 ${enabledCount} 条`} />
      <div className="m-px m-t-cap mt-1">新建和编辑请到桌面端「提示词」页；手机上可查看和启用 / 停用</div>

      {loading && list.length === 0 ? (
        <div className="m-t-meta py-10 text-center">加载中…</div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Sparkles size={36} style={{ color: "var(--m-ink4)" }} />
          <span className="m-t-body" style={{ color: "var(--m-ink2)" }}>还没有提示词</span>
        </div>
      ) : (
        (["builtin", "custom"] as const).map((g) =>
          groups[g].length > 0 ? (
            <div key={g} className="m-px mt-5">
              <MSectionHeader className="mb-2 px-1" title={g === "builtin" ? "内置" : "自定义"} count={groups[g].length} />
              <MGroup>
                {groups[g].map((p, i) => (
                  <PromptRow key={p.id} p={p} divider={i > 0} onOpen={() => setDetail(p)} onToggle={() => void toggle(p)} />
                ))}
              </MGroup>
            </div>
          ) : null,
        )
      )}

      <MSheet open={!!detail} title={detail?.title ?? ""} caption={detail ? `${detail.isBuiltin ? "内置" : "自定义"} · ${OUTPUT_LABEL[detail.outputMode] ?? detail.outputMode}` : undefined} onClose={() => setDetail(null)}>
        {detail && (
          <>
            {detail.description && (
              <p className="m-t-body mb-3 px-1" style={{ color: "var(--m-ink2)" }}>
                {detail.description}
              </p>
            )}
            <div className="m-group max-h-[45vh] overflow-y-auto px-4 py-3">
              <pre className="m-0 whitespace-pre-wrap break-words text-[14px] leading-relaxed" style={{ fontFamily: "inherit", color: "var(--m-ink)" }}>
                {detail.prompt}
              </pre>
            </div>
            <div className="m-group mt-3">
              <button type="button" role="switch" aria-checked={detail.enabled} className="m-row" onClick={() => void toggle(detail)}>
                <span className="min-w-0 flex-1 text-[15px]">启用</span>
                <Switch on={detail.enabled} />
              </button>
            </div>
          </>
        )}
      </MSheet>
    </div>
  );
}

function PromptRow({ p, divider, onOpen, onToggle }: { p: PromptTemplate; divider: boolean; onOpen: () => void; onToggle: () => void }) {
  return (
    <div className="relative flex min-h-[60px] items-center gap-2 pr-3 pl-4">
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-4 h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <button type="button" className="min-w-0 flex-1 self-stretch py-3 text-left" onClick={onOpen}>
        <span className="block truncate text-[15px] font-medium" style={{ color: p.enabled ? "var(--m-ink)" : "var(--m-ink3)" }}>
          {p.title}
        </span>
        {p.description && <span className="m-t-cap mt-0.5 block truncate">{p.description}</span>}
      </button>
      <button type="button" role="switch" aria-checked={p.enabled} aria-label={`${p.enabled ? "停用" : "启用"}「${p.title}」`} className="flex h-11 w-12 shrink-0 items-center justify-end" onClick={onToggle}>
        <Switch on={p.enabled} />
      </button>
    </div>
  );
}

/** 开关外观（交互挂在外层按钮上） */
function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="relative inline-block h-[26px] w-[44px] shrink-0 rounded-full transition-colors" style={{ background: on ? "var(--m-btn)" : "var(--m-ink4)" }}>
      <span className="absolute top-[3px] h-5 w-5 rounded-full bg-white transition-[left]" style={{ left: on ? 21 : 3 }} />
    </span>
  );
}
