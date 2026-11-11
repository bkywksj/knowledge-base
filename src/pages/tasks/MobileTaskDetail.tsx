import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Trash2, Plus, Check, Clock, Bell, Repeat, Folder, Flag, Star } from "lucide-react";
import { Modal, message } from "antd";
import { taskApi, taskCategoryApi } from "@/lib/api";
import { describeRepeat } from "@/lib/taskRepeat";
import { describeDueDate } from "@/lib/taskFilters";
import { useAppStore } from "@/store";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import type { Task, TaskCategory, TaskPriority, UpdateTaskInput } from "@/types";
import TaskAttachments from "@/components/tasks/TaskAttachments";
import { AttachmentPreviewModal } from "@/components/preview/AttachmentPreviewModal";
import { MGroup, MNavBar, MRow, MSectionHeader, MTag } from "@/components/mobile/primitives";
import { MSheet, PickRow } from "@/components/mobile/MSheet";
import { REMIND_OPTIONS, flattenCategories, remindLabel, toLocalInput, toSqliteDate } from "@/lib/taskForm";
import { RepeatSheet } from "@/components/mobile/RepeatSheet";
import { TextPromptModal } from "@/components/mobile/TextPromptModal";

/**
 * 移动端任务详情页（v4 样式，与列表页 / 新建面板同一套 .m-* 令牌）
 *
 * 路由 /task-detail/:id —— 移动端专用，独立顶层路由（沉浸式，不挂底部 Tab）
 *
 * - 顶栏：返回（先保存）+「任务详情」/ 保存状态 + 删除（带确认）
 * - 主卡：勾选 + 标题 + 备注 + 附件；标题 / 备注停 1.2s 自动保存
 * - 子任务：列表 + 勾选（循环子任务完成本次）+ 添加
 * - 属性：截止 / 提醒 / 重复 / 分类 / 优先级 / 重要，全部可在手机上改（2026-11 起分类、重复、重要不再要求去桌面端）
 * - 底部：推迟 30 分钟（snooze）/ 完成（循环任务 = 完成本次）
 *
 * 不做：关联笔记 / 时间线、子任务拖拽排序、重复的结束条件（沿用桌面端设置）
 */

const AUTOSAVE_DELAY_MS = 1200;
const SAVED_TOAST_MS = 2500;

type SaveStatus = "idle" | "dirty" | "saving" | "saved";

// 后端 TaskPriority = 0 | 1 | 2（紧急 / 普通 / 低）
const PRIORITY_LABELS = ["紧急", "普通", "低"];
const PRIORITY_TONE = ["bad", "accent", "neutral"] as const;
const PRIORITY_DOT = ["var(--m-bad)", "var(--m-accent)", "var(--m-ink4)"];

