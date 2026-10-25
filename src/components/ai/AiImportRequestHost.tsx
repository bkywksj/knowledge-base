/**
 * AI 导入请求宿主：接 `ai:import-request`（AI 调了 request_import 工具），
 * 扫描路径后弹出现有的导入预览，用户确认 / 取消后把结果回传给后端，唤醒 AI 的工具调用。
 *
 * 挂在 AppLayout 而不是 AI 页：请求可能在用户切去别的页面时到达，
 * 弹窗是全局的才不会让 AI 那边白等到超时。
 *
 * 读文件的始终是导入管线（scan_markdown_folder / import_selected_files），
 * AI 只拿到统计和新笔记 id —— 这是不给 AI 通用读盘工具的前提，见 services/ai_import.rs。
 */
import { useEffect, useRef, useState } from "react";
import { Modal, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ImportPreviewModal } from "@/components/ImportPreviewModal";
import { aiImportApi, importApi } from "@/lib/api";
import { beginTrackedImportJob } from "@/lib/importJob";
import { useAppStore } from "@/store";
import type {
  AiImportOutcome,
  AiImportRequest,
  ImportConflictPolicy,
  ScannedFile,
} from "@/types";

interface PendingPreview {
  req: AiImportRequest;
  files: ScannedFile[];
}

export function AiImportRequestHost() {
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  // 单文件确认框的句柄：后端超时 / 停止时要能关掉它
  const confirmRef = useRef<{ id: string; destroy: () => void } | null>(null);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    listen<AiImportRequest>("ai:import-request", (e) => {
      void handleRequest(e.payload);
    }).then((fn) => unlisteners.push(fn));

    // 后端不再等了（对话被停止 / 超时）：收起还开着的弹窗，别让用户对着一个没人等的窗口点确认
    listen<{ requestId: string }>("ai:import-request-closed", (e) => {
      const id = e.payload.requestId;
      setPreview((p) => (p?.req.requestId === id ? null : p));
      if (confirmRef.current?.id === id) {
        confirmRef.current.destroy();
        confirmRef.current = null;
      }
    }).then((fn) => unlisteners.push(fn));

    return () => unlisteners.forEach((fn) => fn());
  }, []);

  async function handleRequest(req: AiImportRequest) {
    if (!req.isDir) {
      const m = Modal.confirm({
        title: "AI 请求导入文件",
        content: `把「${req.path}」导入知识库？`,
        okText: "导入",
        cancelText: "取消",
        onOk: () => {
          confirmRef.current = null;
          void runImport(req, [req.path], null, false, "skip", false);
        },
        onCancel: () => {
          confirmRef.current = null;
          void respond(req, { status: "cancelled" });
        },
      });
      confirmRef.current = { id: req.requestId, destroy: m.destroy };
      return;
    }

    const hide = message.loading("AI 请求导入，正在扫描文件夹…", 0);
    let files: ScannedFile[];
    try {
      files = await importApi.scan(req.path);
    } catch (e) {
      hide();
      message.error(`扫描失败: ${e}`);
      await respond(req, { status: "error", message: `扫描失败: ${e}` });
      return;
    }
    hide();
    if (files.length === 0) {
      await respond(req, { status: "error", message: "该文件夹下没有 .md 文件" });
      return;
    }
    setPreview({ req, files });
  }

  async function runImport(
    req: AiImportRequest,
    paths: string[],
    rootPath: string | null,
    preserveRoot: boolean,
    policy: ImportConflictPolicy,
    dailyMode: boolean,
  ) {
    const job = await beginTrackedImportJob("Markdown / 文本", paths.length, "import:progress");
    try {
      const result = await importApi.importSelected(
        paths,
        req.folderId,
        rootPath,
        preserveRoot,
        policy,
        dailyMode,
      );
      job.finish(result.imported, result.errors.length);
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
      await respond(req, {
        status: "done",
        imported: result.imported,
        duplicated: result.duplicated,
        skipped: result.skipped,
        noteIds: result.noteIds ?? [],
        errors: result.errors,
      });
    } catch (e) {
      job.cancel();
      message.error(`导入失败: ${e}`);
      await respond(req, { status: "error", message: String(e) });
    }
  }

  async function respond(req: AiImportRequest, outcome: AiImportOutcome) {
    try {
      await aiImportApi.resolve(req.requestId, outcome);
    } catch (e) {
      console.warn("[ai-import] 回传结果失败:", e);
    }
  }

  if (!preview) return null;
  return (
    <ImportPreviewModal
      open
      files={preview.files}
      rootPath={preview.req.path}
      onCancel={() => {
        const { req } = preview;
        setPreview(null);
        void respond(req, { status: "cancelled" });
      }}
      onConfirm={({ policy, preserveRoot, dailyMode }) => {
        const { req, files } = preview;
        setPreview(null);
        void runImport(
          req,
          files.map((f) => f.path),
          req.path,
          preserveRoot,
          policy,
          dailyMode,
        );
      }}
    />
  );
}
