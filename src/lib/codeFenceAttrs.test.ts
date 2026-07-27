import { describe, it, expect } from "vitest";
import {
  codeFenceInfoToDataAttrs,
  fenceInfoHasNoLanguage,
} from "@/components/editor/CodeBlockEnhanced";

/**
 * 「代码块命名保存不了」的回归测试。
 *
 * 根因：tiptap-markdown 走「markdown-it 渲染 HTML → 解析进编辑器」，而 markdown-it 默认的
 * fence 渲染只取 info 首词当语言名（输出 class="language-xxx"），title/fontSize/wrap/
 * no-line-numbers 全被丢弃 —— 存进 .md 了，读回来就没了。
 *
 * 修复是在 <pre> 上补 data-*，由各 attr 的 parseHTML 接住。这里锁住那段转换。
 */
describe("codeFenceInfoToDataAttrs · 基础", () => {
  it("只有语言名时不产生任何 data-*", () => {
    expect(codeFenceInfoToDataAttrs("python")).toBe("");
  });

  it("空 info / 纯空白不产生 data-*", () => {
    expect(codeFenceInfoToDataAttrs("")).toBe("");
    expect(codeFenceInfoToDataAttrs("   ")).toBe("");
  });

  it("提取 title（本次 bug 的主角）", () => {
    expect(codeFenceInfoToDataAttrs('python title="启动脚本"')).toBe(
      ' data-title="启动脚本"',
    );
  });

  it("四个属性齐活，顺序稳定", () => {
    expect(
      codeFenceInfoToDataAttrs('ts title="工具函数" fontSize=14 wrap no-line-numbers'),
    ).toBe(' data-title="工具函数" data-font-size="14" data-wrap="true" data-line-numbers="false"');
  });

  it("只有 wrap / no-line-numbers 也能单独生效", () => {
    expect(codeFenceInfoToDataAttrs("bash wrap")).toBe(' data-wrap="true"');
    expect(codeFenceInfoToDataAttrs("bash no-line-numbers")).toBe(
      ' data-line-numbers="false"',
    );
  });

  it("没有语言名、只有 attrs 时同样可解析", () => {
    expect(codeFenceInfoToDataAttrs(' title="无语言"')).toBe(' data-title="无语言"');
  });
});

describe("codeFenceInfoToDataAttrs · 转义（防标签注入）", () => {
  it("title 里的双引号被转义，不会截断 <pre> 标签", () => {
    const out = codeFenceInfoToDataAttrs('python title="他说\\"你好\\""');
    expect(out).toContain("&quot;");
    // 转义后不得出现能提前闭合属性的裸双引号
    expect(out.slice(' data-title="'.length, -1)).not.toContain('"');
  });

  it("title 里的尖括号被转义，无法注入标签", () => {
    const out = codeFenceInfoToDataAttrs('python title="<script>x</script>"');
    expect(out).toBe(
      ' data-title="&lt;script&gt;x&lt;/script&gt;"',
    );
    expect(out).not.toContain("<script>");
  });

  it("& 先转义，不会产生双重转义歧义", () => {
    expect(codeFenceInfoToDataAttrs('python title="A&B"')).toBe(
      ' data-title="A&amp;B"',
    );
  });
});

/**
 * 「命名串进语言框」分支：没选语言时 info 形如 ` title="X"`，markdown-it 会把首词整个
 * 当语言名 → class="language-title=&quot;X&quot;" → 语言下拉显示一串 title="..."，
 * 命名框反而是空的。判定为"无语言"后要把这个假 class 删掉。
 */
describe("fenceInfoHasNoLanguage · 判定首词是属性还是语言名", () => {
  it("正常语言名 → 有语言", () => {
    expect(fenceInfoHasNoLanguage("python")).toBe(false);
    expect(fenceInfoHasNoLanguage('python title="X"')).toBe(false);
  });

  it("只有命名（中文不含空格，用户实际踩到的形态）→ 无语言", () => {
    expect(fenceInfoHasNoLanguage(' title="一次性查看所有数据库的默认字符集"')).toBe(true);
  });

  it("命名含空格（会被 markdown-it 截断成 language-title=&quot;工具）→ 无语言", () => {
    expect(fenceInfoHasNoLanguage(' title="工具 函数"')).toBe(true);
  });

  it("只有 wrap / no-line-numbers / fontSize → 无语言", () => {
    expect(fenceInfoHasNoLanguage(" wrap")).toBe(true);
    expect(fenceInfoHasNoLanguage(" no-line-numbers")).toBe(true);
    expect(fenceInfoHasNoLanguage(" fontSize=14")).toBe(true);
  });

  it("空 info → 不当作无语言（markdown-it 本就不加 class，无需处理）", () => {
    expect(fenceInfoHasNoLanguage("")).toBe(false);
    expect(fenceInfoHasNoLanguage("   ")).toBe(false);
  });

  it("语言名恰好以 wrap 开头（wrapper）不误判", () => {
    expect(fenceInfoHasNoLanguage("wrapper")).toBe(false);
  });
});

describe("codeFenceInfoToDataAttrs · 脏值不产出属性", () => {
  it("fontSize 非法（0 / 负数 / 非数字）时忽略", () => {
    expect(codeFenceInfoToDataAttrs("python fontSize=0")).toBe("");
    expect(codeFenceInfoToDataAttrs("python fontSize=abc")).toBe("");
  });

  it("wrap 作为其它词的一部分不误命中", () => {
    // "wrapper" 不是独立 keyword，不应产生 data-wrap
    expect(codeFenceInfoToDataAttrs("python wrapper")).toBe("");
  });
});
