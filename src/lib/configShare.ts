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
 * 输入：parseInner 同时识别本家 kbConfig envelope 和外部 ai.profile envelope，
 *       后者会被自动映射为本家 ai-model envelope，复用现有 applyEnvelope 流程。
 * 输出：stringifyAsAiProfile 将本家 AiModel 输出为 ai.profile 文本，
 *       方便粘贴到 tauri-cc 等其他软件。
 */
export const AI_PROFILE_KIND_SINGLE = "ai.profile";
export const AI_PROFILE_KIND_BUNDLE = "ai.profile.bundle";
export const AI_PROFILE_VERSION = 1;

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
  max_context?: number;
  /** 单次回答 token 上限；null / 缺省 = 用服务商默认 */
  max_tokens?: number | null;
}

export interface FeatureTogglesData {
  enabledViews?: string[];
  mobileDashboardItems?: string[];
  mobileTabKeys?: string[];
}

export interface BundleData {
  webdavBackends?: WebDavBackendData[];
  aiModels?: AiModelData[];
  asrConfig?: AsrConfig;
  featureToggles?: FeatureTogglesData;
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
    max_context: m.max_context,
    max_tokens: m.max_tokens,
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

  // ─── 跨软件通用协议：ai.profile（单条） ───
  // 来源如 tauri-cc 等其他桌面端。识别后自动映射为本家 ai-model envelope，
  // 落库走原有 applyEnvelope -> aiModelApi.create 路径。
  if (
    o.kind === AI_PROFILE_KIND_SINGLE &&
    o.v === AI_PROFILE_VERSION &&
    o.data &&
    typeof o.data === "object"
  ) {
    const d = o.data as Record<string, unknown>;
    // baseURL（标准）/ baseUrl / base_url 都接受，最大化跨家兼容
    const baseURL = String(d.baseURL ?? d.baseUrl ?? d.base_url ?? "");
    const name = typeof d.name === "string" ? d.name : "";
    const provider = typeof d.provider === "string" ? d.provider : "";
    const apiKey = typeof d.apiKey === "string" ? d.apiKey : "";
    const model = typeof d.model === "string" ? d.model : "";
    if (!name || !provider || !model) {
      return {
        ok: false,
        reason: "ai.profile 协议缺少必填字段（name / provider / model）",
      };
    }
    const aiModel: AiModelData = {
      name,
      provider,
      api_url: baseURL,
      api_key: apiKey || null,
      model_id: model,
    };
    return {
      ok: true,
      envelope: {
        kbConfig: ENVELOPE_VERSION,
        kind: "ai-model",
        exportedAt: new Date().toISOString(),
        data: aiModel,
      },
    };
  }

  // ─── 跨软件通用协议：ai.profile.bundle（多条） ───
  // 内层 data 为 SyncDataPayload，字段保持 snake_case（base_url / api_key / model）。
  // 自动跳过 auth_type === "oauth" 的档案（与设备绑定，跨实例无意义）。
  if (
    o.kind === AI_PROFILE_KIND_BUNDLE &&
    o.v === AI_PROFILE_VERSION &&
    o.data &&
    typeof o.data === "object"
  ) {
    const inner = o.data as Record<string, unknown>;
    const list = Array.isArray(inner.api_profiles) ? (inner.api_profiles as unknown[]) : [];
    const aiModels: AiModelData[] = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const pp = p as Record<string, unknown>;
      if (pp.auth_type === "oauth") continue; // OAuth 档案不跨实例
      const name = typeof pp.name === "string" ? pp.name : "";
      const provider = typeof pp.provider === "string" ? pp.provider : "";
      const api_url = typeof pp.base_url === "string" ? pp.base_url : "";
      const api_key = typeof pp.api_key === "string" ? pp.api_key : null;
      const model_id = typeof pp.model === "string" ? pp.model : "";
      if (!name || !provider || !model_id) continue;
      aiModels.push({ name, provider, api_url, api_key, model_id });
    }
    if (aiModels.length === 0) {
      return {
        ok: false,
        reason: "ai.profile.bundle 中未发现可导入的 AI 档案",
      };
    }
    return {
      ok: true,
      envelope: {
        kbConfig: ENVELOPE_VERSION,
        kind: "bundle",
        exportedAt: new Date().toISOString(),
        data: { aiModels },
      },
    };
  }

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
 * 严格解析：可同时处理明文 envelope 和加密 envelope。
 * - 明文 → 直接返回 envelope
 * - 加密但未给 pin → 返回 encrypted: true，提示调用方让用户输 PIN
 * - 加密 + pin → 尝试解密；PIN 错抛 reason
 */
