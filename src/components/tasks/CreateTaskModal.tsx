import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Input,
  InputNumber,
  Segmented,
  DatePicker,
  Checkbox,
  Button,
  Tag,
  Dropdown,
  Select,
  App as AntdApp,
  Space,
  Typography,
  theme as antdTheme,
} from "antd";
import type { MenuProps, RefSelectProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Plus, NotebookText, Folder as FolderIcon, File as FileIcon, Link as LinkIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNavigate } from "react-router-dom";
import { taskApi, noteApi, configApi } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import type {
  Note,
  Task,
  TaskLinkInput,
  TaskPriority,
  TaskRepeatKind,
  UpdateTaskInput,
  CreateTaskInput,
} from "@/types";

type RepeatMode = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
type EndMode = "never" | "until" | "count";
type CustomUnit = "day" | "week" | "month";

interface Props {
  open: boolean;
  editing?: Task | null;
  /** 新建时预设紧急度（看板某列 + 号传进来） */
  presetPriority?: TaskPriority;
  /** 新建时预设"重要"标记（四象限视图 + 号传进来） */
  presetImportant?: boolean;
  /** 新建时预设截止日期 YYYY-MM-DD（日历双击格子传进来） */
  presetDueDate?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function CreateTaskModal({
  open,
  editing,
  presetPriority,
  presetImportant,
  presetDueDate,
  onClose,
  onSaved,
}: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();

  /** 跳到设置页对应区块（默认提醒时刻），关闭当前弹窗 */
  function handleGoSettingsTaskReminder() {
    onClose();
    navigate("/settings", { state: { scrollTo: "settings-task-reminder" } });
  }

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(1);
  const [important, setImportant] = useState(false);
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);
  /** 提前多少分钟提醒；null=不提醒；0=准时 */
  const [remindBefore, setRemindBefore] = useState<number | null>(null);
  const [links, setLinks] = useState<TaskLinkInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [continuous, setContinuous] = useState(false);
  // ─── 循环提醒状态 ─────────────────────────
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("none");
  const [customInterval, setCustomInterval] = useState(2);
  const [customUnit, setCustomUnit] = useState<CustomUnit>("day");
  const [customWeekdays, setCustomWeekdays] = useState<number[]>([]);
  const [endMode, setEndMode] = useState<EndMode>("never");
  const [repeatUntil, setRepeatUntil] = useState<Dayjs | null>(null);
  const [repeatCount, setRepeatCount] = useState<number>(10);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  /** 选日期时用于填充的默认时分（从 app_config.all_day_reminder_time 读，默认 09:00） */
  const [defaultTime, setDefaultTime] = useState("09:00");

  // 组件首次挂载时拉一次默认时分；早于用户打开弹窗加载，避免首屏跳变
  useEffect(() => {
    configApi
      .get("all_day_reminder_time")
      .then((v) => {
        if (v && /^\d{2}:\d{2}/.test(v)) setDefaultTime(v.slice(0, 5));
      })
      .catch(() => {});
  }, []);

  /** 算出任务实际提醒时刻：截止时间 - remindBefore 分钟 */
  const reminderAt = useMemo<Dayjs | null>(() => {
    if (!dueDate || remindBefore === null) return null;
    return dueDate.second(0).subtract(remindBefore, "minute");
  }, [dueDate, remindBefore]);

  /** 切日期时，若已有 dueDate 则保留时分，否则用 defaultTime */
  function applyDate(target: Dayjs): Dayjs {
    const [h, m] = defaultTime.split(":").map(Number);
    return target
      .hour(dueDate?.hour() ?? h ?? 9)
      .minute(dueDate?.minute() ?? m ?? 0)
      .second(0)
      .millisecond(0);
  }

