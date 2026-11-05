import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAntdComponents, getAntdTokens, getThemeCategory, normalizeThemeMode, themes } from "./tokens";

describe("normalizeThemeMode", () => {
  it("现有主题 id 原样返回", () => {
    expect(normalizeThemeMode("light-lilac")).toBe("light-lilac");
    expect(normalizeThemeMode("dark-ember")).toBe("dark-ember");
    for (const t of themes) expect(normalizeThemeMode(t.key)).toBe(t.key);
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
    for (const t of themes.filter((x) => x.category === "light")) {
      expect(getAntdTokens(t.key).colorText.toLowerCase()).not.toBe("#000000");
    }
  });

  it("主题 id 前缀与分类一致（getThemeCategory / 旧 id 归一都靠前缀判断）", () => {
    for (const t of themes) expect(getThemeCategory(t.key)).toBe(t.category);
  });

  it("每套主题在 themes.css 里都有变量块、主色渐变和面板底色", () => {
    const css = readFileSync(resolve(__dirname, "../styles/themes.css"), "utf8");
    for (const t of themes) {
      const blocks = css.split(`[data-theme="${t.key}"] {`).slice(1).map((b) => b.slice(0, b.indexOf("}")));
      const all = blocks.join("\n");
      for (const v of ["--kb-primary:", "--kb-body-bg:", "--kb-input-bg:", "--kb-grad:", "--kb-surface-base:"]) {
        expect(all, `${t.key} 缺 ${v}`).toContain(v);
      }
      // CSS 主色与 antd 主色一致（两处要一起改）
      expect(all.toLowerCase()).toContain(`--kb-primary: ${getAntdTokens(t.key).colorPrimary.toLowerCase()};`);
    }
  });
});