export async function parseEnvelope(
  text: string,
  pin?: string,
): Promise<ParseResult> {
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
  errors: string[];
}

/** 把 envelope 真正写到后端。返回成功统计 + 失败原因列表 */
export async function applyEnvelope(env: Envelope): Promise<ImportSummary> {
  const summary: ImportSummary = {
    syncBackends: 0,
    aiModels: 0,
    asrConfig: false,
    featureToggles: false,
    errors: [],
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
        const input: AiModelInput = {
          name: env.data.name,
          provider: env.data.provider,
          api_url: env.data.api_url,
          api_key: env.data.api_key ?? null,
          model_id: env.data.model_id,
          max_context: env.data.max_context,
          // 老版本导出的包没有这个字段 → undefined = 用服务商默认，与新建同义
          max_tokens: env.data.max_tokens,
        };
        await aiModelApi.create(input);
        summary.aiModels = 1;
      } catch (e) {
        summary.errors.push(`AI 模型创建失败：${e}`);
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
      // 递归调用每个子配置
      if (env.data.webdavBackends) {
        for (const b of env.data.webdavBackends) {
          const sub = await applyEnvelope({
            kbConfig: ENVELOPE_VERSION,
            kind: "webdav-backend",
            exportedAt: new Date().toISOString(),
            data: b,
          });
          summary.syncBackends += sub.syncBackends;
          summary.errors.push(...sub.errors);
        }
      }
      if (env.data.aiModels) {
        for (const m of env.data.aiModels) {
          const sub = await applyEnvelope({
            kbConfig: ENVELOPE_VERSION,
            kind: "ai-model",
            exportedAt: new Date().toISOString(),
            data: m,
          });
          summary.aiModels += sub.aiModels;
          summary.errors.push(...sub.errors);
        }
      }
      if (env.data.asrConfig) {
        const sub = await applyEnvelope({
          kbConfig: ENVELOPE_VERSION,
          kind: "asr-config",
          exportedAt: new Date().toISOString(),
          data: env.data.asrConfig,
        });
        summary.asrConfig = sub.asrConfig;
        summary.errors.push(...sub.errors);
      }
      if (env.data.featureToggles) {
        const sub = await applyEnvelope({
          kbConfig: ENVELOPE_VERSION,
          kind: "feature-toggles",
          exportedAt: new Date().toISOString(),
          data: env.data.featureToggles,
        });
        summary.featureToggles = sub.featureToggles;
        summary.errors.push(...sub.errors);
      }
      break;
  }

  return summary;
}

/** envelope kind → 给用户看的中文标签 */
export const KIND_LABELS: Record<ConfigKind, string> = {
  "webdav-backend": "WebDAV 同步",
  "sync-backend": "同步源",
  "ai-model": "AI 模型",
  "asr-config": "语音识别（ASR）",
  "feature-toggles": "功能开关",
  "bundle": "完整配置包",
};

// ──────────────────────────────────────────────────────────
// 跨软件通用协议：ai.profile 输出
// ──────────────────────────────────────────────────────────

/**
 * 把本家 AiModel 输出为 `ai.profile` 通用协议文本（明文，camelCase）。
 *
 * 字段映射：
 *   - api_url   → baseURL（大写 URL，匹配 OpenAI-compatible 客户端主流命名）
 *   - api_key   → apiKey
 *   - model_id  → model
 *   - max_context → 不输出（ai.profile 协议未约定此字段，由各家自行扩展）
 */
export function stringifyAsAiProfile(m: AiModel, pretty = true): string {
  const env = {
    kind: AI_PROFILE_KIND_SINGLE,
    v: AI_PROFILE_VERSION,
    data: {
      name: m.name,
      provider: m.provider,
      baseURL: m.api_url,
      apiKey: m.api_key ?? "",
      model: m.model_id,
    },
  };
  return JSON.stringify(env, null, pretty ? 2 : 0);
}
