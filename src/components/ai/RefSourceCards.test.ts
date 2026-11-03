import { describe, it, expect, vi } from "vitest";

// 组件文件顶层 import 了 api / router；纯函数测试用不到，打桩避免拉起 Tauri invoke
vi.mock("@/lib/api", () => ({ folderApi: {}, noteApi: {} }));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));

import { resolveRefCards, type NoteBrief } from "./RefSourceCards";
import type { Folder } from "@/types";

const folders = [
  {
    id: 1,
    name: "学习",
    children: [{ id: 2, name: "Rust", children: [] }],
  },
] as unknown as Folder[];

describe("AI 回答出处卡片：resolveRefCards", () => {
  it("按引用顺序编号，带出「父 / 子」文件夹路径，无文件夹显示未分类", () => {
    const briefs = new Map<number, NoteBrief>([
      [10, { title: "Rust 所有权", folderId: 2 }],
      [11, { title: "随手记", folderId: null }],
    ]);
    expect(resolveRefCards([10, 11], briefs, folders)).toEqual([
      { id: 10, no: 1, title: "Rust 所有权", path: "学习 / Rust" },
      { id: 11, no: 2, title: "随手记", path: "未分类" },
    ]);
  });

  it("已删除（null）/ 还没查到（undefined）的笔记不出卡片，但其余卡片保留原始编号（与正文角标对齐）", () => {
    const briefs = new Map<number, NoteBrief>([
      [10, null],
      [12, { title: "借用检查器", folderId: 2 }],
    ]);
    expect(resolveRefCards([10, 11, 12], briefs, folders)).toEqual([
      { id: 12, no: 3, title: "借用检查器", path: "学习 / Rust" },
    ]);
  });

  it("标题为空显示「未命名」；文件夹树还没拉到时路径先显示未分类", () => {
    const briefs = new Map<number, NoteBrief>([[20, { title: "", folderId: 2 }]]);
    expect(resolveRefCards([20], briefs, null)).toEqual([
      { id: 20, no: 1, title: "未命名", path: "未分类" },
    ]);
  });
});
