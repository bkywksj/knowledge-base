import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { BellRing, Edit3, Play, Plus, Trash2 } from "lucide-react";
import { pushApi } from "@/lib/api";
import type { PushJob } from "@/types";
import PushJobForm from "./PushJobForm";

/** 把 "1,2,3" 渲染成中文星期 */
function weekdaysLabel(spec: string | null): string {
  if (!spec) return "";
  const map: Record<string, string> = {
    "1": "一",
    "2": "二",
    "3": "三",
    "4": "四",
    "5": "五",
    "6": "六",
    "7": "日",
  };
  return spec
    .split(",")
    .map((d) => map[d.trim()] ?? d)
    .join("·");
}

export default function PushPage() {
  const [jobs, setJobs] = useState<PushJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PushJob | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      setJobs(await pushApi.list());
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(job: PushJob, enabled: boolean) {
    try {
      await pushApi.setEnabled(job.id, enabled);
      await load();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function remove(job: PushJob) {
    try {
      await pushApi.delete(job.id);
      message.success("已删除");
      await load();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function runNow(job: PushJob) {
    setRunningId(job.id);
    try {
      await pushApi.runNow(job.id);
      message.success("已触发，稍候查看系统通知");
    } catch (e) {
      message.error(String(e));
    } finally {
      setRunningId(null);
    }
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(job: PushJob) {
    setEditing(job);
    setFormOpen(true);
  }

  const columns: ColumnsType<PushJob> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (name: string, job) => (
        <div>
          <div className="font-medium">{name}</div>
          <div className="text-xs text-gray-400 line-clamp-1 max-w-md">
            {job.prompt}
          </div>
        </div>
      ),
    },
    {
      title: "时间",
      key: "schedule",
      width: 160,
      render: (_, job) => (
        <span>
          {job.schedule_time}
          <Tag className="ml-2">
            {job.repeat_kind === "daily"
              ? "每天"
              : `每周·${weekdaysLabel(job.repeat_weekdays)}`}
          </Tag>
        </span>
      ),
    },
    {
      title: "下次运行",
      dataIndex: "next_run_at",
      key: "next_run_at",
      width: 170,
      render: (v: string | null, job) =>
        job.enabled ? (
          <span className="text-xs">{v ?? "—"}</span>
        ) : (
          <span className="text-xs text-gray-400">已停用</span>
        ),
    },
    {
      title: "启用",
      key: "enabled",
      width: 70,
      render: (_, job) => (
        <Switch
          size="small"
          checked={job.enabled}
          onChange={(v) => toggle(job, v)}
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_, job) => (
        <Space size="small">
          <Tooltip title="立即运行一次">
            <Button
              type="text"
              size="small"
              icon={<Play size={16} />}
              loading={runningId === job.id}
              onClick={() => runNow(job)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<Edit3 size={16} />}
              onClick={() => openEdit(job)}
            />
          </Tooltip>
          <Popconfirm
            title="确认删除这条推送？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(job)}
          >
            <Button type="text" size="small" danger icon={<Trash2 size={16} />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <Card
        title={
          <span className="flex items-center gap-2">
            <BellRing size={18} />
            定时推送
          </span>
        }
        extra={
          <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
            新建推送
          </Button>
        }
      >
        <p className="text-sm text-gray-400 mb-4">
          到点自动让 AI 跑你写的提示词，把结果通过系统通知推送给你。例如每天 8
          点推一句励志格言、背一个单词。
        </p>
        {jobs.length === 0 && !loading ? (
          <Empty description="还没有推送，点右上角新建一条" />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={jobs}
            loading={loading}
            pagination={false}
            size="middle"
          />
        )}
      </Card>

      <PushJobForm
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={load}
      />
    </div>
  );
}
