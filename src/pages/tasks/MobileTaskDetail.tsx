import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  Trash2,
  Plus,
  Check,
  Clock,
  Bell,
  Repeat,
  Folder,
  Flag,
} from "lucide-react";
import { Drawer, Modal, message } from "antd";
import { taskApi } from "@/lib/api";
import { describeRepeat } from "@/lib/taskRepeat";
import { useAppStore } from "@/store";
import type { Task } from "@/types";
import TaskAttachments from "@/components/tasks/TaskAttachments";
import { AttachmentPreviewModal } from "@/components/preview/AttachmentPreviewModal";

/**
 * 移动端任务详情页（设计稿：12-task-edit.html）
 *
 * 路由 /task-detail/:id —— 移动端专用，独立顶层路由（沉浸式）
 *
 * 核心功能：
 * - 顶栏：返回 + 标题/保存状态 + 删除按钮（带确认）
 * - 主体：勾选 + 标题（input）+ 备注（textarea）
 * - 子任务：列表 + 勾选 + 添加新子任务（弹 prompt）
 * - 元数据行（暂只读）：截止时间 / 提醒 / 重复 / 分类 / 优先级
 * - 底部：推迟（snooze 30 分钟）/ 完成（toggleStatus）
 *
 * 自动保存：标题/备注 1.2s debounce 调 update。
 *
 * MVP 不做：
 * - 截止时间 / 提醒 / 重复 / 分类 完整编辑（点击只 toast「待开发」）
 * - 关联笔记 / 时间线
 * - 子任务拖拽排序
 */

const AUTOSAVE_DELAY_MS = 1200;
const SAVED_TOAST_MS = 2500;

type SaveStatus = "idle" | "dirty" | "saving" | "saved";

// 后端 TaskPriority = 0 | 1 | 2（紧急 / 普通 / 低）
const PRIORITY_LABELS = ["紧急", "普通", "低"];
const PRIORITY_COLORS = [
  "bg-red-50 text-red-700 border-red-200",
  "bg-blue-50 text-blue-700 border-blue-200",
  "bg-slate-50 text-slate-600 border-slate-200",
];

const REMIND_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "不提醒" },
  { value: 5, label: "提前 5 分钟" },
  { value: 15, label: "提前 15 分钟" },
  { value: 30, label: "提前 30 分钟" },
  { value: 60, label: "提前 1 小时" },
  { value: 120, label: "提前 2 小时" },
  { value: 1440, label: "提前 1 天" },
];

/** "YYYY-MM-DDTHH:MM" → "YYYY-MM-DD HH:MM:SS"（SQLite 友好），空字符串保留为 null */
function toSqliteDate(local: string): string | null {
  if (!local) return null;
  const [date, time] = local.split("T");
  return time ? `${date} ${time}:00` : `${date} 23:59:59`;
}

/** 反向：SQLite 字符串 → datetime-local input 接受的 "YYYY-MM-DDTHH:MM" */
function toLocalInput(sql: string | null): string {
  if (!sql) return "";
  const [date, time] = sql.split(" ");
  if (!time) return `${date}T23:59`;
  return `${date}T${time.slice(0, 5)}`;
}

