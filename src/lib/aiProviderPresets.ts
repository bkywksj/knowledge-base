/**
 * AI 服务商预置 —— 前端适配层。**数据源是 ai-profile crate**，这里不再维护任何清单。
 *
 * 🔴 加服务商 / 加模型 / 改默认 model / 改地址 → 去 ai-profile 仓库
 * （`E:/my/桌面软件tauri/ai-profile`）改，本项目只升依赖版本。技能 `ai-profile-integration`。
 *
 * 此前这里是 24 家、5 张平行表的本地副本：加一家要同时改 5 处，模型候选停在旧代，
 * 与 sigil / reeve 的清单各自漂移。接入 crate 后删掉，统一由后端
 * `list_ai_provider_presets` 暴露（只含本项目能说的 OpenAI 兼容协议）。
 *
 * # 本项目的两种对话协议
 *
 * `services/ai.rs`：`ollama` 走原生 `/api/chat`，其余一律 OpenAI 兼容 `chat/completions`。
 * 没有 Anthropic 原生 `/v1/messages`，所以 crate 里 Anthropic 协议的预置不出现在下拉里。
 */
import { useEffect, useState } from "react";
import { aiModelApi } from "@/lib/api";
import type { AiProviderPreset } from "@/types";

/** 「其它 OpenAI 兼容（自定义接口地址）」的预置 key —— 列表都不匹配时落到这档 */
export const CUSTOM_PROVIDER_KEY = "openai_compatible_custom";

let cache: Promise<AiProviderPreset[]> | null = null;

/** 取预置清单（进程内只请求一次；失败不缓存，下次重试） */
export function loadAiProviderPresets(): Promise<AiProviderPreset[]> {
  if (!cache) {
    cache = aiModelApi.listPresets().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}

/** 组件里用：首次渲染是空数组，加载完自动刷新 */
export function useAiProviderPresets(): AiProviderPreset[] {
  const [list, setList] = useState<AiProviderPreset[]>([]);
  useEffect(() => {
    let alive = true;
    loadAiProviderPresets()
      .then((l) => alive && setList(l))
      .catch((e) => console.warn("[ai] 读取服务商预置失败", e));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

export function findPreset(
  list: AiProviderPreset[],
  key: string | undefined,
): AiProviderPreset | undefined {
  return key ? list.find((p) => p.key === key) : undefined;
}

/** 列表 / 标签里显示的服务商名；key 不认识时原样显示 */
export function providerLabel(list: AiProviderPreset[], key: string): string {
  return findPreset(list, key)?.label ?? key;
}

/** 模型输入框的候选 */
export function modelOptions(p: AiProviderPreset | undefined): { value: string; label: string }[] {
  return (p?.models ?? []).map((m) => ({ value: m.value, label: m.label }));
}

/**
 * 模型输入框占位符：由该档预置的前三个模型拼出。
 * 写死一串 id 的话，换代时改了预置却漏改这里 —— reeve 就停在已退役的一代上过。
 */
export function modelPlaceholder(p: AiProviderPreset | undefined): string {
  const ids = (p?.models ?? []).slice(0, 3).map((m) => m.value);
  return ids.length ? `如: ${ids.join(" / ")}` : "填写服务商文档里的模型名";
}

/** 某个模型在预置里登记的静态窗口（只用于占位提示「不填会用什么」） */
export function presetContextWindow(
  p: AiProviderPreset | undefined,
  modelId: string | undefined,
): number | null {
  const m = p?.models.find((x) => x.value === (modelId ?? "").trim());
  return m?.contextWindow ?? null;
}

export interface ProviderOption {
  value: string;
  /** 选中后输入框里只显示名字（Select 的 optionLabelProp="title"） */
  title: string;
  /** 名字 + 要点一起参与搜索：搜「本地」能搜到 Ollama */
  searchText: string;
  label: string;
  hint: string | null;
}

/**
 * 按分组切成 antd 的 optGroup。
 *
 * crate 保证同组连续（守卫测试 `preset_groups_are_contiguous`），顺序扫一遍、
 * 遇到新分组就开一组即可，不会切出重复的分组标题。
 */
export function groupProviderOptions(
  list: AiProviderPreset[],
): { label: string; title: string; options: ProviderOption[] }[] {
  const groups: { label: string; title: string; options: ProviderOption[] }[] = [];
  for (const p of list) {
    if (groups.length === 0 || groups[groups.length - 1].label !== p.groupLabel) {
      groups.push({ label: p.groupLabel, title: p.groupLabel, options: [] });
    }
    groups[groups.length - 1].options.push({
      value: p.key,
      title: p.label,
      searchText: `${p.label} ${p.hint ?? ""} ${p.key}`.toLowerCase(),
      label: p.label,
      hint: p.hint,
    });
  }
  return groups;
}
