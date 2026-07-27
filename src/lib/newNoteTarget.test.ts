import { describe, it, expect } from "vitest";
import {
  targetFromSidebarKey,
  targetFromFolderParam,
  UNCATEGORIZED_KEY,
  UNCATEGORIZED_PARAM,
} from "./newNoteTarget";

describe("新建笔记落点：侧边栏选中态", () => {
  it("选中文件夹 → 新建落到该文件夹，不套全局默认", () => {
    // 这是本次修复的核心：侧边栏顶部「+ 新建笔记」以前永远传 null，
    // 哪怕用户明明选中了某个文件夹
    expect(targetFromSidebarKey("42")).toEqual({
      folderId: 42,
      useDefaults: false,
    });
  });

  it("没有任何选中 → 无上下文，交给全局默认偏好", () => {
    expect(targetFromSidebarKey(null)).toEqual({
      folderId: null,
      useDefaults: true,
    });
    expect(targetFromSidebarKey(undefined)).toEqual({
      folderId: null,
      useDefaults: true,
    });
    expect(targetFromSidebarKey("")).toEqual({
      folderId: null,
      useDefaults: true,
    });
  });

  it("选中「未分类」→ 落未分类，且**不**被默认文件夹劫持", () => {
    // folderId 同样是 null，但语义完全不同：用户明确点了「未分类」，
    // 这时候再套用全局默认文件夹就是违背意图。光靠 folderId 区分不出来，
    // 所以才有 useDefaults 这个字段
    const t = targetFromSidebarKey(UNCATEGORIZED_KEY);
    expect(t.folderId).toBeNull();
    expect(t.useDefaults).toBe(false);

    const noContext = targetFromSidebarKey(null);
    expect(noContext.folderId).toBeNull();
    expect(noContext.useDefaults).toBe(true);
    // 两者 folderId 相同、行为必须不同
    expect(t).not.toEqual(noContext);
  });

  it("选中的是笔记 → 视为无文件夹上下文", () => {
    // "我在看这篇笔记" ≠ "我在这个文件夹里工作"，
    // 不该拿这篇笔记的 folder_id 去猜用户想建到哪
    expect(targetFromSidebarKey("note:123")).toEqual({
      folderId: null,
      useDefaults: true,
    });
  });

  it("非法 key 不会算出 NaN 文件夹", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "  ", "note:"]) {
      const t = targetFromSidebarKey(bad);
      expect(t.folderId).toBeNull();
      expect(Number.isNaN(t.folderId as unknown as number)).toBe(false);
    }
  });
});

describe("新建笔记落点：URL ?folder= 参数", () => {
  it("?folder=42 → 落到 42 号文件夹", () => {
    expect(targetFromFolderParam("42")).toEqual({
      folderId: 42,
      useDefaults: false,
    });
  });

  it("?folder=uncategorized → 落未分类，不套默认", () => {
    expect(targetFromFolderParam(UNCATEGORIZED_PARAM)).toEqual({
      folderId: null,
      useDefaults: false,
    });
  });

  it("无参数 → 无上下文", () => {
    expect(targetFromFolderParam(null)).toEqual({
      folderId: null,
      useDefaults: true,
    });
  });

  it("非法参数不会算出 NaN", () => {
    for (const bad of ["abc", "0", "-3", "NaN"]) {
      expect(targetFromFolderParam(bad).folderId).toBeNull();
    }
  });
});

describe("两个入口对同一个文件夹必须给出一致答案", () => {
  /**
   * 这是本次 bug 的根因回归测试：同一个选中状态，侧边栏按钮、笔记页按钮、
   * Ctrl+N 三条路以前各算各的。现在它们共用这两个函数，对等输入必须等价输出。
   */
  it("文件夹 id 在两种表示法下结果相同", () => {
    for (const id of [1, 42, 9999]) {
      expect(targetFromSidebarKey(String(id))).toEqual(
        targetFromFolderParam(String(id)),
      );
    }
  });

  it("「未分类」在两种表示法下结果相同", () => {
    expect(targetFromSidebarKey(UNCATEGORIZED_KEY)).toEqual(
      targetFromFolderParam(UNCATEGORIZED_PARAM),
    );
  });

  it("空上下文在两种表示法下结果相同", () => {
    expect(targetFromSidebarKey(null)).toEqual(targetFromFolderParam(null));
  });
});