  // 笔记选择器状态（原地下拉）
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");
  const [noteOptions, setNoteOptions] = useState<Note[]>([]);
  const [noteLoading, setNoteLoading] = useState(false);
  const noteSelectRef = useRef<RefSelectProps>(null);
  const noteSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setDescription(editing.description ?? "");
      setPriority(editing.priority);
      setImportant(editing.important);
      // 旧数据若长度 = 10（仅日期），自动补默认时分以满足"始终带时间"
      if (editing.due_date) {
        let d = dayjs(editing.due_date);
        if (editing.due_date.length <= 10) {
          const [h, m] = defaultTime.split(":").map(Number);
          d = d.hour(h ?? 9).minute(m ?? 0).second(0);
        }
        setDueDate(d);
      } else {
        setDueDate(null);
      }
      setRemindBefore(editing.remind_before_minutes);
      setLinks(
        editing.links.map((l) => ({
          kind: l.kind,
          target: l.target,
          label: l.label,
        })),
      );
      // 反向识别循环预设
      const { mode, unit, interval, weekdays } = detectRepeatMode(editing);
      setRepeatMode(mode);
      setCustomUnit(unit);
      setCustomInterval(interval);
      setCustomWeekdays(weekdays);
      // 结束条件
      if (editing.repeat_until) {
        setEndMode("until");
        setRepeatUntil(dayjs(editing.repeat_until));
        setRepeatCount(10);
      } else if (editing.repeat_count) {
        setEndMode("count");
        setRepeatCount(editing.repeat_count);
        setRepeatUntil(null);
      } else {
        setEndMode("never");
        setRepeatUntil(null);
        setRepeatCount(10);
      }
    } else {
      setTitle("");
      setDescription("");
      setPriority(presetPriority ?? 1);
      setImportant(presetImportant ?? false);
      if (presetDueDate) {
        const [h, m] = defaultTime.split(":").map(Number);
        setDueDate(dayjs(presetDueDate).hour(h ?? 9).minute(m ?? 0).second(0));
      } else {
        setDueDate(null);
      }
      setRemindBefore(null);
      setLinks([]);
      // 循环默认清零
      setRepeatMode("none");
      setCustomInterval(2);
      setCustomUnit("day");
      setCustomWeekdays([]);
      setEndMode("never");
      setRepeatUntil(null);
      setRepeatCount(10);
    }
    setContinuous(false);
    setUrlInputOpen(false);
    setUrlInput("");
    setNotePickerOpen(false);
    setNoteQuery("");
    setNoteOptions([]);
  }, [open, editing, presetPriority, presetImportant, presetDueDate]);

  /** 拉候选笔记：keyword 空 → 最近 8 条，非空 → 模糊搜前 10 条 */
  const loadNoteCandidates = useCallback(async (keyword: string) => {
    setNoteLoading(true);
    try {
      const result = await noteApi.list({
        page: 1,
        page_size: keyword.trim() ? 10 : 8,
        keyword: keyword.trim() || undefined,
      });
      setNoteOptions(result.items);
    } catch (e) {
      console.error("加载笔记候选失败:", e);
      setNoteOptions([]);
    } finally {
      setNoteLoading(false);
    }
  }, []);

  /** 防抖搜索 */
  const handleNoteSearch = useCallback(
    (v: string) => {
      setNoteQuery(v);
      if (noteSearchTimerRef.current) clearTimeout(noteSearchTimerRef.current);
      noteSearchTimerRef.current = setTimeout(() => {
        loadNoteCandidates(v);
      }, 300);
    },
    [loadNoteCandidates],
  );

  // 打开笔记选择器时加载"最近"
  useEffect(() => {
    if (!notePickerOpen) return;
    setNoteQuery("");
    loadNoteCandidates("");
  }, [notePickerOpen, loadNoteCandidates]);

  // 卸载清 timer
  useEffect(
    () => () => {
      if (noteSearchTimerRef.current) clearTimeout(noteSearchTimerRef.current);
    },
    [],
  );

  /** 打开行内笔记选择器（原地下拉） */
  function handleAddNoteLink() {
    setNotePickerOpen(true);
  }

  /** 选中笔记：加到 links，清空 select 值，保持下拉开，让用户继续选 */
  function handleNoteSelect(note: Note) {
    if (links.some((l) => l.kind === "note" && l.target === String(note.id))) {
      message.info("该笔记已关联");
    } else {
      setLinks((prev) => [
        ...prev,
        { kind: "note", target: String(note.id), label: note.title },
      ]);
    }
    // 清空搜索词 + 重新拉"最近"
    setNoteQuery("");
    loadNoteCandidates("");
    // 重新 focus 输入框，保持下拉打开
    setTimeout(() => noteSelectRef.current?.focus(), 0);
  }

  /**
   * 关联本地路径：directory=true 选目录，false 选文件。
   * 存储都走 kind="path"，点击时走 openPath，文件/目录均可用系统默认应用打开。
   */
  async function handleAddPathLink(directory: boolean) {
    try {
      const picked = await openDialog({ directory, multiple: false });
      if (!picked || typeof picked !== "string") return;
      const label = picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
      setLinks((prev) => [...prev, { kind: "path", target: picked, label }]);
    } catch (e) {
      message.error(`选择${directory ? "目录" : "文件"}失败: ${e}`);
    }
  }

  function handleAddUrlLink() {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setLinks((prev) => [
      ...prev,
      { kind: "url", target: trimmed, label: trimmed },
    ]);
    setUrlInput("");
    setUrlInputOpen(false);
  }

  function removeLink(idx: number) {
    setLinks((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    if (!title.trim()) {
      message.warning("请填写任务标题");
      return;
    }
    setSaving(true);
    try {
      const dueStr = dueDate ? dueDate.format("YYYY-MM-DD HH:mm:ss") : null;
      const repeatPayload = buildRepeatPayload({
        mode: repeatMode,
        unit: customUnit,
        interval: customInterval,
        weekdays: customWeekdays,
        endMode,
        until: repeatUntil,
        count: repeatCount,
      });
      if (isEdit && editing) {
        await taskApi.update(editing.id, {
          title: title.trim(),
          description: description.trim() || null,
          priority,
          important,
          due_date: dueStr ?? undefined,
          clear_due_date: !dueStr,
          remind_before_minutes: remindBefore ?? undefined,
          clear_remind_before_minutes: remindBefore === null,
          ...repeatPayload.update,
        });
        // 更新 links：简单策略——删除所有旧的，再加新的
        for (const l of editing.links) {
          await taskApi.removeLink(l.id).catch(() => {});
        }
        for (const l of links) {
          await taskApi.addLink(editing.id, l).catch(() => {});
        }
        message.success("已保存");
      } else {
        await taskApi.create({
          title: title.trim(),
          description: description.trim() || null,
          priority,
          important,
          due_date: dueStr,
          remind_before_minutes: remindBefore,
          links,
          ...repeatPayload.create,
        });
        message.success("已创建");
      }
      if (continuous && !isEdit) {
        // 连续新建：保留紧急度和截止时间，清空标题/描述/关联
        setTitle("");
        setDescription("");
        setLinks([]);
        onSaved();
      } else {
        onSaved();
      }
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  const addMenu: MenuProps = {
    items: [
      { key: "note", icon: <NotebookText size={14} />, label: "笔记" },
      { key: "file", icon: <FileIcon size={14} />, label: "本地文件" },
      { key: "path", icon: <FolderIcon size={14} />, label: "本地目录" },
      { key: "url", icon: <LinkIcon size={14} />, label: "外部链接" },
    ],
    onClick: ({ key }) => {
      if (key === "note") handleAddNoteLink();
      else if (key === "file") handleAddPathLink(false);
      else if (key === "path") handleAddPathLink(true);
      else {
        setUrlInputOpen(true);
      }
    },
  };

  return (
    <Modal
      title={isEdit ? "编辑任务" : "新建任务"}
      open={open}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      styles={{ body: { maxHeight: "65vh", overflowY: "auto", paddingRight: 12 } }}
      footer={
        <div className="flex items-center justify-between">
          <Checkbox
            checked={continuous}
            onChange={(e) => setContinuous(e.target.checked)}
            disabled={isEdit}
          >
            <span className="text-xs">保存后继续新建下一条</span>
          </Checkbox>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              保存
            </Button>
          </Space>
        </div>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        {/* 标题 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            标题 <span style={{ color: token.colorError }}>*</span>
          </div>
          <Input
            autoFocus
            placeholder="做什么？"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={handleSave}
            style={{ fontSize: 15 }}
          />
        </div>

        {/* 紧急度 + 重要性 */}
        <div className="flex items-center gap-4">
          <div>
            <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
              紧急度
            </div>
            <Segmented
              value={priority}
              onChange={(v) => setPriority(v as TaskPriority)}
              options={[
                {
                  label: (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: token.colorError }}
                      />
                      紧急
                    </span>
                  ),
                  value: 0,
                },
                {
                  label: (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: token.colorPrimary }}
                      />
                      一般
                    </span>
                  ),
                  value: 1,
                },
                {
                  label: (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: token.colorTextQuaternary }}
                      />
                      不急
                    </span>
                  ),
                  value: 2,
                },
              ]}
            />
          </div>
          <div>
            <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
              重要性（可选）
            </div>
            <Checkbox
              checked={important}
              onChange={(e) => setImportant(e.target.checked)}
            >
              <span className="text-xs">标记为重要</span>
            </Checkbox>
          </div>
        </div>

        {/* 截止时间 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            截止时间
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <DatePicker
              value={dueDate}
              onChange={(v) => setDueDate(v ? applyDate(v) : null)}
              format="YYYY-MM-DD"
              placeholder="选择日期"
              style={{ flex: 1, minWidth: 160 }}
            />
            <Button size="small" onClick={() => setDueDate(applyDate(dayjs()))}>
              今天
            </Button>
            <Button
              size="small"
              onClick={() => setDueDate(applyDate(dayjs().add(1, "day")))}
            >
              明天
            </Button>
            <Button
              size="small"
              onClick={() =>
                setDueDate(
                  applyDate(
                    dayjs().day(6).isBefore(dayjs())
                      ? dayjs().day(6).add(7, "day")
                      : dayjs().day(6),
                  ),
                )
              }
            >
              本周末
            </Button>
            {dueDate && (
              <Button size="small" danger type="text" onClick={() => setDueDate(null)}>
                清空
              </Button>
            )}
          </div>
          {/* 时间选择器：始终显示，默认填充设置中的"默认提醒时刻" */}
          {dueDate && (
            <div className="flex items-center gap-2 flex-wrap mt-2">
              <span className="text-xs" style={{ color: token.colorTextSecondary }}>
                时间
              </span>
              <DatePicker
                picker="time"
                value={dueDate}
                onChange={(v) => v && setDueDate(v)}
                format="HH:mm"
                minuteStep={5}
                allowClear={false}
                style={{ width: 120 }}
              />
              <span className="text-[11px]" style={{ color: token.colorTextTertiary }}>
                默认 {defaultTime}（
                <Typography.Link
                  onClick={handleGoSettingsTaskReminder}
                  style={{ fontSize: 11 }}
                >
                  去设置中修改
                </Typography.Link>
                ）
              </span>
            </div>
          )}
        </div>

        {/* 提醒 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            提醒
          </div>
          <Select
            value={remindBefore}
            onChange={setRemindBefore}
            disabled={!dueDate}
            style={{ width: 200 }}
            options={[
              { value: null, label: "不提醒" },
              { value: 0, label: "准时提醒" },
              { value: 15, label: "提前 15 分钟" },
              { value: 30, label: "提前 30 分钟" },
              { value: 60, label: "提前 1 小时" },
              { value: 180, label: "提前 3 小时" },
              { value: 1440, label: "提前 1 天" },
              { value: 10080, label: "提前 1 周" },
            ]}
          />
          {reminderAt && (
            <div className="text-[11px] mt-1" style={{ color: token.colorTextTertiary }}>
              {reminderAt.isBefore(dayjs()) ? (
                <span style={{ color: token.colorWarning }}>
                  提醒时刻 {formatReminderAt(reminderAt)} 已过，保存后不会再提醒
                </span>
              ) : (
                <>将于 <strong style={{ color: token.colorText }}>{formatReminderAt(reminderAt)}</strong> 提醒</>
              )}
            </div>
          )}
        </div>

        {/* 重复 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            重复
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={repeatMode}
              onChange={setRepeatMode}
              disabled={!dueDate}
              style={{ width: 140 }}
              options={[
                { value: "none", label: "不重复" },
                { value: "daily", label: "每天" },
                { value: "weekdays", label: "工作日" },
                { value: "weekly", label: "每周" },
                { value: "monthly", label: "每月" },
                { value: "custom", label: "自定义" },
              ]}
            />
            {repeatMode === "custom" && (
              <>
                <span className="text-xs" style={{ color: token.colorTextSecondary }}>
                  每
                </span>
                <InputNumber
                  min={1}
                  max={365}
                  value={customInterval}
                  onChange={(v) => setCustomInterval(Math.max(1, Number(v) || 1))}
                  style={{ width: 70 }}
                />
                <Select
                  value={customUnit}
                  onChange={setCustomUnit}
                  style={{ width: 70 }}
                  options={[
                    { value: "day", label: "天" },
                    { value: "week", label: "周" },
                    { value: "month", label: "月" },
                  ]}
                />
              </>
            )}
          </div>
          {/* 自定义 + 周：星期多选 */}
          {repeatMode === "custom" && customUnit === "week" && (
            <div className="mt-2">
              <Checkbox.Group
                value={customWeekdays}
                onChange={(v) => setCustomWeekdays(v as number[])}
                options={WEEKDAY_OPTIONS}
              />
              <div className="text-[10px] mt-1" style={{ color: token.colorTextTertiary }}>
                不选则沿用截止日的星期
              </div>
            </div>
          )}
          {/* 结束条件 */}
          {repeatMode !== "none" && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-xs" style={{ color: token.colorTextSecondary }}>
                结束：
              </span>
              <Segmented
                size="small"
                value={endMode}
                onChange={(v) => setEndMode(v as EndMode)}
                options={[
                  { value: "never", label: "永不" },
                  { value: "until", label: "截至日期" },
                  { value: "count", label: "重复 N 次" },
                ]}
              />
              {endMode === "until" && (
                <DatePicker
                  size="small"
                  value={repeatUntil}
                  onChange={setRepeatUntil}
                  format="YYYY-MM-DD"
                  placeholder="YYYY-MM-DD"
                  style={{ width: 140 }}
                />
              )}
              {endMode === "count" && (
                <Space size={4}>
                  <InputNumber
                    size="small"
                    min={1}
                    max={9999}
                    value={repeatCount}
                    onChange={(v) => setRepeatCount(Math.max(1, Number(v) || 1))}
                    style={{ width: 80 }}
                  />
                  <span className="text-xs" style={{ color: token.colorTextSecondary }}>
                    次
                  </span>
                </Space>
              )}
            </div>
          )}
          {!dueDate && repeatMode === "none" && (
            <div className="text-[10px] mt-1" style={{ color: token.colorTextTertiary }}>
              需先选择截止时间才能设置重复
            </div>
          )}
        </div>

        {/* 描述 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            描述（可选）
          </div>
          <Input.TextArea
            rows={2}
            placeholder="备注 / 上下文"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* 关联 */}
        <div>
          <div className="text-[11px] mb-1" style={{ color: token.colorTextSecondary }}>
            关联
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {links.map((l, idx) => {
              const icon =
                l.kind === "note" ? (
                  <NotebookText size={10} />
                ) : l.kind === "path" ? (
                  <FolderIcon size={10} />
                ) : (
                  <LinkIcon size={10} />
                );
              const color =
                l.kind === "note" ? "blue" : l.kind === "path" ? "purple" : "green";
              return (
                <Tag
                  key={idx}
                  color={color}
                  closable
                  onClose={() => removeLink(idx)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  {icon}
                  <span className="truncate max-w-[240px]">{l.label || l.target}</span>
                </Tag>
              );
            })}
            {notePickerOpen ? (
              <Select
                ref={noteSelectRef}
                autoFocus
                open
                showSearch
                allowClear
                filterOption={false}
                placeholder="搜索笔记标题…"
                value={undefined}
                loading={noteLoading}
                searchValue={noteQuery}
                onSearch={handleNoteSearch}
                onDropdownVisibleChange={(v) => {
                  if (!v) setNotePickerOpen(false);
                }}
                onBlur={() => {
                  // blur 时如果下拉已关闭则退出选择模式
                  setTimeout(() => setNotePickerOpen(false), 150);
                }}
                notFoundContent={
                  noteLoading ? (
                    <span className="text-xs" style={{ color: token.colorTextTertiary }}>
                      加载中…
                    </span>
                  ) : noteQuery.trim() ? (
                    <span className="text-xs" style={{ color: token.colorTextTertiary }}>
                      没有匹配「{noteQuery}」的笔记
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: token.colorTextTertiary }}>
                      还没有笔记
                    </span>
                  )
                }
                style={{ width: 280 }}
                options={noteOptions.map((n) => ({
                  value: n.id,
                  label: n.title,
                  data: n,
                }))}
                optionRender={(opt) => {
                  const note = (opt.data as { data: Note }).data;
                  return (
                    <div className="flex items-center justify-between gap-2 py-0.5">
                      <span className="truncate flex-1 text-xs">
                        <NotebookText
                          size={10}
                          style={{
                            display: "inline",
                            marginRight: 4,
                            color: token.colorPrimary,
                            verticalAlign: -1,
                          }}
                        />
                        {renderHighlight(note.title, noteQuery, token.colorPrimary)}
                      </span>
                      <span
                        className="text-[10px] shrink-0"
                        style={{ color: token.colorTextTertiary }}
                      >
                        {relativeTime(note.updated_at)}
                      </span>
                    </div>
                  );
                }}
                onSelect={(v) => {
                  const note = noteOptions.find((n) => n.id === v);
                  if (note) handleNoteSelect(note);
                }}
                dropdownRender={(menu) => (
                  <div>
                    {!noteQuery.trim() && (
                      <div
                        className="px-3 pt-2 pb-1 text-[10px]"
                        style={{ color: token.colorTextTertiary }}
                      >
                        最近编辑
                      </div>
                    )}
                    {menu}
                  </div>
                )}
              />
            ) : urlInputOpen ? (
              <Input
                size="small"
                autoFocus
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onPressEnter={handleAddUrlLink}
                onBlur={() => {
                  if (!urlInput.trim()) setUrlInputOpen(false);
                }}
                placeholder="粘贴 URL 回车确认"
                style={{ width: 240 }}
              />
            ) : (
              <Dropdown menu={addMenu} trigger={["click"]}>
                <Button size="small" type="dashed" icon={<Plus size={12} />}>
                  添加关联
                </Button>
              </Dropdown>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 展示提醒时刻：今天/明天/昨天用相对语，其余带日期 */
function formatReminderAt(t: Dayjs): string {
  const today = dayjs().startOf("day");
  const target = t.startOf("day");
  const diff = target.diff(today, "day");
  const hm = t.format("HH:mm");
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  return `${t.format("YYYY-MM-DD")} ${hm}`;
}

/** 星期选项：ISO 1=Mon..7=Sun */
const WEEKDAY_OPTIONS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 7, label: "日" },
];