export function MobileTaskDetail() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const taskId = Number(idParam);
  const keyboardInset = useKeyboardInset();

  const [task, setTask] = useState<Task | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [snoozing, setSnoozing] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [dueInput, setDueInput] = useState("");
  const [remindOpen, setRemindOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [subPromptOpen, setSubPromptOpen] = useState(false);

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const savedHideTimerRef = useRef<number | null>(null);
  // 防 React 闭包陷阱：onChange 同步调 scheduleSave 时 setState 还没生效
  const titleRef = useRef("");
  const descRef = useRef("");

  const load = useCallback(async () => {
    if (!taskId || Number.isNaN(taskId)) return;
    try {
      const [t, subs] = await Promise.all([
        taskApi.get(taskId),
        taskApi.listSubtasks(taskId).catch(() => [] as Task[]),
      ]);
      setTask(t);
      setTitle(t.title);
      setDescription(t.description ?? "");
      titleRef.current = t.title;
      descRef.current = t.description ?? "";
      setSubtasks(subs);
      dirtyRef.current = false;
      setStatus("idle");
    } catch (e) {
      message.error(`加载失败: ${e}`);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    taskCategoryApi.list().then(setCategories).catch(() => {});
  }, []);

  const doSave = useCallback(async () => {
    if (!task || !dirtyRef.current) return;
    setStatus("saving");
    try {
      // 用 ref 读最新值，避免 React 闭包陷阱
      await taskApi.update(task.id, {
        title: titleRef.current,
        description: descRef.current || null,
      });
      dirtyRef.current = false;
      setStatus("saved");
      if (savedHideTimerRef.current) {
        window.clearTimeout(savedHideTimerRef.current);
      }
      savedHideTimerRef.current = window.setTimeout(() => {
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, SAVED_TOAST_MS);
    } catch (e) {
      message.error(`保存失败: ${e}`);
      setStatus("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  function scheduleSave() {
    dirtyRef.current = true;
    setStatus("dirty");
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DELAY_MS);
  }

  async function flushAndExit() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current) await doSave();
    useAppStore.getState().refreshTaskStats();
    navigate(-1);
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (savedHideTimerRef.current)
        window.clearTimeout(savedHideTimerRef.current);
      if (dirtyRef.current) {
        void doSave().then(() => {
          useAppStore.getState().refreshTaskStats();
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleSelf() {
    if (!task) return;
    try {
      // 循环任务勾选 = 完成本次（推进到下一次），不是结束整条循环
      if (task.status === 0 && task.repeat_kind !== "none") {
        await taskApi.completeOccurrence(task.id);
        message.success("已完成本次，已推进到下一次");
      } else {
        await taskApi.toggleStatus(task.id);
      }
      await load();
      useAppStore.getState().refreshTaskStats();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  async function toggleSubtask(sub: Task) {
    try {
      if (sub.status === 0 && sub.repeat_kind !== "none") {
        await taskApi.completeOccurrence(sub.id);
      } else {
        await taskApi.toggleStatus(sub.id);
      }
      const subs = await taskApi.listSubtasks(taskId);
      setSubtasks(subs);
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  async function addSubtask(t: string) {
    if (!task) return;
    try {
      await taskApi.create({
        title: t,
        parent_task_id: task.id,
      });
      const subs = await taskApi.listSubtasks(taskId);
      setSubtasks(subs);
    } catch (e) {
      message.error(`添加失败: ${e}`);
    }
  }

  async function snooze() {
    if (!task || snoozing) return;
    setSnoozing(true);
    try {
      await taskApi.snooze(task.id, 30);
      message.success("已推迟 30 分钟");
      await load();
    } catch (e) {
      message.error(`推迟失败: ${e}`);
    } finally {
      setSnoozing(false);
    }
  }

  /** 属性类字段（截止 / 提醒 / 优先级 / 分类 / 重复 / 重要）即改即存，存完重拉 */
  async function patch(input: Partial<UpdateTaskInput>): Promise<boolean> {
    if (!task) return false;
    try {
      await taskApi.update(task.id, input);
      await load();
      useAppStore.getState().refreshTaskStats();
      return true;
    } catch (e) {
      message.error(`保存失败: ${e}`);
      return false;
    }
  }

  function openDueEditor() {
    setDueInput(toLocalInput(task?.due_date ?? null));
    setDueOpen(true);
  }
  // 清空一律走 clear_*：后端把字段缺省 / null 都当「不改」，旧版这里发 null 导致「清除」「不提醒」点了没反应
  async function saveDue(clearOnly = false) {
    const v = clearOnly ? null : toSqliteDate(dueInput);
    if (await patch(v == null ? { clear_due_date: true } : { due_date: v })) setDueOpen(false);
  }

  async function setRemind(min: number | null) {
    if (await patch(min == null ? { clear_remind_before_minutes: true } : { remind_before_minutes: min })) setRemindOpen(false);
  }

  async function setPriority(p: TaskPriority) {
    if (await patch({ priority: p })) setPriorityOpen(false);
  }

  async function setCategory(id: number | null) {
    if (await patch(id == null ? { clear_category_id: true } : { category_id: id })) setCategoryOpen(false);
  }

  function deleteTask() {
    if (!task) return;
    Modal.confirm({
      title: `删除任务「${task.title || "未命名"}」？`,
      content: "此操作不可撤销。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await taskApi.delete(task.id);
          message.success("已删除");
          useAppStore.getState().refreshTaskStats();
          navigate(-1);
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);

  if (Number.isNaN(taskId)) {
    return (
      <div className="m-t-meta p-4 text-center">任务 ID 无效</div>
    );
  }

  const isDone = task?.status === 1;
  const due = describeDueDate(task?.due_date ?? null, isDone);
  const completedSubs = subtasks.filter((s) => s.status === 1).length;
  const category = task?.category_id != null ? categories.find((c) => c.id === task.category_id) : undefined;
  const priority = task?.priority ?? 1;
  const iconStyle = { color: "var(--m-ink2)" };

  return (
    <div
      className="m-root fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--m-page)", color: "var(--m-ink)", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: keyboardInset }}
    >
      <div className="shrink-0" style={{ background: "var(--m-page)" }}>
        <MNavBar
          title="任务详情"
          subtitle={status === "saving" ? "保存中…" : status === "saved" ? "已保存 · 刚刚" : undefined}
          onBack={() => void flushAndExit()}
          actions={
            <button type="button" aria-label="删除" className="m-icon-btn" style={{ color: "var(--m-bad)" }} onClick={deleteTask}>
              <Trash2 size={20} />
            </button>
          }
        />
      </div>

      <main className="m-gutter flex-1 overflow-y-auto pt-2 pb-6">
        {/* 标题 + 备注 + 附件 */}
        <MGroup className="px-4 py-4">
          <div className="flex items-start gap-3">
            <CheckBox done={isDone} size={24} onClick={() => void toggleSelf()} label={isDone ? "标记未完成" : "标记完成"} />
            <div className="min-w-0 flex-1">
              <input
                value={title}
                onChange={(e) => {
                  const v = e.target.value;
                  titleRef.current = v;
                  setTitle(v);
                  scheduleSave();
                }}
                placeholder="任务标题"
                aria-label="任务标题"
                className="-my-2 min-h-[44px] w-full bg-transparent py-2 text-[20px] font-bold leading-snug outline-none placeholder:font-normal placeholder:text-[var(--m-ink4)]"
                style={isDone ? { color: "var(--m-ink3)", textDecoration: "line-through" } : { color: "var(--m-ink)" }}
              />
              <textarea
                value={description}
                onChange={(e) => {
                  const v = e.target.value;
                  descRef.current = v;
                  setDescription(v);
                  scheduleSave();
                }}
                placeholder="备注…"
                aria-label="备注"
                rows={2}
                className="mt-1.5 w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-[var(--m-ink4)]"
                style={{ color: "var(--m-ink2)" }}
              />
              {/* 附件：点缩略图全屏预览，「＋」从相册 / 文件选 */}
              <div className="m-task-attach mt-2">
                <TaskAttachments taskId={taskId} />
              </div>
            </div>
          </div>
        </MGroup>

        {/* 子任务 */}
        <MSectionHeader
          className="mt-6 mb-2 px-1"
          title="子任务"
          count={subtasks.length > 0 ? `${completedSubs}/${subtasks.length}` : undefined}
          action={
            <button type="button" className="m-tapx flex items-center gap-1 text-[15px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => setSubPromptOpen(true)}>
              <Plus size={16} /> 添加
            </button>
          }
        />
        <MGroup>
          {subtasks.length === 0 ? (
            <div className="m-t-meta py-6 text-center">还没有子任务</div>
          ) : (
            subtasks.map((sub, i) => {
              const subDone = sub.status === 1;
              return (
                <div key={sub.id} className="relative flex items-center gap-3 px-4 py-3">
                  {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-[50px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
                  <CheckBox done={subDone} onClick={() => void toggleSubtask(sub)} label={subDone ? "标记未完成" : "完成"} />
                  <span
                    className="min-w-0 flex-1 text-[15px]"
                    style={subDone ? { color: "var(--m-ink3)", textDecoration: "line-through" } : { color: "var(--m-ink)" }}
                  >
                    {sub.title}
                  </span>
                </div>
              );
            })
          )}
        </MGroup>

        {/* 属性：全部可改 */}
        <MGroup className="mt-6">
          <MRow
            icon={<Clock size={20} style={iconStyle} />}
            chevron
            onClick={openDueEditor}
            right={
              task?.due_date ? (
                <span style={due.overdue ? { color: "var(--m-bad)", fontWeight: 600 } : undefined}>{due.text}</span>
              ) : (
                "未设置"
              )
            }
          >
            截止时间
          </MRow>
          <MRow icon={<Bell size={20} style={iconStyle} />} chevron onClick={() => setRemindOpen(true)} right={remindLabel(task?.remind_before_minutes)}>
            提醒
          </MRow>
          <MRow icon={<Repeat size={20} style={iconStyle} />} chevron onClick={() => setRepeatOpen(true)} right={(task && describeRepeat(task)) || "不重复"}>
            重复
          </MRow>
          <MRow
            icon={<Folder size={20} style={iconStyle} />}
            chevron
            onClick={() => setCategoryOpen(true)}
            right={
              category ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="m-dot" style={{ background: category.color }} />
                  {category.name}
                </span>
              ) : (
                "未分类"
              )
            }
          >
            分类
          </MRow>
          <MRow icon={<Flag size={20} style={iconStyle} />} chevron onClick={() => setPriorityOpen(true)} right={<MTag tone={PRIORITY_TONE[priority] ?? "accent"}>{PRIORITY_LABELS[priority] ?? "普通"}</MTag>}>
            优先级
          </MRow>
          <MRow
            icon={<Star size={20} style={task?.important ? { color: "var(--m-warn)" } : iconStyle} fill={task?.important ? "currentColor" : "none"} />}
            role="switch"
            aria-checked={!!task?.important}
            onClick={() => void patch({ important: !task?.important })}
            right={<Switch on={!!task?.important} />}
          >
            重要
          </MRow>
        </MGroup>

        {/* 元信息 */}
        {task && (
          <div className="m-t-cap mt-4 text-center leading-relaxed">
            创建于 {new Date(task.created_at).toLocaleString("zh-CN")}
            {task.completed_at && (
              <>
                <br />完成于 {new Date(task.completed_at).toLocaleString("zh-CN")}
              </>
            )}
          </div>
        )}
      </main>

      {/* 底部操作栏 */}
      <footer
        className="m-gutter flex shrink-0 gap-3 pt-3"
        style={{
          background: "var(--m-surface)",
          borderTop: "0.5px solid var(--m-hair)",
          paddingBottom: keyboardInset ? 12 : "calc(12px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <button type="button" className="m-btn flex-1" style={{ background: "var(--m-well)", color: "var(--m-ink)" }} onClick={() => void snooze()} disabled={snoozing}>
          推迟 30 分钟
        </button>
        <button type="button" className="m-btn flex-1" onClick={() => void toggleSelf()}>
          {isDone ? "标记未完成" : "完成"}
        </button>
      </footer>

      {/* 截止时间 */}
      <MSheet
        open={dueOpen}
        title="截止时间"
        caption="只填日期不填时间会默认为当天 23:59"
        onClose={() => setDueOpen(false)}
        footer={
          <div className="mt-4 flex items-center gap-3">
            <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-bad)" }} onClick={() => void saveDue(true)}>
              清除
            </button>
            <div className="flex-1" />
            <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={() => setDueOpen(false)}>
              取消
            </button>
            <button type="button" className="m-btn" onClick={() => void saveDue(false)}>
              保存
            </button>
          </div>
        }
      >
        <input
          type="datetime-local"
          value={dueInput}
          onChange={(e) => setDueInput(e.target.value)}
          aria-label="截止时间"
          className="h-12 w-full rounded-[var(--m-r-l)] px-3 text-[16px] outline-none"
          style={{ background: "var(--m-well)", color: "var(--m-ink)" }}
        />
      </MSheet>

      {/* 提醒 */}
      <MSheet
        open={remindOpen}
        title="提前多久提醒"
        caption={task && !task.due_date ? "还没设截止时间，提醒要等设了截止时间才会触发" : undefined}
        onClose={() => setRemindOpen(false)}
      >
        <div className="m-group">
          {REMIND_OPTIONS.map((v) => (
            <PickRow key={String(v)} label={remindLabel(v)} active={(task?.remind_before_minutes ?? null) === v} onClick={() => void setRemind(v)} />
          ))}
        </div>
      </MSheet>

      {/* 优先级 */}
      <MSheet open={priorityOpen} title="优先级" onClose={() => setPriorityOpen(false)}>
        <div className="m-group">
          {PRIORITY_LABELS.map((label, idx) => (
            <PickRow key={label} label={label} dot={PRIORITY_DOT[idx]} active={priority === idx} onClick={() => void setPriority(idx as TaskPriority)} />
          ))}
        </div>
      </MSheet>

      {/* 分类（多级缩进） */}
      <MSheet open={categoryOpen} title="分类" caption={categories.length === 0 ? "还没有分类，可在桌面端待办侧栏新建" : undefined} onClose={() => setCategoryOpen(false)}>
        <div className="m-group max-h-[50vh] overflow-y-auto">
          <PickRow label="未分类" dot="var(--m-ink4)" active={task?.category_id == null} onClick={() => void setCategory(null)} />
          {flatCategories.map(({ c, depth }) => (
            <PickRow key={c.id} label={c.name} dot={c.color} indent={depth} active={task?.category_id === c.id} onClick={() => void setCategory(c.id)} />
          ))}
        </div>
      </MSheet>

      <RepeatSheet
        open={repeatOpen}
        task={task}
        onClose={() => setRepeatOpen(false)}
        onSave={patch}
      />

      <TextPromptModal
        open={subPromptOpen}
        title="添加子任务"
        placeholder="子任务标题"
        okText="添加"
        maxLength={200}
        onOk={addSubtask}
        onClose={() => setSubPromptOpen(false)}
      />

      {/* 本页是独立路由、不挂 AppLayout，附件条点开非图片文件要自己挂预览弹窗 */}
      <AttachmentPreviewModal />
    </div>
  );
}

/** 方形勾选框（同列表页）：视觉 22 / 24，透明热区撑到 44 */
function CheckBox({ done, onClick, label, size = 22 }: { done: boolean; onClick: () => void; label: string; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative mt-0.5 flex shrink-0 items-center justify-center rounded-[var(--m-r-s)] after:absolute after:-inset-[11px] after:content-['']"
      style={{
        width: size,
        height: size,
        ...(done ? { background: "var(--m-ok)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.6px var(--m-ink4)" }),
      }}
    >
      {done && <Check size={size - 8} strokeWidth={3} />}
    </button>
  );
}

/** 开关外观（交互挂在整行 MRow 上，role="switch"） */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className="relative inline-block h-[26px] w-[44px] rounded-full transition-colors"
      style={{ background: on ? "var(--m-btn)" : "var(--m-ink4)" }}
    >
      <span
        className="absolute top-[3px] h-5 w-5 rounded-full bg-white transition-[left]"
        style={{ left: on ? 21 : 3 }}
      />
    </span>
  );
}
