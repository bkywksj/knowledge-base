import { describe, expect, it } from "vitest";
import { getAntdComponents, getAntdTokens, normalizeThemeMode, themes } from "./tokens";

describe("normalizeThemeMode", () => {
  it("现有主题 id 原样返回", () => {
    expect(normalizeThemeMode("light-lilac")).toBe("light-lilac");
    expect(normalizeThemeMode("dark-ember")).toBe("dark-ember");
  });

  it("已下线的旧主题 id 归到同分类的新主题", () => {
    for (const old of ["light-glass", "light-warm", "light-jade"]) {
      expect(normalizeThemeMode(old)).toBe("light-lilac");
    }
    for (const old of ["dark-starry", "dark-mocha"]) {
      expect(normalizeThemeMode(old)).toBe("dark-ember");
    }
  });

  it("没存过 / 存了怪值时返回 null，调用方保持默认", () => {
    expect(normalizeThemeMode(undefined)).toBeNull();
    expect(normalizeThemeMode(null)).toBeNull();
    expect(normalizeThemeMode(42)).toBeNull();
    expect(normalizeThemeMode("")).toBeNull();
    expect(normalizeThemeMode("sepia")).toBeNull();
  });
});

describe("主题令牌", () => {
  it("每套主题都有 antd token 和组件覆盖，且按钮无投影", () => {
    for (const t of themes) {
      expect(getAntdTokens(t.key).colorPrimary).toBeTruthy();
      expect(getAntdComponents(t.key).Button.primaryShadow).toBe("none");
      expect(getAntdComponents(t.key).Button.defaultShadow).toBe("none");
    }
  });

  it("亮色主题的文字色不用纯黑", () => {
    expect(getAntdTokens("light-lilac").colorText.toLowerCase()).not.toBe("#000000");
  });
});
