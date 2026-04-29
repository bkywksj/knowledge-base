/**
 * 笔记创建 / 导入统一入口 —— 从旧 CreateNoteModal 拆出来的公共函数，
 * 让"+ 新建笔记"按钮能直接调用，不必再走 Tab 选择的 Modal 流程。
 */
import { List, Modal, Typography, message } from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { NavigateFunction } from "react-router-dom";

import { noteApi, importApi, pdfApi, sourceFileApi, tagApi, folderApi } from "./api";
import { importWordFiles } from "./wordImport";
import { useAppStore } from "@/store";

/**
 * 导入完成后的统一跳转规则（业界 Bear / Apple Notes / VS Code 路线）：
 *   · 1 篇新建            → 直开编辑器
 *   · 0 新建 + 1 命中已有 → 跳那篇已有的（"我导入是为了打开它"）
 *   · ≥ 2 篇              → 跳笔记列表（默认时间倒序，新导入在顶部）
 *   · 全失败/全跳过       → 留在原地，让 message/Modal 提示就够
 *
 * navigate 可选：调用方不传就静默不跳，兼容旧用法（少数地方还没接 router）。
 */
function navigateAfterImport(
  navigate: NavigateFunction | undefined,
  newIds: number[],
  existingIds: number[],
): void {
  if (!navigate) return;
  const total = newIds.length + existingIds.length;
  if (total === 0) return;
  if (total === 1) {
    const only = newIds[0] ?? existingIds[0];
    if (only != null) navigate(`/notes/${only}`);
    return;
  }
  navigate("/notes");
}

