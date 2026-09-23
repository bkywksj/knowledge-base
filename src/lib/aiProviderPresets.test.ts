import { describe, it, expect } from "vitest";
import { groupProviderOptions, modelPlaceholder, presetContextWindow } from "./aiProviderPresets";
import type { AiProviderPreset } from "@/types";

/**
 * 预置数据本身归 ai-profile crate（它有自己的守卫测试：分组连续、地址带版本段、默认模型在清单里…），
 * 这里只测前端适配：分组切分、占位符、静态窗口查找。
 */
function preset(key: string, group: string, models: string[] = []): AiProviderPreset {
  return {
    key,
    groupKey: `g.${group}`,
    groupLabel: group,
    label: key.toUpperCase(),
    hint: `${key} 的要点`,
    baseUrl: `https://${key}.example.com/v1`,
    model: models[0] ?? "",
    models: models.map((m) => ({ value: m, label: m, contextWindow: m === "big" ? 1000000 : null, maxOutput: null })),
    isLocal: key === "ollama",
    protocol: key === "claude_code" ? "anthropic" : "openai_compatible",
  };
}

describe("aiProviderPresets 适配层", () => {
  const list = [
    preset("deepseek", "国内", ["deepseek-flash", "deepseek-pro"]),
    preset("zhipu", "国内"),
    preset("openrouter", "国际", ["a", "b", "c", "d"]),
    preset("ollama", "本地"),
  ];

  it("按连续分组切 optGroup，不重复开组", () => {
    const g = groupProviderOptions(list);
    expect(g.map((x) => x.label)).toEqual(["国内", "国际", "本地"]);
    expect(g[0].options.map((o) => o.value)).toEqual(["deepseek", "zhipu"]);
  });

  it("副文本参与搜索", () => {
    const opt = groupProviderOptions(list)[2].options[0];
    expect(opt.searchText).toContain("ollama 的要点");
    expect(opt.title).toBe("OLLAMA");
  });

  it("占位符取前三个模型，空清单给通用提示", () => {
    expect(modelPlaceholder(list[2])).toBe("如: a / b / c");
    expect(modelPlaceholder(list[1])).toBe("填写服务商文档里的模型名");
    expect(modelPlaceholder(undefined)).toBe("填写服务商文档里的模型名");
  });

  it("静态窗口按模型名查，查不到给 null（不猜）", () => {
    const p = preset("x", "g", ["big", "small"]);
    expect(presetContextWindow(p, "big")).toBe(1000000);
    expect(presetContextWindow(p, " big ")).toBe(1000000);
    expect(presetContextWindow(p, "small")).toBeNull();
    expect(presetContextWindow(p, "nope")).toBeNull();
  });
});
