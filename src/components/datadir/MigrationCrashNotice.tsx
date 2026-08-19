/**
 * 「上次数据迁移未完成」提示（T-013 迁移失败的用户出口）
 *
 * 背景：数据目录迁移在启动早期由 Rust 侧执行。以前迁移一失败就让 setup 返回 Err，
 * Tauri 内部 expect 直接 panic —— 用户每次启动都崩、marker 每次都还在，
 * 被锁死在「启动即崩」的循环里（v1.52.0 线上事故：旧数据目录在网盘挂载盘上，
 * 重装系统后网盘客户端没运行，读源目录报 os error 362）。
 *
 * 现在 Rust 侧失败后降级继续启动、把 marker 标成 `crashed` 并记下原因，
 * 由这个组件在主窗口把出路交还给用户：重试 / 放弃 / 稍后处理。
 *
 * 仅挂在主窗口（见 App.tsx）——splash 等子窗口不需要。
 */
import { useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Modal,
  Space,
  Typography,
} from "antd";
import { relaunch } from "@tauri-apps/plugin-process";
import { dataDirApi } from "@/lib/api";
import type { MigrationMarker, ResolvedDataDir } from "@/types";

const { Text, Paragraph } = Typography;

export function MigrationCrashNotice() {
  const { message } = AntdApp.useApp();
  const [marker, setMarker] = useState<MigrationMarker | null>(null);
  const [info, setInfo] = useState<ResolvedDataDir | null>(null);
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const m = await dataDirApi.getMigrationMarker();
        // 只处理 crashed：pending 是「等重启执行」的正常状态，弹窗反而吓人
        if (m?.status !== "crashed") return;
        setMarker(m);
        setOpen(true);
        // 当前实际生效的数据目录，用来告诉用户"现在用的是哪一个"
        try {
          setInfo(await dataDirApi.getInfo());
        } catch {
          // 拿不到就不显示这一行，不影响主要功能
        }
      } catch {
        // 读 marker 失败不打扰用户：本来就是兜底提示
      }
    })();
  }, []);

  /** 部分文件已搬走 → 两个目录各有一半数据，措辞和后果都不一样 */
  const partiallyMoved = (marker?.completed_items.length ?? 0) > 0;

  async function handleRetry() {
    if (acting) return;
    setActing(true);
    // 两步分开 catch：状态重置成功但重启失败时，绝不能报「重试失败」——
    // 那是假的，marker 已经是 pending 了，用户手动重启一样会执行迁移。
    try {
      await dataDirApi.retryPendingMigration();
    } catch (e) {
      message.error(`重试失败: ${e}`);
      setActing(false);
      return;
    }
    try {
      message.success("已重置为待迁移，正在重启应用…");
      // 迁移必须在启动早期做（此刻进程正握着 db 连接，当场搬文件会写坏数据）
      await relaunch();
    } catch (e) {
      message.warning(`已重置为待迁移，但自动重启失败（${e}）。请手动关闭并重新打开应用。`);
      setOpen(false);
      setActing(false);
    }
  }

  async function handleGiveUp() {
    if (acting) return;
    setActing(true);
    try {
      await dataDirApi.cancelPendingMigration();
      message.success("已放弃本次迁移，数据目录保持在原位置");
      setOpen(false);
    } catch (e) {
      message.error(`放弃失败: ${e}`);
    } finally {
      setActing(false);
    }
  }

  if (!marker) return null;

  return (
    <Modal
      title="上次数据迁移未完成"
      open={open}
      onCancel={() => setOpen(false)}
      width={640}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={() => setOpen(false)} disabled={acting}>
            稍后处理
          </Button>
          <Button danger onClick={handleGiveUp} loading={acting}>
            放弃迁移
          </Button>
          <Button type="primary" onClick={handleRetry} loading={acting}>
            重试并重启
          </Button>
        </Space>
      }
    >
      <div className="text-sm leading-6">
        <div className="mb-1">
          <Text type="secondary">从：</Text>
          <Text code>{marker.from}</Text>
        </div>
        <div className="mb-3">
          <Text type="secondary">到：</Text>
          <Text code>{marker.to}</Text>
        </div>

        {marker.last_error && (
          <Alert
            type="error"
            showIcon
            className="mb-3"
            message="失败原因"
            description={
              <Paragraph
                copyable={{ text: marker.last_error }}
                style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}
              >
                {marker.last_error}
              </Paragraph>
            }
          />
        )}

        {partiallyMoved ? (
          <Alert
            type="warning"
            showIcon
            className="mb-3"
            message={`已迁移 ${marker.completed_items.length} 项后中断，数据目前分散在两个目录`}
            description={
              <span style={{ fontSize: 12 }}>
                建议先排除上面的失败原因，再点「重试并重启」把剩下的搬完（已完成的项会跳过，不会重复复制）。
                此时点「放弃迁移」会把数据目录退回原位置，但已经搬走的文件仍留在新目录，需要你手动搬回去。
              </span>
            }
          />
        ) : (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message="没有任何文件被移动，数据完好"
            description={
              <span style={{ fontSize: 12 }}>
                本次启动仍在使用原来的数据目录
                {info ? <Text code>{info.currentDir}</Text> : null}。
                排除失败原因（例如启动网盘客户端、接上移动硬盘）后再点「重试并重启」；
                不想迁移了就点「放弃迁移」。
              </span>
            }
          />
        )}

        <Text type="secondary" style={{ fontSize: 12 }}>
          迁移只能在应用启动早期执行 —— 运行中的应用正占用数据库，所以「重试」会重启应用。
        </Text>
      </div>
    </Modal>
  );
}
