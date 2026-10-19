/**
 * 任务附件条：描述下方一排缩略图 / 文件条，主任务与子任务共用。
 *
 * 为什么不做成富文本：描述保持纯文本，图片单独成条 —— 粘贴 / 删除 / 排序都只动
 * `task_attachments` 表，不需要编辑器；点缩略图走 antd Image 预览（缩放 / 旋转 / 左右切换）。
 *
 * 两种模式：
 * - `taskId` 有值：实时模式，增删排序立刻落库
 * - `taskId` 为 null：草稿模式（新建任务还没 id），文件先暂存在 `drafts`，
 *   父组件建完任务后调 `flushDraftAttachments` 一次性上传
 *
 * 添加入口：粘贴（父组件在 onPaste 里调 ref.handlePaste）、拖入、点「＋」选文件。
 *
 * 粘贴图文混合内容（网页 / 微信 / QQ 复制一段带图的文字）：文字照常进描述框，
 * 图片自动识别成附件 —— 见 `parseClipboard`。
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";
import { App as AntdApp, Image, Spin } from "antd";
import { FileText, Paperclip, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

import { taskAttachmentApi } from "@/lib/api";
import { resolveAssetSrc, toKbAsset } from "@/lib/assetUrl";
import { useAppStore } from "@/store";
import { useAttachmentPreviewStore } from "@/store/attachmentPreview";
import { MAX_HTML_IMAGES, parseClipboard } from "@/lib/clipboardAttachments";
import type { TaskAttachment } from "@/types";

/**
 * 草稿附件（新建任务尚未落库时暂存）。三选一：
 * - `file`：截图 / 拖入的文件，已在内存里
 * - `url`：网页图文里的外链图片，落库时由后端下载
 * - `path`：微信 / QQ 等把图片放在本地临时目录，HTML 里是 file:/// 地址，落库时由后端复制
 */
export interface DraftAttachment {
  key: string;
  name: string;
  file?: File;
  url?: string;
  path?: string;
  /** 图片的 blob: 预览地址；外链 / 本地路径拿不到预览（CSP 只放行 asset/data/blob） */
  previewUrl?: string;
}

/** 粘贴事件的最小接口：React 合成事件和原生 ClipboardEvent 都满足 */
export interface PasteLike {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
}

export interface TaskAttachmentsHandle {
  /** 追加文件（拖入时由父组件调用） */
  addFiles: (files: File[]) => Promise<void>;
  /**
   * 处理一次粘贴：识别出图片 / 文件就收进附件条，返回是否识别到附件。
   * `keepText`：粘贴目标是文本框时传 true —— 有文字就不拦截，让文字照常进框；
   * 没有文本框的地方（详情页 / 子任务区）传 false，识别到附件就拦截。
   */
  handlePaste: (e: PasteLike, opts?: { keepText?: boolean }) => boolean;
}

/** base64 走 IPC，太大的文件会卡 —— 超过这个大小请用「＋」选文件（后端直接复制） */
const MAX_INLINE_BYTES = 50 * 1024 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

export function isImageAttachment(a: {
  mime?: string;
  file_name: string;
}): boolean {
  return (a.mime ?? "").startsWith("image/") || IMAGE_EXT_RE.test(a.file_name);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 截图粘贴的 File 名字都叫 image.png，同一毫秒多张也要区分开 */
function nameForFile(file: File, idx: number): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `pasted-${Date.now()}-${idx}.${ext}`;
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "网页图片";
  } catch {
    return "网页图片";
  }
}

/** 新建任务落库后把草稿附件传上去；返回失败条数（不抛错，任务本身已建好） */
export async function flushDraftAttachments(
  taskId: number,
  drafts: DraftAttachment[],
): Promise<number> {
  let failed = 0;
  for (const [idx, d] of drafts.entries()) {
    try {
      if (d.file) {
        await taskAttachmentApi.add(
          taskId,
          nameForFile(d.file, idx),
          await fileToBase64(d.file),
        );
      } else if (d.url) {
        await taskAttachmentApi.addFromUrl(taskId, d.url);
      } else if (d.path) {
        await taskAttachmentApi.addFromPath(taskId, d.path);
      }
    } catch (e) {
      console.error("[TaskAttachments] 草稿附件上传失败", d.name, e);
      failed++;
    }
  }
  drafts.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
  return failed;
}

