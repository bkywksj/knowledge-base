import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  DEFAULT_URLS,
  MODEL_ID_PLACEHOLDERS,
  MODEL_PRESETS,
  PROVIDER_NAME_MAP,
} from "./aiProviderPresets";

/**
 * 这份预置表有 5 个平行的 Record，加一家新服务要同时改 5 处 ——
 * 漏一处的表现是"选了某个 provider，地址栏空白 / 没有模型候选 / 名字回退成 id"，
 * 而且不报错、只在用户实际点到那一项时才发现。
 *
 * 这些用例就是替人记住那 5 处。
 */
describe("AI provider 预置表完整性", () => {
  const ids = PROVIDERS.map((p) => p.value);

  it("provider 值不重复", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条都有 label 和 desc（desc 是下拉副文本，别把说明挤进 label 括号）", () => {
    for (const p of PROVIDERS) {
      expect(p.label.trim(), `${p.value} 缺 label`).not.toBe("");
      expect(p.desc.trim(), `${p.value} 缺 desc`).not.toBe("");
    }
  });

  it.each(ids)("%s 在四个 Record 里都有条目", (id) => {
    expect(DEFAULT_URLS, `${id} 缺 DEFAULT_URLS`).toHaveProperty(id);
    expect(MODEL_ID_PLACEHOLDERS, `${id} 缺 placeholder`).toHaveProperty(id);
    expect(MODEL_PRESETS, `${id} 缺 MODEL_PRESETS`).toHaveProperty(id);
    expect(PROVIDER_NAME_MAP, `${id} 缺 NAME_MAP`).toHaveProperty(id);
  });

  it("Record 里不能有 PROVIDERS 中不存在的孤儿键", () => {
    for (const [name, rec] of [
      ["DEFAULT_URLS", DEFAULT_URLS],
      ["MODEL_ID_PLACEHOLDERS", MODEL_ID_PLACEHOLDERS],
      ["MODEL_PRESETS", MODEL_PRESETS],
      ["PROVIDER_NAME_MAP", PROVIDER_NAME_MAP],
    ] as const) {
      for (const k of Object.keys(rec)) {
        expect(ids, `${name} 里的 ${k} 不在 PROVIDERS 中`).toContain(k);
      }
    }
  });

  it("除自定义端点外都要有默认 baseUrl", () => {
    for (const id of ids) {
      if (id === "custom") {
        // 自定义故意留空 —— 有值反而会误导用户以为该填那个地址
        expect(DEFAULT_URLS[id]).toBe("");
      } else {
        expect(DEFAULT_URLS[id], `${id} 的 baseUrl 为空`).not.toBe("");
      }
    }
  });

  it("baseUrl 不能带 /chat/completions 后缀（后端自己拼）", () => {
    for (const [id, url] of Object.entries(DEFAULT_URLS)) {
      expect(url, `${id} 的 URL 带了 chat/completions`).not.toContain(
        "chat/completions",
      );
      expect(url, `${id} 的 URL 结尾多了斜杠`).not.toMatch(/\/$/);
    }
  });

  it("Claude 与 OpenRouter 是两条独立 provider，指向各自官方地址", () => {
    // 早先它们被混成一条「Claude (经 OpenRouter 等代理)」：
    // 官方 API 反而选不了，OpenRouter 能跑几百个模型也看不出来
    expect(ids).toContain("claude");
    expect(ids).toContain("openrouter");
    expect(DEFAULT_URLS.claude).toContain("api.anthropic.com");
    expect(DEFAULT_URLS.openrouter).toContain("openrouter.ai");
  });

  it("必须保留自定义端点这个兜底项", () => {
    expect(ids).toContain("custom");
  });
});
