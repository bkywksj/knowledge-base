import { describe, it, expect } from "vitest";
import { looksLikeCode } from "./pasteCodeHeuristic";

describe("粘贴判定：终端输出必须包成代码块", () => {
  it("SSH 会话 + 程序启动横幅（用户实际踩到的坑）", () => {
    // 走 Markdown 解析会变成：*unofficial* → 斜体、\---/ → ---/、多空格折叠
    const text = [
      "[NAS_DR@NAS-DR ~]$",
      "[NAS_DR@NAS-DR ~]$ # ④ 等启动并看日志",
      "[NAS_DR@NAS-DR ~]$ sleep 8",
      "[NAS_DR@NAS-DR ~]$ docker logs vaultwarden --tail 15",
      "|--------------------------------------------------------------------|",
      "| This is an *unofficial* Bitwarden implementation, DO NOT use the   |",
      "| official channels to report bugs/features, regardless of client.   |",
      "| Send usage/configuration questions or feature requests to:         |",
      "|   https://github.com/dani-garcia/vaultwarden/discussions or        |",
      "|   https://vaultwarden.discourse.group/                             |",
      "| Report suspected bugs/issues in the software itself at:            |",
      "|   https://github.com/dani-garcia/vaultwarden/issues/new            |",
      "\\--------------------------------------------------------------------/",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });

  it("只有横幅、没有提示符行（ASCII 框图本身就够判定）", () => {
    const text = [
      "|--------------------------------------------------------------------|",
      "| This is an *unofficial* Bitwarden implementation, DO NOT use the   |",
      "| official channels to report bugs/features, regardless of client.   |",
      "\\--------------------------------------------------------------------/",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });

  it("mysql / docker 风格的 +---+ 表格输出", () => {
    const text = [
      "+----+----------+",
      "| id | name     |",
      "+----+----------+",
      "|  1 | vaultwd  |",
      "|  2 | nginx    |",
      "+----+----------+",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });

  it("各家 shell 提示符", () => {
    expect(
      looksLikeCode("user@ubuntu:~/app$ ls -la\nuser@ubuntu:~/app$ cd src"),
    ).toBe(true);
    expect(
      looksLikeCode("PS C:\\Users\\me> git status\nPS C:\\Users\\me> git log"),
    ).toBe(true);
    expect(looksLikeCode("$ npm install\n$ npm run dev")).toBe(true);
    expect(looksLikeCode(">>> import os\n>>> os.getcwd()")).toBe(true);
  });

  it("root 提示符带 [..] 前缀时照样识别（与 Markdown 标题无歧义）", () => {
    expect(
      looksLikeCode("[root@host ~]# systemctl restart nginx\n[root@host ~]# exit"),
    ).toBe(true);
  });
});

describe("粘贴判定：代码仍按原有规则识别", () => {
  it("缩进结构明显的 JS", () => {
    const text = [
      "function foo() {",
      "  const a = 1;",
      "  return a + 1;",
      "}",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });

  it("C 注释横幅不会被当成无序列表", () => {
    const text = [
      "/*",
      " * 说明文字",
      " * 第二行说明",
      " */",
      "int main(void) { return 0; }",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(true);
  });
});

describe("粘贴判定：Markdown 内容不能被抢走", () => {
  it("真 Markdown 表格（有分隔行 + 多列）", () => {
    const text = [
      "| 名称 | 说明 |",
      "| --- | --- |",
      "| alpha | 第一个 |",
      "| bravo | 第二个 |",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(false);
  });

  it("连着两张 Markdown 表格 —— 分隔行不能凑成「框图上下边框」", () => {
    const text = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "| c | d |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(false);
  });

  it("带对齐冒号的表格分隔行", () => {
    const text = [
      "| 左 | 中 | 右 |",
      "| :--- | :---: | ---: |",
      "| 1 | 2 | 3 |",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(false);
  });

  it("普通 Markdown 文档", () => {
    expect(looksLikeCode("# 标题\n正文一段话。\n- 列表项")).toBe(false);
    expect(looksLikeCode("> 引用一\n> 引用二\n普通正文")).toBe(false);
    expect(looksLikeCode("1. 第一步\n2. 第二步\n3. 第三步")).toBe(false);
  });

  it("含代码围栏的 Markdown 文档 —— 围栏里的命令行示例不算终端输出", () => {
    const text = [
      "安装步骤如下：",
      "",
      "```bash",
      "$ npm install",
      "$ npm run dev",
      "```",
      "",
      "然后打开浏览器。",
    ].join("\n");
    expect(looksLikeCode(text)).toBe(false);
  });

  it("普通中文段落", () => {
    expect(looksLikeCode("今天开会讨论了三件事。\n第一件是发版节奏。")).toBe(
      false,
    );
  });

  it("单行一律不处理（交给默认粘贴 / 场景 G 的路径分支）", () => {
    expect(looksLikeCode("[NAS_DR@NAS-DR ~]$ docker ps")).toBe(false);
    expect(looksLikeCode("")).toBe(false);
    expect(looksLikeCode("   ")).toBe(false);
  });
});
