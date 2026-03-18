import { useState } from "react";
import { Card, Input, Button, Typography, Space, message } from "antd";
import { systemApi } from "@/lib/api";

const { Title, Text } = Typography;

export default function HomePage() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("");

  async function handleGreet() {
    if (!name.trim()) {
      message.warning("请输入名称");
      return;
    }
    try {
      const result = await systemApi.greet(name);
      setGreeting(result);
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Title level={3}>首页</Title>
      <Text type="secondary">
        欢迎使用 Knowledge Base — 本地知识库桌面应用
      </Text>

      <Card title="Greet 示例" className="mt-6">
        <Space.Compact style={{ width: "100%" }}>
          <Input
            placeholder="输入你的名字..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={handleGreet}
          />
          <Button type="primary" onClick={handleGreet}>
            问候
          </Button>
        </Space.Compact>
        {greeting && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <Text>{greeting}</Text>
          </div>
        )}
      </Card>
    </div>
  );
}
