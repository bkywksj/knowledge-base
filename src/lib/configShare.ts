/**
 * 跨设备配置导出 / 导入。
 *
 * 使用场景：
 *   - 桌面端配好 WebDAV → 想快速复制到手机端
 *   - 桌面端配好 DeepSeek → 想快速复制到手机端
 *   - 跨设备同步功能开关 / Tab 偏好
 *
 * 传输方式（由 ShareConfigModal / ImportConfigModal 实现）：
 *   - JSON 文本（复制粘贴）
 *   - QR 码（手机端扫码）
 *   - 剪贴板一键读取
 *
 * 安全提示：
 *   API Key、WebDAV 密码会以**明文**写在 envelope 中。用户主动分享，
 *   ShareConfigModal 必须在顶部红色 banner 显式警示，并不要把 envelope
 *   发到不信任的渠道。
 */

import { syncV1Api, aiModelApi, configApi, asrApi } from "@/lib/api";
import { encryptWithPin, decryptWithPin } from "@/lib/configCrypto";
import { useAppStore, applyImportedPrefs } from "@/store";
import type {
  SyncBackend,
  SyncBackendInput,
  SyncBackendKind,
  AiModel,
  AiModelInput,
  WebDavConfig,
  AsrConfig,
} from "@/types";

/** Envelope schema 版本号，未来不兼容时 bump */
export const ENVELOPE_VERSION = "v1" as const;
export const ENCRYPTED_VERSION = "v1-enc" as const;

/**
 * 跨同级软件通用协议（与 tauri-cc 等其他桌面端互通）。
 *
 * 单条：`{ kind: "ai.profile", v: 1, data: { name, provider, baseURL, apiKey, model, hints? } }`
 * 多条：`{ kind: "ai.profile.bundle", v: 1, manifest, data: { api_profiles: [...] } }`
 *
 * 字段采用 camelCase，`baseURL` 用大写 URL（业内主流命名：Cherry Studio /
 * Chatbox / LobeChat / Continue / Vercel AI SDK / OpenCode 等）。
 *
 * 🔴 ai.profile 的解析与生成归 **ai-profile crate**（后端 `parse_ai_profile_text` /
 * `ai_model_to_ai_profile`），这里不再维护 TS 版解析器 —— 此前那份与 crate、sigil、reeve
 * 各写一份，别名与版本判断各不相同（这里只认 `v === 1`，高版本兼容的配置被挡在外面）。
 *
 * 输入：parseEnvelope 先认 ai.profile（交给后端，结果映射为本家 ai-model / bundle envelope，
 *       复用现有 applyEnvelope 流程），不是再按本家 kbConfig envelope 解析。
 * 输出：stringifyAsAiProfile 把本家模型配置交给后端生成 ai.profile 文本，方便粘到其他软件。
 */

/** 加密后的 envelope 外壳：payload = base64url(salt || iv || ciphertext) */
export interface EncryptedEnvelope {
  kbConfig: typeof ENCRYPTED_VERSION;
  payload: string;
}

/** 配置类型：每种 kind 对应一组 data */
export type ConfigKind =
  | "webdav-backend"  // SyncBackend (kind=webdav) — 含密码（旧格式，仅导入端兼容）
  | "sync-backend"     // SyncBackend（任意 kind: local/webdav/s3）— 通用同步源
  | "ai-model"         // AiModelInput — 含 api_key
  | "asr-config"       // AsrConfig — 语音识别（含 apiKey）
  | "feature-toggles"  // 功能开关 + Dashboard 显示项 + Tab 顺序
  | "bundle";          // 一次导出多个

/** 通用 envelope 头 */
interface EnvelopeBase<K extends ConfigKind, D> {
  kbConfig: typeof ENVELOPE_VERSION;
  kind: K;
  exportedAt: string;
  exportedBy?: string;
  data: D;
}

export interface WebDavBackendData {
  name: string;
  /** 直接是 SyncBackend.configJson 解析后的对象（含 password） */
  config: WebDavConfig;
}

/**
 * 通用同步源数据：覆盖 local / webdav / s3 全部类型。
 * config 直接是 SyncBackend.configJson 解析后的对象，
 * 各类型字段不同（local: path / webdav: url+username+password /
 * s3: endpoint+bucket+accessKey+secretKey...），含敏感字段。
 */
export interface SyncBackendData {
  /** 同步源类型：local（本地路径/同步盘）/ webdav / s3 */
  kind: SyncBackendKind;
  name: string;
  config: Record<string, unknown>;
}

