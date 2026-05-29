import { Modal, Button, Progress, Typography, Space } from "antd";
import { CheckCircleOutlined, SyncOutlined, DownloadOutlined } from "@ant-design/icons";
import type { Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdatePhase } from "@/hooks/useUpdateChecker";

const { Text, Paragraph } = Typography;

/**
 * 自动更新失败时的"手动下载"备选地址。
 * 顺序与 tauri.conf.json 的 updater.endpoints 一致：R2 → Gitee → GitHub。
 * R2 是裸文件存储没有 release 页，所以只暴露 Gitee / GitHub 两个 release 页。
 */
const FALLBACK_DOWNLOAD_PAGES = [
  {
    label: "Gitee Releases（国内推荐）",
    url: "https://gitee.com/bkywksj/knowledge-base-release/releases",
  },
  {
    label: "GitHub Releases（海外）",
    url: "https://github.com/bkywksj/knowledge-base-release/releases",
  },
];

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  update: Update | null;
  /** 更新生命周期状态（由 useUpdateChecker 驱动）。 */
  phase: UpdatePhase;
  progress: number;
  downloadedSize: number;
  totalSize: number;
  error: string | null;
  /** 触发/重试后台下载。 */
  onStartDownload: () => void;
  /** 安装已下载好的更新并重启（秒装）。 */
  onInstall: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 软件更新弹窗。
 *
 * 配合「后台预下载」模式：多数情况下用户点开时下载早已在后台完成（phase=ready），
 * 直接点「立即重启」即可秒装；若仍在下载则显示进度；下载失败给镜像手动下载兜底。
 */
export function UpdateModal({
  open,
  onClose,
  update,
  phase,
  progress,
  downloadedSize,
  totalSize,
  error,
  onStartDownload,
  onInstall,
}: UpdateModalProps) {
  const downloading = phase === "downloading";
  const ready = phase === "ready";
  const installing = phase === "installing";
  const failed = phase === "error";

  function handleClose() {
    // 下载中 / 安装中不允许关闭，避免误操作中断。
    if (downloading || installing) return;
    onClose();
  }

  return (
    <Modal
      title="软件更新"
      open={open}
      onCancel={handleClose}
      closable={!downloading && !installing}
      maskClosable={!downloading && !installing}
      footer={renderFooter()}
    >
      {update && (
        <div>
          <Paragraph>
            <Text strong>新版本：</Text>
            <Text>{update.version}</Text>
          </Paragraph>

          {update.body && (
            <Paragraph>
              <Text strong>更新内容：</Text>
              <div
                className="mt-2 p-3 rounded-md"
                style={{ background: "rgba(0,0,0,0.04)", maxHeight: 220, overflow: "auto" }}
              >
                <Text style={{ whiteSpace: "pre-wrap" }}>{update.body}</Text>
              </div>
            </Paragraph>
          )}

          {downloading && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <SyncOutlined spin />
                <Text>正在后台下载更新...</Text>
              </div>
              <Progress percent={progress} />
              {totalSize > 0 && (
                <Text type="secondary" className="text-xs">
                  {/* 以 contentLength 为权威总大小，已下载 clamp 到不超过总大小，
                      避免下载统计虚高时出现「18.7 MB / 13.6 MB」这种已下载 > 总的观感。 */}
                  {formatSize(Math.min(downloadedSize, totalSize))} / {formatSize(totalSize)}
                </Text>
              )}
            </div>
          )}

          {ready && (
            <div className="mt-4 flex items-center gap-2">
              <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 18 }} />
              <Text>更新已下载完成，点「立即重启」即可秒速完成安装</Text>
            </div>
          )}

          {installing && (
            <div className="mt-4 flex items-center gap-2">
              <SyncOutlined spin />
              <Text>正在安装并重启...</Text>
            </div>
          )}

          {failed && (
            <div className="mt-4">
              <Paragraph type="danger" style={{ marginBottom: 8 }}>
                自动下载失败，可重试或从下方任一镜像页手动下载安装：
              </Paragraph>
              <Space direction="vertical" style={{ width: "100%" }}>
                {FALLBACK_DOWNLOAD_PAGES.map((page) => (
                  <Button
                    key={page.url}
                    block
                    onClick={() => void openUrl(page.url)}
                    style={{ textAlign: "left" }}
                  >
                    {page.label}
                  </Button>
                ))}
              </Space>
              {error && (
                <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                  错误详情：{error}
                </Paragraph>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );

  function renderFooter() {
    if (ready) {
      return (
        <Button type="primary" icon={<CheckCircleOutlined />} onClick={onInstall}>
          立即重启
        </Button>
      );
    }
    if (installing) {
      return (
        <Button type="primary" loading disabled>
          正在重启…
        </Button>
      );
    }
    if (downloading) {
      // 下载中不给操作，只能等（不可关闭）。
      return null;
    }
    if (failed) {
      return (
        <Space>
          <Button onClick={handleClose}>稍后</Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={onStartDownload}>
            重新下载
          </Button>
        </Space>
      );
    }
    // available：后台下载通常已自动开始；这里兜底给一个立即下载按钮。
    return (
      <Space>
        <Button onClick={handleClose}>稍后</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={onStartDownload}>
          立即下载
        </Button>
      </Space>
    );
  }
}
