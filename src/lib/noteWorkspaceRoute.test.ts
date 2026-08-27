import { describe, it, expect } from "vitest";
import { isNoteWorkspacePath } from "./noteWorkspaceRoute";

describe("笔记工作区路由判定：标签栏该不该出现", () => {
  it("笔记列表与编辑器 → 显示", () => {
    expect(isNoteWorkspacePath("/notes")).toBe(true);
    expect(isNoteWorkspacePath("/notes/1")).toBe(true);
    expect(isNoteWorkspacePath("/notes/12345")).toBe(true);
  });

  it("白板 → 显示（本次修复最容易被后人改错的一条）", () => {
    // 白板本质是 note_type='whiteboard' 的笔记：从 /notes/:id 进去会被
    // editor 的入口重定向 replace 到 /whiteboard/:id。若这里判 false，
    // 用户从笔记点进白板就会丢掉切回其他已开笔记的入口。
    expect(isNoteWorkspacePath("/whiteboard/7")).toBe(true);
  });

  it("其他模块 → 不显示（原 BUG：这些页面顶着笔记标签栏）", () => {
    for (const p of [
      "/",
      "/daily",
      "/tasks",
      "/settings",
      "/about",
      "/graph",
      "/ai",
      "/prompts",
      "/push",
      "/tags",
      "/trash",
      "/hidden",
      "/cards",
      "/search",
    ]) {
      expect(isNoteWorkspacePath(p), `${p} 不该显示标签栏`).toBe(false);
    }
  });

  it("前缀相近但不同的路径不能误命中", () => {
    // startsWith 判定的经典坑：/notes-archive 不是 /notes 的子路由
    expect(isNoteWorkspacePath("/notes-archive")).toBe(false);
    expect(isNoteWorkspacePath("/notesomething")).toBe(false);
    expect(isNoteWorkspacePath("/whiteboards")).toBe(false);
  });

  it("白板列表页（无 :id）不算 —— 目前无此路由，防的是将来新增时静默命中", () => {
    expect(isNoteWorkspacePath("/whiteboard")).toBe(false);
  });
});
