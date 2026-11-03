import { useEffect, useState } from "react";
import {
  Modal,
  Form,
  Input,
  Button,
  DatePicker,
  ColorPicker,
  Popconfirm,
  App as AntdApp,
  Empty,
  theme as antdTheme,
} from "antd";
import { Plus, Edit3, Trash2, Archive, ArchiveRestore } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { projectApi } from "@/lib/api";
import type { Project } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 项目列表变化后通知父级刷新（甘特图等使用方需要重拉） */
  onChanged?: () => void;
}

const PRESET_COLORS = [
  "#1677ff",
  "#52c41a",
  "#faad14",
  "#ff4d4f",
  "#722ed1",
  "#13c2c2",
  "#eb2f96",
  "#fa8c16",
  "#8c8c8c",
];

/** AntD ColorPicker 回调可能给 Color 对象或字符串，统一拿 hex */
function toHex(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toHexString" in value) {
    const fn = (value as { toHexString: () => string }).toHexString;
    if (typeof fn === "function") return fn.call(value);
  }
  return "#722ed1";
}

interface ProjectFormValues {
  name: string;
  description?: string;
  color: string;
  range?: [Dayjs | null, Dayjs | null];
}

function fmtDate(d: Dayjs | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.format("YYYY-MM-DD");
}

/**
 * 项目管理 Modal（v41）—— 项目 CRUD + 归档。
 *
 * 设计：
 * - 左侧项目列表（含活动 / 已归档分段）；右侧表单（新建或编辑）
 * - 同 TaskCategoryManageModal 的"主-从"布局，但用更紧凑的 Drawer-like 单 Modal 实现
 * - 删除走 Popconfirm：tasks.project_id 因 ON DELETE SET NULL 会自动落"无项目"
 * - 归档/恢复用 Switch；归档项目隐藏在折叠区，不影响主视图
 */
