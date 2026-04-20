import { useEffect, useState } from "react";
import {
  Modal,
  Input,
  Segmented,
  DatePicker,
  Checkbox,
  Button,
  Tag,
  Dropdown,
  App as AntdApp,
  Space,
  theme as antdTheme,
} from "antd";
import type { MenuProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Plus, FileText, Folder as FolderIcon, Link as LinkIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { taskApi, noteApi } from "@/lib/api";
import type { Task, TaskLinkInput, TaskPriority } from "@/types";

interface Props {
  open: boolean;
  editing?: Task | null;
  onClose: () => void;
  onSaved: () => void;
}

export function CreateTaskModal({ open, editing, onClose, onSaved }: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(1);
  const [important, setImportant] = useState(false);
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);
  const [links, setLinks] = useState<TaskLinkInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");

  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setDescription(editing.description ?? "");
      setPriority(editing.priority);
      setImportant(editing.important);
      setDueDate(editing.due_date ? dayjs(editing.due_date) : null);
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
      setPriority(1);
      setImportant(false);
      setDueDate(null);
      setLinks([]);
    }
    setContinuous(false);
    setUrlInputOpen(false);
    setUrlInput("");
  }, [open, editing]);

  async function handleAddNoteLink() {
    try {
      // 用 noteApi.list 拉最近 10 条让用户选
      const result = await noteApi.list({ page: 1, page_size: 20 });
      const note = result.items[0];
      if (!note) {
        message.warning("还没有笔记可关联");
        return;
      }
      // 简化：用原生 prompt 让用户输入笔记标题关键词，然后精确匹配
      const keyword = window.prompt("输入要关联的笔记标题（完整）", "");
      if (!keyword) return;
      const hit = result.items.find((n) => n.title === keyword.trim());
      if (!hit) {
        message.error(`未找到标题为「${keyword}」的笔记`);
        return;
      }
      setLinks((prev) => [
        ...prev,
        { kind: "note", target: String(hit.id), label: hit.title },
      ]);
    } catch (e) {
      message.error(`关联失败: ${e}`);
    }
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
      if (isEdit && editing) {
        await taskApi.update(editing.id, {
          title: title.trim(),
          description: description.trim() || null,
          priority,
          important,
          due_date: dueDate ? dueDate.format("YYYY-MM-DD") : undefined,
          clear_due_date: !dueDate,
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
          due_date: dueDate ? dueDate.format("YYYY-MM-DD") : null,
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
        <Input
          autoFocus
          size="large"
          placeholder="做什么？（必填）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={handleSave}
          variant="borderless"
          style={{
            fontSize: 16,
            fontWeight: 500,
            borderBottom: `2px solid ${token.colorPrimary}`,
            borderRadius: 0,
            paddingLeft: 0,
            paddingRight: 0,
          }}
        />

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
              onChange={setDueDate}
              format="YYYY-MM-DD"
              placeholder="选择日期"
              style={{ flex: 1, minWidth: 180 }}
            />
            <Button size="small" onClick={() => setDueDate(dayjs())}>
              今天
            </Button>
            <Button size="small" onClick={() => setDueDate(dayjs().add(1, "day"))}>
              明天
            </Button>
            <Button
              size="small"
              onClick={() =>
                setDueDate(dayjs().day(6).isBefore(dayjs()) ? dayjs().day(6).add(7, "day") : dayjs().day(6))
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
            {urlInputOpen ? (
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