export interface AiModelData {
  /** 与 AiModelInput 完全一致 */
  name: string;
  provider: string;
  api_url: string;
  api_key?: string | null;
  model_id: string;
  /** 上下文窗口；null / 缺省 / 0 = 未设置 */
  max_context?: number | null;
  /** 单次回答 token 上限；null / 缺省 = 用服务商默认 */
  max_tokens?: number | null;
  /** 限额来源（v1.65 起导出） */
  limits_source?: "user" | "endpoint" | null;
  /** 端点上报的输出上限（v1.65 起导出） */
  max_output?: number | null;
  /**
   * 🔴 地址已是「原样使用」口径（v1.65 起导出时带 true）。
   *
   * 缺失 = 旧版本导出的配置：地址按旧规则会被自动补 /v1、provider 是旧的厂商 id ——
   * 导入时要先按旧规则修正（后端 `fix_legacy_ai_model`，与 schema v62 同一套），
   * 否则裸根地址会 404。新导出的再修正一遍反而会把刻意不带版本段的地址错补 /v1。
   */
  api_url_verbatim?: boolean;
}

export interface FeatureTogglesData {
  enabledViews?: string[];
  mobileDashboardItems?: string[];
  mobileTabKeys?: string[];
}

export interface BundleData {
  webdavBackends?: WebDavBackendData[];
  /** 通用同步源（local / webdav / s3），设置备份文件用 */
  syncBackends?: SyncBackendData[];
  aiModels?: AiModelData[];
  asrConfig?: AsrConfig;
  featureToggles?: FeatureTogglesData;
  /** 界面 / 编辑器偏好（settings store 里可移植的那部分），设置备份文件用 */
  uiPrefs?: Record<string, unknown>;
  /** app_config 里的行为类设置，导入时只认 {@link isPortableConfigKey} 放行的键 */
  appConfig?: Record<string, string>;
}

// ──────────────────────────────────────────────────────────
// 设置备份：app_config 可导出键
// ──────────────────────────────────────────────────────────

/**
 * 可以带去别的设备的 app_config 键。
 *
 * 🔴 导入端也拿它过滤：备份文件是用户从外面选进来的，不能让它写任意键 ——
 * app_config 里还存着启动锁 / 隐藏笔记 PIN 的哈希、同步时间戳、加密后的备份密码这类
 * 写坏了会锁死或误同步的东西。
 *
 * 不在名单里的（及原因）：
 * - 默认文件夹 / 默认标签 / 日记默认模板 / 文件夹自动导入：存的是本库 id 或本机路径
 * - 启动锁、隐藏笔记 PIN、回收站自动清理：带校验状态或生效时间，必须走各自的服务写
 * - MCP HTTP 端口 / token、更新版本标记、速记草稿、同步时间戳：本机运行状态
 */
const PORTABLE_CONFIG_KEYS = new Set<string>([
  "all_day_reminder_time",
  "start_minimized",
  "window.close_action",
  "update.auto_check",
  "update.install_timing",
  "reminder_sound_enabled",
  "reminder_sound_normal",
  "reminder_sound_urgent",
  "reminder_sound_volume",
  "reminder_sound_repeat",
  "task_recognize_mode",
  "enabled_views",
  "mobile_dashboard_items",
  "mobile_tab_keys",
  "ai_writable",
  "mcp_tool_whitelist",
  "mcp_external_writable",
]);

/** 按前缀放行的键：全局快捷键是 `shortcut.<id>`，id 随功能增加 */
const PORTABLE_CONFIG_PREFIXES = ["shortcut."];

/** 属于密钥的 app_config 键：只在用户勾了「包含密钥」时导出 */
export const SECRET_CONFIG_KEYS = new Set<string>(["web_clip_jina_key"]);

export function isPortableConfigKey(key: string): boolean {
  return (
    PORTABLE_CONFIG_KEYS.has(key) ||
    SECRET_CONFIG_KEYS.has(key) ||
    PORTABLE_CONFIG_PREFIXES.some((p) => key.startsWith(p))
  );
}

export type Envelope =
  | EnvelopeBase<"webdav-backend", WebDavBackendData>
  | EnvelopeBase<"sync-backend", SyncBackendData>
  | EnvelopeBase<"ai-model", AiModelData>
  | EnvelopeBase<"asr-config", AsrConfig>
  | EnvelopeBase<"feature-toggles", FeatureTogglesData>
  | EnvelopeBase<"bundle", BundleData>;

