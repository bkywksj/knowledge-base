import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Badge, Modal, Input, message, theme as antdTheme } from "antd";
import {
  CheckSquare,
  Plus,
  ListChecks,
  AlertTriangle,
  Sun,
  CalendarRange,
  CalendarClock,
  Flame,
  Circle,
  Check,
  Ban,
  Repeat,
  Link as LinkIcon,
  Tags as TagsIcon,
  Settings as SettingsIcon,
  Inbox as InboxIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Edit3,
  Trash2,
  FolderPlus,
} from "lucide-react";
import { taskApi, taskCategoryApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Task, TaskStats, TaskCategory } from "@/types";
import { TaskCategoryManageModal } from "@/components/tasks/TaskCategoryManageModal";
import { flattenCategoryTree, subtreeCounts } from "@/lib/categoryTree";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/**
 * TasksPanel —— "待办"视图的主面板（方案 C MVP）。
 *
 * 维度：
 *   智能  : 进行中 / 逾期 / 今天 / 本周 / 无日期
 *   优先级: 紧急 / 普通 / 低
 *   归档  : 已完成
 *
 * 计数策略：拉一次 taskApi.list({status:0}) 拿所有未完成任务，本地派生
 * 所有未完成维度的计数；已完成数从 taskApi.stats().totalDone 取（避免
 * 把庞大的历史完成记录都拉回前端）。
 *
 * 订阅 urgentTodoCount：主区做任务操作后会 refreshTaskStats，这里 tick
 * 一次就重拉两份数据，Badge 保持实时。
 */

/** 侧栏折叠的父分类 id 列表（多级分类）*/
const COLLAPSED_CATS_KEY = "kb.tasks.collapsedCategories";

type FilterKey =
  | "todo"
  | "overdue"
  | "today"
  | "week"
  | "no-date"
  | "urgent"
  | "normal"
  | "low"
  | "recurring"
  | "linked"
  | "done"
  | "abandoned";

/** YYYY-MM-DD（本地时区） */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dueDay(t: Task): string | null {
  return t.due_date ? t.due_date.slice(0, 10) : null;
}

/** 从 Task[] 派生各维度计数 */
function deriveCounts(todoTasks: Task[]): Record<FilterKey, number> {
  const today = ymd(new Date());
  const weekEnd = ymd(new Date(Date.now() + 7 * 86400000));
  let overdue = 0;
  let dueToday = 0;
  let week = 0;
  let noDate = 0;
  let urgent = 0;
  let normal = 0;
  let low = 0;
  let recurring = 0;
  let linked = 0;
  for (const t of todoTasks) {
    if (t.priority === 0) urgent++;
    else if (t.priority === 1) normal++;
    else if (t.priority === 2) low++;
    if (t.repeat_kind && t.repeat_kind !== "none") recurring++;
    if (t.links && t.links.length > 0) linked++;
    const day = dueDay(t);
    if (!day) {
      noDate++;
    } else if (day < today) {
      overdue++;
    } else if (day === today) {
      dueToday++;
    } else if (day <= weekEnd) {
      week++;
    }
  }
  return {
    todo: todoTasks.length,
    overdue,
    today: dueToday,
    week,
    "no-date": noDate,
    urgent,
    normal,
    low,
    recurring,
    linked,
    done: 0, // 由 stats 覆盖
    // 已放弃不显计数（SmartRow 不传 count），这里占位满足 Record<FilterKey, number>
    abandoned: 0,
  };
}