export function ProjectManageModal({ open, onClose, onChanged }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ProjectFormValues>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  /** 当前在编辑的项目；null = 新建模式 */
  const [editing, setEditing] = useState<Project | null>(null);
  /** 表单是否进入"创建/编辑"模式（true=展开右侧表单） */
  const [formOpen, setFormOpen] = useState(false);

  async function reload() {
    try {
      const list = await projectApi.list(true); // 始终拿全量，前端按 showArchived 分组
      setProjects(list);
    } catch (e) {
      message.error(`加载项目失败：${e}`);
    }
  }

  useEffect(() => {
    if (open) {
      void reload();
      setFormOpen(false);
      setEditing(null);
      form.resetFields();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function startCreate() {
    setEditing(null);
    setFormOpen(true);
    form.resetFields();
    form.setFieldsValue({ color: "#722ed1" });
  }

  function startEdit(p: Project) {
    setEditing(p);
    setFormOpen(true);
    form.setFieldsValue({
      name: p.name,
      description: p.description ?? "",
      color: p.color,
      range: [
        p.startDate ? dayjs(p.startDate) : null,
        p.endDate ? dayjs(p.endDate) : null,
      ],
    });
  }

  function cancelForm() {
    setFormOpen(false);
    setEditing(null);
    form.resetFields();
  }

  async function handleSubmit(values: ProjectFormValues) {
    try {
      const startDate = fmtDate(values.range?.[0]);
      const endDate = fmtDate(values.range?.[1]);
      if (editing) {
        // 编辑：用 clear* flags 显式清空（DatePicker 清空时 range 整体可能为 undefined）
        await projectApi.update(editing.id, {
          name: values.name,
          description: values.description ?? "",
          clearDescription: !values.description,
          color: values.color,
          startDate: startDate,
          clearStartDate: !startDate,
          endDate: endDate,
          clearEndDate: !endDate,
        });
        message.success("已更新");
      } else {
        await projectApi.create({
          name: values.name,
          description: values.description,
          color: values.color,
          startDate,
          endDate,
        });
        message.success("已创建");
      }
      await reload();
      onChanged?.();
      cancelForm();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleArchiveToggle(p: Project) {
    try {
      await projectApi.update(p.id, { archived: !p.archived });
      message.success(p.archived ? "已恢复" : "已归档");
      await reload();
      onChanged?.();
    } catch (e) {
      message.error(`切换失败：${e}`);
    }
  }

  async function handleDelete(p: Project) {
    try {
      await projectApi.delete(p.id);
      message.success("已删除");
      await reload();
      onChanged?.();
      if (editing?.id === p.id) cancelForm();
    } catch (e) {
      message.error(`删除失败：${e}`);
    }
  }

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  return (
    <Modal
      title="项目管理"
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      destroyOnHidden
    >
      <div className="flex gap-3" style={{ minHeight: 420 }}>
        {/* 左侧：项目列表 */}
        <div
          className="flex flex-col"
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            paddingRight: 12,
          }}
        >
          <Button
            type="primary"
            icon={<Plus size={14} />}
            onClick={startCreate}
            style={{ marginBottom: 8 }}
          >
            新建项目
          </Button>
          {active.length === 0 ? (
            <Empty
              description={<span style={{ fontSize: 12 }}>暂无项目</span>}
              style={{ margin: "24px 0" }}
            />
          ) : (
            <div className="flex flex-col gap-1 overflow-y-auto" style={{ flex: 1 }}>
              {active.map((p) => (
                <ProjectListItem
                  key={p.id}
                  project={p}
                  active={editing?.id === p.id}
                  onEdit={() => startEdit(p)}
                  onToggleArchive={() => void handleArchiveToggle(p)}
                  onDelete={() => void handleDelete(p)}
                />
              ))}
            </div>
          )}
          {archived.length > 0 && (
            <>
              <div
                className="cursor-pointer flex items-center gap-1 mt-2"
                style={{ fontSize: 11, color: token.colorTextTertiary }}
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive size={12} />
                <span>已归档 ({archived.length}) {showArchived ? "▼" : "▶"}</span>
              </div>
              {showArchived && (
                <div className="flex flex-col gap-1 mt-1">
                  {archived.map((p) => (
                    <ProjectListItem
                      key={p.id}
                      project={p}
                      active={editing?.id === p.id}
                      onEdit={() => startEdit(p)}
                      onToggleArchive={() => void handleArchiveToggle(p)}
                      onDelete={() => void handleDelete(p)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 右侧：表单 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!formOpen ? (
            <div
              className="flex flex-col items-center justify-center h-full"
              style={{ color: token.colorTextTertiary, fontSize: 12 }}
            >
              点击左侧 + 新建项目，或选中已有项目编辑
            </div>
          ) : (
            <Form
              form={form}
              layout="vertical"
              onFinish={handleSubmit}
              initialValues={{ color: "#722ed1" }}
            >
              <Form.Item
                name="name"
                label="项目名称"
                rules={[{ required: true, message: "请输入项目名称" }]}
              >
                <Input placeholder="如：v1.11 发版冲刺" maxLength={64} />
              </Form.Item>
              <Form.Item name="description" label="描述">
                <Input.TextArea
                  placeholder="可选：项目目标 / 背景说明"
                  rows={2}
                  maxLength={200}
                />
              </Form.Item>
              <Form.Item name="color" label="颜色" getValueFromEvent={toHex}>
                <ColorPicker presets={[{ label: "推荐", colors: PRESET_COLORS }]} />
              </Form.Item>
              <Form.Item name="range" label="计划时间区间">
                <DatePicker.RangePicker
                  style={{ width: "100%" }}
                  allowEmpty={[true, true]}
                  placeholder={["开始日期", "结束日期"]}
                />
              </Form.Item>
              <div className="flex justify-end gap-2">
                <Button onClick={cancelForm}>取消</Button>
                <Button type="primary" htmlType="submit">
                  {editing ? "保存" : "创建"}
                </Button>
              </div>
            </Form>
          )}
        </div>
      </div>
    </Modal>
  );
}

interface ItemProps {
  project: Project;
  active: boolean;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

function ProjectListItem({
  project,
  active,
  onEdit,
  onToggleArchive,
  onDelete,
}: ItemProps) {
  const { token } = antdTheme.useToken();
  return (
    <div
      onClick={onEdit}
      className="cursor-pointer flex items-center gap-2"
      style={{
        padding: "6px 8px",
        borderRadius: 4,
        background: active ? `${token.colorPrimary}14` : "transparent",
        border: `1px solid ${active ? token.colorPrimary : "transparent"}`,
        opacity: project.archived ? 0.55 : 1,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background: project.color,
          flexShrink: 0,
        }}
      />
      <span
        className="truncate"
        style={{ flex: 1, fontSize: 13, minWidth: 0 }}
        title={project.name}
      >
        {project.name}
      </span>
      <span style={{ fontSize: 10, color: token.colorTextTertiary }}>
        {project.activeTaskCount}/{project.activeTaskCount + project.doneTaskCount}
      </span>
      <Button
        size="small"
        type="text"
        icon={<Edit3 size={12} />}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        title="编辑"
      />
      <Button
        size="small"
        type="text"
        icon={
          project.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggleArchive();
        }}
        title={project.archived ? "恢复" : "归档"}
      />
      <Popconfirm
        title={`删除「${project.name}」？`}
        description={`项目下的任务会自动落到"无项目"，不会被删除。`}
        okText="删除"
        okButtonProps={{ danger: true }}
        onConfirm={() => {
          onDelete();
        }}
      >
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={12} />}
          onClick={(e) => e.stopPropagation()}
          title="删除"
        />
      </Popconfirm>
    </div>
  );
}
