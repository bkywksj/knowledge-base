import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Modal, message } from "antd";
import {
  Check,
  ChevronDown,
  CircleCheck,
  CornerDownRight,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { taskApi, taskCategoryApi } from "@/lib/api";
import type { Task, TaskCategory, TaskQuery } from "@/types";
import { useAppStore } from "@/store";
import { useLongPress } from "@/hooks/useLongPress";
import {
  applySmartFilter,
  describeDueDate,
  dueShortText,
  filterTitle,
  filterToStatusArg,
  groupTasks,
  type SmartFilter,
} from "@/lib/taskFilters";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { SwipeRow } from "@/components/mobile/SwipeRow";
import { TaskCreateSheet } from "@/components/mobile/TaskCreateSheet";
import { MChip, MGroup, MPageHeader, MTag, LinkBadge } from "@/components/mobile/primitives";

/**
 * 移动端待办（v4 原型第 07 屏；功能底稿 docs/tasks/mobile-v4-feature-inventory.md）
 *
 * - 标题下拉 = PC 待办侧栏：12 种智能筛选 + 分类，网址参数与 PC 一致（?filter= / ?category=）
 *   筛选口径共用 lib/taskFilters.ts（从 PC 待办页抽出来的同一份）
 * - 分组胶囊 = PC 分组胶囊：全部 / 逾期 / 今天 / 即将到期 / 无截止
 * - 任务行：勾选完成（循环任务 = 完成本次）、左滑「完成 / 删除」、长按菜单、轻点进详情
 * - 「全部任务」视图底部带最近完成的 20 条（可折叠），同原版「已完成」分组
 */

const FILTER_MENU: { key: SmartFilter; label: string }[] = [
  { key: "todo", label: "全部任务" },
  { key: "overdue", label: "逾期任务" },
  { key: "today", label: "今天的任务" },
  { key: "week", label: "本周到期" },
  { key: "no-date", label: "无日期任务" },
  { key: "urgent", label: "紧急任务" },
  { key: "normal", label: "普通任务" },
  { key: "low", label: "低优先级" },
  { key: "recurring", label: "循环任务" },
  { key: "linked", label: "有关联任务" },
  { key: "done", label: "已完成" },
  { key: "abandoned", label: "已放弃" },
];

type Group = "all" | "overdue" | "today" | "upcoming" | "noDate";
const GROUP_LABEL: Record<Group, string> = {
  all: "全部",
  overdue: "逾期",
  today: "今天",
  upcoming: "即将到期",
  noDate: "无截止",
};

const PRIORITY_COLOR: Record<number, string> = {
  0: "var(--m-bad)",
  1: "var(--m-accent)",
  2: "var(--m-ink4)",
};

export function MobileTasks() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as SmartFilter | null) ?? "todo";
  const categoryParam = params.get("category"); // 分类 id 或 "none"

  const [tasks, setTasks] = useState<Task[]>([]);
  const [recentDone, setRecentDone] = useState<Task[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<Group>("all");
  const [keyword, setKeyword] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [sheetTask, setSheetTask] = useState<Task | null>(null);
  const listTick = useAppStore((s) => s.tasksListRefreshTick);

  const load = useCallback(async () => {
    setLoading(true);
    const query: TaskQuery = { status: filterToStatusArg(filter) };
    if (categoryParam === "none") query.uncategorized = true;
    else if (categoryParam) query.category_id = Number(categoryParam);
    try {
      const [list, done] = await Promise.all([
        taskApi.list(query).catch(() => [] as Task[]),
        // 「全部任务」底部的最近完成（原版就有，最多 20 条）
        filter === "todo" ? taskApi.list({ ...query, status: 1 }).catch(() => [] as Task[]) : Promise.resolve([] as Task[]),
      ]);
      // 子任务在详情页里看，列表只列主任务（与 PC 列表一致）
      setTasks(applySmartFilter(list.filter((t) => t.parent_task_id == null), filter, "list"));
      setRecentDone(done.filter((t) => t.parent_task_id == null).slice(0, 20));
    } finally {
      setLoading(false);
    }
  }, [filter, categoryParam]);

  useEffect(() => {
    void load();
  }, [load, listTick]);

  useEffect(() => {
    taskCategoryApi.list().then(setCategories).catch(() => {});
  }, []);

  // 从「新建」带 ?new=1 进来：自动弹出新建面板，随后删掉参数（返回 / 刷新不会重复弹）
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params, setParams]);

  // 切换筛选时回到「全部」分组
  useEffect(() => setGroup("all"), [filter, categoryParam]);

  const searched = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return tasks;
    return tasks.filter((t) => t.title.toLowerCase().includes(k) || (t.description ?? "").toLowerCase().includes(k));
  }, [tasks, keyword]);

  const groups = useMemo(() => groupTasks(searched), [searched]);
  const isOpenFilter = filter !== "done" && filter !== "abandoned";
  const sections: { key: Exclude<Group, "all">; list: Task[] }[] = isOpenFilter
    ? (["overdue", "today", "upcoming", "noDate"] as const)
        .map((k) => ({ key: k, list: groups[k] }))
        .filter((s) => s.list.length > 0 && (group === "all" || group === s.key))
    : [];
  const openCount = searched.filter((t) => t.status === 0).length;
  const urgentCount = searched.filter((t) => t.status === 0 && t.priority === 0).length;

  const category = categoryParam && categoryParam !== "none" ? categories.find((c) => c.id === Number(categoryParam)) : null;
  const title = categoryParam === "none" ? "未分类" : category ? category.name : filterTitle(filter);

  function pickFilter(next: { filter?: SmartFilter; category?: string | null }) {
    const p = new URLSearchParams();
    if (next.filter && next.filter !== "todo") p.set("filter", next.filter);
    if (next.category) p.set("category", next.category);
    setParams(p, { replace: true });
    setFilterOpen(false);
  }

  // 勾选：未完成的循环任务 = 完成本次（推进到下一次），与桌面端一致；
  // 直接 toggleStatus 会把整条循环标成完成，以后再也不会出现
  async function toggleTask(task: Task) {
    try {
      if (task.status === 0 && task.repeat_kind !== "none") {
        await taskApi.completeOccurrence(task.id);
        message.success("已完成本次，已推进到下一次");
      } else {
        await taskApi.toggleStatus(task.id);
      }
      useAppStore.getState().refreshTaskStats();
      await load();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  // 删除任务（永久，无回收站 → 二次确认）
  function confirmDelete(task: Task) {
    Modal.confirm({
      title: `删除「${task.title}」？`,
      content: "任务删除后不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      async onOk() {
        try {
          await taskApi.delete(task.id);
          message.success("已删除");
          useAppStore.getState().refreshTaskStats();
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  const sheetItems: ActionSheetItem[] = sheetTask
    ? [
        {
          key: "toggle",
          label: sheetTask.status === 1 ? "标记为未完成" : "标记为完成",
          icon: <CircleCheck size={20} />,
          onClick: () => void toggleTask(sheetTask),
        },
        { key: "edit", label: "编辑详情", icon: <Pencil size={20} />, onClick: () => navigate(`/task-detail/${sheetTask.id}`) },
        { key: "delete", label: "删除", icon: <Trash2 size={20} />, danger: true, onClick: () => confirmDelete(sheetTask) },
      ]
    : [];

  const rowProps = {
    onToggle: (t: Task) => void toggleTask(t),
    onOpen: (t: Task) => navigate(`/task-detail/${t.id}`),
    onMenu: setSheetTask,
    onDelete: confirmDelete,
  };

  return (
    <div className="mx-auto w-full max-w-[860px] pb-28">
      <MPageHeader
        title={
          <button type="button" className="flex items-center gap-1" onClick={() => setFilterOpen(true)} aria-label="切换筛选">
            {title}
            <ChevronDown size={18} style={{ color: "var(--m-ink3)" }} />
          </button>
        }
        actions={
          <button
            type="button"
            aria-label={searchOpen ? "收起搜索" : "搜索"}
            className="m-icon-btn mr-2"
            onClick={() => {
              if (searchOpen) setKeyword("");
              setSearchOpen((v) => !v);
            }}
          >
            {searchOpen ? <X size={20} /> : <Search size={20} />}
          </button>
        }
      />
      <div className="m-px m-t-meta mt-1">
        {isOpenFilter ? (
          <>
            {openCount} 条未完成 · <span style={{ color: "var(--m-bad)" }}>{urgentCount} 条紧急</span>
          </>
        ) : (
          `共 ${searched.length} 条`
        )}
      </div>

      {searchOpen && (
        <div className="m-px mt-3">
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索待办标题 / 备注"
            className="h-11 w-full rounded-[var(--m-r-l)] px-4 text-[16px] outline-none"
            style={{ background: "var(--m-surface)", color: "var(--m-ink)" }}
          />
        </div>
      )}

      {isOpenFilter && (
        <div className="m-px m-hscroll mt-3 flex gap-2">
          {(Object.keys(GROUP_LABEL) as Group[]).map((g) => {
            const n = g === "all" ? openCount : groups[g].length;
            return (
              <MChip key={g} active={group === g} onClick={() => setGroup(g)}>
                {GROUP_LABEL[g]}
                <span className="m-num" style={g === "overdue" && n > 0 && group !== g ? { color: "var(--m-bad)", fontWeight: 700 } : undefined}>
                  {n}
                </span>
              </MChip>
            );
          })}
        </div>
      )}

      <div className="m-px">
        {loading && tasks.length === 0 ? (
          <MGroup className="mt-5 py-8 text-center">
            <span className="m-t-meta">加载中…</span>
          </MGroup>
        ) : keyword.trim() && searched.length === 0 ? (
          <MGroup className="mt-5 py-8 text-center">
            <span className="m-t-meta">没有匹配「{keyword.trim()}」的待办</span>
          </MGroup>
        ) : searched.length === 0 && recentDone.length === 0 ? (
          <MGroup className="mt-5 flex flex-col items-center gap-3 py-8">
            <span className="m-t-meta">{filter === "todo" && !categoryParam ? "暂无待办，享受当下 ✨" : "这里没有任务"}</span>
            {filter === "todo" && (
              <button type="button" className="m-btn h-10" onClick={() => setCreateOpen(true)}>
                添加第一条
              </button>
            )}
          </MGroup>
        ) : isOpenFilter ? (
          sections.map((s) => (
            <div key={s.key}>
              <div className="mt-5 mb-2 flex items-center gap-1.5">
                {s.key === "overdue" && <TriangleAlert size={15} style={{ color: "var(--m-bad)" }} />}
                <span className="m-t-sec" style={s.key === "overdue" ? { color: "var(--m-bad)" } : undefined}>
                  {GROUP_LABEL[s.key]}
                </span>
                <span className="m-t-meta m-num">{s.list.length}</span>
              </div>
              <TaskGroup tasks={s.list} {...rowProps} />
            </div>
          ))
        ) : (
          <div className="mt-5">
            <TaskGroup tasks={searched} {...rowProps} />
          </div>
        )}

        {/* 「全部任务」底部：最近完成，默认折叠 */}
        {filter === "todo" && group === "all" && recentDone.length > 0 && (
          <div className="mt-6">
            <button type="button" className="m-tapx mb-2 flex items-center gap-1.5" onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}>
              <span className="m-t-sec">已完成</span>
              <span className="m-t-meta m-num">{recentDone.length}</span>
              <ChevronDown size={16} style={{ color: "var(--m-ink3)", transform: doneOpen ? "rotate(180deg)" : undefined }} />
            </button>
            {doneOpen && <TaskGroup tasks={recentDone} {...rowProps} />}
          </div>
        )}
      </div>

      {/* 页面自带 FAB（全局 FAB 在本页隐藏），无阴影 */}
      <button
        type="button"
        aria-label="添加待办"
        className="m-fab"
        style={{ bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 16px)" }}
        onClick={() => setCreateOpen(true)}
      >
        <Plus size={26} strokeWidth={2.4} />
      </button>

      <ActionSheet open={!!sheetTask} title={sheetTask?.title} items={sheetItems} onClose={() => setSheetTask(null)} />

      {/* 筛选面板 = PC 待办侧栏 */}
      {filterOpen && (
        <div className="m-sheet-mask" role="dialog" aria-modal="true" aria-label="筛选待办">
          <div className="m-sheet-backdrop" onClick={() => setFilterOpen(false)} />
          <div className="m-sheet">
            <div className="m-sheet-grabber" />
            <div className="m-px m-t-sec pt-1 pb-3">筛选</div>
            <div className="m-px">
              <MGroup>
                {FILTER_MENU.map((f) => (
                  <FilterRow key={f.key} label={f.label} active={!categoryParam && filter === f.key} onClick={() => pickFilter({ filter: f.key })} />
                ))}
              </MGroup>
              <div className="m-t-cap mt-4 mb-1.5">分类</div>
              <MGroup>
                {categories.map((c) => (
                  <FilterRow
                    key={c.id}
                    label={c.name}
                    dot={c.color}
                    active={categoryParam === String(c.id)}
                    onClick={() => pickFilter({ category: String(c.id) })}
                  />
                ))}
                <FilterRow label="未分类" dot="var(--m-ink4)" active={categoryParam === "none"} onClick={() => pickFilter({ category: "none" })} />
              </MGroup>
              <MGroup className="mt-3">
                <button type="button" className="m-row justify-center text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={() => setFilterOpen(false)}>
                  取消
                </button>
              </MGroup>
            </div>
          </div>
        </div>
      )}

      <TaskCreateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          useAppStore.getState().refreshTaskStats();
          void load();
        }}
      />
    </div>
  );
}

function FilterRow({ label, active, dot, onClick }: { label: string; active: boolean; dot?: string; onClick: () => void }) {
  return (
    <button type="button" className={dot ? "m-row m-row-icon" : "m-row"} onClick={onClick}>
      {dot && (
        <span className="flex w-6 shrink-0 justify-center">
          <span className="m-dot" style={{ background: dot }} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[15px]" style={active ? { color: "var(--m-accent-ink)", fontWeight: 700 } : undefined}>
        {label}
      </span>
      {active && <Check size={18} style={{ color: "var(--m-accent-ink)" }} />}
    </button>
  );
}

interface RowHandlers {
  onToggle: (t: Task) => void;
  onOpen: (t: Task) => void;
  onMenu: (t: Task) => void;
  onDelete: (t: Task) => void;
}

function TaskGroup({ tasks, ...h }: { tasks: Task[] } & RowHandlers) {
  return (
    <MGroup>
      {tasks.map((t, i) => (
        <div key={t.id} className="relative">
          {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-[52px] z-[1] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
          <SwipeRow
            actions={[
              {
                key: "toggle",
                label: t.status === 1 ? "未完成" : "完成",
                icon: <CircleCheck size={18} />,
                tone: "accent",
                onClick: () => h.onToggle(t),
              },
              { key: "del", label: "删除", icon: <Trash2 size={18} />, tone: "bad", onClick: () => h.onDelete(t) },
            ]}
          >
            <TaskRow task={t} {...h} />
          </SwipeRow>
        </div>
      ))}
    </MGroup>
  );
}

function TaskRow({ task, onToggle, onOpen, onMenu }: { task: Task } & RowHandlers) {
  const lp = useLongPress(() => onMenu(task), { onClick: () => onOpen(task) });
  const done = task.status === 1;
  const due = describeDueDate(task.due_date, done);
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      {/* 勾选框独立于长按区：点它只切换完成，不触发长按 / 进详情 */}
      <button
        type="button"
        aria-label={done ? "标记为未完成" : "完成"}
        onClick={() => onToggle(task)}
        className="relative mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--m-r-s)] after:absolute after:-inset-[11px] after:content-['']"
        style={done ? { background: "var(--m-ok)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.6px var(--m-ink4)" }}
      >
        {done && <Check size={14} strokeWidth={3} />}
      </button>
      <div {...lp} role="button" tabIndex={0} className="-my-3.5 min-w-0 flex-1 cursor-pointer select-none py-3.5" style={{ WebkitTouchCallout: "none" }}>
        <div className="text-[15px] leading-snug" style={done ? { color: "var(--m-ink3)", textDecoration: "line-through" } : { color: "var(--m-ink)" }}>
          {task.title}
        </div>
        {task.description && !done && <div className="m-t-meta mt-0.5 truncate">{task.description}</div>}
        {(task.priority === 0 || task.important || task.subtask_total > 0 || task.due_date || (task.links?.length ?? 0) > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {task.priority === 0 && !done && <MTag tone="bad">紧急</MTag>}
            {task.important && (
              <MTag tone="warn">
                <Star size={12} /> 重要
              </MTag>
            )}
            {task.subtask_total > 0 && (
              <MTag>
                <CornerDownRight size={12} />
                <span className="m-num">
                  {task.subtask_done}/{task.subtask_total}
                </span>
              </MTag>
            )}
            {(task.links?.length ?? 0) > 0 && <LinkBadge>关联 {task.links!.length}</LinkBadge>}
            {task.due_date && (
              <span className="m-t-cap m-num" style={due.overdue ? { color: "var(--m-bad)", fontWeight: 600 } : undefined} title={due.text}>
                {due.overdue ? due.text : dueShortText(task.due_date)}
              </span>
            )}
          </div>
        )}
      </div>
      {!done && <span className="m-dot mt-2" style={{ background: PRIORITY_COLOR[task.priority] ?? "var(--m-accent)" }} aria-label={task.priority === 0 ? "紧急" : task.priority === 2 ? "低" : "普通"} />}
    </div>
  );
}
