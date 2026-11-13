/**
 * 设置备份：把散在三处的设置收成一个 `.kbconfig` 文件，换机器 / 重装后一键恢复。
 *
 * 设置实际分布：
 *   - settings store（tauri-plugin-store）：界面 / 编辑器偏好 → `collectPortablePrefs`
 *   - app_config 表：行为类设置 → 只取 `isPortableConfigKey` 放行的键
 *   - 独立表：模型服务 / 同步源 / 语音识别 → 复用配置分享的序列化
 *
 * 文件格式就是配置分享的完整配置包（kind = "bundle"），所以「导入配置」弹窗粘贴文件内容
 * 也能认；老版本应用遇到新加的字段会忽略，不会报错。
 *
 * 不进备份的：笔记数据本身（走同步 / 快照归档）、localStorage 里的分栏宽度这类零碎记忆、
 * 只对本机 / 本库有意义的设置（见 `DEVICE_LOCAL_PERSIST_KEYS` 与 `PORTABLE_CONFIG_KEYS` 注释）。
 */

import { aiModelApi, asrApi, configApi, syncV1Api } from "@/lib/api";
import { collectPortablePrefs } from "@/store";
import {
  SECRET_CONFIG_KEYS,
  exportAiModel,
  exportBundle,
  exportSyncBackend,
  isPortableConfigKey,
  type AiModelData,
  type BundleData,
  type Envelope,
  type SyncBackendData,
} from "@/lib/configShare";

export type BackupCategory = "uiPrefs" | "appConfig" | "aiModels" | "syncBackends" | "asr";

export const BACKUP_CATEGORIES: { key: BackupCategory; label: string; desc: string }[] = [
  { key: "uiPrefs", label: "界面与编辑器", desc: "主题、字体字号、版面、标题编号、自动保存、列表显示等" },
  { key: "appConfig", label: "应用行为", desc: "启动与关闭、自动更新、待办提醒与提醒音、功能模块、全局快捷键、MCP 权限" },
  { key: "aiModels", label: "模型服务", desc: "服务商、地址、模型与限额" },
  { key: "syncBackends", label: "同步源", desc: "本地文件夹 / WebDAV / S3 连接信息" },
  { key: "asr", label: "语音识别", desc: "服务商、模型与区域" },
];

/** 同步源 config_json 里的凭据字段（与后端 `sync_v1::secret_fields` 一致） */
const BACKEND_SECRET_FIELDS: Record<string, string[]> = {
  webdav: ["password"],
  s3: ["secretKey"],
};

/** 后端解不开密文时打的标记（见 `database::sync_v1::SECRET_UNREADABLE_KEY`），不能带进备份 */
const SECRET_UNREADABLE_KEY = "_secretUnreadable";

/** 语音识别是否配过：从没配过的默认值导出去，会把对方已有的配置刷成默认 */
function asrConfigured(cfg: { apiKey: string; enabled: boolean }): boolean {
  return cfg.enabled || cfg.apiKey.trim() !== "";
}

/** 导出弹窗里每个分类显示的条数 */
export async function countBackupItems(): Promise<Record<BackupCategory, number>> {
  const [models, backends, asr, configs] = await Promise.all([
    aiModelApi.list().catch(() => []),
    syncV1Api.listBackends().catch(() => []),
    asrApi.getConfig().catch(() => null),
    configApi.getAll().catch(() => []),
  ]);
  return {
    uiPrefs: Object.keys(collectPortablePrefs()).length,
    appConfig: configs.filter((c) => isPortableConfigKey(c.key) && !SECRET_CONFIG_KEYS.has(c.key)).length,
    aiModels: models.length,
    syncBackends: backends.length,
    asr: asr && asrConfigured(asr) ? 1 : 0,
  };
}

export interface CollectedBackup {
  envelope: Envelope;
  /** 文件里实际带了非空密钥 —— 调用方据此强制 PIN 加密 */
  hasSecrets: boolean;
}

/**
 * 按勾选的分类收集设置。
 *
 * `includeSecrets = false` 时 API Key / 同步密码 / Jina Key 一律不导出：
 * 模型服务和同步源照样带上，对方导入后在编辑里补填即可。
 */
