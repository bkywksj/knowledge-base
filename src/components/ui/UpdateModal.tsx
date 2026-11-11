import { useEffect, useState } from "react";
import { Modal, Button, Progress, Typography, Space, Alert, Collapse, Tag } from "antd";
import {
  CheckCircleOutlined,
  SyncOutlined,
  DownloadOutlined,
  PauseOutlined,
  CaretRightOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUpdater } from "@/components/updater/UpdaterProvider";

const { Text, Paragraph } = Typography;

/**
 * 自动更新失败时的"手动下载"备选地址。
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 剩余时间：速度为 0（刚开始 / 卡住）时不显示，免得出现「约 ∞ 秒」 */
function formatEta(remaining: number, speed: number): string | null {
  if (speed <= 0 || remaining <= 0) return null;
  const secs = Math.ceil(remaining / speed);
  if (secs < 60) return `约 ${secs} 秒`;
  if (secs < 3600) return `约 ${Math.ceil(secs / 60)} 分钟`;
  return "超过 1 小时";
}

/**
 * 软件更新弹窗。状态全部来自全局更新状态（Rust 那一份），这里只负责显示和按钮。
 *
 * 配合「后台预下载」：多数时候用户点开时已经下好（ready），直接「立即重启」秒装；
 * 还在下就显示进度，可暂停 / 关掉弹窗后台继续；下载失败列出每个源的原因，并给镜像页手动下载兜底。
 */