interface Props {
  taskId: number | null;
  /** false = 只读（详情页）：不显示「＋」和删除按钮，没有附件时整块不渲染 */
  editable?: boolean;
  /** 子任务行用小号缩略图 */
  size?: "default" | "small";
  drafts?: DraftAttachment[];
  onDraftsChange?: (drafts: DraftAttachment[]) => void;
  /** 实时模式下附件数变化（父组件刷新列表角标用） */
  onCountChange?: (count: number) => void;
  ref?: Ref<TaskAttachmentsHandle>;
}

/** 内部拖动排序用的 dataTransfer 类型，和 OS 文件拖入（"Files"）区分开 */
const REORDER_MIME = "application/x-kb-task-attachment";

export default function TaskAttachments({
  taskId,
  editable = true,
  size = "default",
  drafts = [],
  onDraftsChange,
  onCountChange,
  ref,
}: Props) {
  const { message } = AntdApp.useApp();
  const dataDir = useAppStore((s) => s.instanceInfo?.dataDir);
  const openFilePreview = useAttachmentPreviewStore((s) => s.open);
  const [items, setItems] = useState<TaskAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const live = taskId != null;
  const tile = size === "small" ? 44 : 64;

  const reload = useCallback(async () => {
    if (taskId == null) return;
    setLoading(true);
    try {
      const list = await taskAttachmentApi.list(taskId);
      setItems(list);
      onCountChange?.(list.length);
    } catch (e) {
      message.error(`加载附件失败：${e}`);
    } finally {
      setLoading(false);
    }
    // onCountChange 是父组件内联回调，放进依赖会每次渲染都重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, message]);

  useEffect(() => {
    if (live) void reload();
    else setItems([]);
  }, [live, reload]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const tooBig = files.filter((f) => f.size > MAX_INLINE_BYTES);
      const ok = files.filter((f) => f.size <= MAX_INLINE_BYTES);
      if (tooBig.length > 0) {
        message.warning(
          `${tooBig.length} 个文件超过 50MB，请点「＋」从磁盘选择添加`,
        );
      }
      if (ok.length === 0) return;

      if (!live) {
        const next = ok.map((file, i) => ({
          key: `${Date.now()}-${i}-${file.name}`,
          name: file.name || nameForFile(file, i),
          file,
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
        }));
        onDraftsChange?.([...drafts, ...next]);
        return;
      }

      setBusy(true);
      try {
        for (const [idx, file] of ok.entries()) {
          try {
            await taskAttachmentApi.add(
              taskId,
              nameForFile(file, idx),
              await fileToBase64(file),
            );
          } catch (e) {
            message.error(`添加 ${file.name || "图片"} 失败：${e}`);
          }
        }
      } finally {
        setBusy(false);
        await reload();
      }
    },
    [live, taskId, drafts, onDraftsChange, message, reload],
  );

  /** 外链图片 / 本地路径：实时模式交后端下载或复制，草稿模式先记下来 */
  const addRemote = useCallback(
    async (urls: string[], paths: string[]) => {
      if (urls.length === 0 && paths.length === 0) return;
      if (!live) {
        const stamp = Date.now();
        onDraftsChange?.([
          ...drafts,
          ...urls.map((url, i) => ({
            key: `${stamp}-u${i}`,
            name: nameFromUrl(url),
            url,
          })),
          ...paths.map((path, i) => ({
            key: `${stamp}-p${i}`,
            name: path.split(/[\\/]/).pop() || path,
            path,
          })),
        ]);
        return;
      }
      setBusy(true);
      let failed = 0;
      try {
        for (const url of urls) {
          await taskAttachmentApi.addFromUrl(taskId, url).catch(() => failed++);
        }
        for (const p of paths) {
          await taskAttachmentApi.addFromPath(taskId, p).catch(() => failed++);
        }
      } finally {
        setBusy(false);
        if (failed > 0)
          message.warning(`${failed} 张图片没取到（可能已失效或被防盗链拦截）`);
        await reload();
      }
    },
    [live, taskId, drafts, onDraftsChange, message, reload],
  );

  const handlePaste = useCallback(
    (e: PasteLike, opts?: { keepText?: boolean }) => {
      const plan = parseClipboard(e.clipboardData);
      const found = plan.files.length + plan.urls.length + plan.paths.length;
      if (found === 0) return false;
      // 文字留给文本框自己插入；没有文字（纯截图）或者根本没有文本框时才拦截默认行为
      if (!opts?.keepText || plan.text.trim() === "") e.preventDefault();
      if (plan.skipped > 0)
        message.info(`图片较多，只收了前 ${MAX_HTML_IMAGES} 张`);
      // addFiles 和 addRemote 都基于同一份 drafts 闭包，草稿模式下串行调用会互相覆盖 ——
      // 有文件就先收文件，外链 / 路径留到下一次渲染拿到新 drafts 再收
      if (
        !live &&
        plan.files.length > 0 &&
        plan.urls.length + plan.paths.length > 0
      ) {
        void addFiles(plan.files);
        pendingRemote.current = { urls: plan.urls, paths: plan.paths };
        return true;
      }
      void addFiles(plan.files);
      void addRemote(plan.urls, plan.paths);
      return true;
    },
    [live, addFiles, addRemote, message],
  );

  // 见 handlePaste：草稿模式里文件和外链同时出现时，外链在 drafts 更新后补收
  const pendingRemote = useRef<{ urls: string[]; paths: string[] } | null>(
    null,
  );
  useEffect(() => {
    const p = pendingRemote.current;
    if (!p) return;
    pendingRemote.current = null;
    void addRemote(p.urls, p.paths);
  }, [drafts, addRemote]);

  useImperativeHandle(ref, () => ({ addFiles, handlePaste }), [
    addFiles,
    handlePaste,
  ]);

  async function pickFiles() {
    if (!live) {
      // 草稿模式还没有任务目录，只能先拿 File 暂存
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => void addFiles(Array.from(input.files ?? []));
      input.click();
      return;
    }
    const selected = await open({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setBusy(true);
    try {
      for (const p of paths) {
        try {
          await taskAttachmentApi.addFromPath(taskId, p);
        } catch (e) {
          message.error(`添加失败：${e}`);
        }
      }
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function removeItem(id: number) {
    try {
      await taskAttachmentApi.remove(id);
      await reload();
    } catch (e) {
      message.error(`删除失败：${e}`);
    }
  }

  function removeDraft(key: string) {
    const d = drafts.find((x) => x.key === key);
    if (d?.previewUrl) URL.revokeObjectURL(d.previewUrl);
    onDraftsChange?.(drafts.filter((x) => x.key !== key));
  }

  async function moveItem(fromId: number, toId: number) {
    if (taskId == null || fromId === toId) return;
    const ids = items.map((x) => x.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // 先乐观更新，失败再拉一遍
    setItems(ids.map((id) => items.find((x) => x.id === id)!));
    try {
      await taskAttachmentApi.reorder(taskId, ids);
    } catch (e) {
      message.error(`排序失败：${e}`);
      await reload();
    }
  }

  function onDrop(e: DragEvent) {
    setDragOver(false);
    if (!editable) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void addFiles(files);
  }

  function onDragOver(e: DragEvent) {
    if (!editable || !Array.from(e.dataTransfer.types).includes("Files"))
      return;
    e.preventDefault();
    setDragOver(true);
  }

  const count = live ? items.length : drafts.length;
  if (!editable && count === 0) return null;

  const images = items.filter(isImageAttachment);
  const others = items.filter((a) => !isImageAttachment(a));
  const draftImages = drafts.filter((d) => d.previewUrl);
  const draftOthers = drafts.filter((d) => !d.previewUrl);

  const removeBtn = (onClick: () => void) =>
    editable && (
      <button
        type="button"
        title="移除"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="absolute -top-1.5 -right-1.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full border-0 bg-black/60 text-white group-hover:flex cursor-pointer"
      >
        <X size={10} />
      </button>
    );

  const fileChip = (
    key: string | number,
    name: string,
    bytes: number | undefined,
    onOpen?: () => void,
    onRemove?: () => void,
  ) => (
    <div
      key={key}
      className="group relative flex max-w-[220px] items-center gap-1.5 rounded border border-solid px-2 text-xs"
      style={{
        height: tile,
        borderColor: "var(--ant-color-border-secondary, rgba(0,0,0,0.06))",
        cursor: onOpen ? "pointer" : "default",
      }}
      title={onOpen ? `点击预览：${name}` : name}
      onClick={onOpen}
    >
      <FileText
        size={size === "small" ? 14 : 18}
        className="shrink-0 opacity-60"
      />
      <div className="min-w-0">
        <div className="truncate">{name}</div>
        {size !== "small" && (
          <div className="opacity-50">
            {bytes != null ? fmtSize(bytes) : "保存后下载"}
          </div>
        )}
      </div>
      {onRemove && removeBtn(onRemove)}
    </div>
  );

  return (
    <div
      className="rounded transition-colors"
      style={{
        outline: dragOver
          ? "1px dashed var(--ant-color-primary, #1677ff)"
          : undefined,
        outlineOffset: 2,
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <Spin spinning={loading || busy} size="small">
        <div className="flex flex-wrap items-center gap-2">
          <Image.PreviewGroup>
            {images.map((a) => (
              <div
                key={a.id}
                className="group relative"
                draggable={editable}
                onDragStart={(e) =>
                  e.dataTransfer.setData(REORDER_MIME, String(a.id))
                }
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(REORDER_MIME))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const from = Number(e.dataTransfer.getData(REORDER_MIME));
                  if (!from) return;
                  e.preventDefault();
                  e.stopPropagation();
                  void moveItem(from, a.id);
                }}
              >
                <Image
                  src={resolveAssetSrc(toKbAsset(a.rel_path), dataDir)}
                  alt={a.file_name}
                  width={tile}
                  height={tile}
                  className="rounded object-cover"
                  styles={{ image: { objectFit: "cover", borderRadius: 4 } }}
                  preview={{ mask: size === "small" ? null : "查看" }}
                />
                {removeBtn(() => void removeItem(a.id))}
              </div>
            ))}
            {draftImages.map((d) => (
              <div key={d.key} className="group relative">
                <Image
                  src={d.previewUrl}
                  alt={d.name}
                  width={tile}
                  height={tile}
                  styles={{ image: { objectFit: "cover", borderRadius: 4 } }}
                  preview={{ mask: "查看" }}
                />
                {removeBtn(() => removeDraft(d.key))}
              </div>
            ))}
          </Image.PreviewGroup>

          {others.map((a) =>
            fileChip(
              a.id,
              a.file_name,
              a.size,
              () => openFilePreview({ rel: a.rel_path, fileName: a.file_name }),
              () => void removeItem(a.id),
            ),
          )}
          {draftOthers.map((d) =>
            fileChip(d.key, d.name, d.file?.size, undefined, () =>
              removeDraft(d.key),
            ),
          )}

          {editable && (
            <button
              type="button"
              title="添加图片或文件（也可以在描述框里直接粘贴截图，或把文件拖到这里）"
              onClick={() => void pickFiles()}
              className="flex items-center justify-center gap-1 rounded border border-dashed bg-transparent text-xs opacity-60 hover:opacity-100 cursor-pointer"
              style={{
                // 没有附件时只是一行入口，不占缩略图那么高
                height: count === 0 ? 28 : tile,
                minWidth: count === 0 ? undefined : tile,
                padding: count === 0 ? "0 10px" : 0,
                borderColor: "var(--ant-color-border, #d9d9d9)",
                color: "inherit",
              }}
            >
              {count === 0 ? (
                <>
                  <Paperclip size={13} />{" "}
                  {size === "small" ? "添加" : "添加图片 / 附件"}
                </>
              ) : (
                <Plus size={16} />
              )}
            </button>
          )}
        </div>
      </Spin>
    </div>
  );
}