export async function collectSettingsBackup(
  categories: ReadonlySet<BackupCategory>,
  includeSecrets: boolean,
): Promise<CollectedBackup> {
  const data: BundleData = {};
  let hasSecrets = false;

  if (categories.has("uiPrefs")) {
    data.uiPrefs = collectPortablePrefs();
  }

  if (categories.has("appConfig")) {
    const all = await configApi.getAll();
    const picked: Record<string, string> = {};
    for (const { key, value } of all) {
      if (!isPortableConfigKey(key)) continue;
      if (SECRET_CONFIG_KEYS.has(key)) {
        if (!includeSecrets || !value) continue;
        hasSecrets = true;
      }
      picked[key] = value;
    }
    data.appConfig = picked;
  }

  if (categories.has("aiModels")) {
    const models: AiModelData[] = [];
    for (const m of await aiModelApi.list()) {
      // 明文 Key 只能逐条临时取（列表里恒为 null），见 exportAiModel 注释
      const key = includeSecrets ? await aiModelApi.getApiKey(m.id) : null;
      if (key) hasSecrets = true;
      const env = exportAiModel(m, key);
      if (env.kind === "ai-model") models.push(env.data);
    }
    data.aiModels = models;
  }

  if (categories.has("syncBackends")) {
    const backends: SyncBackendData[] = [];
    for (const b of await syncV1Api.listBackends()) {
      const env = exportSyncBackend(b);
      if (env.kind !== "sync-backend") continue;
      const config = { ...env.data.config };
      delete config[SECRET_UNREADABLE_KEY];
      for (const f of BACKEND_SECRET_FIELDS[b.kind] ?? []) {
        if (!includeSecrets) delete config[f];
        else if (typeof config[f] === "string" && config[f]) hasSecrets = true;
      }
      backends.push({ ...env.data, config });
    }
    data.syncBackends = backends;
  }

  if (categories.has("asr")) {
    const cfg = await asrApi.getConfig();
    if (asrConfigured(cfg)) {
      if (includeSecrets) {
        if (cfg.apiKey) hasSecrets = true;
        data.asrConfig = cfg;
      } else {
        // 去掉 Key 后必须一并关掉启用：后端保存时对「启用但没 Key」直接报错，整项导入失败
        data.asrConfig = { ...cfg, apiKey: "", enabled: false };
      }
    }
  }

  return { envelope: exportBundle(data), hasSecrets };
}

/** 导入预览：文件里每个分类有什么 */
export interface BackupPreviewItem {
  key: BackupCategory;
  label: string;
  /** 一句话说明，如「3 项：DeepSeek、Kimi、Ollama」 */
  detail: string;
}

function nameList(names: string[]): string {
  const shown = names.slice(0, 4).join("、");
  return names.length > 4 ? `${shown} 等` : shown;
}

export function describeBackup(data: BundleData): BackupPreviewItem[] {
  const items: BackupPreviewItem[] = [];
  const label = (k: BackupCategory) => BACKUP_CATEGORIES.find((c) => c.key === k)!.label;

  const prefCount = data.uiPrefs ? Object.keys(data.uiPrefs).length : 0;
  if (prefCount > 0) items.push({ key: "uiPrefs", label: label("uiPrefs"), detail: `${prefCount} 项` });

  // 老格式的功能开关包也归到「应用行为」
  const cfgCount = (data.appConfig ? Object.keys(data.appConfig).length : 0) + (data.featureToggles ? 1 : 0);
  if (cfgCount > 0) items.push({ key: "appConfig", label: label("appConfig"), detail: `${cfgCount} 项` });

  const models = (data.aiModels ?? []).map((m) => m.name);
  if (models.length > 0)
    items.push({ key: "aiModels", label: label("aiModels"), detail: `${models.length} 个：${nameList(models)}` });

  const backends = [...(data.webdavBackends ?? []), ...(data.syncBackends ?? [])].map((b) => b.name);
  if (backends.length > 0)
    items.push({ key: "syncBackends", label: label("syncBackends"), detail: `${backends.length} 个：${nameList(backends)}` });

  if (data.asrConfig)
    items.push({ key: "asr", label: label("asr"), detail: `${data.asrConfig.provider} · ${data.asrConfig.model}` });

  return items;
}

/** 只留下用户勾选的分类 */
export function pickBackup(data: BundleData, categories: ReadonlySet<BackupCategory>): BundleData {
  return {
    uiPrefs: categories.has("uiPrefs") ? data.uiPrefs : undefined,
    appConfig: categories.has("appConfig") ? data.appConfig : undefined,
    featureToggles: categories.has("appConfig") ? data.featureToggles : undefined,
    aiModels: categories.has("aiModels") ? data.aiModels : undefined,
    webdavBackends: categories.has("syncBackends") ? data.webdavBackends : undefined,
    syncBackends: categories.has("syncBackends") ? data.syncBackends : undefined,
    asrConfig: categories.has("asr") ? data.asrConfig : undefined,
  };
}

/** 导入后要重启才生效的设置：快捷键在启动时注册，最小化启动只在启动时读 */
export function needsRestart(data: BundleData): boolean {
  return Object.keys(data.appConfig ?? {}).some((k) => k.startsWith("shortcut.") || k === "start_minimized");
}
