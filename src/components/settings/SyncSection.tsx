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
  Switch,
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
  RemoteSnapshot,
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

/**
 * 失焦时把 WebDAV URL / 用户名写入 app_config，独立于密码保存流程。
 *
 * 历史问题：URL/用户名的持久化原本只挂在"保存密码"成功路径里。
 * 若用户填完直接点推送、或测试成功后选择"不保存密码"，配置不会入库，
 * 下次重启时 Input 空白，被当成"配置丢失"。失败静默不打扰用户。
 */
function persistUrl(v: string) {
  configApi.set(CFG_KEY_URL, v.trim()).catch(() => {});
}
function persistUsername(v: string) {
  configApi.set(CFG_KEY_USER, v.trim()).catch(() => {});
}

/**
 * 导入 / 拉取前的二次确认，两种模式都要弹。
 *
 * 为什么「保留本地文件」模式也要确认：两种模式下数据库（笔记 / 待办 / 设置）都会**整库替换**
 * 成备份里的内容，区别只在图片 / PDF 等文件目录是否整体换掉。旧文案把它叫「合并」，
 * 用户以为本地新写的笔记会保留，结果被冲掉了 —— 所以必须把真实后果讲清楚再让用户点。
 */
function confirmImport(mode: SyncImportMode, source: string): Promise<boolean> {
  const overwrite = mode === "overwrite";
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: overwrite ? `完全替换为${source}的数据？` : `用${source}的数据替换本机笔记？`,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div>
            本机当前的<b>笔记、文件夹、待办、设置</b>会整体替换为备份里的内容，
            本机在备份之后新写的内容<b>不会保留</b>。
          </div>
          <div>
            {overwrite
              ? "图片 / PDF / Word 附件目录也会整体换成备份里的。"
              : "本机已有的图片 / PDF / Word 附件文件会保留，只补上备份里多出的文件。"}
          </div>
          <div style={{ color: "var(--ant-color-text-secondary, #888)", marginTop: 4 }}>
            替换前会自动把当前数据库另存为 app.db.bak-时间
            {overwrite ? "，旧附件目录改名为 <目录>.bak-时间" : ""}，可手动找回。
          </div>
        </div>
      ),
      okText: "确认替换",
      okType: "danger",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function SyncSection() {
  // 同步范围 & 模式
  const [scope, setScope] = useState<SyncScope>({ ...DEFAULT_SYNC_SCOPE });
  // T-B03: 默认改为"合并"。覆盖模式风险高（清空本地）；用户多次反馈
  // "默认覆盖很吓人"，仅在用户主动切到覆盖时才走危险路径，且仍有二次确认拦截
  const [importMode, setImportMode] = useState<SyncImportMode>("merge");

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
  const [previewing, setPreviewing] = useState(false);
  // 从其他设备拉取
  const [snapshotsModalOpen, setSnapshotsModalOpen] = useState(false);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<RemoteSnapshot[]>([]);

  // 自动同步
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoInterval, setAutoInterval] = useState(30);

  // T-S050: 加密备份
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [savingBackupPw, setSavingBackupPw] = useState(false);

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
        // T-S050: 加载已保存的备份密码
        const hasBackupPw = await syncApi.hasBackupPassword().catch(() => false);
        if (hasBackupPw) {
          setBackupEnabled(true);
          const pw = await syncApi.getBackupPassword().catch(() => null);
          if (pw) setBackupPassword(pw);
        }
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

  /** T-S050: 取当前生效的备份密码（仅当开启加密 + 密码非空时返回，否则 undefined = 明文） */
  function backupPwArg(): string | undefined {
    const pw = backupPassword.trim();
    return backupEnabled && pw ? pw : undefined;
  }

  async function handleToggleBackup(checked: boolean) {
    if (!checked) {
      // 关闭加密 → 顺手清掉已保存的备份密码（后续 push/导出回到明文 ZIP）
      try {
        await syncApi.deleteBackupPassword();
      } catch {}
      setBackupEnabled(false);
      setBackupPassword("");
      message.info("已关闭加密备份，后续推送/导出将使用明文 ZIP");
      return;
    }
    setBackupEnabled(true);
  }

  async function handleSaveBackupPassword() {
    const pw = backupPassword.trim();
    if (!pw) {
      message.warning("请先输入备份密码");
      return;
    }
    setSavingBackupPw(true);
    try {
      await syncApi.saveBackupPassword(pw);
      message.success("备份密码已保存");
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSavingBackupPw(false);
    }
  }

  async function handleClearBackupPassword() {
    setSavingBackupPw(true);
    try {
      await syncApi.deleteBackupPassword();
      setBackupPassword("");
      message.success("已清除已保存的备份密码");
    } catch (e) {
      message.error(`清除失败: ${e}`);
    } finally {
      setSavingBackupPw(false);
    }
  }

  // ─── 本地 ZIP ────────────────────────────────

  async function handleExport() {
    const enc = backupPwArg();
    const ext = enc ? "zip.enc" : "zip";
    const target = await save({
      defaultPath: `knowledge-base-backup-${new Date().toISOString().slice(0, 10)}.${ext}`,
      filters: enc
        ? [{ name: "加密备份", extensions: ["enc"] }]
        : [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!target) return;
    setExporting(true);
    try {
      const result = await syncApi.exportToFile(scope, target, enc);
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
      filters: [{ name: "备份包", extensions: ["zip", "enc"] }],
    });
    if (!selected) return;

    if (!(await confirmImport(importMode, "该备份包"))) return;

    setImporting(true);
    try {
      // T-S050: 加密文件需密码；这里直接把当前密码框的值传过去（后端检测魔数，明文文件会忽略密码）
      const m = await syncApi.importFromFile(
        selected as string,
        importMode,
        backupPassword.trim() || undefined,
      );
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
      // 测试成功 → URL/用户名确定可用，先落库（与是否保存密码解耦）
      persistUrl(url);
      persistUsername(username);
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
      const result = await syncApi.webdavPush(scope, config, backupPwArg());
      // 推送成功即证明配置可用，兜底落库（避免用户跳过测试直接推，下次重启丢配置）
      persistUrl(url);
      persistUsername(username);
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
    if (!(await confirmImport(importMode, "云端"))) return;
    setPulling(true);
    try {
      const config = { url, username, password: password || undefined };
      const m = await syncApi.webdavPull(importMode, config, undefined, backupPwArg());
      // 拉取成功即证明配置可用，兜底落库
      persistUrl(url);
      persistUsername(username);
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

  async function handleOpenSnapshots() {
    if (!webdavReady) {
      message.warning("请先完成 WebDAV 配置并测试连接");
      return;
    }
    setSnapshotsModalOpen(true);
    setLoadingSnapshots(true);
    try {
      const config = { url, username, password: password || undefined };
      const list = await syncApi.webdavListSnapshots(config);
      setSnapshots(list);
      if (list.length === 0) {
        message.info("云端暂无任何快照");
      }
    } catch (e) {
      message.error(`列表失败: ${String(e)}`);
      setSnapshots([]);
    } finally {
      setLoadingSnapshots(false);
    }
  }

  async function handlePullFromDevice(snap: RemoteSnapshot) {
    if (!(await confirmImport(importMode, `「${snap.device}」`))) return;
    setPulling(true);
    try {
      const config = { url, username, password: password || undefined };
      // 该快照若以 .enc 结尾说明是加密包，需要传备份密码
      const needPw = snap.filename.endsWith(".enc");
      const m = await syncApi.webdavPull(
        importMode,
        config,
        snap.filename,
        needPw ? backupPassword.trim() || undefined : undefined,
      );
      message.success(
        `已从 ${snap.device} 拉取：${m.stats.notesCount} 条笔记（${m.exportedAt}）`,
      );
      setSnapshotsModalOpen(false);
      loadHistory();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setPulling(false);
    }
  }

  async function loadCloudPreview() {
    if (!webdavReady) {
      message.warning("请先完成 WebDAV 配置并测试连接");
      return;
    }
    setPreviewing(true);
    try {
      const config = { url, username, password: password || undefined };
      const m = await syncApi.webdavPreview(config);
      setCloudManifest(m);
      if (m) {
        message.success(
          `云端快照：${m.device}（${m.exportedAt}）· ${m.stats.notesCount} 条笔记`,
        );
      } else {
        message.info("云端暂无快照，请先执行一次推送");
      }
    } catch (e) {
      setCloudManifest(null);
      message.error(`查询云端失败: ${String(e)}`);
    } finally {
      setPreviewing(false);
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
    <Card title="快照归档" size="small">
      <Alert
        type="info"
        showIcon
        message="整库 ZIP 快照"
        description={
          <span style={{ fontSize: 12 }}>
            把笔记、图片、PDF、Word 等全部数据打包成 ZIP，推到 WebDAV 云盘或导出本地文件。
            <br />
            适合<b>灾备/迁移/版本回退</b>；
            <b>日常多端协作建议改用「多端实时同步」标签页</b>（增量同步 + 附件去重 + 删除可同步）。
          </span>
        }
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

      {/* 导入模式。两种都会整库替换笔记数据（整包备份不做逐条合并），
          区别只在附件目录；旧文案叫「合并」让人误以为本地笔记会保留，已按真实语义改名 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>导入模式</div>
        <Radio.Group value={importMode} onChange={(e) => setImportMode(e.target.value)}>
          <Radio value="merge">
            替换笔记，保留本地附件{" "}
            <Text type="secondary" style={{ fontSize: 12 }}>（推荐 · 本机已有的图片 / PDF 不删）</Text>
          </Radio>
          <Radio value="overwrite">
            完全替换{" "}
            <Text type="danger" style={{ fontSize: 12 }}>（附件目录也换成备份里的）</Text>
          </Radio>
        </Radio.Group>
        <div style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)", marginTop: 4 }}>
          整包备份不会逐条合并：两种模式下笔记、待办、设置都以备份为准，本机之后新写的内容会被替换。
          想多台设备互相合并，请用「多端实时同步」标签页。
        </div>
      </div>

      <Divider style={{ margin: "12px 0" }}>加密备份（端到端）</Divider>

      <div style={{ marginBottom: 4 }}>
        <Space>
          <Switch size="small" checked={backupEnabled} onChange={handleToggleBackup} />
          <Text style={{ fontSize: 13 }}>启用加密备份</Text>
        </Space>
        <div style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)", marginTop: 4 }}>
          开启后，导出 / 推送生成的快照会用下方密码做 AES-256-GCM 整块加密（文件名 <code>.zip.enc</code>），云端只能看到密文。
          <Text type="danger" style={{ fontSize: 12 }}> 忘记密码 = 无法恢复，请务必牢记。</Text>
        </div>
        {backupEnabled && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, maxWidth: 420 }}>
            <Input.Password
              placeholder="备份密码"
              value={backupPassword}
              onChange={(e) => setBackupPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button onClick={handleSaveBackupPassword} loading={savingBackupPw}>
              保存
            </Button>
            <Button onClick={handleClearBackupPassword} loading={savingBackupPw} danger>
              清除
            </Button>
          </div>
        )}
      </div>

      <Divider style={{ margin: "12px 0" }}>本地 ZIP</Divider>

      <Space>
        <Button
          type="primary"
          icon={<UploadOutlined />}
          onClick={handleExport}
          loading={exporting}
        >
          {backupPwArg() ? "导出加密备份" : "导出到 ZIP"}
        </Button>
        <Button icon={<DownloadOutlined />} onClick={handleImport} loading={importing}>
          从备份导入
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
            onBlur={() => persistUrl(url)}
          />
          <Input
            placeholder="用户名（邮箱）"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => persistUsername(username)}
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
        <Button
          onClick={loadCloudPreview}
          loading={previewing}
          disabled={!webdavReady}
        >
          查看云端状态
        </Button>
        <Button onClick={handleOpenSnapshots} disabled={!webdavReady}>
          从其他设备拉取…
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
          <div style={{ maxHeight: 440, overflow: "auto" }}>
            {history.map((h) => (
              <HistoryRow key={h.id} item={h} />
            ))}
          </div>
        )}
      </Modal>

      {/* 从其他设备拉取 */}
      <Modal
        title="选择要拉取的设备快照"
        open={snapshotsModalOpen}
        onCancel={() => setSnapshotsModalOpen(false)}
        footer={null}
        width={520}
      >
        <div className="mb-2" style={{ fontSize: 12 }}>
          <Text type="secondary">
            云端每台设备会推送独立的 <code>kb-sync-&lt;主机名&gt;.zip</code>。
            选一个覆盖本机（受"导入模式"影响）。
          </Text>
        </div>
        {loadingSnapshots ? (
          <div className="py-4 text-center">
            <Text type="secondary">加载中…</Text>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="py-4 text-center">
            <Text type="secondary">云端暂无任何快照</Text>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {snapshots.map((snap) => (
              <div
                key={snap.filename}
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--ant-color-border)",
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text strong>{snap.device}</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {snap.filename}
                  </Text>
                </div>
                <Button
                  type="primary"
                  size="small"
                  loading={pulling}
                  onClick={() => handlePullFromDevice(snap)}
                >
                  拉取
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  );
}

// ─── 历史行子组件 ────────────────────────────────

const DIRECTION_META: Record<
  string,
  { label: string; color: string }
> = {
  push: { label: "推送", color: "blue" },
  pull: { label: "拉取", color: "geekblue" },
  export: { label: "导出", color: "purple" },
  import: { label: "导入", color: "cyan" },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function summarizeStats(json: string): string[] {
  try {
    const s = JSON.parse(json);
    const parts: string[] = [];
    if (s.notesCount) parts.push(`${s.notesCount} 笔记`);
    if (s.foldersCount) parts.push(`${s.foldersCount} 文件夹`);
    if (s.tagsCount) parts.push(`${s.tagsCount} 标签`);
    if (s.imagesCount) parts.push(`${s.imagesCount} 图片`);
    if (s.pdfsCount) parts.push(`${s.pdfsCount} PDF`);
    if (s.sourcesCount) parts.push(`${s.sourcesCount} Word`);
    if (typeof s.assetsSize === "number" && s.assetsSize > 0) {
      parts.push(formatBytes(s.assetsSize));
    }
    return parts.length > 0 ? parts : ["（空快照）"];
  } catch {
    return ["（无法解析统计）"];
  }
}

function HistoryRow({ item }: { item: SyncHistoryItem }) {
  const meta = DIRECTION_META[item.direction] ?? { label: item.direction, color: "default" };
  const summary = item.success ? summarizeStats(item.statsJson) : [];

  return (
    <div
      style={{
        padding: "10px 4px",
        borderBottom: "1px solid var(--ant-color-border-secondary)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <Tag color={item.success ? meta.color : "red"} style={{ marginTop: 2 }}>
        {meta.label}
      </Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--ant-color-text-secondary)", marginBottom: 2 }}>
          {item.startedAt}
        </div>
        {item.success ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 12 }}>
            {summary.map((s, i) => (
              <Text key={i} type="secondary">
                {s}
              </Text>
            ))}
          </div>
        ) : (
          <Text type="danger" style={{ fontSize: 12 }}>
            {item.error || "未知错误"}
          </Text>
        )}
      </div>
    </div>
  );
}
