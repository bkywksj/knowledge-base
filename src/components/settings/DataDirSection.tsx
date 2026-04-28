/**
 * T-013 自定义数据目录设置区
 *
 * 让用户把 db + 附件搬到自己的 D 盘 / 大磁盘，避免占 C 盘。
 *
 * 设计：
 * - 修改路径只写指针文件（`<framework_app_data_dir>/data_dir.txt`），**重启生效**
 * - 不自动迁移老数据；明确提示用户手动复制 `app.db + kb_assets/`
 * - 显示当前 / 默认 / 待生效路径 + 来源 tag（env / pointer / default）
 */
import { useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Tag,
  Typography,
  theme as antdTheme,
} from "antd";
import {
  HardDrive,
  FolderOpen,
  RotateCcw,
  AlertTriangle,
  Copy,
  Sparkles,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { dataDirApi } from "@/lib/api";
import type { DataDirSource, ResolvedDataDir } from "@/types";

const { Text } = Typography;

const SOURCE_LABEL: Record<DataDirSource, { label: string; color: string }> = {
  env: { label: "环境变量", color: "purple" },
  pointer: { label: "自定义路径", color: "geekblue" },
  default: { label: "默认", color: "default" },
};

export function DataDirSection() {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [info, setInfo] = useState<ResolvedDataDir | null>(null);
  const [loading, setLoading] = useState(false);
  const [restartHint, setRestartHint] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [migrateChoice, setMigrateChoice] = useState<"auto" | "manual">("auto");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      setInfo(await dataDirApi.getInfo());
    } catch (e) {
      message.error(`读取数据目录信息失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handlePick() {
    const sel = await openDialog({
      directory: true,
      multiple: false,
      title: "选择新的数据目录",
      // 让对话框默认定位到当前数据目录的父级，方便用户在原位置附近找新目录
      defaultPath: info?.currentDir,
    });
    if (typeof sel !== "string") return;

    if (info && sel === info.currentDir) {
      message.info("和当前数据目录相同，无需修改");
      return;
    }

    setPickedPath(sel);
    setMigrateChoice("auto");
  }

  async function handleConfirmMove() {
    if (!pickedPath) return;
    try {
      if (migrateChoice === "auto") {
        await dataDirApi.setPendingWithMigration(pickedPath);
        message.success(
          "已写入指针 + 迁移 marker；关闭应用后重启，启动时会自动迁移",
        );
      } else {
        await dataDirApi.setPending(pickedPath);
        message.success(
          "已写入指针；关闭应用后请手动复制 app.db + 资产到新目录，再重启",
        );
      }
      setRestartHint(pickedPath);
      setPickedPath(null);
      await load();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleClear() {
    try {
      await dataDirApi.clearPending();
      message.success("已清除指针，重启后回到默认数据目录");
      setRestartHint(info?.defaultDir ?? null);
      await load();
    } catch (e) {
      message.error(`清除失败: ${e}`);
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      message.success("路径已复制到剪贴板");
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }

  const sourceTag = info ? SOURCE_LABEL[info.source] : null;
  const isEnvOverride = info?.source === "env";
  const hasPending = info?.pendingDir != null;

  return (
    <Card
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <HardDrive size={16} style={{ color: token.colorPrimary }} />
          数据目录（数据库 + 附件存储位置）
        </span>
      }
      loading={loading}
    >
      <div className="mb-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          把数据搬到自己选的目录（如 D 盘），避免占 C 盘 + 防重装系统丢数据。
          修改后<Text strong style={{ fontSize: 12 }}>重启生效</Text>；不自动迁移老数据，需手动复制{" "}
          <Text code style={{ fontSize: 11 }}>app.db</Text> + 资产目录到新位置。
        </Text>
      </div>

      {info && (
        <div className="space-y-2">
          {/* 当前 */}
          <PathRow
            label="当前数据目录"
            path={info.currentDir}
            tag={sourceTag}
            onCopy={copyPath}
          />

          {/* 默认 */}
          {info.source !== "default" && (
            <PathRow
              label="默认目录"
              path={info.defaultDir}
              dim
              onCopy={copyPath}
            />
          )}

          {/* 待生效 */}
          {hasPending && info.pendingDir !== info.currentDir && (
            <Alert
              type="warning"
              showIcon
              className="mt-1"
              message="环境变量 KB_DATA_DIR 临时覆盖了你的设置"
              description={
                <span style={{ fontSize: 12 }}>
                  指针文件里记的是{" "}
                  <Text code>{info.pendingDir}</Text>
                  ；当前进程被环境变量临时覆盖到{" "}
                  <Text code>{info.currentDir}</Text>。
                  下次启动如果环境变量没设，会回到指针文件的路径。
                </span>
              }
            />
          )}

          {/* 重启提示 */}
          {restartHint && (
            <Alert
              type="success"
              showIcon
              className="mt-2"
              message="指针已写入，下次重启使用："
              description={<Text code>{restartHint}</Text>}
            />
          )}

          <Space className="mt-3" wrap>
            <Button
              type="primary"
              icon={<FolderOpen size={14} />}
              onClick={handlePick}
              disabled={isEnvOverride}
            >
              {info.source === "default" ? "选择新数据目录…" : "更换数据目录…"}
            </Button>
            {info.source === "pointer" && (
              <Popconfirm
                title="恢复默认数据目录?"
                description="清除指针文件，重启后回到默认 app_data 路径。本地数据不会被删除。"
                onConfirm={handleClear}
                okText="恢复默认"
                cancelText="取消"
              >
                <Button icon={<RotateCcw size={14} />}>恢复默认</Button>
              </Popconfirm>
            )}
            {isEnvOverride && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                提示：当前由 <Text code>KB_DATA_DIR</Text>{" "}
                环境变量驱动，UI 不允许覆盖；要修改请先 unset 该环境变量
              </Text>
            )}
          </Space>
        </div>
      )}

      {/* 修改数据目录确认 Modal — 在 Modal 内部让用户选迁移策略 */}
      <Modal
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle size={18} style={{ color: token.colorWarning }} />
            修改数据目录
          </span>
        }
        open={pickedPath != null}
        onOk={handleConfirmMove}
        onCancel={() => setPickedPath(null)}
        okText={
          migrateChoice === "auto" ? "保存（重启时自动迁移）" : "保存（手动迁移）"
        }
        cancelText="取消"
        width={600}
        destroyOnHidden
      >
        {pickedPath && info && (
          <div className="text-sm leading-6">
            <div className="mb-2">
              <Text type="secondary">从：</Text>
              <Text code>{info.currentDir}</Text>
            </div>
            <div className="mb-3">
              <Text type="secondary">到：</Text>
              <Text code>{pickedPath}</Text>
            </div>

            <Radio.Group
              value={migrateChoice}
              onChange={(e) => setMigrateChoice(e.target.value)}
              className="w-full"
            >
              <Space direction="vertical" className="w-full">
                <Radio value="auto">
                  <Space className="ml-1">
                    <Sparkles size={14} style={{ color: token.colorPrimary }} />
                    <span>
                      <Text strong>自动迁移（推荐）</Text>
                      <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>
                        重启时弹独立窗口跑迁移，进度可见，旧目录保留作备份
                      </span>
                    </span>
                  </Space>
                </Radio>
                <Radio value="manual">
                  <span className="ml-1">
                    <Text strong>不迁移，我自己复制</Text>
                    <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>
                      重启后空库，需手动复制
                      <Text code style={{ fontSize: 11 }}>
                        app.db
                      </Text>{" "}
                      + 资产目录
                    </span>
                  </span>
                </Radio>
              </Space>
            </Radio.Group>

            {migrateChoice === "auto" ? (
              <Alert
                type="info"
                showIcon
                className="mt-3"
                message="迁移过程"
                description={
                  <ol className="pl-4 my-0" style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <li>关闭应用</li>
                    <li>重启 → 启动早期弹一个 splash 窗口显示迁移进度</li>
                    <li>迁移完成（同盘几乎瞬间，跨盘按附件大小耗时）→ 主窗口自动打开</li>
                    <li>旧目录会保留并写入 <Text code style={{ fontSize: 11 }}>_MIGRATED_README.txt</Text>，确认数据 OK 后可手动删除</li>
                  </ol>
                }
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                className="mt-3"
                message="手动迁移注意"
                description={
                  <span style={{ fontSize: 12 }}>
                    需要复制：
                    <Text code style={{ fontSize: 11 }}>app.db</Text>{" "}
                    <Text code style={{ fontSize: 11 }}>kb_assets/</Text>{" "}
                    <Text code style={{ fontSize: 11 }}>attachments/</Text>{" "}
                    <Text code style={{ fontSize: 11 }}>pdfs/</Text>{" "}
                    <Text code style={{ fontSize: 11 }}>sources/</Text>
                  </span>
                }
              />
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}

function PathRow({
  label,
  path,
  tag,
  dim,
  onCopy,
}: {
  label: string;
  path: string;
  tag?: { label: string; color: string } | null;
  dim?: boolean;
  onCopy: (p: string) => void;
}) {
  const { token } = antdTheme.useToken();
  return (
    <div className="flex items-start gap-2" style={{ fontSize: 13 }}>
      <span
        style={{
          color: dim ? token.colorTextTertiary : token.colorTextSecondary,
          minWidth: 88,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <code
        className="flex-1 break-all"
        style={{
          background: token.colorFillTertiary,
          padding: "2px 6px",
          borderRadius: 4,
          fontSize: 12,
          color: dim ? token.colorTextTertiary : token.colorText,
        }}
      >
        {path}
      </code>
      {tag && <Tag color={tag.color}>{tag.label}</Tag>}
      <Button
        type="text"
        size="small"
        icon={<Copy size={12} />}
        onClick={() => onCopy(path)}
        title="复制路径"
      />
    </div>
  );
}
