import { describe, expect, it } from "vitest";
import { buildSlashCommandItems } from "@/components/editor/slashCommandItems";
import { MOBILE_EXTRA_INSERT_KEYS, MOBILE_INSERT_GROUPS, allMobileInsertKeys } from "./mobileInsertGroups";

describe("手机插入面板分组", () => {
  const slashKeys = buildSlashCommandItems({ getNoteId: () => 1, ensureNoteId: () => undefined }).map((it) => it.key);

  it("PC 斜杠清单里的每一项都登记到了某个分组（PC 新增项不会在手机上缺失）", () => {
    const registered = allMobileInsertKeys();
    const missing = slashKeys.filter((k) => !registered.has(k));
    expect(missing).toEqual([]);
  });

  it("分组里没有既不在斜杠清单、也不是手机额外项的 key（防手误拼错）", () => {
    const known = new Set<string>([...slashKeys, ...MOBILE_EXTRA_INSERT_KEYS]);
    const unknown = [...allMobileInsertKeys()].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it("同一分组内不重复", () => {
    for (const g of MOBILE_INSERT_GROUPS) {
      const keys = g.entries.map((x) => x.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("「常用」与原型 05 屏一致：12 格", () => {
    expect(MOBILE_INSERT_GROUPS[0].label).toBe("常用");
    expect(MOBILE_INSERT_GROUPS[0].entries).toHaveLength(12);
  });
});
