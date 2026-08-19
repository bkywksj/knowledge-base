/**
 * T-013 完整版 — 数据目录迁移 splash 窗口
 *
 * 启动早期由 lib.rs::run_data_dir_migration_with_splash 创建，URL 是
 * `index.html#/migration-splash`。这个独立窗口在主窗 visible:false 期间
 * 顶替主窗显示进度，迁移完后被 Rust 端 close。
 *
 * 注意：
 * - 这个页面用同一个 React 包 + HashRouter 路由分发，省事但意味着会跑一遍 antd
 *   ConfigProvider；冷启动 ~100-200ms 才能 listen 上事件。lib.rs 那边在
 *   open splash 后 sleep 300ms 再开始 emit，确保我们订阅好。
 * - 不要在这个窗口里调任何需要 db 的 API（迁移期间 db 还没初始化）。
 */
import { useEffect, useState } from "react";
import {
  Alert,
  ConfigProvider,
  Progress,
  Result,
  Spin,
  Typography,
  theme,
} from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { dataDirApi } from "@/lib/api";
import type { MigrationMarker, MigrationProgress } from "@/types";

const { Text, Paragraph } = Typography;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function MigrationSplash() {
  const [marker, setMarker] = useState<MigrationMarker | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        // 拉一次初始 marker（用户能看到从哪迁到哪）
        const m = await dataDirApi.getMigrationMarker();
        setMarker(m);
      } catch {
        // 忽略 — splash 早期 marker 可能不存在
      }
      unlisten = await listen<MigrationProgress>(
        "data_dir:migrate_progress",
        (e) => {
          setProgress(e.payload);
          if (e.payload.phase === "done") setDone(true);
          if (e.payload.phase === "error") {
            setError(e.payload.message);
          }
        },
      );
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const percent = progress
    ? progress.bytesTotal > 0
      ? Math.min(
          100,
          Math.round((progress.bytesDone / progress.bytesTotal) * 100),
        )
      : 0
    : 0;

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#7c3aed",
        },
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          height: "100vh",
          width: "100vw",
          padding: 24,
          background:
            "linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "hidden",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
        }}
      >
        <div className="flex items-center gap-2">
          <Spin spinning={!done && !error} size="small" />
          <Text strong style={{ fontSize: 16 }}>
            {error ? "迁移失败" : done ? "迁移完成" : "正在迁移数据目录"}
          </Text>
        </div>

        {marker && (
          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
            <div>
              <Text type="secondary">从：</Text>
              <Text code style={{ fontSize: 11 }}>
                {marker.from}
              </Text>
            </div>
            <div>
              <Text type="secondary">到：</Text>
              <Text code style={{ fontSize: 11 }}>
                {marker.to}
              </Text>
            </div>
          </div>
        )}

        {error ? (
          <>
            <Result
              status="error"
              title="迁移失败"
              subTitle={error}
              style={{ padding: "8px 0" }}
            />
            {/* 关键的安心话术：失败不会丢数据、也不会卡住启动。
                Rust 侧失败后会把指针退回源目录并照常启动主窗口（见 lib.rs 的降级分支）。 */}
            <Alert
              type="info"
              showIcon
              message="数据没有丢失，应用会继续启动"
              description={
                <span style={{ fontSize: 12 }}>
                  本次仍使用原来的数据目录。进入主界面后可在弹出的提示里选择「重试迁移」或「放弃迁移」。
                </span>
              }
              style={{ marginTop: "auto" }}
            />
          </>
        ) : done ? (
          <Result
            status="success"
            title="完成"
            subTitle={progress?.message ?? "数据迁移完成，应用即将进入"}
            style={{ padding: "8px 0" }}
          />
        ) : (
          <>
            <Progress
              percent={percent}
              status={percent < 100 ? "active" : "success"}
              size="small"
              strokeColor={{ from: "#7c3aed", to: "#3b82f6" }}
            />

            {progress && (
              <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }}>
                <Paragraph
                  style={{ margin: 0 }}
                  ellipsis={{ rows: 1, tooltip: progress.currentFile }}
                >
                  <Text type="secondary">当前：</Text>
                  {progress.currentFile || progress.message}
                </Paragraph>
                <Paragraph style={{ margin: 0 }}>
                  <Text type="secondary">已传：</Text>
                  {formatBytes(progress.bytesDone)} /{" "}
                  {formatBytes(progress.bytesTotal)}
                  {progress.itemTotal > 0 && (
                    <>
                      {" · "}
                      <Text type="secondary">项：</Text>
                      {progress.itemIndex} / {progress.itemTotal}
                    </>
                  )}
                </Paragraph>
              </div>
            )}

            <Alert
              type="info"
              showIcon
              message="请勿关闭应用"
              description={
                <span style={{ fontSize: 12 }}>
                  迁移期间应用窗口暂时不可见；完成后自动进入主界面。
                  跨盘大文件复制可能需要 30 秒~几分钟（取决于附件大小）。
                </span>
              }
              style={{ marginTop: "auto" }}
            />
          </>
        )}
      </div>
    </ConfigProvider>
  );
}
