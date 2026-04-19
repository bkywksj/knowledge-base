import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Input,
  Modal,
  Radio,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import {
  UploadOutlined,
  DownloadOutlined,
  CloudUploadOutlined,
  CloudDownloadOutlined,
  LinkOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import { save, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { syncApi, configApi } from "@/lib/api";
import type {
  SyncScope,
  SyncImportMode,
  SyncManifest,
  SyncHistoryItem,
} from "@/types";
import { DEFAULT_SYNC_SCOPE } from "@/types";

const { Text } = Typography;

const SCOPE_ITEMS: { key: keyof SyncScope; label: string; hint?: string }[] = [
  { key: "notes", label: "笔记元数据", hint: "包含文件夹/标签/链接/AI 对话" },
  { key: "images", label: "图片（kb_assets/）" },
  { key: "pdfs", label: "PDF 原文件（pdfs/）", hint: "可能较大" },
  { key: "sources", label: "Word 原文件（sources/）" },
  { key: "settings", label: "应用设置（settings.json）" },
];

const SCOPE_PRESETS: { name: string; scope: SyncScope }[] = [
  { name: "全量", scope: { ...DEFAULT_SYNC_SCOPE } },
  { name: "仅元数据", scope: { notes: true, settings: true, images: false, pdfs: false, sources: false } },
  { name: "笔记+图片", scope: { notes: true, settings: true, images: true, pdfs: false, sources: false } },
];

const CFG_KEY_AUTO = "sync.auto_enabled";
const CFG_KEY_INTERVAL = "sync.auto_interval_min";
const CFG_KEY_URL = "sync.webdav_url";
const CFG_KEY_USER = "sync.webdav_username";

export function SyncSection() {
  // 同步范围 & 模式
  const [scope, setScope] = useState<SyncScope>({ ...DEFAULT_SYNC_SCOPE });
  const [importMode, setImportMode] = useState<SyncImportMode>("overwrite");

  // WebDAV 配置
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasSavedPw, setHasSavedPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [cloudManifest, setCloudManifest] = useState<SyncManifest | null>(null);

  // 动作状态
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);

  // 自动同步
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoInterval, setAutoInterval] = useState(30);

  // 历史
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 初始化：从配置读 WebDAV 信息 + 自动同步设置 + 订阅自动同步事件
  useEffect(() => {
    (async () => {
      try {
        const u = await configApi.get(CFG_KEY_URL).catch(() => "");
        const user = await configApi.get(CFG_KEY_USER).catch(() => "");
        if (u) setUrl(u);
        if (user) {
          setUsername(user);
          const has = await syncApi.hasPassword(user).catch(() => false);
          setHasSavedPw(has);
        }
        const auto = await configApi.get(CFG_KEY_AUTO).catch(() => "false");
        setAutoEnabled(auto === "true");
        const interval = await configApi.get(CFG_KEY_INTERVAL).catch(() => "30");
        setAutoInterval(Number(interval) || 30);
      } catch {}
      loadHistory();
    })();

    // 订阅后台自动同步结果事件
    const unlistenPromise = listen<{ success: boolean; error?: string; stats?: unknown }>(
      "sync:auto-triggered",
      (e) => {
        if (e.payload.success) {
          message.success("自动同步成功");
        } else {
          message.warning(`自动同步失败：${e.payload.error || "未知错误"}`);
        }
        loadHistory();
      },
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadHistory() {
    try {
      const list = await syncApi.listHistory(20);
      setHistory(list);
    } catch {}
  }

  // ─── 本地 ZIP ────────────────────────────────

  async function handleExport() {
    const target = await save({
      defaultPath: `knowledge-base-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!target) return;
    setExporting(true);
    try {
      const result = await syncApi.exportToFile(scope, target);
      message.success(
        `已导出：${result.stats.notesCount} 条笔记 / ${result.stats.imagesCount + result.stats.pdfsCount + result.stats.sourcesCount} 个资产`,
      );
      loadHistory();
    } catch (e) {
      message.error(`导出失败: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!selected) return;

    if (importMode === "overwrite") {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: "覆盖式导入 — 危险操作",
          content:
            "当前本地所有笔记、图片、PDF、Word 都会被清空并替换为该 ZIP 包里的数据。此操作不可撤销。确定继续？",
          okText: "我已备份，继续",
          okType: "danger",
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    setImporting(true);
    try {
      const m = await syncApi.importFromFile(selected as string, importMode);
      message.success(
        `已导入：来自 ${m.device}（${m.exportedAt}），${m.stats.notesCount} 条笔记`,
      );
      loadHistory();
    } catch (e) {
      message.error(`导入失败: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  // ─── WebDAV ────────────────────────────────

  const webdavReady = url && username && (password || hasSavedPw);

  async function handleSavePassword() {
    if (!username || !password) {
      message.warning("请先填写用户名和密码");
      return;
    }
    try {
      await syncApi.savePassword(username, password);
      await configApi.set(CFG_KEY_URL, url);
      await configApi.set(CFG_KEY_USER, username);
      setPassword("");
      setHasSavedPw(true);
      message.success("密码已保存到系统钥匙串");
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleTestConnection() {
    if (!url || !username || !password) {
      message.warning("请先填写 URL / 用户名 / 密码");
      return;
    }
    setTesting(true);
    try {
      await syncApi.webdavTest(url, username, password);
      message.success("连接成功");
      // 测试成功后询问是否把密码保存到钥匙串
      Modal.confirm({
        title: "是否保存密码到系统钥匙串？",
        content:
          "保存后下次无需再填写密码，后台自动同步也可直接使用。" +
          "密码由操作系统加密管理（Windows Credential Manager / macOS Keychain），" +
          "不会写入数据库。",
        okText: "保存",
        cancelText: "不保存",
        async onOk() {
          try {
            await syncApi.savePassword(username, password);
            await configApi.set(CFG_KEY_URL, url);
            await configApi.set(CFG_KEY_USER, username);
            setPassword("");
            setHasSavedPw(true);
            message.success("密码已保存到系统钥匙串");
          } catch (e) {
            message.error(`保存失败: ${e}`);
          }
        },
        onCancel() {
          message.info("密码仅本次会话有效，关闭应用后需重新填写；自动同步需要先保存密码");
        },
      });
    } catch (e) {
      message.error(`连接失败: ${e}`);
    } finally {
      setTesting(false);
    }
  }

  async function handlePush() {
    setPushing(true);
    try {
      const config = { url, username, password: password || undefined };
      const result = await syncApi.webdavPush(scope, config);
      message.success(`已推送 ${result.stats.notesCount} 条笔记到云端`);
      loadHistory();
      loadCloudPreview();
    } catch (e) {
      message.error(`推送失败: ${e}`);
    } finally {
      setPushing(false);
    }
  }

  async function handlePull() {
    if (importMode === "overwrite") {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: "覆盖式拉取 — 危险操作",
          content: "本地所有数据将被云端数据替换。确定继续？",
          okText: "继续",
          okType: "danger",
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }
    setPulling(true);
    try {
      const config = { url, username, password: password || undefined };
      const m = await syncApi.webdavPull(importMode, config);
      message.success(
        `已拉取：来自 ${m.device}（${m.exportedAt}），${m.stats.notesCount} 条笔记`,
      );
      loadHistory();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setPulling(false);
    }
  }

  async function loadCloudPreview() {
    if (!webdavReady) return;
    try {
      const config = { url, username, password: password || undefined };
      const m = await syncApi.webdavPreview(config);
      setCloudManifest(m);
    } catch {
      setCloudManifest(null);
    }
  }

  // ─── 自动同步 ────────────────────────────────

  async function handleAutoToggle(enabled: boolean) {
    setAutoEnabled(enabled);
    try {
      await configApi.set(CFG_KEY_AUTO, enabled ? "true" : "false");
      await syncApi.schedulerReload();
      message.success(enabled ? "已启用自动同步" : "已关闭自动同步");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleIntervalChange(v: number) {
    setAutoInterval(v);
    try {
      await configApi.set(CFG_KEY_INTERVAL, String(v));
      await syncApi.schedulerReload();
    } catch {}
  }

  return (
    <Card title="同步" size="small">
      <Alert
        type="info"
        showIcon
        message="将笔记、图片、PDF、Word 等数据同步到 WebDAV 云盘（如坚果云），或导出为 ZIP 文件"
        style={{ marginBottom: 16 }}
      />

      {/* 同步范围 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>同步范围</div>
        <Space size={4} wrap style={{ marginBottom: 6 }}>
          {SCOPE_PRESETS.map((p) => (
            <Button
              key={p.name}
              size="small"
              type="link"
              style={{ padding: "0 4px", fontSize: 12, height: "auto" }}
              onClick={() => setScope({ ...p.scope })}
            >
              {p.name}
            </Button>
          ))}
        </Space>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {SCOPE_ITEMS.map((item) => (
            <Checkbox
              key={item.key}
              checked={scope[item.key]}
              onChange={(e) => setScope({ ...scope, [item.key]: e.target.checked })}
            >
              {item.label}
              {item.hint && (
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  ({item.hint})
                </Text>
              )}
            </Checkbox>
          ))}
        </div>
      </div>

      {/* 导入模式 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>导入模式</div>
        <Radio.Group value={importMode} onChange={(e) => setImportMode(e.target.value)}>
          <Radio value="overwrite">覆盖（清空本地，用云端替换）</Radio>
          <Radio value="merge">合并（只添加云端有而本地无的资产）</Radio>
        </Radio.Group>
      </div>

      <Divider style={{ margin: "12px 0" }}>本地 ZIP</Divider>

      <Space>
        <Button
          type="primary"
          icon={<UploadOutlined />}
          onClick={handleExport}
          loading={exporting}
        >
          导出到 ZIP
        </Button>
        <Button icon={<DownloadOutlined />} onClick={handleImport} loading={importing}>
          从 ZIP 导入
        </Button>
      </Space>

      <Divider style={{ margin: "12px 0" }}>WebDAV 云同步</Divider>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
          WebDAV 服务
          <Space size={4} style={{ marginLeft: 8 }}>
            <Button
              size="small"
              type="link"
              style={{ padding: "0 4px", fontSize: 12, height: "auto" }}
              onClick={() => setUrl("https://dav.jianguoyun.com/dav/")}
            >
              坚果云
            </Button>
            <Button
              size="small"
              type="link"
              style={{ padding: "0 4px", fontSize: 12, height: "auto" }}
              onClick={() => setUrl("https://connect.teracloud.jp/dav/")}
            >
              InfiniCLOUD
            </Button>
          </Space>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
          <Input
            placeholder="WebDAV URL（如 https://dav.jianguoyun.com/dav/文件夹/）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Input
            placeholder="用户名（邮箱）"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Input.Password
            placeholder={hasSavedPw ? "•••••（已保存到钥匙串，留空使用）" : "应用密码（不是登录密码）"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Space>
            <Button icon={<LinkOutlined />} onClick={handleTestConnection} loading={testing}>
              测试连接
            </Button>
            <Button onClick={handleSavePassword} disabled={!username || !password}>
              保存密码到钥匙串
            </Button>
            {hasSavedPw && <Tag color="green">密码已保存</Tag>}
          </Space>
        </div>
      </div>

      {cloudManifest && (
        <div style={{ marginBottom: 8, fontSize: 12 }}>
          <Text type="secondary">
            云端最新快照：{cloudManifest.device}（{cloudManifest.exportedAt}），
            {cloudManifest.stats.notesCount} 条笔记
          </Text>
        </div>
      )}

      <Space style={{ marginTop: 8 }}>
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          onClick={handlePush}
          loading={pushing}
          disabled={!webdavReady}
        >
          推送到云端
        </Button>
        <Button
          icon={<CloudDownloadOutlined />}
          onClick={handlePull}
          loading={pulling}
          disabled={!webdavReady}
        >
          从云端拉取
        </Button>
        <Button onClick={loadCloudPreview} disabled={!webdavReady}>
          查看云端状态
        </Button>
      </Space>

      <Divider style={{ margin: "12px 0" }}>自动同步</Divider>

      <Space>
        <Checkbox checked={autoEnabled} onChange={(e) => handleAutoToggle(e.target.checked)}>
          启用自动同步
        </Checkbox>
        <Text type="secondary" style={{ fontSize: 12 }}>每</Text>
        <Input
          type="number"
          min={5}
          max={1440}
          style={{ width: 80 }}
          value={autoInterval}
          onChange={(e) => handleIntervalChange(Number(e.target.value) || 30)}
          disabled={!autoEnabled}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>分钟推送一次</Text>
      </Space>
      <div style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)", marginTop: 4 }}>
        默认关闭。启用后应用在后台按设定间隔自动推送到 WebDAV；推送结果会通过消息提示。最小间隔 5 分钟。
      </div>

      <Divider style={{ margin: "12px 0" }} />

      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
        查看同步历史
      </Button>

      <Modal
        title="同步历史"
        open={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        footer={<Button onClick={() => setHistoryOpen(false)}>关闭</Button>}
        width={640}
        destroyOnHidden
      >
        {history.length === 0 ? (
          <Text type="secondary">暂无历史记录</Text>
        ) : (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            {history.map((h) => (
              <div
                key={h.id}
                style={{
                  padding: "6px 0",
                  borderBottom: "1px solid var(--ant-color-border-secondary)",
                  fontSize: 12,
                }}
              >
                <Space>
                  <Tag color={h.success ? "green" : "red"}>{h.direction}</Tag>
                  <Text>{h.startedAt}</Text>
                  {h.success ? (
                    <Text type="secondary">{h.statsJson}</Text>
                  ) : (
                    <Text type="danger">{h.error}</Text>
                  )}
                </Space>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  );
}