/** 从 Task 反推 UI 预设模式 */
function detectRepeatMode(task: Task): {
  mode: RepeatMode;
  unit: CustomUnit;
  interval: number;
  weekdays: number[];
} {
  const { repeat_kind, repeat_interval, repeat_weekdays } = task;
  const parsed = repeat_weekdays
    ? repeat_weekdays
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => n >= 1 && n <= 7)
    : [];
  if (repeat_kind === "none") {
    return { mode: "none", unit: "day", interval: 1, weekdays: [] };
  }
  const isDefault = repeat_interval === 1;
  if (repeat_kind === "daily" && isDefault) {
    return { mode: "daily", unit: "day", interval: 1, weekdays: [] };
  }
  if (repeat_kind === "weekly" && isDefault && repeat_weekdays === "1,2,3,4,5") {
    return { mode: "weekdays", unit: "week", interval: 1, weekdays: parsed };
  }
  if (repeat_kind === "weekly" && isDefault && parsed.length === 0) {
    return { mode: "weekly", unit: "week", interval: 1, weekdays: [] };
  }
  if (repeat_kind === "monthly" && isDefault) {
    return { mode: "monthly", unit: "month", interval: 1, weekdays: [] };
  }
  // 其他一律视作自定义
  const unit: CustomUnit =
    repeat_kind === "daily" ? "day" : repeat_kind === "weekly" ? "week" : "month";
  return {
    mode: "custom",
    unit,
    interval: Math.max(1, repeat_interval),
    weekdays: parsed,
  };
}

