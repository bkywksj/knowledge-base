import { useEffect, useState } from "react";
import { Card, Typography, Table, message, Tag, Button, Space } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import type { Update } from "@tauri-apps/plugin-updater";
import type { AppConfig } from "@/types";
import { configApi, systemApi, updaterApi } from "@/lib/api";
import { UpdateModal } from "@/components/ui/UpdateModal";

const { Title, Text } = Typography;

export default function SettingsPage() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");

  async function loadConfigs() {
    setLoading(true);
    try {
      const data = await configApi.getAll();
      setConfigs(data);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckUpdate() {
    setChecking(true);
    try {
      const result = await updaterApi.checkUpdate();
      if (result) {
        setUpdate(result);
        setUpdateModalOpen(true);
      } else {
        message.success("当前已是最新版本");
      }
    } catch (e) {
      message.warning(`检查更新失败: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    loadConfigs();
    systemApi.getSystemInfo().then((info) => setAppVersion(info.appVersion)).catch(() => {});
  }, []);

  const columns = [
    {
      title: "配置键",
      dataIndex: "key",
      key: "key",
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: "配置值",
      dataIndex: "value",
      key: "value",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      <Title level={3}>设置</Title>
      <Text type="secondary">应用配置管理（数据来自 Rust SQLite）</Text>

      <Card title="软件更新" className="mt-6">
        <Space>
          <Button
            icon={<SyncOutlined spin={checking} />}
            onClick={handleCheckUpdate}
            loading={checking}
          >
            检查更新
          </Button>
          <Text type="secondary">当前版本: {appVersion}</Text>
        </Space>
      </Card>

      <Card title="配置列表" className="mt-4">
        <Table
          columns={columns}
          dataSource={configs}
          rowKey="key"
          loading={loading}
          pagination={false}
          size="small"
        />
      </Card>

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        update={update}
      />
    </div>
  );
}
