import { describe, it, expect } from "vitest";
import { parseDatasetRows } from "./datasetRows";

describe("parseDatasetRows", () => {
  it("解析正常的行 JSON", () => {
    const rows = parseDatasetRows([
      '{"名称":"甲","金额":"100"}',
      '{"名称":"乙","金额":"200"}',
    ]);
    expect(rows).toEqual([
      { 名称: "甲", 金额: "100" },
      { 名称: "乙", 金额: "200" },
    ]);
  });

  it("单行坏数据不影响其余行", () => {
    // 库被外部工具改坏时，坏行退化成空行，其余照常显示 —— 整页空掉才是最糟的
    const rows = parseDatasetRows([
      '{"a":"1"}',
      "{不是合法 JSON",
      '{"a":"3"}',
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ a: "1" });
    expect(rows[1]).toEqual({});
    expect(rows[2]).toEqual({ a: "3" });
  });

  it("非对象 JSON 退化成空行", () => {
    // null / 数组 / 字符串直接喂给 antd Table 会渲染崩
    expect(parseDatasetRows(["null", "[1,2]", '"字符串"', "42"])).toEqual([
      {},
      {},
      {},
      {},
    ]);
  });

  it("保留单元格里的分隔符", () => {
    // 这正是行数据用 JSON 而非「行N｜列名=值」文本的原因
    const rows = parseDatasetRows(['{"备注":"含｜竖线","值":"含=等号,和逗号"}']);
    expect(rows[0]["备注"]).toBe("含｜竖线");
    expect(rows[0]["值"]).toBe("含=等号,和逗号");
  });

  it("空输入返回空数组", () => {
    expect(parseDatasetRows([])).toEqual([]);
  });
});
