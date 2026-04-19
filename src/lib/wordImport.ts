import mammoth from "mammoth";
import { convertFileSrc } from "@tauri-apps/api/core";
import { noteApi, sourceFileApi, imageApi } from "@/lib/api";
import type { Note } from "@/types";

export interface WordImportResult {
  sourcePath: string;
  noteId: number | null;
  title: string | null;
  error: string | null;
  warnings: string[];
}

/** base64 → ArrayBuffer */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 路径取文件名（不带扩展名） */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() || "未命名";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** mammoth 把内联图片转成 data URL；后续替换成本地 asset:// */
function imgConvertOption() {
  return mammoth.images.imgElement(async (image) => {
    const buf = await image.read("base64");
    return { src: `data:${image.contentType};base64,${buf}` };
  });
}

/** 把 HTML 里 data:image base64 替换成本地保存后的 asset:// URL */
async function relocateImages(html: string, noteId: number): Promise<string> {
  // 匹配 <img src="data:image/...;base64,...">
  const regex = /<img\s+([^>]*?)src="data:(image\/[a-zA-Z0-9+]+);base64,([^"]+)"([^>]*)>/g;
  const replacements: Array<{ match: string; replacement: string }> = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(html)) !== null) {
    const [whole, before, mime, b64, after] = m;
    const ext = mime.split("/")[1].split("+")[0] || "png";
    const fileName = `word-${Date.now()}-${idx++}.${ext}`;
    try {
      const abs = await imageApi.save(noteId, fileName, b64);
      const url = convertFileSrc(abs);
      replacements.push({
        match: whole,
        replacement: `<img ${before}src="${url}"${after}>`,
      });
    } catch {
      // 图片保存失败：保留原 data URL，至少不丢图
    }
  }
  let out = html;
  for (const { match, replacement } of replacements) {
    out = out.replace(match, replacement);
  }
  return out;
}

/** 导入一个 Word 文件（.docx 或 .doc） */
export async function importWordFile(
  filePath: string,
): Promise<{ note: Note; warnings: string[] }> {
  const lower = filePath.toLowerCase();
  const isDoc = lower.endsWith(".doc") && !lower.endsWith(".docx");

  // 1. 拿到 .docx 字节（base64）
  const base64 = isDoc
    ? await sourceFileApi.convertDocToDocxBase64(filePath)
    : await sourceFileApi.readFileAsBase64(filePath);

  const arrayBuffer = base64ToArrayBuffer(base64);

  // 2. mammoth 转 HTML（图片先嵌入 data URL）
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    { convertImage: imgConvertOption() },
  );
  const rawHtml = result.value || "<p></p>";
  const warnings = (result.messages || [])
    .filter((m) => m.type === "warning" || m.type === "error")
    .map((m) => m.message);

  // 3. 创建笔记
  const title = fileStem(filePath);
  const note = await noteApi.create({
    title,
    content: rawHtml,
    folder_id: null,
  });

  // 4. 抽出图片转存到 images/
  const finalHtml = await relocateImages(rawHtml, note.id);
  if (finalHtml !== rawHtml) {
    await noteApi.update(note.id, {
      title,
      content: finalHtml,
      folder_id: null,
    });
  }

  // 5. 挂上原文件（保留原 .doc/.docx）
  try {
    await sourceFileApi.attach(
      note.id,
      filePath,
      isDoc ? "doc" : "docx",
    );
  } catch (e) {
    warnings.push(`原文件保存失败: ${e}`);
  }

  // 6. 重新拿一次 note（带 source_file_path/type）
  const fresh = await noteApi.get(note.id);
  return { note: fresh, warnings };
}

/** 批量导入，每个文件独立处理失败 */
export async function importWordFiles(
  paths: string[],
): Promise<WordImportResult[]> {
  const results: WordImportResult[] = [];
  for (const p of paths) {
    try {
      const { note, warnings } = await importWordFile(p);
      results.push({
        sourcePath: p,
        noteId: note.id,
        title: note.title,
        error: null,
        warnings,
      });
    } catch (e) {
      results.push({
        sourcePath: p,
        noteId: null,
        title: null,
        error: String(e),
        warnings: [],
      });
    }
  }
  return results;
}
