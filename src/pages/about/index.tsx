import { useEffect, useState } from "react";
import { Card, Typography, Descriptions, Spin, message, Button, Tooltip } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { FolderOpen, ExternalLink } from "lucide-react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import type { SystemInfo } from "@/types";
import { systemApi, updaterApi } from "@/lib/api";
import { RecommendCards } from "@/components/ui/RecommendCards";
import { UpdateModal } from "@/components/ui/UpdateModal";

const OFFICIAL_SITE = "https://kb.ruoyi.plus/";

const { Title, Text } = Typography;

export default function AboutPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

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
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>v{info.appVersion}</Text>
                <Button
                  type="link"
                  size="small"
                  icon={<SyncOutlined spin={checking} />}
                  loading={checking}
                  onClick={handleCheckUpdate}
                >
                  检查更新
                </Button>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="官网">
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>{OFFICIAL_SITE}</Text>
                <Tooltip title="在浏览器中打开">
                  <Button
                    type="link"
                    size="small"
                    icon={<ExternalLink size={14} />}
                    onClick={() => openUrl(OFFICIAL_SITE)}
                  />
                </Tooltip>
              </div>
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
            数据按类型分散在应用数据目录下的多个文件/子目录中：
          </Typography.Paragraph>
          <ul style={{ fontSize: 13, paddingLeft: 20, margin: "0 0 8px" }}>
            <li style={{ marginBottom: 2 }}><code>app.db</code> — 笔记/文件夹/标签/链接/AI 对话等元数据（SQLite）</li>
            <li style={{ marginBottom: 2 }}><code>kb_assets/</code> — 笔记中插入的图片</li>
            <li style={{ marginBottom: 2 }}><code>pdfs/</code> — 导入的 PDF 原始文件</li>
            <li style={{ marginBottom: 2 }}><code>sources/</code> — 导入的 Word (.docx/.doc) 原始文件</li>
            <li><code>settings.json</code> — 应用偏好（主题、窗口状态等）</li>
          </ul>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
            迁移步骤：
          </Typography.Paragraph>
          <ol style={{ fontSize: 13, paddingLeft: 20, margin: 0 }}>
            <li style={{ marginBottom: 4 }}>关闭应用</li>
            <li style={{ marginBottom: 4 }}>
              把上述所有文件/目录整体复制到新电脑的相同路径（点击上方"打开数据目录"定位）
            </li>
            <li>启动应用即可</li>
          </ol>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            也可以使用 <Text strong style={{ fontSize: 12 }}>设置 → 导出 Markdown</Text> 将笔记导出为通用格式，便于导入其他工具。
          </Typography.Paragraph>
        </Card>
      )}

      <RecommendCards />

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        update={update}
      />
    </div>
  );
}