export function MobileTaskDetail() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const taskId = Number(idParam);

  const [task, setTask] = useState<Task | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [snoozing, setSnoozing] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [dueInput, setDueInput] = useState("");
  const [remindOpen, setRemindOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);

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

  async function addSubtask() {
    const t = window.prompt("子任务标题");
    if (!t?.trim() || !task) return;
    try {
      await taskApi.create({
        title: t.trim(),
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

  function openDueEditor() {
    setDueInput(toLocalInput(task?.due_date ?? null));
    setDueOpen(true);
  }
  async function saveDue(clearOnly = false) {
    if (!task) return;
    try {
      await taskApi.update(task.id, {
        due_date: clearOnly ? null : toSqliteDate(dueInput),
      });
      setDueOpen(false);
      await load();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function setRemind(min: number | null) {
    if (!task) return;
    try {
      await taskApi.update(task.id, { remind_before_minutes: min });
      setRemindOpen(false);
      await load();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function setPriority(p: 0 | 1 | 2) {
    if (!task) return;
    try {
      await taskApi.update(task.id, { priority: p });
      setPriorityOpen(false);
      await load();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
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

  if (Number.isNaN(taskId)) {
    return (
      <div className="p-4 text-center text-sm text-slate-400">任务 ID 无效</div>
    );
  }

  const dueLabel = task?.due_date
    ? new Date(task.due_date).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未设置";
  const overdue =
    task?.due_date &&
    new Date(task.due_date).getTime() < Date.now() &&
    task.status === 0;

  const completedSubs = subtasks.filter((s) => s.status === 1).length;
  const isDone = task?.status === 1;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2 shrink-0">
        <button
          onClick={() => void flushAndExit()}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <div className="flex flex-col items-center min-w-0 flex-1 leading-tight">
          <span className="text-sm font-semibold text-slate-900">任务详情</span>
          <SaveBadge status={status} />
        </div>
        <button
          onClick={deleteTask}
          aria-label="删除"
          className="flex h-10 w-10 items-center justify-center"
        >
          <Trash2 size={20} className="text-red-500" />
        </button>
      </header>

      {/* 主体 */}
      <main className="flex-1 overflow-y-auto pb-4">
        {/* 标题 + 备注 */}
        <div className="border-b border-slate-200 bg-white px-4 py-4">
          <div className="flex items-start gap-3">
            <button
              onClick={toggleSelf}
              aria-label={isDone ? "标记未完成" : "标记完成"}
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 ${
                isDone
                  ? "border-[#1677FF] bg-[#1677FF] text-white"
                  : "border-slate-300"
              }`}
            >
              {isDone && <Check size={14} />}
            </button>
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
                className={`w-full bg-transparent text-lg font-semibold outline-none placeholder:text-slate-300 ${
                  isDone ? "text-slate-400 line-through" : "text-slate-900"
                }`}
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
                rows={2}
                className="mt-1 w-full resize-none bg-transparent text-sm text-slate-500 outline-none placeholder:text-slate-300"
              />
              {/* 附件：点缩略图全屏预览，「＋」从相册 / 文件选 */}
              <div className="mt-2">
                <TaskAttachments taskId={taskId} />
              </div>
            </div>
          </div>
        </div>

        {/* 子任务 */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">
            <span>
              子任务 · {completedSubs}/{subtasks.length}
            </span>
            <button
              onClick={addSubtask}
              className="flex items-center gap-0.5 text-[#1677FF]"
            >
              <Plus size={12} /> 添加
            </button>
          </div>
          {subtasks.length === 0 ? (
            <div className="rounded-2xl bg-white py-6 text-center text-xs text-slate-400 shadow-sm">
              还没有子任务
            </div>
          ) : (
            <div className="divide-y divide-slate-100 rounded-2xl bg-white">
              {subtasks.map((sub) => {
                const subDone = sub.status === 1;
                return (
                  <div
                    key={sub.id}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <input
                      type="checkbox"
                      checked={subDone}
                      onChange={() => toggleSubtask(sub)}
                      className="h-4 w-4 rounded"
                    />
                    <span
                      className={`flex-1 text-sm ${
                        subDone ? "text-slate-400 line-through" : "text-slate-700"
                      }`}
                    >
                      {sub.title}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 元属性（暂只读） */}
        <div className="px-4 py-2">
          <div className="divide-y divide-slate-100 rounded-2xl bg-white">
            <MetaRow
              icon={<Clock size={18} className="text-red-500" />}
              label="截止时间"
              value={
                <span
                  className={
                    overdue
                      ? "text-xs font-medium text-red-500"
                      : "text-xs text-slate-500"
                  }
                >
                  {overdue ? "⏰ 已逾期 " : ""}
                  {dueLabel}
                </span>
              }
              onClick={openDueEditor}
            />
            <MetaRow
              icon={<Bell size={18} className="text-amber-500" />}
              label="提醒"
              value={
                <span className="text-xs text-slate-500">
                  {/* 0 = 到点准时提醒，不是「不提醒」；只有 null 才是不提醒 */}
                  {task?.remind_before_minutes == null
                    ? "不提醒"
                    : task.remind_before_minutes === 0
                      ? "准时提醒"
                      : `提前 ${task.remind_before_minutes} 分钟`}
                </span>
              }
              onClick={() => setRemindOpen(true)}
            />
            <MetaRow
              icon={<Repeat size={18} className="text-blue-500" />}
              label="重复"
              value={
                <span className="text-xs text-slate-400">
                  {(task && describeRepeat(task)) || "不重复"}
                </span>
              }
              onClick={() => message.info("重复规则需要在桌面端编辑")}
            />
            <MetaRow
              icon={<Folder size={18} className="text-orange-500" />}
              label="分类"
              value={<span className="text-xs text-slate-400">未分类</span>}
              onClick={() => message.info("分类需要在桌面端管理")}
            />
            <MetaRow
              icon={<Flag size={18} className="text-red-500" />}
              label="优先级"
              value={
                <span
                  className={`rounded px-1.5 py-0.5 text-xs border ${PRIORITY_COLORS[task?.priority ?? 1]}`}
                >
                  {PRIORITY_LABELS[task?.priority ?? 1] ?? "普通"}
                </span>
              }
              onClick={() => setPriorityOpen(true)}
            />
          </div>
        </div>

        {/* 元信息 */}
        {task && (
          <div className="px-4 py-2 text-center text-[11px] text-slate-400">
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
        className="border-t border-slate-200 bg-white px-4 py-3 shrink-0"
        style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="flex gap-2">
          <button
            onClick={snooze}
            disabled={snoozing}
            className="flex h-11 flex-1 items-center justify-center rounded-xl bg-slate-100 text-sm font-medium text-slate-700 active:bg-slate-200 disabled:opacity-50"
          >
            推迟 30 分钟
          </button>
          <button
            onClick={toggleSelf}
            className="flex h-11 flex-1 items-center justify-center rounded-xl bg-[#1677FF] text-sm font-medium text-white active:scale-95 transition-transform"
          >
            {isDone ? "标记未完成" : "完成"}
          </button>
        </div>
      </footer>

      {/* 截止时间编辑 Modal */}
      <Modal
        title="设置截止时间"
        open={dueOpen}
        onCancel={() => setDueOpen(false)}
        footer={
          <div className="flex gap-2">
            <button
              onClick={() => void saveDue(true)}
              className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700"
            >
              清除
            </button>
            <button
              onClick={() => setDueOpen(false)}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              取消
            </button>
            <button
              onClick={() => void saveDue(false)}
              className="flex-1 rounded-lg bg-[#1677FF] px-3 py-2 text-sm font-medium text-white"
            >
              保存
            </button>
          </div>
        }
      >
        <input
          type="datetime-local"
          value={dueInput}
          onChange={(e) => setDueInput(e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <div className="mt-2 text-xs text-slate-400">
          只填日期不填时间会默认为当天 23:59
        </div>
      </Modal>

      {/* 提醒选择 Drawer */}
      <Drawer
        title="提前多久提醒"
        placement="bottom"
        height={Math.min(REMIND_OPTIONS.length * 56 + 100, 540)}
        open={remindOpen}
        onClose={() => setRemindOpen(false)}
      >
        <div className="flex flex-col gap-2">
          {REMIND_OPTIONS.map((opt) => {
            const active = (task?.remind_before_minutes ?? null) === opt.value;
            return (
              <button
                key={String(opt.value)}
                onClick={() => void setRemind(opt.value)}
                className={`flex items-center justify-between rounded-xl px-4 py-3 text-left ${
                  active
                    ? "border border-[#1677FF] bg-blue-50"
                    : "border border-slate-100 bg-white"
                }`}
              >
                <span className="text-sm text-slate-800">{opt.label}</span>
                {active && (
                  <span className="text-xs font-semibold text-[#1677FF]">
                    ✓ 当前
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Drawer>

      {/* 优先级选择 Drawer */}
      <Drawer
        title="优先级"
        placement="bottom"
        height={320}
        open={priorityOpen}
        onClose={() => setPriorityOpen(false)}
      >
        <div className="grid grid-cols-2 gap-2">
          {PRIORITY_LABELS.map((label, idx) => {
            const active = task?.priority === idx;
            return (
              <button
                key={label}
                onClick={() => void setPriority(idx as 0 | 1 | 2)}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl py-4 ${PRIORITY_COLORS[idx]} ${
                  active ? "ring-2 ring-offset-1" : ""
                }`}
              >
                <Flag size={18} />
                <span className="text-sm font-semibold">{label}</span>
              </button>
            );
          })}
        </div>
      </Drawer>
      {/* 本页是独立路由、不挂 AppLayout，附件条点开非图片文件要自己挂预览弹窗 */}
      <AttachmentPreviewModal />
    </div>
  );
}

function MetaRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 active:bg-slate-50"
    >
      {icon}
      <span className="flex-1 text-left text-sm text-slate-800">{label}</span>
      {value}
    </button>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "saving")
    return <span className="mt-0.5 text-[10px] text-orange-600">保存中…</span>;
  if (status === "saved")
    return (
      <span className="mt-0.5 text-[10px] text-green-600">已保存 · 刚刚</span>
    );
  return <span className="mt-0.5 h-3.5 text-[10px]" aria-hidden />;
}
