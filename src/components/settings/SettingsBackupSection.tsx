/**
 * 配置备份与恢复：把全部设置导出成一个 `.kbconfig` 文件，换机器 / 重装后导回来。
 *
 * - 导出：勾选分类 → 含密钥时强制设 PIN 加密 → 原生保存对话框写盘
 * - 导入：选文件 → 加密的先输 PIN → 预览文件里有什么、按分类勾选 → 写入
 *   模型服务 / 同步源遇到本机同名的跳过，同一份备份导两次不会冒出重复配置
 *
 * 收集 / 筛选逻辑在 `@/lib/settingsBackup`，写入复用配置分享的 `applyEnvelope`。
 */
import { useState } from "react";
import { Alert, App as AntdApp, Button, Card, Checkbox, Input, Modal, Space, theme as antdTheme } from "antd";
import { ArchiveRestore, Download, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { systemApi } from "@/lib/api";
import {
  applyEnvelope,
  parseEnvelope,
  stringifyEncrypted,
  stringifyEnvelope,
  type BundleData,
} from "@/lib/configShare";
import {
  BACKUP_CATEGORIES,
  collectSettingsBackup,
  countBackupItems,
  describeBackup,
  needsRestart,
  pickBackup,
  type BackupCategory,
  type BackupPreviewItem,
} from "@/lib/settingsBackup";

const ALL_CATEGORIES = BACKUP_CATEGORIES.map((c) => c.key);
/** 与配置分享弹窗的解密门槛一致：PBKDF2 算一次几十毫秒，太短的 PIN 也没意义 */
const MIN_PIN_LEN = 4;
const FILE_FILTERS = [{ name: "知识库配置", extensions: ["kbconfig", "json"] }];

export function SettingsBackupSection() {
  const { token } = antdTheme.useToken();
  const { message, modal } = AntdApp.useApp();

  // ─── 导出 ───
  const [exportOpen, setExportOpen] = useState(false);
  const [counts, setCounts] = useState<Record<BackupCategory, number> | null>(null);
  const [exportCats, setExportCats] = useState<BackupCategory[]>(ALL_CATEGORIES);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [exportPin, setExportPin] = useState("");
  const [exporting, setExporting] = useState(false);

  // ─── 导入 ───
  const [importText, setImportText] = useState<string | null>(null);
  const [importNeedPin, setImportNeedPin] = useState(false);
  const [importPin, setImportPin] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importData, setImportData] = useState<BundleData | null>(null);
  const [importItems, setImportItems] = useState<BackupPreviewItem[]>([]);
  const [importCats, setImportCats] = useState<BackupCategory[]>([]);
  const [importing, setImporting] = useState(false);

  async function openExport() {
    setExportCats(ALL_CATEGORIES);
    setIncludeSecrets(true);
    setExportPin("");
    setCounts(null);
    setExportOpen(true);
    setCounts(await countBackupItems());
  }

  async function doExport() {
    if (exportCats.length === 0) {
      message.warning("至少勾选一项");
      return;
    }
    const pin = exportPin.trim();
    if (includeSecrets && pin.length < MIN_PIN_LEN) {
      message.warning(`包含密钥时必须设置至少 ${MIN_PIN_LEN} 位的 PIN`);
      return;
    }
    setExporting(true);
    try {
      const { envelope, hasSecrets } = await collectSettingsBackup(new Set(exportCats), includeSecrets);
      // 兜底：上面按勾选判断过一次，这里按文件里实际有没有密钥再卡一次，明文密钥绝不落盘
      if (hasSecrets && !pin) {
        message.error("备份里含密钥，必须设置 PIN");
        return;
      }
      // 没有实际密钥（比如只勾了界面偏好）时 PIN 可填可不填；填了就照样加密
      const text = pin ? await stringifyEncrypted(envelope, pin, true) : stringifyEnvelope(envelope);
      const path = await saveDialog({
        defaultPath: `知识库配置-${dayjs().format("YYYYMMDD-HHmm")}.kbconfig`,
        filters: FILE_FILTERS,
      });
      if (!path) return;
      await systemApi.writeTextFile(path, text);
      setExportOpen(false);
      message.success(pin ? `已导出（已加密，导入时需输入 PIN）：${path}` : `已导出：${path}`);
    } catch (e) {
      message.error(`导出失败：${e}`);
    } finally {
      setExporting(false);
    }
  }

  function resetImport() {
    setImportText(null);
    setImportNeedPin(false);
    setImportPin("");
    setImportErr(null);
    setImportData(null);
    setImportItems([]);
    setImportCats([]);
  }

  /** 解析文件内容（或 PIN 解密后）→ 进入预览 */
  async function parseImport(text: string, pin?: string) {
    const r = await parseEnvelope(text, pin);
    if (!r.ok) {
      if ("encrypted" in r && r.encrypted) {
        setImportNeedPin(true);
        setImportErr(null);
      } else {
        setImportErr(pin ? "PIN 错误或文件已损坏" : r.reason);
      }
      return;
    }
    if (r.envelope.kind !== "bundle") {
      setImportErr("这是单项配置的分享内容，不是设置备份文件。请到对应设置里点「导入」");
      return;
    }
    const items = describeBackup(r.envelope.data);
    if (items.length === 0) {
      setImportErr("文件里没有可导入的设置");
      return;
    }
    setImportNeedPin(false);
    setImportErr(null);
    setImportData(r.envelope.data);
    setImportItems(items);
    setImportCats(items.map((i) => i.key));
  }

  async function openImport() {
    try {
      const picked = await openDialog({ multiple: false, filters: FILE_FILTERS });
      if (typeof picked !== "string") return;
      const text = await systemApi.readTextFile(picked);
      resetImport();
      setImportText(text);
      await parseImport(text);
    } catch (e) {
      message.error(`读取文件失败：${e}`);
    }
  }

  async function doImport() {
    if (!importData || importCats.length === 0 || importing) return;
    setImporting(true);
    try {
      const data = pickBackup(importData, new Set(importCats));
      const s = await applyEnvelope({ kbConfig: "v1", kind: "bundle", exportedAt: new Date().toISOString(), data }, {
        skipExistingNames: true,
      });
      const done: string[] = [];
      if (s.uiPrefs > 0) done.push(`界面与编辑器 ${s.uiPrefs} 项`);
      if (s.appConfig > 0 || s.featureToggles) done.push(`应用行为 ${s.appConfig + (s.featureToggles ? 1 : 0)} 项`);
      if (s.aiModels > 0) done.push(`模型服务 ${s.aiModels} 个`);
      if (s.syncBackends > 0) done.push(`同步源 ${s.syncBackends} 个`);
      if (s.asrConfig) done.push("语音识别");
      resetImport();
      modal[s.errors.length > 0 ? "warning" : "success"]({
        title: s.errors.length > 0 ? "部分设置导入失败" : "导入完成",
        width: 480,
        content: (
          <div className="flex flex-col gap-2 text-sm">
            <div>已导入：{done.join("、") || "无"}</div>
            {s.skipped.length > 0 && <div>本机已有同名项，已跳过：{s.skipped.join("、")}</div>}
            {s.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
            {s.errors.map((e) => (
              <div key={e} style={{ color: token.colorError }}>
                {e}
              </div>
            ))}
            {needsRestart(data) && <div>全局快捷键、最小化启动在重启应用后生效。</div>}
            <div style={{ color: token.colorTextTertiary }}>
              设置页里已打开的其他分区可能还显示旧值，切换页面后会刷新。
            </div>
          </div>
        ),
      });
    } catch (e) {
      message.error(`导入失败：${e}`);
    } finally {
      setImporting(false);
    }
  }

  const importOpen = importText !== null;

  return (
    <Card
      id="settings-config-backup"
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <ArchiveRestore size={16} style={{ color: token.colorPrimary }} />
          配置备份与恢复
          <span className="kb-set-note">换机器 / 重装后一键恢复全部设置</span>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-sm" style={{ color: token.colorTextSecondary }}>
          导出界面偏好、应用行为、模型服务、同步源和语音识别配置到一个文件。不含笔记数据（笔记请用「同步备份」）。
        </div>
        <Space>
          <Button icon={<Download size={14} />} onClick={() => void openExport()}>
            导出到文件
          </Button>
          <Button icon={<Upload size={14} />} onClick={() => void openImport()}>
            从文件导入
          </Button>
        </Space>
      </div>

      <Modal
        open={exportOpen}
        title="导出配置"
        okText="选择位置并导出"
        onOk={() => void doExport()}
        confirmLoading={exporting}
        onCancel={() => setExportOpen(false)}
        destroyOnHidden
        width={480}
      >
        <Checkbox.Group
          value={exportCats}
          onChange={(v) => setExportCats(v as BackupCategory[])}
          className="!flex !flex-col gap-2"
        >
          {BACKUP_CATEGORIES.map((c) => (
            <Checkbox key={c.key} value={c.key}>
              <span className="font-medium">{c.label}</span>
              {counts && (
                <span style={{ color: token.colorTextTertiary }}>
                  {c.key === "asr" ? (counts.asr ? "（已配置）" : "（未配置）") : `（${counts[c.key]}）`}
                </span>
              )}
              <div className="text-xs" style={{ color: token.colorTextTertiary }}>
                {c.desc}
              </div>
            </Checkbox>
          ))}
        </Checkbox.Group>

        <div className="mt-4 flex flex-col gap-2">
          <Checkbox checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)}>
            包含密钥（模型 API Key、同步密码、网页剪藏 Jina Key）
          </Checkbox>
          <Input.Password
            value={exportPin}
            onChange={(e) => setExportPin(e.target.value)}
            placeholder={includeSecrets ? `加密 PIN（必填，至少 ${MIN_PIN_LEN} 位）` : "加密 PIN（可选）"}
            autoComplete="new-password"
          />
          {includeSecrets ? (
            <Alert
              type="warning"
              showIcon
              message="文件会用 PIN 加密，导入时必须输入同一个 PIN。PIN 忘了就解不开，请记好。"
            />
          ) : (
            <Alert type="info" showIcon message="不含密钥：导入后需在模型服务、同步源里重新填写 Key 和密码。" />
          )}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        title="从文件导入配置"
        okText="导入所选"
        onOk={() => void doImport()}
        okButtonProps={{ disabled: !importData || importCats.length === 0 }}
        confirmLoading={importing}
        onCancel={resetImport}
        destroyOnHidden
        width={480}
      >
        {importNeedPin && (
          <div className="flex flex-col gap-2">
            <div className="text-sm">此文件已加密，请输入导出时设置的 PIN。</div>
            <Input.Password
              value={importPin}
              onChange={(e) => setImportPin(e.target.value)}
              onPressEnter={() => importText && void parseImport(importText, importPin.trim())}
              placeholder="PIN"
              autoComplete="off"
              autoFocus
            />
            <Button
              type="primary"
              disabled={importPin.trim().length < MIN_PIN_LEN}
              onClick={() => importText && void parseImport(importText, importPin.trim())}
            >
              解密
            </Button>
          </div>
        )}

        {importErr && <Alert type="error" showIcon className="!mt-3" message={importErr} />}

        {importData && (
          <>
            <div className="mb-2 text-sm" style={{ color: token.colorTextSecondary }}>
              勾选要导入的内容。界面与应用设置会覆盖本机当前值；模型服务、同步源遇到本机同名的会跳过。
            </div>
            <Checkbox.Group
              value={importCats}
              onChange={(v) => setImportCats(v as BackupCategory[])}
              className="!flex !flex-col gap-2"
            >
              {importItems.map((i) => (
                <Checkbox key={i.key} value={i.key}>
                  <span className="font-medium">{i.label}</span>
                  <span style={{ color: token.colorTextTertiary }}>（{i.detail}）</span>
                </Checkbox>
              ))}
            </Checkbox.Group>
          </>
        )}
      </Modal>
    </Card>
  );
}
