/**
 * AI 回答下方的"溯源图片"组件。
 *
 * 场景：RAG 问答 / 笔记内问 AI 时，AI 引用了哪几篇笔记记录在 message.references 里。
 * 本组件拿这批 note_id 调 `notesApi.getImages` 取回每篇笔记 content 内的图片，
 * 渲染成可点击放大的缩略图条，让用户直接看到"答案来自笔记里的哪张图"。
 *
 * 图片解析复用编辑器同一套（src/lib/assetUrl + imageApi.getBlob）：
 * - 明文图（kb-asset://...png）→ resolveAssetSrc → asset 协议 URL
 * - 加密图（.enc）           → imageApi.getBlob 解密 → Blob URL（卸载时 revoke）
 *
 * 取图失败 / 无图 → 静默渲染 null，绝不影响回答正文展示。
 */
import { useEffect, useState } from "react";
import { Image } from "antd";
import { noteApi, imageApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { toKbAsset, isEncryptedAsset, resolveAssetSrc } from "@/lib/assetUrl";
import type { NoteImageRef } from "@/types";

interface ResolvedImage {
  /** 去重 key（用相对路径）*/
  key: string;
  /** 可直接喂 <img> 的 URL（asset 协议 或 blob:）*/
  url: string;
  /** 来源笔记标题，作为缩略图 tooltip */
  title: string;
}

interface Props {
  /** 引用的笔记 id 列表（一般来自 message.references 解析）*/
  noteIds: number[];
}

export function NoteImageRefs({ noteIds }: Props) {
  const dataDir = useAppStore((s) => s.instanceInfo?.dataDir ?? null);
  const [images, setImages] = useState<ResolvedImage[]>([]);

  // noteIds 用 join 做依赖，避免数组引用每次渲染都变触发重取
  const idsKey = noteIds.join(",");

  useEffect(() => {
    let cancelled = false;
    const blobUrls: string[] = [];

    async function load() {
      if (noteIds.length === 0) {
        setImages([]);
        return;
      }
      let refs: NoteImageRef[];
      try {
        refs = await noteApi.getImages(noteIds);
      } catch {
        return; // 静默：溯源图取不到不影响回答
      }

      const resolved: ResolvedImage[] = [];
      for (const ref of refs) {
        for (const rel of ref.images) {
          if (isEncryptedAsset(rel)) {
            try {
              const bytes = await imageApi.getBlob(rel); // 后端接受相对路径
              const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
              blobUrls.push(url);
              resolved.push({ key: rel, url, title: ref.title });
            } catch {
              // 未解锁 vault / 解密失败 → 跳过该图
            }
          } else {
            resolved.push({
              key: rel,
              url: resolveAssetSrc(toKbAsset(rel), dataDir),
              title: ref.title,
            });
          }
        }
      }

      if (!cancelled) setImages(resolved);
    }

    void load();
    return () => {
      cancelled = true;
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [idsKey, dataDir]);

  if (images.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Image.PreviewGroup>
        {images.map((img) => (
          <Image
            key={img.key}
            src={img.url}
            alt={img.title}
            title={img.title}
            width={56}
            height={56}
            rootClassName="rounded overflow-hidden"
            style={{ objectFit: "cover", borderRadius: 6 }}
          />
        ))}
      </Image.PreviewGroup>
    </div>
  );
}
