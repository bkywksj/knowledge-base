import { useEffect, useState } from "react";
import { Card, Typography, Button, Space, Alert, message, Input, Tag } from "antd";
import { FileImage, FileText, ScanText } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ocrApi, noteApi } from "@/lib/api";

const { Text, Paragraph } = Typography;

/**
 * #9 本地 OCR（RapidOCR sidecar）。识别图片 / 扫描件 PDF 的文字。
 * 引擎不可用（未随包分发）时整块禁用并提示。
 */
export function OcrSection() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const [sourceLabel, setSourceLabel] = useState<string>("");

  useEffect(() => {
    ocrApi.available().then(setAvailable).catch(() => setAvailable(false));
  }, []);

  async function ocrImage() {
    const file = await openFileDialog({
      multiple: false,
      title: "选择图片",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp", "gif"] }],
    });
    if (!file) return;
    setBusy(true);
    setResult("");
    const hide = message.loading("正在识别图片…", 0);
    try {
      const text = await ocrApi.image(file as string);
      setResult(text);
      setSourceLabel(`图片：${file}`);
      hide();
      if (!text.trim()) message.info("未识别到文字");
    } catch (e) {
      hide();
      message.error(`识别失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function ocrPdf() {
    const file = await openFileDialog({
      multiple: false,
      title: "选择扫描件 PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!file) return;
    setBusy(true);
    setResult("");
    const hide = message.loading("正在逐页识别 PDF（可能较慢）…", 0);
    try {
      const text = await ocrApi.pdf(file as string);
      setResult(text);
      setSourceLabel(`PDF：${file}`);
      hide();
      if (!text.trim()) message.info("未识别到文字");
    } catch (e) {
      hide();
      message.error(`识别失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNote() {
    if (!result.trim()) return;
    try {
      const title = `OCR 识别 ${new Date().toLocaleString()}`;
      await noteApi.create({ title, content: result });
      message.success("已存为新笔记");
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      message.success("已复制");
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Card
      id="settings-ocr"
      title={
        <span className="flex items-center gap-2">
          <ScanText size={16} />
          本地 OCR
          <span className="kb-set-note">图片 / 扫描件识别</span>
          {available === true && <Tag color="green">引擎就绪</Tag>}
          {available === false && <Tag>引擎未安装</Tag>}
        </span>
      }
    >
      {available === false ? (
        <Alert
          type="warning"
          showIcon
          message="本地 OCR 引擎未随当前安装包分发，OCR 功能不可用。"
        />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="离线本地识别（RapidOCR），支持中英文。识别图片文字，或把无文本层的扫描件 PDF 逐页转成文字。"
          />
          <Space wrap className="mb-3">
            <Button
              icon={<FileImage size={16} />}
              loading={busy}
              disabled={available !== true}
              onClick={() => void ocrImage()}
            >
              识别图片…
            </Button>
            <Button
              icon={<FileText size={16} />}
              loading={busy}
              disabled={available !== true}
              onClick={() => void ocrPdf()}
            >
              识别扫描件 PDF…
            </Button>
          </Space>

          {(result || sourceLabel) && (
            <div>
              {sourceLabel && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {sourceLabel}
                </Text>
              )}
              <Input.TextArea
                className="mt-1"
                value={result}
                onChange={(e) => setResult(e.target.value)}
                rows={8}
                placeholder="识别结果显示在这里，可编辑后再保存"
              />
              <Space className="mt-2">
                <Button type="primary" onClick={() => void saveAsNote()} disabled={!result.trim()}>
                  存为新笔记
                </Button>
                <Button onClick={() => void copyResult()} disabled={!result}>
                  复制
                </Button>
              </Space>
            </div>
          )}

          {available === null && (
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
              正在检测引擎…
            </Paragraph>
          )}
        </>
      )}
    </Card>
  );
}
