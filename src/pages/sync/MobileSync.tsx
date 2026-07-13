import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  CloudUpload,
  CloudDownload,
  Plus,
  Plug,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Pencil,
  Share2,
  Download,
  RefreshCw,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportSyncBackend, type Envelope } from "@/lib/configShare";
import { Modal, Form, Input, Segmented, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { syncV1Api } from "@/lib/api";
import { notifySystem } from "@/lib/notify";
import { useAppStore } from "@/store";
import type {
  SyncBackend,
  SyncBackendKind,
  SyncV1ProgressEvent,
  WebDavConfig,
} from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * 移动端云端同步管理（设计：基于 11-sync.html，简化为只支持 WebDAV）
 *
 * 路由 /sync —— 移动端独立路由（不在 LayoutSwitch 子路由下）
 *
 * 功能：
 * - 列出所有 V1 同步后端 + 上次推送/拉取时间 + 启用状态
 * - 每个后端单独的 推送 / 拉取 / 测试 / 编辑 / 删除 操作
 * - 新增 / 编辑 backend：仅支持 WebDAV（移动端 S3 已被 cfg gate 掉）
 *
 * 桌面端零影响：MobileSync 只通过 /sync 路由触达，且桌面端入口在 settings/SyncSettings 里走另一套。
 */

/** 统一承载 WebDAV + S3 两种后端的表单字段（按 kind 显示对应字段） */
interface BackendForm {
  name: string;
  // WebDAV
  url: string;
  username: string;
  password: string;
  // S3（endpoint/region/bucket/accessKey/secretKey/prefix，与后端 parse_auth 对齐）
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

/** S3 后端 configJson 结构（与桌面 SyncV1Section + 后端 parse_auth 对齐） */
interface S3Config {
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  prefix?: string;
}

export function MobileSync() {
  const navigate = useNavigate();
  const [backends, setBackends] = useState<SyncBackend[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncV1ProgressEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // 当前编辑的后端类型（WebDAV / S3），决定表单显示哪组字段
  const [formKind, setFormKind] = useState<SyncBackendKind>("webdav");
  const [form] = Form.useForm<BackendForm>();
  // 配置分享 / 导入
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // 监听后端推/拉进度事件，渲染到对应 backend 卡片下
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      const fn = await listen<SyncV1ProgressEvent>("sync_v1:progress", (e) => {
        setProgress(e.payload);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV1Api.listBackends();
      setBackends(list);
    } catch (e) {
      console.error("[MobileSync] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setEditingId(null);
    setFormKind("webdav");
    form.resetFields();
    form.setFieldsValue({
      name: "WebDAV",
      url: "https://",
      username: "",
      password: "",
      endpoint: "https://",
      region: "auto",
      bucket: "",
      accessKey: "",
      secretKey: "",
      prefix: "",
    });
    setEditorOpen(true);
  }

  function openEdit(b: SyncBackend) {
    const kind = (b.kind as SyncBackendKind) ?? "webdav";
    setEditingId(b.id);
    setFormKind(kind);
    if (kind === "s3") {
      let cfg: S3Config = {};
      try {
        cfg = JSON.parse(b.configJson) as S3Config;
      } catch {
        // 静默失败：表单显示空值
      }
      form.setFieldsValue({
        name: b.name,
        endpoint: cfg.endpoint ?? "",
        region: cfg.region ?? "auto",
        bucket: cfg.bucket ?? "",
        accessKey: cfg.accessKey ?? "",
        secretKey: "", // 留空 = 不修改
        prefix: cfg.prefix ?? "",
      });
    } else {
      let cfg: WebDavConfig = { url: "", username: "" };
      try {
        cfg = JSON.parse(b.configJson) as WebDavConfig;
      } catch {
        // 静默失败：表单显示空值
      }
      form.setFieldsValue({
        name: b.name,
        url: cfg.url ?? "",
        username: cfg.username ?? "",
        password: "", // 留空 = 不修改
      });
    }
    setEditorOpen(true);
  }

  async function submitForm() {
    try {
      const values = await form.validateFields();
      let input;
      if (formKind === "s3") {
        // 编辑时 secretKey 留空 = 保留原密钥（后端按 configJson 缺失字段处理）
        const cfg: S3Config = {
          endpoint: values.endpoint.trim(),
          region: (values.region || "auto").trim(),
          bucket: values.bucket.trim(),
          accessKey: values.accessKey.trim(),
          ...(values.secretKey ? { secretKey: values.secretKey } : {}),
          prefix: (values.prefix || "").trim(),
        };
        input = {
          kind: "s3" as const,
          name: values.name.trim(),
          configJson: JSON.stringify(cfg),
        };
      } else {
        const cfg: WebDavConfig = {
          url: values.url.trim(),
          username: values.username,
          ...(values.password ? { password: values.password } : {}),
        };
        input = {
          kind: "webdav" as const,
          name: values.name.trim(),
          configJson: JSON.stringify(cfg),
        };
      }
      if (editingId !== null) {
        await syncV1Api.updateBackend(editingId, input);
        message.success("已更新");
      } else {
        await syncV1Api.createBackend(input);
        message.success("已添加");
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function testConn(id: number) {
    setBusyId(id);
    try {
      await syncV1Api.testConnection(id);
      message.success("连接正常");
    } catch (e) {
      message.error(`连接失败: ${e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function push(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.push(id);
      message.success(
        `推送完成：上传 ${r.uploaded} · 删除 ${r.deletedRemote} · 跳过 ${r.skipped}` +
          (r.errors.length > 0 ? ` · ${r.errors.length} 错误` : ""),
      );
      await load();
    } catch (e) {
      message.error(`推送失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  async function pull(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.pull(id);
      message.success(
        `拉取完成：下载 ${r.downloaded} · 删除本地 ${r.deletedLocal}` +
          (r.conflicts > 0 ? ` · ${r.conflicts} 冲突` : ""),
      );
      useAppStore.getState().bumpNotesRefresh();
      await load();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  // 一键同步：先推后拉（先把本地新改动传上去，再合并远端），串行复用同一进度条。
  // 完成/失败都发系统通知（用户常"点完切走"，需后台可见结果）。
  async function syncAll(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const p = await syncV1Api.push(id);
      // High-3：push 有失败条目（弱网下单条上传失败）→ 不继续 pull。
      // 后端已保证 manifest 只宣告成功上传的内容，但本地仍有改动没传上去；此时拉取远端只会
      // 让"本地未传完"的状态更难判断，也给不了用户明确的重试信号。停在这里、提示重试更稳。
      if (p.errors.length > 0) {
        const summary = `上传 ${p.uploaded} · ${p.errors.length} 项失败，已暂停拉取，请重试`;
        message.warning(`同步未完成：${summary}`);
        void notifySystem("同步未完成", summary);
        await load();
        return;
      }
      const q = await syncV1Api.pull(id);
      const summary =
        `上传 ${p.uploaded} · 下载 ${q.downloaded}` +
        (p.deletedRemote + q.deletedLocal > 0
          ? ` · 删除 ${p.deletedRemote + q.deletedLocal}`
          : "") +
        (q.conflicts > 0 ? ` · ${q.conflicts} 冲突` : "") +
        (p.errors.length > 0 ? ` · ${p.errors.length} 错误` : "");
      message.success(`同步完成：${summary}`);
      void notifySystem("同步完成", summary);
      useAppStore.getState().bumpNotesRefresh();
      await load();
    } catch (e) {
      const reason = String(e);
      message.error(`同步失败: ${reason}`);
      void notifySystem("同步失败", reason.slice(0, 120));
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  function remove(b: SyncBackend) {
    Modal.confirm({
      title: `删除「${b.name}」？`,
      content: "本地的同步配置将被清除（远端数据不动）。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await syncV1Api.deleteBackend(b.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">云端同步</h1>
        <div className="flex">
          <button
            onClick={() => setImportOpen(true)}
            aria-label="导入配置"
            className="flex h-10 w-10 items-center justify-center text-slate-600"
          >
            <Download size={20} />
          </button>
          <button
            onClick={openAdd}
            aria-label="新增"
            className="flex h-10 w-10 items-center justify-center text-[#1677FF]"
          >
            <Plus size={22} />
          </button>
        </div>
      </header>

      {/* 信息横幅 */}
      <div className="flex items-start gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2.5 shrink-0">
        <CloudUpload size={16} className="mt-0.5 shrink-0 text-blue-600" />
        <p className="text-xs leading-relaxed text-blue-800">
          移动端手动同步，建议每次记录后「一键同步」。支持 WebDAV 与 S3
          （AWS / 阿里云 OSS / 腾讯云 COS / R2 / MinIO）。
        </p>
      </div>

      {/* 列表 */}
      <main className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-sm text-slate-400 py-8">加载中…</div>
        ) : backends.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <CloudUpload size={40} className="text-slate-300" />
            <span className="text-sm">还没有配置同步</span>
            <span className="text-xs text-slate-300">
              点右上 + 添加 WebDAV / S3
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            {backends.map((b) => (
              <BackendCard
                key={b.id}
                backend={b}
                busy={busyId === b.id}
                progress={
                  busyId === b.id && progress?.backendId === b.id
                    ? progress
                    : null
                }
                onSyncAll={() => syncAll(b.id)}
                onPush={() => push(b.id)}
                onPull={() => pull(b.id)}
                onTest={() => testConn(b.id)}
                onEdit={() => openEdit(b)}
                onDelete={() => remove(b)}
                onShare={() => setShareEnv(exportSyncBackend(b))}
              />
            ))}
          </div>
        )}
      </main>

      {/* 添加 / 编辑 Modal */}
      <Modal
        title={
          editingId === null
            ? formKind === "s3"
              ? "添加 S3 同步"
              : "添加 WebDAV 同步"
            : "编辑同步"
        }
        open={editorOpen}
        onOk={submitForm}
        onCancel={() => setEditorOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          {/* 类型选择：仅新增时可切换（编辑已存在后端不改类型，避免 configJson 结构错位） */}
          {editingId === null && (
            <Form.Item label="类型">
              <Segmented
                block
                value={formKind}
                onChange={(v) => setFormKind(v as SyncBackendKind)}
                options={[
                  { label: "WebDAV", value: "webdav" },
                  { label: "S3 / 对象存储", value: "s3" },
                ]}
              />
            </Form.Item>
          )}

          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder={formKind === "s3" ? "如：R2 / MinIO / 阿里云" : "如：坚果云 / Nextcloud"} />
          </Form.Item>

          {formKind === "s3" ? (
            <>
              <Form.Item
                name="endpoint"
                label="Endpoint"
                tooltip="AWS: https://s3.<region>.amazonaws.com；R2: https://<账户ID>.r2.cloudflarestorage.com；阿里云 OSS / MinIO 填各自地址"
                rules={[{ required: true, message: "请输入 endpoint" }]}
              >
                <Input placeholder="https://<账户ID>.r2.cloudflarestorage.com" />
              </Form.Item>
              <Form.Item name="bucket" label="Bucket" rules={[{ required: true, message: "请输入 bucket" }]}>
                <Input placeholder="桶名" />
              </Form.Item>
              <Form.Item name="region" label="Region" tooltip="不确定填 auto（R2）或 us-east-1">
                <Input placeholder="auto" />
              </Form.Item>
              <Form.Item name="accessKey" label="Access Key" rules={[{ required: true, message: "请输入 Access Key" }]}>
                <Input placeholder="Access Key ID" autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="secretKey"
                label="Secret Key"
                rules={editingId === null ? [{ required: true, message: "请输入 Secret Key" }] : []}
              >
                <Input.Password placeholder={editingId === null ? "Secret Access Key" : "留空 = 不修改"} autoComplete="off" />
              </Form.Item>
              <Form.Item name="prefix" label="路径前缀（可选）" tooltip="在 bucket 内做隔离，如 kb/；留空放桶根">
                <Input placeholder="kb/" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="url"
                label="WebDAV 地址"
                rules={[{ required: true, message: "请输入完整 URL" }]}
              >
                <Input placeholder="https://dav.jianguoyun.com/dav/knowledge_base" />
              </Form.Item>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true, message: "请输入用户名" }]}
              >
                <Input placeholder="账号 / 邮箱" />
              </Form.Item>
              <Form.Item
                name="password"
                label="应用密码"
                tooltip="坚果云需在「账户信息 → 安全选项」生成第三方应用密码"
                rules={editingId === null ? [{ required: true, message: "请输入密码" }] : []}
              >
                <Input.Password placeholder={editingId === null ? "" : "留空 = 不修改密码"} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* 配置分享 */}
      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      {/* 配置导入 */}
      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  compute: "计算清单",
  diff: "对比远端",
  upload: "上传",
  download: "下载",
  manifest: "更新清单",
  apply: "应用本地",
  done: "完成",
};

function BackendCard({
  backend,
  busy,
  progress,
  onSyncAll,
  onPush,
  onPull,
  onTest,
  onEdit,
  onDelete,
  onShare,
}: {
  backend: SyncBackend;
  busy: boolean;
  progress: SyncV1ProgressEvent | null;
  onSyncAll: () => void;
  onPush: () => void;
  onPull: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const lastPush = backend.lastPushTs
    ? relativeTime(backend.lastPushTs)
    : "从未";
  const lastPull = backend.lastPullTs
    ? relativeTime(backend.lastPullTs)
    : "从未";
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
          <CloudUpload size={20} className="text-[#1677FF]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">
              {backend.name}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 uppercase">
              {backend.kind}
            </span>
            {backend.enabled ? (
              <CheckCircle2 size={12} className="text-green-500" />
            ) : (
              <AlertCircle size={12} className="text-slate-400" />
            )}
          </div>
          <div className="mt-1 grid grid-cols-2 text-[11px] text-slate-500">
            <span>↑ 推送 · {lastPush}</span>
            <span>↓ 拉取 · {lastPull}</span>
          </div>
        </div>
      </div>

      {/* 进度条（仅在 busy 时显示） */}
      {busy && (
        <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-blue-700">
            <span className="font-medium">
              {progress
                ? PHASE_LABELS[progress.phase] ?? progress.phase
                : "准备中…"}
            </span>
            {progress && progress.total > 0 && (
              <span>
                {progress.current} / {progress.total}
              </span>
            )}
          </div>
          {progress?.message && (
            <div className="mt-0.5 truncate text-[10px] text-blue-600/80">
              {progress.message}
            </div>
          )}
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full bg-[#1677FF] transition-all"
              style={{
                width:
                  progress && progress.total > 0
                    ? `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`
                    : "8%",
              }}
            />
          </div>
        </div>
      )}

      {/* 一键同步（主操作）：先推后拉 */}
      <button
        onClick={onSyncAll}
        disabled={busy}
        className="mt-3 flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-[#1677FF] text-sm font-semibold text-white active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        <RefreshCw size={16} className={busy ? "animate-spin" : ""} /> 一键同步
      </button>

      {/* 单向操作（次级）：分别推/拉 */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          onClick={onPush}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <CloudUpload size={13} /> 仅推送
        </button>
        <button
          onClick={onPull}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <CloudDownload size={13} /> 仅拉取
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        <button
          onClick={onTest}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Plug size={12} /> 测试
        </button>
        <button
          onClick={onShare}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Share2 size={12} /> 分享
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 active:bg-slate-50 disabled:opacity-50"
        >
          <Pencil size={12} /> 编辑
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-red-200 bg-white text-xs text-red-600 active:bg-red-50 disabled:opacity-50"
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>
    </div>
  );
}
