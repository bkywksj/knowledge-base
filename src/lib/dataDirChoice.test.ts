import { describe, expect, it } from "vitest";
import type { DataDirInspect } from "@/types";
import { defaultMoveChoice, describeInspect, migrationOf } from "./dataDirChoice";

const inspect = (o: Partial<DataDirInspect>): DataDirInspect => ({
  hasDb: true,
  noteCount: 10,
  sizeBytes: 2 * 1024 * 1024,
  modifiedAt: "2026-11-01 09:35:16",
  ...o,
});

describe("defaultMoveChoice", () => {
  it("目标没有数据：默认迁移", () => {
    expect(defaultMoveChoice(inspect({ hasDb: false, noteCount: null }))).toBe("auto");
  });

  it("目标有笔记：默认直接使用目标，不迁移", () => {
    expect(defaultMoveChoice(inspect({ noteCount: 1 }))).toBe("useTarget");
  });

  it("目标读不出来：按可能有数据对待，不默认替换", () => {
    expect(defaultMoveChoice(inspect({ noteCount: null }))).toBe("useTarget");
  });

  it("目标明确 0 篇：默认替换", () => {
    expect(defaultMoveChoice(inspect({ noteCount: 0 }))).toBe("replace");
  });
});

describe("migrationOf", () => {
  it("只有 replace 才放行覆盖目标", () => {
    expect(migrationOf("replace")).toEqual({ migrate: true, replaceExisting: true });
    expect(migrationOf("auto")).toEqual({ migrate: true, replaceExisting: false });
  });

  it("useTarget / manual 不走迁移", () => {
    expect(migrationOf("useTarget").migrate).toBe(false);
    expect(migrationOf("manual").migrate).toBe(false);
  });
});

describe("describeInspect", () => {
  it("没有数据", () => {
    expect(describeInspect(null)).toBe("没有数据");
    expect(describeInspect(inspect({ hasDb: false }))).toBe("没有数据");
  });

  it("有数据：笔记数 · 大小 · 时间", () => {
    expect(describeInspect(inspect({}))).toBe("10 篇笔记 · 2.0 MB · 最后修改于 2026-11-01 09:35:16");
  });

  it("读不出笔记数、体积很小、没有时间", () => {
    expect(describeInspect(inspect({ noteCount: null, sizeBytes: 100, modifiedAt: null }))).toBe(
      "笔记数读取失败 · 1 KB",
    );
  });
});