export function UpdateModal() {
  const updater = useUpdater();
  const [currentVersion, setCurrentVersion] = useState("");

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  if (!updater) return null;
  const {
    update,
    phase,
    progress,
    downloadedSize,
    totalSize,
    speed,
    source,
    notice,
    error,
    failures,
    modalOpen,
    closeModal,
    startDownload,
    pauseDownload,
    cancelDownload,
    installAndRelaunch,
    installOnNextLaunch,
    installCurrentOnNextLaunch,
  } = updater;

  const downloading = phase === "downloading";
  const paused = phase === "paused";
  const verifying = phase === "verifying";
  const ready = phase === "ready";
  const installing = phase === "installing";
  const failed = phase === "error";

  function handleClose() {
    // 只有安装中不允许关（安装器马上要接管进程）。下载中关掉弹窗不会中断下载：
    // 只是隐藏，下载在 Rust 后台继续，右上角徽章继续显示进度。
    if (installing) return;
    closeModal();
  }

  const title = ready
    ? `${update?.version ?? ""} 已准备好`
    : paused
      ? "下载已暂停"
      : failed
        ? `${update?.version ?? ""} 下载失败`
        : `发现新版本 ${update?.version ?? ""}`;

  const sizeLine = totalSize > 0 ? `${formatSize(Math.min(downloadedSize, totalSize))} / ${formatSize(totalSize)}` : formatSize(downloadedSize);
  const eta = formatEta(totalSize - downloadedSize, speed);

  return (
    <Modal
      title={title}
      open={modalOpen}
      onCancel={handleClose}
      closable={!installing}
      maskClosable={!installing}
      footer={renderFooter()}
    >
      {update && (
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {currentVersion && `当前 ${currentVersion}`}
            {totalSize > 0 && ` · 安装包 ${formatSize(totalSize)}`}
          </Text>

          {update.body && (
            <Collapse
              className="mt-3"
              size="small"
              // 下载失败 / 暂停时用户关心的是怎么处理，更新内容先收起
              defaultActiveKey={failed || paused ? [] : ["body"]}
              items={[
                {
                  key: "body",
                  label: "更新内容",
                  children: (
                    <div style={{ maxHeight: 200, overflow: "auto" }}>
                      <Text style={{ whiteSpace: "pre-wrap" }}>{update.body}</Text>
                    </div>
                  ),
                },
              ]}
            />
          )}

          {(downloading || paused || verifying) && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <span className="flex items-center gap-2">
                  {downloading && <SyncOutlined spin />}
                  {paused && <PauseOutlined />}
                  {verifying && <SafetyCertificateOutlined />}
                  <Text>{verifying ? "正在校验更新包签名…" : paused ? "已暂停" : "正在后台下载"}</Text>
                </span>
                {source && !verifying && <Tag bordered={false}>{source}</Tag>}
              </div>
              <Progress percent={verifying ? 100 : progress} status={paused ? "normal" : "active"} showInfo />
              <Text type="secondary" className="text-xs">
                {sizeLine}
                {downloading && speed > 0 && ` · ${formatSize(speed)}/s`}
                {downloading && eta && ` · ${eta}`}
                {downloading && speed === 0 && downloadedSize > 0 && " · 正在连接…"}
              </Text>
              {notice && downloading && (
                <Alert className="mt-3" type="info" showIcon message={notice} />
              )}
              <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                {paused
                  ? "取消会删除已下载的部分；只是暂停的话，重启应用后也能接着下。"
                  : "可以关掉这个窗口继续使用，下载在后台进行，进度见右上角版本号；下完会自动校验，再提示你重启。"}
              </Paragraph>
            </div>
          )}

          {(ready || installing) && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                {installing ? (
                  <SyncOutlined spin />
                ) : (
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success, #52c41a)", fontSize: 16 }} />
                )}
                <Text>{installing ? "正在安装并重启…" : "更新包签名校验通过"}</Text>
              </div>
              {ready && (
                <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                  已下载的更新包会保留，关掉应用也不用重下。
                  {installOnNextLaunch && "下次启动应用时会自动安装。"}
                </Paragraph>
              )}
              {error && (
                <Alert className="mt-3" type="error" showIcon message="安装没有完成" description={error} />
              )}
            </div>
          )}

          {failed && (
            <div className="mt-4">
              <Paragraph type="danger" style={{ marginBottom: 8 }}>
                {error ?? "自动下载失败"}
                {downloadedSize > 0 && `（已保留 ${formatSize(downloadedSize)}，重试会接着下）`}
              </Paragraph>
              {failures.length > 0 && (
                <Collapse
                  size="small"
                  items={[
                    {
                      key: "failures",
                      label: `${failures.length} 个下载源都没连上`,
                      children: (
                        <Space direction="vertical" size={4} style={{ width: "100%" }}>
                          {failures.map((f) => (
                            <div key={f.source} className="flex gap-2 text-xs">
                              <Text strong style={{ fontSize: 12, flexShrink: 0 }}>
                                {f.source}
                              </Text>
                              <Text type="secondary" style={{ fontSize: 12, wordBreak: "break-all" }}>
                                {f.reason}
                              </Text>
                            </div>
                          ))}
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
              {failures.some((f) => /proxy|代理/i.test(f.reason)) && (
                <Alert
                  className="mt-3"
                  type="warning"
                  showIcon
                  message="看起来是系统里设置的代理没在运行：关掉代理设置，或打开代理软件后重试。"
                />
              )}
              <Paragraph type="secondary" style={{ fontSize: 12, margin: "12px 0 8px" }}>
                也可以从下面任一镜像页手动下载安装：
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
            </div>
          )}
        </div>
      )}
    </Modal>
  );

  function renderFooter() {
    if (ready) {
      return (
        <Space>
          {!installOnNextLaunch && (
            <Button
              onClick={() => {
                void installCurrentOnNextLaunch();
                closeModal();
              }}
            >
              下次启动时安装
            </Button>
          )}
          <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => void installAndRelaunch()}>
            立即重启
          </Button>
        </Space>
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
      return (
        <Space>
          <Button icon={<PauseOutlined />} onClick={pauseDownload}>
            暂停
          </Button>
          <Button type="primary" onClick={handleClose}>
            后台下载
          </Button>
        </Space>
      );
    }
    if (verifying) {
      return <Button onClick={handleClose}>后台进行</Button>;
    }
    if (paused) {
      return (
        <Space>
          <Button type="text" danger onClick={cancelDownload}>
            取消下载
          </Button>
          <Button type="primary" icon={<CaretRightOutlined />} onClick={startDownload}>
            继续
          </Button>
        </Space>
      );
    }
    if (failed) {
      return (
        <Space>
          <Button onClick={handleClose}>稍后</Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={startDownload}>
            重试
          </Button>
        </Space>
      );
    }
    // available：关了自动更新、或取消过下载
    return (
      <Space>
        <Button onClick={handleClose}>稍后</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={startDownload}>
          立即下载
        </Button>
      </Space>
    );
  }
}