/** 把 UI 状态转成后端负载（create / update 格式不同） */
function buildRepeatPayload(args: {
  mode: RepeatMode;
  unit: CustomUnit;
  interval: number;
  weekdays: number[];
  endMode: EndMode;
  until: Dayjs | null;
  count: number;
}): {
  create: Partial<CreateTaskInput>;
  update: Partial<UpdateTaskInput>;
} {
  let kind: TaskRepeatKind = "none";
  let interval = 1;
  let weekdays: string | null = null;
  switch (args.mode) {
    case "none":
      return {
        create: { repeat_kind: "none" },
        update: {
          repeat_kind: "none",
          clear_repeat_weekdays: true,
          clear_repeat_until: true,
          clear_repeat_count: true,
        },
      };
    case "daily":
      kind = "daily";
      break;
    case "weekdays":
      kind = "weekly";
      weekdays = "1,2,3,4,5";
      break;
    case "weekly":
      kind = "weekly";
      break;
    case "monthly":
      kind = "monthly";
      break;
    case "custom":
      kind =
        args.unit === "day" ? "daily" : args.unit === "week" ? "weekly" : "monthly";
      interval = Math.max(1, args.interval);
      if (args.unit === "week" && args.weekdays.length > 0) {
        weekdays = [...args.weekdays].sort((a, b) => a - b).join(",");
      }
      break;
  }

  const create: Partial<CreateTaskInput> = {
    repeat_kind: kind,
    repeat_interval: interval,
  };
  const update: Partial<UpdateTaskInput> = {
    repeat_kind: kind,
    repeat_interval: interval,
  };
  if (weekdays) {
    create.repeat_weekdays = weekdays;
    update.repeat_weekdays = weekdays;
  } else {
    update.clear_repeat_weekdays = true;
  }
  if (args.endMode === "until" && args.until) {
    const u = args.until.format("YYYY-MM-DD");
    create.repeat_until = u;
    update.repeat_until = u;
    update.clear_repeat_count = true;
  } else if (args.endMode === "count" && args.count > 0) {
    create.repeat_count = args.count;
    update.repeat_count = args.count;
    update.clear_repeat_until = true;
  } else {
    update.clear_repeat_until = true;
    update.clear_repeat_count = true;
  }
  return { create, update };
}

/** 在标题中把匹配词加粗高亮（不区分大小写） */
function renderHighlight(text: string, keyword: string, color: string): React.ReactNode {
  const k = keyword.trim();
  if (!k) return text;
  const idx = text.toLowerCase().indexOf(k.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <strong style={{ color, fontWeight: 600 }}>{text.slice(idx, idx + k.length)}</strong>
      {text.slice(idx + k.length)}
    </>
  );
}