export function TasksPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  // URL 是真相源；缺省视为 "todo"
  const currentFilter = (searchParams.get("filter") ?? "todo") as FilterKey;
  /** URL 上的 category 参数：数字字符串 = 该分类 ID；"none" = 未分类 */
  const currentCategory = searchParams.get("category");

  // 订阅：主区任务增删改后调 refreshTaskStats() → taskStatsTick 递增 → 这里重拉。
  // 不能只订阅 urgentTodoCount：增删改**非紧急**任务时它不变，计数会停在旧值。
  const taskStatsTick = useAppStore((s) => s.taskStatsTick);

  const [todoTasks, setTodoTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  /** 折叠的父分类（存 localStorage：切页面回来保持用户的折叠习惯） */
  const [collapsedCats, setCollapsedCats] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_CATS_KEY);
      return new Set(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
      return new Set();
    }
  });
  /** 确保某个父分类处于展开状态（新建子分类后要能立刻看到它） */
  function expandCategory(id: number) {
    setCollapsedCats((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      localStorage.setItem(COLLAPSED_CATS_KEY, JSON.stringify([...next]));
      return next;
    });
  }
  function toggleCollapsed(id: number) {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSED_CATS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    // 并发：未完成任务列表 + 统计 + 分类
    Promise.all([
      taskApi.list({ status: 0 }).catch(() => [] as Task[]),
      taskApi.stats().catch(() => null),
      taskCategoryApi.list().catch(() => [] as TaskCategory[]),
    ]).then(([list, s, cats]) => {
      if (cancelled) return;
      setTodoTasks(list);
      setStats(s);
      setCategories(cats);
    });
    return () => {
      cancelled = true;
    };
  }, [taskStatsTick]);

  /** 每个分类下的未完成任务数 + 未分类计数 */
  const categoryCounts = useMemo(() => {
    const map = new Map<number, number>();
    let none = 0;
    for (const t of todoTasks) {
      if (t.category_id == null) {
        none++;
      } else {
        map.set(t.category_id, (map.get(t.category_id) ?? 0) + 1);
      }
    }
    // 父分类显示「自身 + 子孙」的数：点进去列出来的就是这么多（后端按子树筛选）
    return { byId: subtreeCounts(categories, map), none };
  }, [todoTasks, categories]);

  const categoryRows = useMemo(
    () => flattenCategoryTree(categories, collapsedCats),
    [categories, collapsedCats],
  );

  const counts = useMemo(() => {
    const c = deriveCounts(todoTasks);
    c.done = stats?.totalDone ?? 0;
    return c;
  }, [todoTasks, stats]);

  function goTo(f: FilterKey) {
    if (f === "todo") {
      navigate("/tasks");
    } else {
      navigate(`/tasks?filter=${f}`);
    }
  }

  /** 跳到分类视图：value=number 表示分类 ID，"none" 表示未分类 */
  function goToCategory(value: number | "none") {
    navigate(`/tasks?category=${value}`);
  }

  // ─── 右键菜单（分类行）────────────────────────
  const ctx = useContextMenu<{ id: number; name: string }>();
  // 分类名输入 Modal（新建顶级 / 新建子分类 / 重命名共用）：null = 关闭。
  // 以前新建只能点齿轮进管理弹窗，侧栏右键和标题的「+」直接走这个小弹窗
  const [nameDialog, setNameDialog] = useState<
    | { mode: "create"; parentId: number | null; parentName?: string }
    | { mode: "rename"; id: number; name: string }
    | null
  >(null);
  const [nameInput, setNameInput] = useState("");

  function openCreateCategory(parentId: number | null, parentName?: string) {
    setNameDialog({ mode: "create", parentId, parentName });
    setNameInput("");
  }

  /** 重新拉分类列表（重命名 / 删除后调用） */
  async function reloadCategories() {
    const list = await taskCategoryApi.list().catch(() => [] as TaskCategory[]);
    setCategories(list);
  }

  const categoryMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "new-child",
        label: "新建子分类",
        icon: <FolderPlus size={13} />,
        onClick: () => {
          ctx.close();
          openCreateCategory(p.id, p.name);
        },
      },
      {
        key: "rename",
        label: "重命名",
        icon: <Edit3 size={13} />,
        onClick: () => {
          setNameDialog({ mode: "rename", id: p.id, name: p.name });
          setNameInput(p.name);
          ctx.close();
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除分类",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          Modal.confirm({
            title: `删除分类「${p.name}」？`,
            content: "此分类下的任务会自动落到「未分类」（任务本身不会被删除）。",
            okText: "删除",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await taskCategoryApi.delete(p.id);
                message.success("已删除分类");
                await reloadCategories();
                // 当前若正在查看这个分类，跳到未分类
                if (currentCategory === String(p.id)) {
                  goToCategory("none");
                }
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
  }, [ctx, currentCategory]);

  async function submitNameDialog() {
    if (!nameDialog) return;
    const name = nameInput.trim();
    if (!name) {
      message.warning("分类名不能为空");
      return;
    }
    if (nameDialog.mode === "rename") {
      if (name === nameDialog.name) {
        setNameDialog(null);
        return;
      }
      try {
        await taskCategoryApi.update(nameDialog.id, { name });
        message.success("已重命名");
        setNameDialog(null);
        await reloadCategories();
      } catch (e) {
        message.error(`重命名失败：${e}`);
      }
      return;
    }
    // 分类名全局唯一（后端也会拦），前端先查一遍省一次往返
    if (categories.some((c) => c.name === name)) {
      message.warning(`分类名称「${name}」已存在`);
      return;
    }
    const { parentId } = nameDialog;
    const parent = parentId == null ? undefined : categories.find((c) => c.id === parentId);
    try {
      await taskCategoryApi.create({
        name,
        // 子分类沿用父分类颜色，一眼看出归属；顶级用默认蓝，之后可在管理弹窗里改
        color: parent?.color ?? "#1677ff",
        sort_order: categories.filter((c) => (c.parent_id ?? null) === parentId).length,
        parent_id: parentId,
      });
      message.success("已创建");
      setNameDialog(null);
      if (parentId != null) expandCategory(parentId);
      await reloadCategories();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 本面板纯导航 + 没有 input 元素 → 顶层兜底吞掉 WebView 默认菜单。
      // 已接入自定义菜单的子元素（分类行）会在子级 onContextMenu 自己处理；
      // 其他智能筛选行 / "分类"标题 / "未分类"行右键无反应（桌面应用一致行为）
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <CheckSquare size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          待办
        </span>
        <div style={{ flex: 1 }} />
        <Button
          type="text"
          size="small"
          icon={<Plus size={14} />}
          onClick={() => {
            // 触发主区"新建任务"Modal：通过一次性 URL 参数携带
            navigate("/tasks?new=1");
          }}
          style={{ width: 24, height: 24, padding: 0 }}
          title="新建任务"
        />
      </div>

      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "6px 8px" }}
      >
        {/* 智能列表 */}
        {/*
          "全部任务" = 默认入口视图；列表视图下展示进行中任务 + 底部"已完成"折叠区，
          日历视图下进行中正常显示、已完成置灰显示。Badge 数仍只数未完成（与
          urgentTodoCount 等其他维度保持一致）。
        */}
        <SmartRow
          active={currentFilter === "todo"}
          icon={<ListChecks size={14} />}
          label="全部任务"
          count={counts.todo}
          onClick={() => goTo("todo")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "overdue"}
          icon={<AlertTriangle size={14} />}
          label="逾期"
          count={counts.overdue}
          danger
          onClick={() => goTo("overdue")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "today"}
          icon={<Sun size={14} />}
          label="今天"
          count={counts.today}
          onClick={() => goTo("today")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "week"}
          icon={<CalendarRange size={14} />}
          label="本周"
          count={counts.week}
          onClick={() => goTo("week")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "no-date"}
          icon={<CalendarClock size={14} />}
          label="无日期"
          count={counts["no-date"]}
          onClick={() => goTo("no-date")}
          token={token}
        />

        <GroupLabel token={token}>优先级</GroupLabel>

        <SmartRow
          active={currentFilter === "urgent"}
          icon={<Flame size={14} />}
          label="紧急"
          count={counts.urgent}
          danger
          onClick={() => goTo("urgent")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "normal"}
          icon={<Circle size={14} fill={token.colorPrimary} stroke="none" />}
          label="普通"
          count={counts.normal}
          onClick={() => goTo("normal")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "low"}
          icon={<Circle size={14} fill={token.colorTextQuaternary} stroke="none" />}
          label="低"
          count={counts.low}
          onClick={() => goTo("low")}
          token={token}
        />

        <GroupLabel token={token}>属性</GroupLabel>

        <SmartRow
          active={currentFilter === "recurring"}
          icon={<Repeat size={14} />}
          label="循环任务"
          count={counts.recurring}
          onClick={() => goTo("recurring")}
          token={token}
        />
        <SmartRow
          active={currentFilter === "linked"}
          icon={<LinkIcon size={14} />}
          label="有关联"
          count={counts.linked}
          onClick={() => goTo("linked")}
          token={token}
        />

        {/* 分类 section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: token.colorTextTertiary,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            padding: "12px 10px 6px",
          }}
        >
          <TagsIcon size={11} style={{ marginRight: 4 }} />
          <span style={{ flex: 1 }}>分类</span>
          <Button
            type="text"
            size="small"
            icon={<Plus size={12} />}
            onClick={() => openCreateCategory(null)}
            style={{ width: 20, height: 20, padding: 0, fontSize: 11 }}
            title="新建分类（右键分类可新建子分类）"
          />
          <Button
            type="text"
            size="small"
            icon={<SettingsIcon size={12} />}
            onClick={() => setManageOpen(true)}
            style={{ width: 20, height: 20, padding: 0, fontSize: 11 }}
            title="管理分类"
          />
        </div>
        <SmartRow
          active={currentCategory === "none"}
          icon={<InboxIcon size={14} />}
          label="未分类"
          count={categoryCounts.none}
          onClick={() => goToCategory("none")}
          token={token}
        />
        {categoryRows.map(({ category: c, depth, hasChildren }) => (
          <SmartRow
            key={c.id}
            active={currentCategory === String(c.id)}
            contextActive={ctx.state.payload?.id === c.id}
            icon={
              // 缩进 + 折叠箭头塞在图标位里，SmartRow 本身不用改
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  paddingLeft: depth * 12,
                }}
              >
                <span
                  role={hasChildren ? "button" : undefined}
                  title={hasChildren ? (collapsedCats.has(c.id) ? "展开" : "收起") : undefined}
                  onClick={(e) => {
                    if (!hasChildren) return;
                    e.stopPropagation();
                    toggleCollapsed(c.id);
                  }}
                  style={{
                    display: "inline-flex",
                    width: 12,
                    marginRight: 2,
                    color: token.colorTextTertiary,
                    cursor: hasChildren ? "pointer" : "default",
                  }}
                >
                  {hasChildren &&
                    (collapsedCats.has(c.id) ? (
                      <ChevronRightIcon size={11} />
                    ) : (
                      <ChevronDownIcon size={11} />
                    ))}
                </span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: c.color,
                  }}
                />
              </span>
            }
            label={c.name}
            count={categoryCounts.byId.get(c.id) ?? 0}
            onClick={() => goToCategory(c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              ctx.open(e.nativeEvent, { id: c.id, name: c.name });
            }}
            token={token}
          />
        ))}
        {categories.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: token.colorTextTertiary,
              padding: "4px 10px 10px",
            }}
          >
            <Button
              type="link"
              size="small"
              style={{ padding: 0, fontSize: 11, height: "auto" }}
              onClick={() => openCreateCategory(null)}
            >
              + 新建分类
            </Button>
          </div>
        )}

        <GroupLabel token={token}>归档</GroupLabel>

        <SmartRow
          active={currentFilter === "done"}
          icon={<Check size={14} />}
          label="已完成"
          count={counts.done}
          onClick={() => goTo("done")}
          token={token}
        />

        {/* 已放弃：不显计数——这个列表访问频率低，为它单开一个后端统计字段
            不划算；点进去自然看得到有多少条 */}
        <SmartRow
          active={currentFilter === "abandoned"}
          icon={<Ban size={14} />}
          label="已放弃"
          onClick={() => goTo("abandoned")}
          token={token}
        />
      </div>

      <TaskCategoryManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={reloadCategories}
      />

      {/* 分类右键菜单 */}
      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={categoryMenuItems}
        onClose={ctx.close}
      />

      {/* 分类名 Modal：新建 / 新建子分类 / 重命名 */}
      <Modal
        open={!!nameDialog}
        title={
          nameDialog?.mode === "rename"
            ? "重命名分类"
            : nameDialog?.parentName
              ? `在「${nameDialog.parentName}」下新建子分类`
              : "新建分类"
        }
        okText={nameDialog?.mode === "rename" ? "保存" : "创建"}
        cancelText="取消"
        onCancel={() => setNameDialog(null)}
        onOk={submitNameDialog}
        destroyOnHidden
      >
        <Input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onPressEnter={submitNameDialog}
          placeholder={nameDialog?.mode === "rename" ? "新分类名" : "分类名称"}
          maxLength={32}
          autoFocus
        />
      </Modal>
    </div>
  );
}

