import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Modal, Popconfirm, Spin, Switch, Tooltip, message } from "antd";
import { BellRing, Bot, Clock, Edit3, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { aiModelApi, pushApi } from "@/lib/api";
import type { AiModel, PushJob } from "@/types";
import PushJobForm, { CHANNEL_OPTIONS, parseChannels } from "./PushJobForm";

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

/** 「下次 11-04 08:30」：今年的省掉年份 */
function nextRunLabel(v: string | null): string {
  if (!v) return "—";
  const s = v.replace("T", " ");
  return s.slice(0, 4) === String(new Date().getFullYear()) ? s.slice(5, 16) : s.slice(0, 16);
}

/**
 * 定时推送（v4 原型）：顶栏 + 左推送卡片列表 + 右侧常驻编辑表单（原弹窗）。
 * 编辑交互与提示词库一致：有改动才能保存；切卡片前有未保存改动先确认；新建态取消回到第一条。
 */
function DesktopPushPage() {
  const [jobs, setJobs] = useState<PushJob[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PushJob | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null);

  async function load(): Promise<PushJob[]> {
    setLoading(true);
    try {
      const list = await pushApi.list();
      setJobs(list);
      return list;
    } catch (e) {
      message.error(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // 首次进来默认选中第一条，右侧表单不空着
    void load().then((list) => {
      if (list.length > 0) select(list[0]);
    });
    aiModelApi.list().then(setModels).catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(job: PushJob | null) {
    setEditing(job);
    setFormKey((k) => k + 1);
    setDirty(false);
  }

  /** 切到别的卡片前，有未保存改动就先问一下 */
  function confirmLeave(next: () => void) {
    if (!dirty) {
      next();
      return;
    }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: "右侧表单里的改动还没保存。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      onOk: next,
    });
  }

  async function toggle(job: PushJob, enabled: boolean) {
    try {
      await pushApi.setEnabled(job.id, enabled);
      const list = await load();
      // 右侧正在编辑这条且没有改动时，表单跟着刷新（启用状态 / 下次运行时间都会变）
      if (editing?.id === job.id && !dirty) {
        select(list.find((j) => j.id === job.id) ?? null);
      }
    } catch (e) {
      message.error(String(e));
    }
  }

  async function remove(job: PushJob) {
    try {
      await pushApi.delete(job.id);
      message.success("已删除");
      const list = await load();
      if (editing?.id === job.id) select(list[0] ?? null);
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

  const modelName = useMemo(() => new Map(models.map((m) => [m.id, m.name])), [models]);

  return (
    <div className="kb-prompts-page">
      {/* 顶栏（原型 .bar）：定时推送 · 说明 ｜ 新建推送 */}
      <div className="kb-page-bar">
        <h1>定时推送</h1>
        <span className="kb-page-sub">到点自动让 AI 跑你写的提示词，把结果推送给你</span>
        <span className="flex-1" />
        <Button
          type="primary"
          className="kb-bar-btn-p"
          icon={<Plus size={14} />}
          onClick={() => confirmLeave(() => select(null))}
        >
          新建推送
        </Button>
      </div>

      <div className="kb-prompts-main">
        <div className="kb-push-list">
          {loading && jobs.length === 0 ? (
            <div className="flex justify-center py-12">
              <Spin />
            </div>
          ) : jobs.length === 0 ? (
            <section className="kb-cards-panel" style={{ padding: 24 }}>
              <Empty description="还没有推送，右侧填好就能建一条，例如每天 8 点推一句励志格言、背一个单词" />
            </section>
          ) : (
            jobs.map((job) => {
              const active = editing?.id === job.id;
              const chans = parseChannels(job.channels)
                .map((c) => CHANNEL_OPTIONS.find((o) => o.value === c)?.label ?? c)
                .join(" + ");
              return (
                <div
                  key={job.id}
                  className={
                    "kb-push-card" + (active ? " is-active" : "") + (job.enabled ? "" : " is-off")
                  }
                  onClick={() => {
                    if (!active) confirmLeave(() => select(job));
                  }}
                >
                  <div className="kb-push-head">
                    <span className="kb-prompt-ico">
                      {job.repeat_kind === "daily" ? <Sparkles size={15} /> : <BellRing size={15} />}
                    </span>
                    <div className="kb-push-main">
                      <div className="kb-push-name">
                        <b>{job.name}</b>
                        {!job.enabled && <span className="kb-push-off">已停用</span>}
                      </div>
                      <div className="kb-push-prompt">{job.prompt}</div>
                    </div>
                    <span onClick={(e) => e.stopPropagation()}>
                      <Switch size="small" checked={job.enabled} onChange={(v) => void toggle(job, v)} />
                    </span>
                  </div>
                  <div className="kb-push-foot">
                    <span className="kb-push-chip is-time">
                      <Clock size={12} />
                      {job.repeat_kind === "daily"
                        ? `每天 ${job.schedule_time}`
                        : `每周${weekdaysLabel(job.repeat_weekdays)} ${job.schedule_time}`}
                    </span>
                    <span className="kb-push-chip">{chans}</span>
                    <span className="kb-push-chip">
                      <Bot size={12} />
                      {job.model_id != null ? modelName.get(job.model_id) ?? "已删除的模型" : "默认模型服务"}
                    </span>
                    <span className="flex-1" />
                    {/* 停用时名字旁已有「已停用」，这里不再重复 */}
                    {job.enabled && (
                      <span className="kb-push-next">下次 {nextRunLabel(job.next_run_at)}</span>
                    )}
                    <span className="kb-push-actions" onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="text"
                        size="small"
                        icon={<Play size={13} />}
                        loading={runningId === job.id}
                        onClick={() => void runNow(job)}
                      >
                        立即运行一次
                      </Button>
                      <Tooltip title="编辑">
                        <Button
                          type="text"
                          size="small"
                          icon={<Edit3 size={13} />}
                          onClick={() => confirmLeave(() => select(job))}
                        />
                      </Tooltip>
                      <Popconfirm
                        title="确认删除这条推送？"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void remove(job)}
                      >
                        <Button type="text" size="small" danger icon={<Trash2 size={13} />} />
                      </Popconfirm>
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <PushJobForm
          editing={editing}
          formKey={formKey}
          models={models}
          dirty={dirty}
          onDirtyChange={setDirty}
          onSaved={async (id) => {
            const list = await load();
            select(list.find((j) => j.id === id) ?? null);
          }}
          onCancelNew={() => select(jobs[0] ?? null)}
        />
      </div>
    </div>
  );
}

// 手机端单独一版（v4 重构 M3-11）：原来手机上直接渲染这个桌面页，布局挤成一团
import { useIsMobile } from "@/hooks/useIsMobile";
import { DesktopOnlyPage } from "@/components/mobile/DesktopOnlyPage";

export default function PushPage() {
  const isMobile = useIsMobile();
  return isMobile ? (
      <DesktopOnlyPage
        title="定时推送"
        reason="定时推送靠桌面端常驻后台按时弹窗；手机上 App 切到后台就会被系统暂停，推送不可靠。"
        tips={["待办的截止提醒在手机上照常可用（系统通知）"]}
      />
  ) : (
    <DesktopPushPage />
  );
}
