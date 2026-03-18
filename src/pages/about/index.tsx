import { useEffect, useState } from "react";
import { Card, Typography, Descriptions, Spin, message } from "antd";
import type { SystemInfo } from "@/types";
import { systemApi } from "@/lib/api";

const { Title, Text } = Typography;

export default function AboutPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    systemApi
      .getSystemInfo()
      .then(setInfo)
      .catch((e) => message.error(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl mx-auto">
      <Title level={3}>关于</Title>
      <Text type="secondary">系统信息和应用版本</Text>

      <Card title="系统信息" className="mt-6">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : info ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="操作系统">{info.os}</Descriptions.Item>
            <Descriptions.Item label="CPU 架构">{info.arch}</Descriptions.Item>
            <Descriptions.Item label="应用版本">
              v{info.appVersion}
            </Descriptions.Item>
            <Descriptions.Item label="数据目录">
              {info.dataDir}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="danger">无法获取系统信息</Text>
        )}
      </Card>

      <Card title="技术栈" className="mt-4">
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="桌面框架">Tauri 2.x</Descriptions.Item>
          <Descriptions.Item label="后端语言">Rust 2021</Descriptions.Item>
          <Descriptions.Item label="前端框架">React 19</Descriptions.Item>
          <Descriptions.Item label="UI 组件库">Ant Design</Descriptions.Item>
          <Descriptions.Item label="样式方案">TailwindCSS 4</Descriptions.Item>
          <Descriptions.Item label="状态管理">Zustand</Descriptions.Item>
          <Descriptions.Item label="数据库">SQLite (rusqlite)</Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}