/** 分组小标题（UPPERCASE 灰字） */
function GroupLabel({
  children,
  token,
}: {
  children: React.ReactNode;
  token: { colorTextTertiary: string };
}) {
  return (
    <div
      style={{
        color: token.colorTextTertiary,
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "12px 10px 6px",
      }}
    >
      {children}
    </div>
  );
}

function SmartRow({
  active,
  contextActive,
  icon,
  label,
  count,
  danger,
  onClick,
  onContextMenu,
  token,
}: {
  active: boolean;
  /** 右键菜单当前指向本行 → 加蓝色描边 */
  contextActive?: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  danger?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  token: {
    colorPrimary: string;
    colorError: string;
    colorText: string;
    colorTextSecondary: string;
    colorTextTertiary: string;
  };
}) {
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="cursor-pointer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderRadius: 6,
        background: active ? `${token.colorPrimary}14` : "transparent",
        color: active ? token.colorPrimary : token.colorText,
        fontWeight: active ? 500 : undefined,
        fontSize: 13,
        outline: contextActive ? `1px solid ${token.colorPrimary}` : "none",
        outlineOffset: -1,
        transition: "background .15s, outline .1s",
      }}
    >
      <span
        style={{
          color: danger
            ? token.colorError
            : active
              ? token.colorPrimary
              : token.colorTextSecondary,
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {typeof count === "number" && count > 0 && (
        <Badge
          count={count}
          overflowCount={99}
          style={{
            backgroundColor: danger
              ? token.colorError
              : active
                ? token.colorPrimary
                : "transparent",
            color: danger || active ? "#fff" : token.colorTextTertiary,
            boxShadow: "none",
            fontWeight: 500,
          }}
        />
      )}
    </div>
  );
}