/** 未命名笔记标题，带时间戳避免同名堆叠时难区分 */
function untitledTitle(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `未命名笔记 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 创建一篇空白笔记并跳转到编辑器。用户想写就写，不想保留可直接删除。
 *
 * `opts.useDefaults`：true 时套用全局"默认文件夹/默认标签"偏好——仅在
 * 调用方完全没有文件夹上下文时（顶部新建按钮、Ctrl+N、托盘"新建笔记"等）
 * 才传 true。文件夹右键 / ?folder=X 等已声明 folderId 的入口保持 false，
 * 不被默认覆盖。套用后给 toast 提示，方便用户感知"是否吃到默认"。
 */
export async function createBlankAndOpen(
  folderId: number | null,
  navigate: NavigateFunction,
  opts?: { useDefaults?: boolean },
): Promise<void> {
  try {
    let finalFolderId = folderId;
    let appliedTagIds: number[] = [];
    let appliedFolderName: string | null = null;
    let appliedTagNames: string[] = [];

    if (opts?.useDefaults && folderId == null) {
      const { defaultFolderId, defaultTagIds } = useAppStore.getState();
      if (defaultFolderId != null) {
        finalFolderId = defaultFolderId;
        // 拉一下文件夹名给 toast 用；失败不影响创建
        try {
          const allFolders = await folderApi.list();
          appliedFolderName =
            findFolderName(allFolders, defaultFolderId) ?? null;
        } catch {
          /* ignore */
        }
      }
      if (defaultTagIds.length > 0) {
        appliedTagIds = defaultTagIds;
        try {
          const allTags = await tagApi.list();
          appliedTagNames = defaultTagIds
            .map((id) => allTags.find((t) => t.id === id)?.name)
            .filter((n): n is string => !!n);
        } catch {
          /* ignore */
        }
      }
    }

    const note = await noteApi.create({
      title: untitledTitle(),
      content: "",
      folder_id: finalFolderId,
    });

    // 套用默认标签：循环 addToNote（避免改动 noteApi.create 签名波及其他调用方）
    if (appliedTagIds.length > 0) {
      await Promise.all(
        appliedTagIds.map((tid) =>
          tagApi.addToNote(note.id, tid).catch((e) => {
            console.warn(`套用默认标签 ${tid} 失败:`, e);
          }),
        ),
      );
    }

    useAppStore.getState().bumpNotesRefresh();
    navigate(`/notes/${note.id}`);

    // 反馈：让用户知道默认有没有生效
    if (appliedFolderName || appliedTagNames.length > 0) {
      const parts: string[] = [];
      if (appliedFolderName) parts.push(`文件夹「${appliedFolderName}」`);
      if (appliedTagNames.length > 0) {
        parts.push(`标签 ${appliedTagNames.map((n) => `「${n}」`).join("、")}`);
      }
      message.success(`已新建笔记 · 默认套用 ${parts.join(" + ")}`, 3);
    }
  } catch (e) {
    message.error(String(e));
  }
}

/** 在文件夹树里按 id 找名字（深度优先） */
function findFolderName(
  folders: { id: number; name: string; children?: typeof folders }[],
  id: number,
): string | null {
  for (const f of folders) {
    if (f.id === id) return f.name;
    if (f.children) {
      const r = findFolderName(f.children, id);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 文本笔记导入流程（同质合并版）：md / markdown / txt 共用一条通路。
 *
 * 后端 `import_selected_files` 已能识别这三种扩展名，并自动嗅探编码
 * （UTF-8 / GBK / GB18030 / Big5 等老 .txt 也能正确读出中文）。
 * 用户可一次混选不同扩展名的文件批量导入。
 */
export async function importTextFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const picked = await openDialog({
    multiple: true,
    filters: [
      { name: "Markdown / 纯文本", extensions: ["md", "markdown", "txt"] },
    ],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  const hide = message.loading(`正在导入 ${paths.length} 个文件...`, 0);
  try {
    const result = await importApi.importSelected(paths, folderId);
    hide();
    if (result.imported > 0) {
      let msg = `成功导入 ${result.imported} 篇`;
      if (result.skipped > 0) msg += `，跳过 ${result.skipped} 篇`;
      if (result.tags_attached && result.tags_attached > 0) {
        msg += `；自动关联 ${result.tags_attached} 条 frontmatter 标签`;
      }
      if (result.attachments_copied && result.attachments_copied > 0) {
        msg += `；复制 ${result.attachments_copied} 张图`;
      }
      const missCount = result.attachments_missing?.length ?? 0;
      if (missCount > 0) {
        msg += `（${missCount} 张图缺失，详见日志）`;
      }
      message.success(msg);
    } else if (result.skipped > 0) {
      message.warning(`全部 ${result.skipped} 篇已跳过`);
    }
    if (result.errors.length > 0) {
      Modal.warning({
        title: `${result.errors.length} 个文件导入失败`,
        content: (
          <List
            size="small"
            dataSource={result.errors}
            renderItem={(err) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {err}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    useAppStore.getState().bumpFoldersRefresh();
    navigateAfterImport(navigate, result.noteIds ?? [], result.existingNoteIds ?? []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}

/** PDF 导入流程 */
export async function importPdfsFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  const hide = message.loading(`正在导入 ${paths.length} 个 PDF...`, 0);
  try {
    const results = await pdfApi.importPdfs(paths, folderId);
    const ok = results.filter((r) => r.noteId !== null);
    const fail = results.filter((r) => r.noteId === null);
    hide();
    if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 PDF`);
    if (fail.length > 0) {
      Modal.warning({
        title: `${fail.length} 个 PDF 导入失败`,
        content: (
          <List
            size="small"
            dataSource={fail}
            renderItem={(r) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    const ids = ok.map((r) => r.noteId).filter((v): v is number => v != null);
    navigateAfterImport(navigate, ids, []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}

/** Word 导入流程：.doc 需本机装 LibreOffice / Office / WPS */
export async function importWordFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const converter = await sourceFileApi
    .getConverterStatus()
    .catch(() => "none" as const);
  const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "Word", extensions: exts }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  if (
    converter === "none" &&
    paths.some((p) => p.toLowerCase().endsWith(".doc"))
  ) {
    Modal.warning({
      title: ".doc 暂不可用",
      content: "未检测到 LibreOffice 或 Microsoft Office / WPS。安装后可导入 .doc。",
    });
    return;
  }
  const hide = message.loading(`正在导入 ${paths.length} 个 Word 文件...`, 0);
  try {
    const results = await importWordFiles(paths, folderId);
    const ok = results.filter((r) => r.noteId !== null);
    const fail = results.filter((r) => r.noteId === null);
    hide();
    if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word 文件`);
    if (fail.length > 0) {
      Modal.warning({
        title: `${fail.length} 个 Word 文件导入失败`,
        content: (
          <List
            size="small"
            dataSource={fail}
            renderItem={(r) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    const ids = ok.map((r) => r.noteId).filter((v): v is number => v != null);
    navigateAfterImport(navigate, ids, []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}
