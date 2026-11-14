import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  InputNumber,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Typography,
  theme as antdTheme,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import QRCode from "qrcode";
import { lanSyncApi } from "@/lib/api";
import type { LanSyncStatus } from "@/types";

const { Text, Paragraph } = Typography;

/**
 * 局域网同步（手机 ↔ 本机）设置区。方案见 docs/tasks/lan-sync-tasks.md。
 *
 * 用户场景：在家用电脑记、外出用手机记，回家连同一个 Wi-Fi 同步一下，不经任何云端。
 * - 开启后电脑监听局域网端口，并自动建一个「局域网同步（本机中转）」同步源把笔记同步进中转库
 * - 二维码里带地址 / 证书指纹 / 配对令牌，手机扫码即配对；令牌只在这里渲染成二维码，不显示明文
 * - 「重新生成配对码」= 所有已配对设备失效，丢了手机或想踢掉某台设备时用
 */
export function LanSyncSection() {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const [status, setStatus] = useState<LanSyncStatus | null>(null);
  const [port, setPort] = useState<number>(47321);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await lanSyncApi.status();
      setStatus(s);
      setPort(s.port);
    } catch (e) {
      message.error(`读取局域网同步状态失败：${e}`);
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 服务在跑才生成二维码；配对码重置后 status 对象变化会重新生成
  useEffect(() => {
    if (!status?.running) {
      setQr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const payload = await lanSyncApi.pairingPayload();
        const url = await QRCode.toDataURL(payload, { margin: 1, width: 220, errorCorrectionLevel: "M" });
        if (!cancelled) setQr(url);
      } catch (e) {
        if (!cancelled) message.error(`生成配对二维码失败：${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, message]);

  async function handleToggle(on: boolean) {
    setBusy(true);
    try {
      setStatus(on ? await lanSyncApi.enable(port) : await lanSyncApi.disable());
      if (on) message.success("局域网同步已开启");
    } catch (e) {
      message.error(`${on ? "开启" : "关闭"}失败：${e}`);
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPairing() {
    setBusy(true);
    try {
      setStatus(await lanSyncApi.resetPairing());
      message.success("已重新生成配对码，之前配对的设备需要重新扫码");
    } catch (e) {
      message.error(`重新生成失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const running = status.running;

  return (
    <div>
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        在家里让手机和这台电脑直接同步，数据不经过任何云端。需要电脑开着知识库，两台设备连同一个 Wi-Fi。
        传输全程加密，只有扫过这台电脑二维码的设备才能连上。
      </Paragraph>

      <div className="flex items-center justify-between py-1">
        <Space>
          <Text>开启局域网同步</Text>
          {running ? <Tag color="success">运行中</Tag> : status.enabled ? <Tag color="warning">未运行</Tag> : null}
        </Space>
        <Switch checked={running} loading={busy} onChange={(v) => void handleToggle(v)} />
      </div>

      <div className="flex items-center justify-between py-1">
        <Text>端口</Text>
        <InputNumber
          min={1024}
          max={65535}
          value={port}
          disabled={running || busy}
          onChange={(v) => v && setPort(v)}
          style={{ width: 120 }}
        />
      </div>

      {status.enabled && !running && (
        <Alert
          type="warning"
          showIcon
          className="mt-2"
          message="已开启但服务没在运行（多半是端口被占用），换个端口再打开试试"
        />
      )}

      {running && (
        <>
          <div className="mt-3 flex gap-4" style={{ alignItems: "flex-start" }}>
            <div
              style={{
                width: 220,
                height: 220,
                flexShrink: 0,
                borderRadius: 8,
                background: "#fff",
                border: `1px solid ${token.colorBorderSecondary}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {qr ? <img src={qr} alt="局域网同步配对二维码" width={210} height={210} /> : <Text type="secondary">生成中…</Text>}
            </div>
            <div className="min-w-0 flex-1" style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>
                <Text type="secondary">本机：</Text>
                {status.deviceName}
              </div>
              <div>
                <Text type="secondary">地址：</Text>
                {status.hosts.length ? (
                  status.hosts.map((h) => (
                    <Text key={h} code>
                      {h}:{status.port}
                    </Text>
                  ))
                ) : (
                  <Text type="warning">没获取到本机局域网地址，请确认电脑已连上 Wi-Fi 或网线</Text>
                )}
              </div>
              {status.fingerprint && (
                <div>
                  <Text type="secondary">证书指纹：</Text>
                  <Text code style={{ fontSize: 11 }} title={status.fingerprint}>
                    {status.fingerprint.slice(0, 23)}…
                  </Text>
                </div>
              )}
              <Popconfirm
                title="重新生成配对码？"
                description="之前扫码配对过的设备都会失效，需要重新扫码。"
                okText="重新生成"
                cancelText="取消"
                onConfirm={() => void handleResetPairing()}
              >
                <Button size="small" icon={<ReloadOutlined />} disabled={busy} className="mt-1">
                  重新生成配对码
                </Button>
              </Popconfirm>
            </div>
          </div>

          <Alert
            type="info"
            showIcon
            className="mt-3"
            message="手机端的扫码配对还在开发中，下个版本提供"
            description={
              <ul className="my-1 pl-4" style={{ fontSize: 12, lineHeight: 1.8 }}>
                <li>
                  电脑上的笔记会通过同步源「局域网同步（本机中转）」每 5 分钟同步进中转库，也可以在「多端实时同步」里手动同步它。
                </li>
                <li>Windows 首次开启时会弹出防火墙询问，请允许「专用网络」访问，否则手机连不上。</li>
                <li>二维码等同于这台电脑的访问凭据，不要截图发给别人。</li>
              </ul>
            }
          />
        </>
      )}
    </div>
  );
}
