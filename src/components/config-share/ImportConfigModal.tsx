import { useEffect, useRef, useState } from "react";
import { Modal, Tabs, message, Alert, Input } from "antd";
import { ClipboardPaste, ScanLine, Lock } from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  KIND_LABELS,
  applyEnvelope,
  parseEnvelope,
  type Envelope,
} from "@/lib/configShare";

/**
 * 配置导入弹窗。
 *
 * 三种导入路径：
 *   - JSON 文本：用户从其他设备复制 envelope，粘贴到 textarea
 *   - 剪贴板：一键 navigator.clipboard.readText（移动端 WebView 支持）
 *   - 扫码：调摄像头扫 QR（用 html5-qrcode 封装 zxing）
 *
 * 解析 → 预览 envelope.kind → 用户确认 → applyEnvelope 写后端 → onImported 回调刷新列表
 */
export function ImportConfigModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}) {
  const [tab, setTab] = useState<"paste" | "scan">("paste");
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Envelope | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [needPin, setNeedPin] = useState(false);
  const [pin, setPin] = useState("");
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scanContainerId = "config-import-qr-reader";

  // 解析 text + pin → envelope。
  // 1) PIN 长度门槛：默认 6 位，用户边敲边解密会在第 1-5 位时全部失败弹红色，体验差。
  //    < 4 位时不带 PIN 调用，仅检测是否加密 envelope（设 needPin=true，不报错）。
  // 2) debounce 350ms：PBKDF2 100k 迭代算一次约 50-100ms，连续按键不必每次跑。
  useEffect(() => {
    if (!text.trim()) {
      setParsed(null);
      setParseErr(null);
      setNeedPin(false);
      return;
    }
    let alive = true;
    const tryPin = pin.length >= 4 ? pin : undefined;
    const timer = setTimeout(async () => {
      const r = await parseEnvelope(text, tryPin);
      if (!alive) return;
      if (r.ok) {
        setParsed(r.envelope);
        setParseErr(null);
        setNeedPin(false);
      } else {
        setParsed(null);
        if ("encrypted" in r && r.encrypted) {
          setNeedPin(true);
          setParseErr(null); // 加密但未输够 PIN 不当错误
        } else if (tryPin) {
          // 已尝试解密但失败 → 真的是 PIN 错
          setParseErr("PIN 错误或数据损坏");
        } else {
          setNeedPin(false);
          setParseErr(r.reason);
        }
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, pin]);

  // Modal 关闭时清场
  useEffect(() => {
    if (!open) {
      setText("");
      setParsed(null);
      setParseErr(null);
      setNeedPin(false);
      setPin("");
      setTab("paste");
      void stopScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function pasteFromClipboard() {
    // 优先走 Tauri 原生剪贴板插件 — Android WebView 的 navigator.clipboard.readText
    // 默认被禁；plugin 走 JNI 直接读系统剪贴板，桌面 / 移动端都能用。
    // 退路：如果 plugin 调用异常（例如开发服务器尚未注入 IPC），再尝试浏览器 API。
    let t = "";
    try {
      t = await readClipboardText();
    } catch {
      try {
        t = await navigator.clipboard.readText();
      } catch {
        message.error("剪贴板读取失败（请手动粘贴）");
        return;
      }
    }
    if (!t?.trim()) {
      message.warning("剪贴板是空的");
      return;
    }
    setText(t);
    message.success("已粘贴");
  }

  async function startScan() {
    if (scanning) return;
    setScanning(true);
    try {
      // 等 DOM 渲染出 reader 容器
      await new Promise((r) => setTimeout(r, 50));
      const html5Qr = new Html5Qrcode(scanContainerId);
      scannerRef.current = html5Qr;
      await html5Qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 240 },
        (decoded) => {
          // 命中即停 + 自动切回粘贴标签让用户看到内容
          setText(decoded);
          setTab("paste");
          void stopScan();
        },
        () => {
          // 每帧未命中是常态，不打日志
        },
      );
    } catch (e) {
      message.error(`摄像头启动失败：${e}`);
      setScanning(false);
    }
  }

  async function stopScan() {
    const s = scannerRef.current;
    if (s) {
      try {
        if (s.isScanning) await s.stop();
        await s.clear();
      } catch {
        // 清理失败静默
      }
      scannerRef.current = null;
    }
    setScanning(false);
  }

  async function doImport() {
    if (!parsed || importing) return;
    setImporting(true);
    try {
      const summary = await applyEnvelope(parsed);
      const lines: string[] = [];
      if (summary.syncBackends > 0)
        lines.push(`✓ 同步源 ${summary.syncBackends} 个`);
      if (summary.aiModels > 0)
        lines.push(`✓ AI 模型 ${summary.aiModels} 个`);
      if (summary.asrConfig) lines.push("✓ 语音识别配置");
      if (summary.featureToggles) lines.push("✓ 功能开关");
      // 导入成功但要提醒的（如 Anthropic 协议的配置），不能混进 errors 里当失败
      if (summary.warnings.length > 0) {
        message.warning({ content: summary.warnings.join("\n"), duration: 8 });
      }
      if (summary.errors.length > 0) {
        message.error(
          `部分失败：\n${summary.errors.join("\n")}` +
            (lines.length ? `\n\n已成功：\n${lines.join("\n")}` : ""),
          5,
        );
      } else {
        message.success(`导入完成：${lines.join(" · ") || "（未发现可导入项）"}`);
        onImported?.();
        onClose();
      }
    } catch (e) {
      message.error(`导入失败：${e}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="导入配置"
      footer={null}
      destroyOnClose
      width={460}
      onOk={doImport}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => {
          setTab(k as typeof tab);
          if (k !== "scan") void stopScan();
        }}
        items={[
          {
            key: "paste",
            label: "JSON / 剪贴板",
            children: (
              <div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder='粘贴 envelope JSON，例如：\n{"kbConfig":"v1","kind":"webdav-backend","data":{...}}'
                  className="w-full h-40 rounded-lg border border-slate-200 p-3 font-mono text-xs leading-relaxed"
                />
                <button
                  onClick={pasteFromClipboard}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-700 active:bg-slate-50"
                >
                  <ClipboardPaste size={14} /> 从剪贴板读取
                </button>
              </div>
            ),
          },
          {
            key: "scan",
            label: "扫码",
            children: (
              <div className="flex flex-col items-center gap-3">
                <div
                  id={scanContainerId}
                  className="w-full overflow-hidden rounded-lg border border-slate-200"
                  style={{ minHeight: 280 }}
                />
                {!scanning ? (
                  <button
                    onClick={startScan}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#1677FF] py-2 text-sm font-medium text-white active:scale-95"
                  >
                    <ScanLine size={14} /> 启动摄像头
                  </button>
                ) : (
                  <button
                    onClick={() => void stopScan()}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-700"
                  >
                    停止扫描
                  </button>
                )}
                <p className="text-center text-xs text-slate-500">
                  对准对方设备「分享」页面的二维码
                </p>
              </div>
            ),
          },
        ]}
      />

      {/* 加密 envelope → 让用户输 PIN */}
      {needPin && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-blue-700">
            <Lock size={12} />
            此配置已加密，请输入分享方提供的 PIN
          </div>
          <Input.Password
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="6 位数字 PIN（默认）"
            autoComplete="off"
            autoFocus
          />
        </div>
      )}

      {/* 解析结果预览 */}
      {parseErr && (
        <Alert type="error" showIcon className="!mt-3" message={parseErr} />
      )}
      {parsed && (
        <Alert
          type="success"
          showIcon
          className="!mt-3"
          message={`识别到：${KIND_LABELS[parsed.kind]}`}
          description={
            parsed.kind === "webdav-backend"
              ? `名称：${parsed.data.name} · URL：${parsed.data.config.url}`
              : parsed.kind === "sync-backend"
                ? `名称：${parsed.data.name} · 类型：${
                    { local: "本地路径", webdav: "WebDAV", s3: "S3 兼容" }[
                      parsed.data.kind
                    ]
                  }`
              : parsed.kind === "ai-model"
                ? `名称：${parsed.data.name} · ${parsed.data.provider} · ${parsed.data.model_id}`
                : parsed.kind === "asr-config"
                  ? `服务商：${parsed.data.provider} · 模型：${parsed.data.model} · 区域：${parsed.data.region}`
                  : parsed.kind === "feature-toggles"
                    ? "包含功能开关偏好"
                    : "包含多项配置"
          }
        />
      )}

      <div className="mt-4 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-700"
        >
          取消
        </button>
        <button
          onClick={doImport}
          disabled={!parsed || importing}
          className="flex-1 rounded-lg bg-[#1677FF] py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {importing ? "导入中…" : "导入"}
        </button>
      </div>
    </Modal>
  );
}
