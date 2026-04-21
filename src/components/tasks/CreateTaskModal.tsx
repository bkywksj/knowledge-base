import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Input,
  Segmented,
  DatePicker,
  Checkbox,
  Button,
  Tag,
  Dropdown,
  Select,
  App as AntdApp,
  Space,
  theme as antdTheme,
} from "antd";
import type { MenuProps, RefSelectProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Plus, FileText, Folder as FolderIcon, Link as LinkIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { taskApi, noteApi, configApi } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import type { Note, Task, TaskLinkInput, TaskPriority } from "@/types";

interface Props {
  open: boolean;
  editing?: Task | null;
  /** 新建时预设紧急度（看板某列 + 号传进来） */
  presetPriority?: TaskPriority;
  /** 新建时预设截止日期 YYYY-MM-DD（日历双击格子传进来） */
  presetDueDate?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function CreateTaskModal({
  open,
  editing,
  presetPriority,
  presetDueDate,
  onClose,
  onSaved,
}: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(1);
  const [important, setImportant] = useState(false);
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);
  /** 是否"全天"——true 时不展示时间选择器，写 DB 时只存 YYYY-MM-DD */
  const [allDay, setAllDay] = useState(true);
  /** 提前多少分钟提醒；null=不提醒；0=准时 */
  const [remindBefore, setRemindBefore] = useState<number | null>(null);
  const [links, setLinks] = useState<TaskLinkInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  /** 全天任务的提醒基准时刻（从 app_config.all_day_reminder_time 读，默认 09:00） */
  const [allDayBaseTime, setAllDayBaseTime] = useState("09:00");

  // 打开弹窗时拉一次基准时刻，用于实时预览
  useEffect(() => {
    if (!open) return;
    configApi
      .get("all_day_reminder_time")
      .then((v) => {
        if (v && /^\d{2}:\d{2}/.test(v)) setAllDayBaseTime(v.slice(0, 5));
      })
      .catch(() => {});
  }, [open]);

  /** 算出任务实际提醒时刻：基准时间 - remindBefore 分钟 */
  const reminderAt = useMemo<Dayjs | null>(() => {
    if (!dueDate || remindBefore === null) return null;
    if (allDay) {
      const [h, m] = allDayBaseTime.split(":").map(Number);
      return dueDate
        .hour(h ?? 9)
        .minute(m ?? 0)
        .second(0)
        .subtract(remindBefore, "minute");
    }
    return dueDate.second(0).subtract(remindBefore, "minute");
  }, [dueDate, remindBefore, allDay, allDayBaseTime]);

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
      setDueDate(editing.due_date ? dayjs(editing.due_date) : null);
      // due_date 长度 > 10（"YYYY-MM-DD" 是 10 位）说明带时分
      setAllDay(!editing.due_date || editing.due_date.length <= 10);
      setRemindBefore(editing.remind_before_minutes);
      setLinks(
        editing.links.map((l) => ({
          kind: l.kind,
          target: l.target,
          label: l.label,
        })),
      );
    } else {
      setTitle("");
      setDescription("");
      setPriority(presetPriority ?? 1);
      setImportant(false);
      setDueDate(presetDueDate ? dayjs(presetDueDate) : null);
      setAllDay(true);
      setRemindBefore(null);
      setLinks([]);
    }
    setContinuous(false);
    setUrlInputOpen(false);
    setUrlInput("");
    setNotePickerOpen(false);
    setNoteQuery("");
    setNoteOptions([]);
  }, [open, editing, presetPriority, presetDueDate]);

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

  async function handleAddPathLink() {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;
      const label = picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
      setLinks((prev) => [...prev, { kind: "path", target: picked, label }]);
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
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
      const dueStr = dueDate
        ? allDay
          ? dueDate.format("YYYY-MM-DD")
          : dueDate.format("YYYY-MM-DD HH:mm:ss")
        : null;
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
      { key: "note", icon: <FileText size={14} />, label: "笔记" },
      { key: "path", icon: <FolderIcon size={14} />, label: "本地目录" },
      { key: "url", icon: <LinkIcon size={14} />, label: "外部链接" },
    ],
    onClick: ({ key }) => {
      if (key === "note") handleAddNoteLink();
      else if (key === "path") handleAddPathLink();
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
              onChange={(v) => {
                // 切日期时：若之前没选过时间（allDay），保留默认；否则保留已选时分
                if (!v) setDueDate(null);
                else if (allDay) setDueDate(v.startOf("day"));
                else
                  setDueDate(
                    v
                      .hour(dueDate?.hour() ?? 9)
                      .minute(dueDate?.minute() ?? 0)
                      .second(0),
                  );
              }}
              format="YYYY-MM-DD"
              placeholder="选择日期"
              style={{ flex: 1, minWidth: 160 }}
            />
            <Button size="small" onClick={() => setDueDate(dayjs().startOf("day"))}>
              今天
            </Button>
            <Button
              size="small"
              onClick={() => setDueDate(dayjs().add(1, "day").startOf("day"))}
            >
              明天
            </Button>
            <Button
              size="small"
              onClick={() =>
                setDueDate(
                  (dayjs().day(6).isBefore(dayjs())
                    ? dayjs().day(6).add(7, "day")
                    : dayjs().day(6)
                  ).startOf("day"),
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
          {/* 全天 / 具体时间 */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <Checkbox
              checked={allDay}
              disabled={!dueDate}
              onChange={(e) => {
                const checked = e.target.checked;
                setAllDay(checked);
                if (checked && dueDate) {
                  setDueDate(dueDate.startOf("day"));
                } else if (!checked && dueDate) {
                  // 切到具体时间：默认填今天 09:00
                  setDueDate(dueDate.hour(9).minute(0).second(0));
                }
              }}
            >
              <span className="text-xs">全天</span>
            </Checkbox>
            {!allDay && dueDate && (
              <DatePicker
                picker="time"
                value={dueDate}
                onChange={(v) => v && setDueDate(v)}
                format="HH:mm"
                minuteStep={5}
                allowClear={false}
                style={{ width: 120 }}
              />
            )}
          </div>
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
              {allDay && (
                <span className="ml-1">
                  · 全天基准 {allDayBaseTime}（可在设置中修改）
                </span>
              )}
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
                  <FileText size={10} />
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
                        <FileText
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
