import { useEffect, useState } from "react";
import { Spin, Alert, theme as antdTheme } from "antd";
import mammoth from "mammoth";
import { sourceFileApi, systemApi } from "@/lib/api";

interface Props {
  /**
   * kb-asset:// 相对路径。**.doc / .docx 的判断以它为准**。
   *
   * 曾经这里还收一个 `fileName` 并用它推扩展名 —— 但 fileName 取自笔记里链接的
   * 显示文本，用户可能改成不带扩展名的中文标题，于是改过名的 .doc 认不出来、
   * 跳过 doc→docx 转换、把老 Word 二进制直接喂给只吃 zip 的 mammoth。
   * 现在只认 rel，参数也一并去掉，免得后来者再拿它做类型判断。
   */
  rel: string;
}

/** base64 → ArrayBuffer */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Word（.docx/.doc）附件预览。
 *
 * 渲染策略：
 * - .docx：直接 read_file_as_base64 → mammoth.convertToHtml
 * - .doc：先 convert_doc_to_docx_base64（依赖系统 Word/WPS）→ mammoth
 * - 图片：mammoth 默认转 data URL 内嵌（预览不存盘，不污染附件目录）
 *
 * 与 wordImport.ts 的区别：那个会把图片转存到本地 + 创建笔记；这个**只读渲染**。
 */
export function DocxPreview({ rel }: Props) {
  const { token } = antdTheme.useToken();
  const [html, setHtml] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWarnings([]);
    setHtml("");

    const run = async () => {
      try {
        const abs = await systemApi.resolveAssetAbsolute(rel);
        // 按 `rel`（真实文件路径）而不是 `fileName` 判断格式。
        //
        // fileName 取自笔记里链接的显示文本，用户可能改成不带扩展名的中文标题。
        // 按它判断的话，改过名的老 .doc 会认不出来 → 跳过 doc→docx 转换 →
        // 直接把二进制喂给 mammoth（它只吃 zip 格式的 docx）→ 解析失败。
        // 与 AttachmentPreviewModal 的口径保持一致：类型判断一律看 rel。
        const ext = rel.toLowerCase().split(".").pop() ?? "";
        let base64: string;
        if (ext === "doc") {
          base64 = await sourceFileApi.convertDocToDocxBase64(abs);
        } else {
          base64 = await sourceFileApi.readFileAsBase64(abs);
        }
        if (cancelled) return;
        const arrayBuffer = base64ToArrayBuffer(base64);
        const result = await mammoth.convertToHtml(
          { arrayBuffer },
          {
            // 内嵌图片为 data URL：预览不落盘
            convertImage: mammoth.images.imgElement(async (image) => {
              const buf = await image.read("base64");
              return { src: `data:${image.contentType};base64,${buf}` };
            }),
          },
        );
        if (cancelled) return;
        setHtml(result.value || "<p>（文档为空）</p>");
        setWarnings(
          (result.messages || [])
            .filter((m) => m.type === "warning" || m.type === "error")
            .map((m) => m.message),
        );
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [rel]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height: "100%", minHeight: 240 }}
      >
        <Spin tip="正在解析 Word 文档..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Word 预览失败"
        description={error}
      />
    );
  }

  return (
    <div className="docx-preview-root">
      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`mammoth 转换提示（${warnings.length}）`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.slice(0, 5).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {warnings.length > 5 && <li>...（共 {warnings.length} 条）</li>}
            </ul>
          }
          style={{ marginBottom: 12 }}
        />
      )}
      <div
        className="docx-preview-content"
        style={{
          fontSize: 14,
          lineHeight: 1.7,
          color: token.colorText,
          padding: "8px 4px",
          // 让长内容可读：mammoth 输出的 table/img/ul 等都用默认样式即可
          wordBreak: "break-word",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
