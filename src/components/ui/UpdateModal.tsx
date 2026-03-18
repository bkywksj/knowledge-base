import { useState, useRef } from "react";
import { Modal, Button, Progress, Typography, Space } from "antd";
import { CheckCircleOutlined, SyncOutlined } from "@ant-design/icons";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const { Text, Paragraph } = Typography;

type UpdateStatus = "found" | "downloading" | "downloaded";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  update: Update | null;
}

export function UpdateModal({ open, onClose, update }: UpdateModalProps) {
  const [status, setStatus] = useState<UpdateStatus>("found");
  const [progress, setProgress] = useState(0);
  const [downloadedSize, setDownloadedSize] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const totalSizeRef = useRef(0);

  async function handleInstall() {
    if (!update) return;

    setStatus("downloading");
    setProgress(0);

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalSizeRef.current = event.data.contentLength;
          setTotalSize(event.data.contentLength);
        } else if (event.event === "Progress") {
          setDownloadedSize((prev) => {
            const newSize = prev + event.data.chunkLength;
            if (totalSizeRef.current > 0) {
              setProgress(Math.round((newSize / totalSizeRef.current) * 100));
            }
            return newSize;
          });
        } else if (event.event === "Finished") {
          setStatus("downloaded");
          setProgress(100);
        }
      });

      setStatus("downloaded");
    } catch (e) {
      Modal.error({ title: "更新失败", content: String(e) });
      setStatus("found");
    }
  }

  async function handleRelaunch() {
    await relaunch();
  }

  function handleClose() {
    if (status === "downloading") return;
    setStatus("found");
    setProgress(0);
    setDownloadedSize(0);
    setTotalSize(0);
    onClose();
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <Modal
      title="软件更新"
      open={open}
      onCancel={handleClose}
      closable={status !== "downloading"}
      maskClosable={status !== "downloading"}
      footer={
        status === "found" ? (
          <Space>
            <Button onClick={handleClose}>稍后</Button>
            <Button type="primary" onClick={handleInstall}>
              安装更新
            </Button>
          </Space>
        ) : status === "downloaded" ? (
          <Button type="primary" onClick={handleRelaunch}>
            重启应用
          </Button>
        ) : null
      }
    >
      {update && (
        <div>
          <Paragraph>
            <Text strong>新版本：</Text>
            <Text>{update.version}</Text>
          </Paragraph>

          {update.body && (
            <Paragraph>
              <Text strong>更新日志：</Text>
              <div
                className="mt-2 p-3 rounded-md"
                style={{ background: "rgba(0,0,0,0.04)", maxHeight: 200, overflow: "auto" }}
              >
                <Text style={{ whiteSpace: "pre-wrap" }}>{update.body}</Text>
              </div>
            </Paragraph>
          )}

          {status === "downloading" && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <SyncOutlined spin />
                <Text>正在下载更新...</Text>
              </div>
              <Progress percent={progress} />
              {totalSize > 0 && (
                <Text type="secondary" className="text-xs">
                  {formatSize(downloadedSize)} / {formatSize(totalSize)}
                </Text>
              )}
            </div>
          )}

          {status === "downloaded" && (
            <div className="mt-4 flex items-center gap-2">
              <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 18 }} />
              <Text>下载完成，重启应用以完成更新</Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