// ──────────────────────────────────────────────────────────
// 序列化（导出）
// ──────────────────────────────────────────────────────────

function envelope<K extends ConfigKind, D>(kind: K, data: D): EnvelopeBase<K, D> {
  return {
    kbConfig: ENVELOPE_VERSION,
    kind,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/**
 * 把后端返回的 SyncBackend 序列化成 webdav-backend envelope（仅 WebDAV）。
 * 移动端（只支持 WebDAV）仍用此函数；桌面端含 local/s3 的场景请用 exportSyncBackend。
 */
export function exportWebDavBackend(b: SyncBackend): Envelope {
  let cfg: WebDavConfig = { url: "", username: "" };
  try {
    cfg = JSON.parse(b.configJson) as WebDavConfig;
  } catch {
    // 静默失败，envelope 里 url/username 为空字串
  }
  return envelope("webdav-backend", {
    name: b.name,
    config: cfg,
  });
}

/**
 * 通用同步源导出：覆盖 local / webdav / s3 三种类型。
 * config 直接取 configJson 解析后的对象，原样带上各类型的敏感字段
 * （webdav 的 password、s3 的 secretKey、local 的 path），
 * 由 ShareConfigModal 顶部的 PIN 加密兜底，避免明文外泄。
 */
export function exportSyncBackend(b: SyncBackend): Envelope {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(b.configJson) as Record<string, unknown>;
  } catch {
    // 静默失败：config 为空对象（对方导入后可在编辑里补全）
  }
  return envelope("sync-backend", {
    kind: b.kind,
    name: b.name,
    config,
  });
}

/**
 * 把 AiModel 序列化（含 api_key）。
 *
 * 🔴 `apiKey` 必须由调用方**显式传入** —— P0-1b 起 `m.api_key` 恒为 null，
 * 明文只能临时调 `aiModelApi.getApiKey(id)` 取。做成必填参数是为了让
 * 每个分享入口都被迫走那一步，而不是静默导出一个没 Key 的空壳。
 */
export function exportAiModel(m: AiModel, apiKey: string | null): Envelope {
  return envelope("ai-model", {
    name: m.name,
    provider: m.provider,
    api_url: m.api_url,
    api_key: apiKey,
    model_id: m.model_id,
    max_context: m.max_context > 0 ? m.max_context : null,
    max_tokens: m.max_tokens,
    limits_source: m.limits_source,
    max_output: m.max_output,
    api_url_verbatim: true,
  });
}

/** 序列化 ASR（语音识别）配置 */
export function exportAsrConfig(cfg: AsrConfig): Envelope {
  return envelope("asr-config", cfg);
}

/** 序列化功能开关（仅 mobile 三个 set） */
export function exportFeatureToggles(opts: FeatureTogglesData): Envelope {
  return envelope("feature-toggles", opts);
}

export function exportBundle(opts: BundleData): Envelope {
  return envelope("bundle", opts);
}

/** 把 envelope 渲染成可粘贴 / 显示在 QR 中的文本 */
export function stringifyEnvelope(env: Envelope, pretty = true): string {
  return JSON.stringify(env, null, pretty ? 2 : 0);
}

/**
 * 用 PIN 加密 envelope，输出 EncryptedEnvelope 的 JSON 字符串。
 * 接收方需要相同 PIN 才能解密。
 */
export async function stringifyEncrypted(
  env: Envelope,
  pin: string,
  pretty = false,
): Promise<string> {
  const plain = stringifyEnvelope(env, false);
  const payload = await encryptWithPin(plain, pin);
  const wrapper: EncryptedEnvelope = {
    kbConfig: ENCRYPTED_VERSION,
    payload,
  };
  return JSON.stringify(wrapper, null, pretty ? 2 : 0);
}

// ──────────────────────────────────────────────────────────
// 反序列化（导入）
// ──────────────────────────────────────────────────────────

export interface ParseError {
  ok: false;
  reason: string;
}
export interface ParseSuccess {
  ok: true;
  envelope: Envelope;
}
export interface ParseEncrypted {
  ok: false;
  encrypted: true;
  /** 后续要让用户输入 PIN，再调 parseEnvelope(text, pin) 解密 */
  reason: "需要 PIN 解密";
}
export type ParseResult = ParseError | ParseSuccess | ParseEncrypted;

function parseInner(text: string): ParseResult {
  if (!text || !text.trim()) {
    return { ok: false, reason: "内容为空" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `JSON 解析失败：${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "不是 JSON 对象" };
  }
  const o = raw as Record<string, unknown>;

  if (o.kbConfig === ENCRYPTED_VERSION) {
    return { ok: false, encrypted: true, reason: "需要 PIN 解密" };
  }
  if (o.kbConfig !== ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: `版本不匹配（期望 ${ENVELOPE_VERSION}，得到 ${o.kbConfig}）`,
    };
  }
  const kind = o.kind;
  if (
    kind !== "webdav-backend" &&
    kind !== "sync-backend" &&
    kind !== "ai-model" &&
    kind !== "asr-config" &&
    kind !== "feature-toggles" &&
    kind !== "bundle"
  ) {
    return { ok: false, reason: `未知配置类型：${String(kind)}` };
  }
  if (!o.data || typeof o.data !== "object") {
    return { ok: false, reason: "data 字段缺失或非对象" };
  }
  return { ok: true, envelope: o as unknown as Envelope };
}

/**
 * 认出 ai.profile（单条 / 打包）就交给后端解析，并映射成本家 ai-model / bundle envelope。
 * 不是 ai.profile 返回 null，交回原流程。
 *
 * 来源如 tauri-cc（智码）/ sigil / reeve 等桌面端。后端已把字段换成 ai_models 口径
 * （服务商按地址反推成预置 key、没给模型名按预置默认补），地址是「原样使用」口径。
 */
async function parseAiProfileEnvelope(text: string): Promise<ParseResult | null> {
  let kind: unknown;
  try {
    kind = (JSON.parse(text) as { kind?: unknown } | null)?.kind;
  } catch {
    return null;
  }
  if (typeof kind !== "string" || !kind.startsWith("ai.profile")) return null;
  try {
    const r = await aiModelApi.parseAiProfile(text);
    const aiModels: AiModelData[] = r.models.map((m) => ({
      name: m.name,
      provider: m.provider,
      api_url: m.api_url,
      api_key: m.api_key,
      model_id: m.model_id,
      api_url_verbatim: true,
    }));
    const exportedAt = new Date().toISOString();
    if (!r.bundle && aiModels.length === 1) {
      return {
        ok: true,
        envelope: { kbConfig: ENVELOPE_VERSION, kind: "ai-model", exportedAt, data: aiModels[0] },
      };
    }
    return {
      ok: true,
      envelope: { kbConfig: ENVELOPE_VERSION, kind: "bundle", exportedAt, data: { aiModels } },
    };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/**
 * 严格解析：可同时处理明文 envelope 和加密 envelope。
 * - 明文 → 直接返回 envelope
 * - 加密但未给 pin → 返回 encrypted: true，提示调用方让用户输 PIN
 * - 加密 + pin → 尝试解密；PIN 错抛 reason
 */
export async function parseEnvelope(
  text: string,
  pin?: string,
): Promise<ParseResult> {
  // 跨软件通用协议 ai.profile（单条 / 打包）：交给后端 crate 解析
  const profile = await parseAiProfileEnvelope(text);
  if (profile) return profile;
  const inner = parseInner(text);
  if (inner.ok) return inner;
  // 不是加密 envelope 就直接传出错误
  if (!("encrypted" in inner)) return inner;
  // 是加密 envelope
  if (!pin) {
    return inner; // ok=false + encrypted=true，让 UI 弹 PIN 输入框
  }
  // 尝试解密
  let outerObj: { payload?: string };
  try {
    outerObj = JSON.parse(text);
  } catch {
    return { ok: false, reason: "外层 JSON 损坏" };
  }
  const payload = outerObj?.payload;
  if (!payload || typeof payload !== "string") {
    return { ok: false, reason: "加密 payload 缺失" };
  }
  let plain: string;
  try {
    plain = await decryptWithPin(payload, pin);
  } catch {
    return { ok: false, reason: "PIN 错误或数据损坏" };
  }
  return parseInner(plain);
}

// ──────────────────────────────────────────────────────────
// 导入执行（写入后端）
// ──────────────────────────────────────────────────────────

export interface ImportSummary {
  /** 成功导入的同步源数量（webdav-backend 旧格式 + sync-backend 新格式合并计数） */
  syncBackends: number;
  aiModels: number;
  asrConfig: boolean;
  featureToggles: boolean;
  /** 写入的界面 / 编辑器偏好项数 */
  uiPrefs: number;
  /** 写入的 app_config 行为设置项数 */
  appConfig: number;
  /** 因本机已有同名项而跳过的（形如「模型服务：DeepSeek」） */
  skipped: string[];
  errors: string[];
  /** 导入成功但需要提醒的（如 Anthropic 协议的配置） */
  warnings: string[];
}

export interface ApplyOptions {
  /**
   * 本机已有同名的模型服务 / 同步源时跳过不建。
   * 设置备份恢复要开：同一份备份导两次不该冒出两套重复配置。
   * 扫码 / 粘贴分享不开：保持原行为，用户分享一条就是想加一条。
   */
  skipExistingNames?: boolean;
}

/** 把 envelope 真正写到后端。返回成功统计 + 失败原因列表 */
export async function applyEnvelope(
  env: Envelope,
  opts: ApplyOptions = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    syncBackends: 0,
    aiModels: 0,
    asrConfig: false,
    featureToggles: false,
    uiPrefs: 0,
    appConfig: 0,
    skipped: [],
    errors: [],
    warnings: [],
  };

  switch (env.kind) {
    case "webdav-backend":
      try {
        const input: SyncBackendInput = {
          kind: "webdav",
          name: env.data.name,
          configJson: JSON.stringify(env.data.config),
        };
        await syncV1Api.createBackend(input);
        summary.syncBackends = 1;
      } catch (e) {
        summary.errors.push(`WebDAV 后端创建失败：${e}`);
      }
      break;

    case "sync-backend":
      try {
        const input: SyncBackendInput = {
          kind: env.data.kind,
          name: env.data.name,
          configJson: JSON.stringify(env.data.config),
        };
        await syncV1Api.createBackend(input);
        summary.syncBackends = 1;
      } catch (e) {
        summary.errors.push(`同步源创建失败：${e}`);
      }
      break;

    case "ai-model":
      try {
        let { provider, api_url } = env.data;
        let max_context = env.data.max_context ?? null;
        let limits_source = env.data.limits_source ?? null;
        // 旧版本导出的：地址按旧规则补齐、厂商 id 换成预置 key、历史默认窗口当作未设置
        if (!env.data.api_url_verbatim) {
          const fixed = await aiModelApi.fixLegacy(provider, api_url, max_context);
          provider = fixed.provider;
          api_url = fixed.api_url;
          max_context = fixed.max_context;
          limits_source = max_context !== null ? "user" : null;
        }
        const input: AiModelInput = {
          name: env.data.name,
          provider,
          api_url,
          api_key: env.data.api_key ?? null,
          model_id: env.data.model_id,
          max_context,
          // 老版本导出的包没有这个字段 → undefined = 用服务商默认，与新建同义
          max_tokens: env.data.max_tokens,
          limits_source,
          max_output: env.data.max_output ?? null,
        };
        await aiModelApi.create(input);
        summary.aiModels = 1;
      } catch (e) {
        summary.errors.push(`模型服务创建失败：${e}`);
      }
      break;

    case "asr-config":
      try {
        await asrApi.saveConfig(env.data);
        summary.asrConfig = true;
      } catch (e) {
        summary.errors.push(`语音识别配置写入失败：${e}`);
      }
      break;

    case "feature-toggles":
      try {
        if (env.data.enabledViews) {
          await configApi.set(
            "enabled_views",
            JSON.stringify(env.data.enabledViews),
          );
        }
        if (env.data.mobileDashboardItems) {
          await configApi.set(
            "mobile_dashboard_items",
            JSON.stringify(env.data.mobileDashboardItems),
          );
        }
        if (env.data.mobileTabKeys) {
          await configApi.set(
            "mobile_tab_keys",
            JSON.stringify(env.data.mobileTabKeys),
          );
        }
        summary.featureToggles = true;
      } catch (e) {
        summary.errors.push(`功能开关写入失败：${e}`);
      }
      break;

    case "bundle":
      await applyBundle(env.data, opts, summary);
      break;
  }

  return summary;
}

/** 合并子 envelope 的导入结果 */
function mergeSummary(into: ImportSummary, sub: ImportSummary) {
  into.syncBackends += sub.syncBackends;
  into.aiModels += sub.aiModels;
  into.asrConfig ||= sub.asrConfig;
  into.featureToggles ||= sub.featureToggles;
  into.uiPrefs += sub.uiPrefs;
  into.appConfig += sub.appConfig;
  into.skipped.push(...sub.skipped);
  into.errors.push(...sub.errors);
  into.warnings.push(...sub.warnings);
}

/** 完整配置包：逐项递归成单条 envelope 复用上面的写入逻辑 */
async function applyBundle(data: BundleData, opts: ApplyOptions, summary: ImportSummary) {
  const sub = (kind: Exclude<ConfigKind, "bundle">, d: unknown) =>
    applyEnvelope({
      kbConfig: ENVELOPE_VERSION,
      kind,
      exportedAt: new Date().toISOString(),
      data: d,
    } as Envelope);

  // 同名跳过：先各取一次现有名字，导入过程中新建的也记进去（同一份包里有重名时只建第一个）
  let backendNames: Set<string> | null = null;
  let modelNames: Set<string> | null = null;
  if (opts.skipExistingNames) {
    try {
      backendNames = new Set((await syncV1Api.listBackends()).map((b) => b.name));
      modelNames = new Set((await aiModelApi.list()).map((m) => m.name));
    } catch (e) {
      summary.errors.push(`读取现有配置失败，未导入同步源和模型服务：${e}`);
      backendNames = null;
      modelNames = null;
      data = { ...data, webdavBackends: undefined, syncBackends: undefined, aiModels: undefined };
    }
  }

  const backends: { kind: "webdav-backend" | "sync-backend"; name: string; data: WebDavBackendData | SyncBackendData }[] = [
    ...(data.webdavBackends ?? []).map((b) => ({ kind: "webdav-backend" as const, name: b.name, data: b })),
    ...(data.syncBackends ?? []).map((b) => ({ kind: "sync-backend" as const, name: b.name, data: b })),
  ];
  for (const b of backends) {
    if (backendNames?.has(b.name)) {
      summary.skipped.push(`同步源：${b.name}`);
      continue;
    }
    mergeSummary(summary, await sub(b.kind, b.data));
    backendNames?.add(b.name);
  }
  for (const m of data.aiModels ?? []) {
    if (modelNames?.has(m.name)) {
      summary.skipped.push(`模型服务：${m.name}`);
      continue;
    }
    mergeSummary(summary, await sub("ai-model", m));
    modelNames?.add(m.name);
  }
  if (data.asrConfig) {
    mergeSummary(summary, await sub("asr-config", data.asrConfig));
  }
  if (data.featureToggles) {
    mergeSummary(summary, await sub("feature-toggles", data.featureToggles));
  }

  if (data.appConfig) {
    let wrote = 0;
    for (const [key, value] of Object.entries(data.appConfig)) {
      if (!isPortableConfigKey(key) || typeof value !== "string") continue;
      try {
        await configApi.set(key, value);
        wrote += 1;
      } catch (e) {
        summary.errors.push(`设置项 ${key} 写入失败：${e}`);
      }
    }
    summary.appConfig += wrote;
    // 功能模块开关在内存里有一份，重新读一次界面才跟着变
    if (wrote > 0 && "enabled_views" in data.appConfig) {
      await useAppStore.getState().loadEnabledViews().catch(() => {});
    }
  }
  if (data.uiPrefs && typeof data.uiPrefs === "object") {
    try {
      summary.uiPrefs += await applyImportedPrefs(data.uiPrefs);
    } catch (e) {
      summary.errors.push(`界面偏好写入失败：${e}`);
    }
  }
}

/** envelope kind → 给用户看的中文标签 */
export const KIND_LABELS: Record<ConfigKind, string> = {
  "webdav-backend": "WebDAV 同步",
  "sync-backend": "同步源",
  "ai-model": "模型服务",
  "asr-config": "语音识别（ASR）",
  "feature-toggles": "功能开关",
  "bundle": "完整配置包",
};

// ──────────────────────────────────────────────────────────
// 跨软件通用协议：ai.profile 输出
// ──────────────────────────────────────────────────────────

/**
 * 把本家模型配置输出为 `ai.profile` 通用协议文本（明文，规范写法），由后端 crate 生成。
 *
 * 🔴 含明文密钥，只在用户点「复制为 ai.profile」时调用。
 * 上下文窗口等限额不输出：ai.profile 协议没有约定这些字段。
 */
export function stringifyAsAiProfile(
  m: Pick<AiModelData, "name" | "provider" | "api_url" | "api_key" | "model_id">,
): Promise<string> {
  return aiModelApi.toAiProfile({
    name: m.name,
    apiUrl: m.api_url,
    apiKey: m.api_key ?? null,
    modelId: m.model_id,
    // 协议跟着预置 key 走：Claude 中转导出后在别的软件里仍是 Anthropic 协议
    provider: m.provider,
  });
}
