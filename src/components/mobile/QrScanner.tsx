import { useEffect, useId, useRef } from "react";
import { message } from "antd";
import type { Html5Qrcode } from "html5-qrcode";

/**
 * 手机端扫码框（局域网同步配对等用）。挂载即开后置摄像头，扫到第一个码回调后自动停止。
 *
 * 写法同 config-share/ImportConfigModal：扫码库按需动态加载，不进主包；
 * 摄像头权限走 WebView getUserMedia（AndroidManifest 已声明 CAMERA）。
 */
export function QrScanner({ onResult, onError }: { onResult: (text: string) => void; onError?: () => void }) {
  const id = `qr-${useId().replace(/:/g, "")}`;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // 回调放 ref：父组件每次渲染传新函数也不重启摄像头
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let stopped = false;
    async function stop() {
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
      try {
        if (s.isScanning) await s.stop();
        await s.clear();
      } catch {
        // 清理失败静默
      }
    }
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (stopped) return;
        const qr = new Html5Qrcode(id);
        scannerRef.current = qr;
        await qr.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 240 },
          (decoded) => {
            if (stopped) return;
            stopped = true;
            void stop();
            onResultRef.current(decoded);
          },
          () => {
            // 每帧未命中是常态，不打日志
          },
        );
      } catch (e) {
        message.error(`摄像头启动失败：${e}`);
        onError?.();
      }
    })();
    return () => {
      stopped = true;
      void stop();
    };
    // 只在挂载时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div id={id} style={{ width: "100%", minHeight: 240, borderRadius: 8, overflow: "hidden", background: "#000" }} />;
}
