/**
 * T-024 同步 V1 设置区
 *
 * 与现有 V0 SyncSection（整库 ZIP 备份）并存。
 * 这里管理"多 backend + 单笔记粒度增量同步"。
 *
 * v1 阶段仅 LocalPath backend 可用；S3 / WebDAV / Git 显示"敬请期待"占位。
 */
import { useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from "antd";
import {
  CloudDownload,
  CloudUpload,
  FolderOpen,
  Plug,
  Plus,
  Trash2,
  Pencil,
  RefreshCcw,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { configApi, syncApi, syncV1Api } from "@/lib/api";
import type {
  SyncBackend,
  SyncBackendInput,
  SyncBackendKind,
  SyncV1ProgressEvent,
} from "@/types";

const { Text, Paragraph } = Typography;

interface BackendFormState {
  id: number | null;
  kind: SyncBackendKind;
  name: string;
  /** Local */
  path: string;
  /** WebDAV */
  url: string;
  username: string;
  password: string;
  /** S3 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
  enabled: boolean;
  autoSync: boolean;
  syncIntervalMin: number;
}

const EMPTY_FORM: BackendFormState = {
  id: null,
  kind: "local",
  name: "",
  path: "",
  url: "",
  username: "",
  password: "",
  endpoint: "",
  region: "auto",
  bucket: "",
  accessKey: "",
  secretKey: "",
  prefix: "",
  enabled: true,
  autoSync: false,
  syncIntervalMin: 30,
};

const KIND_LABEL: Record<SyncBackendKind, string> = {
  local: "本地路径 / 同步盘",
  webdav: "WebDAV",
  s3: "S3 兼容（阿里云 OSS / 腾讯云 COS / R2 / MinIO）",
};

const KIND_TAG_COLOR: Record<SyncBackendKind, string> = {
  local: "green",
  webdav: "blue",
  s3: "geekblue",
};

function buildConfigJson(s: BackendFormState): string {
  switch (s.kind) {
    case "local":
      return JSON.stringify({ path: s.path });
    case "webdav":
      return JSON.stringify({
        url: s.url,
        username: s.username,
        password: s.password,
      });
    case "s3":
      return JSON.stringify({
        endpoint: s.endpoint,
        region: s.region || "auto",
        bucket: s.bucket,
        accessKey: s.accessKey,
        secretKey: s.secretKey,
        prefix: s.prefix || "",
      });
  }
}

function parseConfigJson(
  kind: SyncBackendKind,
  json: string,
): Partial<BackendFormState> {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const get = (k: string, def = "") =>
      typeof v[k] === "string" ? (v[k] as string) : def;
    switch (kind) {
      case "local":
        return { path: get("path") };
      case "webdav":
        return {
          url: get("url"),
          username: get("username"),
          password: get("password"),
        };
      case "s3":
        return {
          endpoint: get("endpoint"),
          region: get("region", "auto"),
          bucket: get("bucket"),
          accessKey: get("accessKey"),
          secretKey: get("secretKey"),
          prefix: get("prefix"),
        };
    }
  } catch {
    return {};
  }
}

export function SyncV1Section() {
  const { token } = antdTheme.useToken();
  const { message, modal } = AntdApp.useApp();
  const [backends, setBackends] = useState<SyncBackend[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<BackendFormState>(EMPTY_FORM);
  const [busyBackendId, setBusyBackendId] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncV1ProgressEvent | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<SyncV1ProgressEvent>("sync_v1:progress", (e) => {
      setProgress(e.payload);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // 自动同步结果通知：成功不打扰（仅刷新列表更新 last_*_ts 显示），失败弹 toast
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ backendId: number; ok: boolean; error?: string | null }>(
      "sync_v1:auto-triggered",
      (e) => {
        const { ok, error, backendId } = e.payload;
        if (ok) {
          void loadBackends();
        } else {
          message.warning(`自动同步失败 (backend #${backendId})：${error ?? "未知错误"}`);
        }
      },
    ).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadBackends();
  }, []);

  async function loadBackends() {
    setLoading(true);
    try {
      const list = await syncV1Api.listBackends();
      setBackends(list);
    } catch (e) {
      message.error(`加载同步配置失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setForm({ ...EMPTY_FORM });
    setModalOpen(true);
  }

  function openEditModal(b: SyncBackend) {
    const parsed = parseConfigJson(b.kind, b.configJson);
    setForm({
      ...EMPTY_FORM,
      id: b.id,
      kind: b.kind,
      name: b.name,
      enabled: b.enabled,
      autoSync: b.autoSync,
      syncIntervalMin: b.syncIntervalMin,
      ...parsed,
    });
    setModalOpen(true);
  }

  async function handlePickPath() {
    const sel = await openDialog({
      directory: true,
      multiple: false,
      title: "选择同步目录",
    });
    if (typeof sel === "string") {
      setForm((s) => ({ ...s, path: sel }));
    }
  }

  /**
   * 一键复用「备份与恢复」(V0) 里已配置的 WebDAV：
   * URL/用户名走 app_config，密码走 SQLite 加密存储 → 解密后塞进表单
   * 仅在新建时拉到当前的 V0 名字作为默认 name；编辑时不覆盖已有 name
   */
  async function handleReuseV0Webdav() {
    try {
      const url = await configApi.get("sync.webdav_url").catch(() => "");
      const username = await configApi
        .get("sync.webdav_username")
        .catch(() => "");
      if (!url || !username) {
        message.warning(
          "「备份与恢复」里还没填 WebDAV，请先去那边填好 URL 和用户名",
        );
        return;
      }
      let password = "";
      try {
        password = (await syncApi.getPassword(username)) ?? "";
      } catch {
        password = "";
      }
      setForm((s) => ({
        ...s,
        kind: "webdav",
        name: s.name || `从备份与恢复复用（${username}）`,
        url,
        username,
        password,
      }));
      if (!password) {
        message.info("已填入 URL 和用户名；密码未保存到钥匙串，请手动补填");
      } else {
        message.success("已从「备份与恢复」复用 WebDAV 配置");
      }
    } catch (e) {
      message.error(`读取失败：${e}`);
    }
  }

  function validateForm(): string | null {
    if (!form.name.trim()) return "请填写名称";
    switch (form.kind) {
      case "local":
        if (!form.path.trim()) return "请选择本地路径";
        break;
      case "webdav":
        if (!form.url || !form.username) return "请填写 WebDAV URL 和用户名";
        break;
      case "s3":
        if (!form.endpoint || !form.bucket || !form.accessKey)
          return "请填写 endpoint / bucket / accessKey";
        break;
    }
    return null;
  }

  async function handleSave() {
    const err = validateForm();
    if (err) {
      message.warning(err);
      return;
    }
    const input: SyncBackendInput = {
      kind: form.kind,
      name: form.name.trim(),
      configJson: buildConfigJson(form),
      enabled: form.enabled,
      autoSync: form.autoSync,
      syncIntervalMin: form.syncIntervalMin,
    };
    try {
      if (form.id == null) {
        await syncV1Api.createBackend(input);
        message.success("已创建同步配置");
      } else {
        await syncV1Api.updateBackend(form.id, input);
        message.success("已更新同步配置");
      }
      setModalOpen(false);
      void loadBackends();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await syncV1Api.deleteBackend(id);
      message.success("已删除");
      void loadBackends();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function handleTest(id: number) {
    setBusyBackendId(id);
    try {
      await syncV1Api.testConnection(id);
      message.success("连接正常");
    } catch (e) {
      message.error(`连接失败: ${e}`);
    } finally {
      setBusyBackendId(null);
    }
  }

  async function handlePush(id: number) {
    setBusyBackendId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.push(id);
      const msg = `推送完成：上传 ${r.uploaded} / 跳过 ${r.skipped} / 错误 ${r.errors.length}`;
      if (r.errors.length > 0) {
        modal.warning({ title: "推送有错误", content: r.errors.join("\n") });
      } else {
        message.success(msg);
      }
      void loadBackends();
    } catch (e) {
      message.error(`推送失败: ${e}`);
    } finally {
      setBusyBackendId(null);
      setProgress(null);
    }
  }

  async function handlePull(id: number) {
    setBusyBackendId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.pull(id);
      const msg = `拉取完成：下载 ${r.downloaded} / 删本地 ${r.deletedLocal} / 冲突 ${r.conflicts} / 错误 ${r.errors.length}`;
      if (r.errors.length > 0) {
        modal.warning({ title: "拉取有错误", content: r.errors.join("\n") });
      } else if (r.conflicts > 0) {
        modal.warning({
          title: `${r.conflicts} 条冲突`,
          content:
            "落败的远端版本已写到 <数据目录>/sync_conflicts/backend_<id>/，请手动比对。",
        });
      } else {
        message.success(msg);
      }
      void loadBackends();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setBusyBackendId(null);
      setProgress(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span
          className="flex items-center gap-2"
          style={{ fontSize: 13, color: token.colorTextSecondary }}
        >
          <RefreshCcw size={14} />
          已配置的同步源：每个同步源独立维护推送 / 拉取状态
        </span>
        <Button
          type="primary"
          size="small"
          icon={<Plus size={14} />}
          onClick={openCreateModal}
        >
          新增同步源
        </Button>
      </div>

      <Table<SyncBackend>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={backends}
        pagination={false}
        locale={{ emptyText: "还没有同步源，点右上角「新增同步源」开始" }}
        columns={[
          {
            title: "名称",
            dataIndex: "name",
            render: (_, b) => (
              <span className="flex items-center gap-2">
                <Tag color={KIND_TAG_COLOR[b.kind]}>{KIND_LABEL[b.kind]}</Tag>
                <Text strong>{b.name}</Text>
                {!b.enabled && <Tag>已禁用</Tag>}
              </span>
            ),
          },
          {
            title: "上次推送 / 拉取",
            width: 220,
            render: (_, b) => (
              <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
                <Text type="secondary">
                  ↑ {b.lastPushTs ?? "—"}
                </Text>
                <Text type="secondary">
                  ↓ {b.lastPullTs ?? "—"}
                </Text>
              </Space>
            ),
          },
          {
            title: "操作",
            width: 360,
            render: (_, b) => {
              const busy = busyBackendId === b.id;
              return (
                <Space size={4} wrap>
                  <Tooltip title="测试连接">
                    <Button
                      size="small"
                      icon={<Plug size={13} />}
                      loading={busy}
                      onClick={() => handleTest(b.id)}
                    />
                  </Tooltip>
                  <Tooltip title="推送本地变更到远端">
                    <Button
                      size="small"
                      icon={<CloudUpload size={13} />}
                      loading={busy}
                      onClick={() => handlePush(b.id)}
                    >
                      推送
                    </Button>
                  </Tooltip>
                  <Tooltip title="从远端拉取变更到本地">
                    <Button
                      size="small"
                      icon={<CloudDownload size={13} />}
                      loading={busy}
                      onClick={() => handlePull(b.id)}
                    >
                      拉取
                    </Button>
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      size="small"
                      icon={<Pencil size={13} />}
                      onClick={() => openEditModal(b)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认删除此同步源？"
                    description="只清掉同步源配置和远端状态记录，不会动你的笔记"
                    onConfirm={() => handleDelete(b.id)}
                  >
                    <Button size="small" danger icon={<Trash2 size={13} />} />
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />

      {progress && (
        <div className="mt-3">
          <Paragraph style={{ fontSize: 13, marginBottom: 4 }}>
            {progress.message}
          </Paragraph>
          {progress.total > 0 ? (
            <Progress
              percent={Math.round(
                ((progress.current || 0) / Math.max(1, progress.total)) * 100,
              )}
              size="small"
              status={progress.phase === "done" ? "success" : "active"}
            />
          ) : (
            <Progress percent={100} size="small" status="active" showInfo={false} />
          )}
        </div>
      )}

      <Modal
        title={form.id == null ? "新增同步源" : `编辑同步源：${form.name}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText="保存"
        cancelText="取消"
        width={620}
        destroyOnClose
        styles={{
          body: {
            // 表单字段较多（尤其 S3 类型）时，弹窗高度会撑爆视口顶到导航栏后面，
            // 用户找不到底部「保存」按钮。固定 body 高度 + 内部滚动，让 Modal
            // 自身保持稳定的可视高度。
            height: 480,
            overflowY: "auto",
            paddingRight: 12,
          },
        }}
      >
        <Form layout="vertical" size="small">
          <Form.Item label="类型">
            <Radio.Group
              value={form.kind}
              onChange={(e) =>
                setForm((s) => ({ ...s, kind: e.target.value as SyncBackendKind }))
              }
              optionType="button"
              buttonStyle="solid"
            >
              {(
                ["local", "webdav", "s3"] as SyncBackendKind[]
              ).map((k) => (
                <Radio.Button key={k} value={k}>
                  {KIND_LABEL[k]}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>

          <Form.Item label="名称（自起，区分多个配置）" required>
            <Input
              value={form.name}
              onChange={(e) =>
                setForm((s) => ({ ...s, name: e.target.value }))
              }
              placeholder="如「我的坚果云」「办公电脑」"
            />
          </Form.Item>

          {form.kind === "local" && (
            <>
              <Form.Item
                label="本地路径"
                required
                extra="可以指向你的百度云 / iCloud Drive / OneDrive 同步盘目录，借用云盘原生同步"
              >
                <Input
                  value={form.path}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, path: e.target.value }))
                  }
                  placeholder="C:\Users\...\Sync\knowledge-base"
                  suffix={
                    <Button
                      type="text"
                      size="small"
                      icon={<FolderOpen size={13} />}
                      onClick={handlePickPath}
                    />
                  }
                />
              </Form.Item>
            </>
          )}

          {form.kind === "webdav" && (
            <>
              <div className="mb-2">
                <Button
                  size="small"
                  icon={<RefreshCcw size={13} />}
                  onClick={handleReuseV0Webdav}
                >
                  复用「备份与恢复」的 WebDAV 配置
                </Button>
              </div>
              <Form.Item
                label="WebDAV URL"
                required
                extra="例如坚果云：https://dav.jianguoyun.com/dav/我的同步空间"
              >
                <Input
                  value={form.url}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, url: e.target.value }))
                  }
                  placeholder="https://dav.example.com/dav/path"
                />
              </Form.Item>
              <Form.Item label="用户名" required>
                <Input
                  value={form.username}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, username: e.target.value }))
                  }
                />
              </Form.Item>
              <Form.Item label="密码（应用密码 / 第三方授权码）" required>
                <Input.Password
                  value={form.password}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, password: e.target.value }))
                  }
                  placeholder="坚果云用「应用密码」、Nextcloud 用 App Token"
                />
              </Form.Item>
              <Alert
                type="info"
                showIcon
                message="V1 是单笔记粒度的真同步，跟上方「整库 ZIP 备份」V0 是两套独立机制，可以并存"
              />
            </>
          )}

          {form.kind === "s3" && (
            <>
              <Form.Item
                label="Endpoint URL"
                required
                extra="阿里云 OSS：https://oss-cn-hangzhou.aliyuncs.com / 腾讯云 COS：https://cos.ap-shanghai.myqcloud.com / R2：https://<account>.r2.cloudflarestorage.com / MinIO：http://localhost:9000"
              >
                <Input
                  value={form.endpoint}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, endpoint: e.target.value }))
                  }
                  placeholder="https://oss-cn-hangzhou.aliyuncs.com"
                />
              </Form.Item>
              <Form.Item
                label="Region"
                extra="AWS S3 必填（如 us-east-1）；R2 / 阿里云 / 腾讯云通常填 auto 或留空即可"
              >
                <Input
                  value={form.region}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, region: e.target.value }))
                  }
                  placeholder="auto"
                />
              </Form.Item>
              <Form.Item label="Bucket 名称" required>
                <Input
                  value={form.bucket}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, bucket: e.target.value }))
                  }
                  placeholder="my-knowledge-base"
                />
              </Form.Item>
              <Form.Item label="Access Key" required>
                <Input
                  value={form.accessKey}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, accessKey: e.target.value }))
                  }
                />
              </Form.Item>
              <Form.Item label="Secret Key" required>
                <Input.Password
                  value={form.secretKey}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, secretKey: e.target.value }))
                  }
                />
              </Form.Item>
              <Form.Item
                label="路径前缀（可选）"
                extra="留空则放在 bucket 根；填 kb/ 则所有同步对象放在 bucket/kb/ 下，方便和别的内容隔离"
              >
                <Input
                  value={form.prefix}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, prefix: e.target.value }))
                  }
                  placeholder="kb"
                />
              </Form.Item>
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-6">
            <span className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onChange={(v) => setForm((s) => ({ ...s, enabled: v }))}
              />
              <Text>启用</Text>
            </span>
            <span className="flex items-center gap-2">
              <Switch
                checked={form.autoSync}
                onChange={(v) => setForm((s) => ({ ...s, autoSync: v }))}
              />
              <Text>自动同步</Text>
            </span>
            <span className="flex items-center gap-2">
              <Text type="secondary">间隔</Text>
              <InputNumber
                size="small"
                min={5}
                max={1440}
                value={form.syncIntervalMin}
                onChange={(v) =>
                  setForm((s) => ({
                    ...s,
                    syncIntervalMin: typeof v === "number" ? v : 30,
                  }))
                }
              />
              <Text type="secondary">分钟</Text>
            </span>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
