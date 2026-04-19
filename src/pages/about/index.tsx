import { useEffect, useState } from "react";
import { Card, Typography, Descriptions, Spin, message, Button, Tooltip } from "antd";
import { FolderOpen, Copy } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SystemInfo } from "@/types";
import { systemApi } from "@/lib/api";
import { RecommendCards } from "@/components/ui/RecommendCards";

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

  async function handleOpenDataDir() {
    if (!info?.dataDir) return;
    try {
      await openPath(info.dataDir);
    } catch (e) {
      message.error(`打开目录失败: ${e}`);
    }
  }

  async function handleCopyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  }

  const dbPath = info ? `${info.dataDir}${info.dataDir.includes("\\") ? "\\" : "/"}app.db` : "";

  return (
    <div className="max-w-2xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>关于</Title>
        <Text type="secondary">系统信息和应用版本</Text>
      </div>

      <Card title="系统信息">
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
              <div className="flex items-center justify-between gap-2">
                <Text copyable={{ text: info.dataDir }} style={{ fontSize: 13 }}>
                  {info.dataDir}
                </Text>
                <Tooltip title="在文件管理器中打开">
                  <Button
                    type="link"
                    size="small"
                    icon={<FolderOpen size={14} />}
                    onClick={handleOpenDataDir}
                  />
                </Tooltip>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="数据库文件">
              <div className="flex items-center justify-between gap-2">
                <code style={{ fontSize: 12 }}>app.db</code>
                <Tooltip title="复制完整路径">
                  <Button
                    type="link"
                    size="small"
                    icon={<Copy size={14} />}
                    onClick={() => handleCopyPath(dbPath)}
                  />
                </Tooltip>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="图片存储">
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>
                  {info.imagesDir}
                </Text>
                <span className="flex items-center gap-1">
                  <Tooltip title="复制路径">
                    <Button
                      type="link"
                      size="small"
                      icon={<Copy size={14} />}
                      onClick={() => handleCopyPath(info.imagesDir)}
                    />
                  </Tooltip>
                  <Tooltip title="在文件管理器中打开">
                    <Button
                      type="link"
                      size="small"
                      icon={<FolderOpen size={14} />}
                      onClick={async () => {
                        try {
                          await openPath(info.imagesDir);
                        } catch (e) {
                          message.error(`打开目录失败: ${e}`);
                        }
                      }}
                    />
                  </Tooltip>
                </span>
              </div>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="danger">无法获取系统信息</Text>
        )}
      </Card>

      {info && (
        <Card
          title="数据迁移说明"
          size="small"
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
            笔记数据保存在 SQLite 数据库文件中，图片保存在 <code>kb_assets/images/</code> 目录下。迁移步骤：
          </Typography.Paragraph>
          <ol style={{ fontSize: 13, paddingLeft: 20, margin: 0 }}>
            <li style={{ marginBottom: 4 }}>关闭应用</li>
            <li style={{ marginBottom: 4 }}>
              复制 <code>app.db</code> 和 <code>kb_assets/</code> 目录到新电脑的相同路径
            </li>
            <li>启动应用即可</li>
          </ol>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            也可以使用 <Text strong style={{ fontSize: 12 }}>设置 → 导出 Markdown</Text> 将笔记导出为通用格式，便于导入其他工具。
          </Typography.Paragraph>
        </Card>
      )}

      <RecommendCards />
    </div>
  );
}
