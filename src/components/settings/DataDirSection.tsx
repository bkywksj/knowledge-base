/**
 * T-013 自定义数据目录设置区
 *
 * 让用户把 db + 附件搬到自己的 D 盘 / 大磁盘，避免占 C 盘。
 *
 * 设计：
 * - 修改路径只写指针文件（`<framework_app_data_dir>/data_dir.txt`），**重启生效**
 * - 选好目录先检查目标：已有数据时默认直接使用它，替换必须用户明确选择（目标的库会留档）
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
import {
  defaultMoveChoice,
  describeInspect,
  migrationOf,
  type MoveChoice,
} from "@/lib/dataDirChoice";
import type { DataDirInspect, DataDirSource, ResolvedDataDir } from "@/types";

const { Text } = Typography;

const SOURCE_LABEL: Record<DataDirSource, { label: string; color: string }> = {
  env: { label: "环境变量", color: "purple" },
  portable: { label: "便携模式", color: "cyan" },
  pointer: { label: "自定义路径", color: "geekblue" },
  default: { label: "默认", color: "default" },
};

const MOVE_OK_TEXT: Record<MoveChoice, string> = {
  auto: "保存（重启时自动迁移）",
  manual: "保存（手动迁移）",
  useTarget: "保存（重启后使用该目录）",
  replace: "确认替换（重启时执行）",
};

export function DataDirSection() {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [info, setInfo] = useState<ResolvedDataDir | null>(null);
  const [loading, setLoading] = useState(false);
  const [restartHint, setRestartHint] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [migrateChoice, setMigrateChoice] = useState<MoveChoice>("auto");
  const [checking, setChecking] = useState(false);
  const [targetInfo, setTargetInfo] = useState<DataDirInspect | null>(null);
  const [currentInfo, setCurrentInfo] = useState<DataDirInspect | null>(null);

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

    // 先看目标里有什么，再决定给哪些选项：目标已有数据时绝不能默认迁移过去
    setChecking(true);
    let target: DataDirInspect;
    try {
      target = await dataDirApi.inspect(sel);
    } catch {
      // 查不出来就按「可能有数据」对待，宁可多问一句
      target = { hasDb: true, noteCount: null, sizeBytes: 0, modifiedAt: null };
    }
    const current = info
      ? await dataDirApi.inspect(info.currentDir).catch(() => null)
      : null;
    setChecking(false);

    setTargetInfo(target);
    setCurrentInfo(current);
    setMigrateChoice(defaultMoveChoice(target));
    setPickedPath(sel);
  }

  async function handleConfirmMove() {
    if (!pickedPath) return;
    try {
      const { migrate, replaceExisting } = migrationOf(migrateChoice);
      if (migrate) {
        await dataDirApi.setPendingWithMigration(pickedPath, replaceExisting);
        message.success(
          "已写入指针 + 迁移 marker；关闭应用后重启，启动时会自动迁移",
        );
      } else if (migrateChoice === "useTarget") {
        await dataDirApi.setPending(pickedPath);
        message.success("已保存；重启后使用该目录里的数据");
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
  const isPortable = info?.source === "portable";
  // env / portable 模式下 UI 不允许改路径（改了也会被启动期覆盖）
  const lockUi = isEnvOverride || isPortable;
  const hasPending = info?.pendingDir != null;

  return (
    <Card
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <HardDrive size={16} style={{ color: token.colorPrimary }} />
          数据目录
          <span className="kb-set-note">数据库 + 附件存储位置</span>
        </span>
      }
      loading={loading}
    >
      <div className="mb-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          把数据搬到自己选的目录（如 D 盘），避免占 C 盘 + 防重装系统丢数据。
          修改后<Text strong style={{ fontSize: 12 }}>重启生效</Text>；如果选的目录里已有数据，会先让你确认怎么处理。
        </Text>
      </div>

      {info && (
        <div className="space-y-2">
          {/* 当前数据目录：路径展示 + 行末尾的「选择/更换」「恢复默认」按钮组，
              环境变量覆盖时按钮被隐藏（UI 不允许在 env 模式下改路径）。 */}
          <PathRow
            label="当前数据目录"
            path={info.currentDir}
            tag={sourceTag}
            onCopy={copyPath}
            trailing={
              !lockUi && (
                <Space size={4}>
                  {info.source === "pointer" && (
                    <Popconfirm
                      title="恢复默认数据目录?"
                      description="清除指针文件，重启后回到默认 app_data 路径。本地数据不会被删除。"
                      onConfirm={handleClear}
                      okText="恢复默认"
                      cancelText="取消"
                    >
                      <Button size="small" icon={<RotateCcw size={12} />}>
                        恢复默认
                      </Button>
                    </Popconfirm>
                  )}
                  <Button
                    type="primary"
                    size="small"
                    icon={<FolderOpen size={12} />}
                    loading={checking}
                    onClick={handlePick}
                  >
                    {info.source === "default" ? "选择新数据目录…" : "更换…"}
                  </Button>
                </Space>
              )
            }
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

          {info.missingDir && (
            <Alert
              type="warning"
              showIcon
              className="mt-1"
              message="原来设置的数据目录找不到了，当前使用的是默认目录"
              description={
                <span style={{ fontSize: 12 }}>
                  <Text code>{info.missingDir}</Text>
                  <br />
                  恢复这个路径后重启即可；如果文件夹换了位置，点「选择新数据目录」选它的新位置。
                </span>
              }
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

          {/* 操作按钮已提到 Card 标题栏右侧 extra 槽，保持与其它卡片一致；
              仅 KB_DATA_DIR 环境变量覆盖时显示状态提示（此时 extra 不渲染按钮） */}
          {isEnvOverride && (
            <div className="mt-2">
              <Text type="secondary" style={{ fontSize: 12 }}>
                提示：当前由 <Text code>KB_DATA_DIR</Text>{" "}
                环境变量驱动，UI 不允许覆盖；要修改请先 unset 该环境变量
              </Text>
            </div>
          )}
          {isPortable && (
            <Alert
              type="info"
              showIcon
              className="mt-2"
              message="便携模式已启用"
              description={
                <span style={{ fontSize: 12 }}>
                  exe 同级存在 <Text code>portable.txt</Text>{" "}
                  哨兵文件 → 数据绑死在安装目录，不再写 C 盘 AppData。
                  要更换数据位置，直接编辑该文件的内容（空 ={" "}
                  <Text code>&lt;exe同级&gt;/data/</Text>
                  ；或填绝对路径 / 相对路径），重启生效。
                </span>
              }
            />
          )}
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
        okText={MOVE_OK_TEXT[migrateChoice]}
        okButtonProps={{ danger: migrateChoice === "replace" }}
        cancelText="取消"
        width={600}
        destroyOnHidden
      >
        {pickedPath && info && (
          <div className="text-sm leading-6">
            <div className="mb-2">
              <Text type="secondary">从：</Text>
              <Text code>{info.currentDir}</Text>
              <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                {describeInspect(currentInfo)}
              </div>
            </div>
            <div className="mb-3">
              <Text type="secondary">到：</Text>
              <Text code>{pickedPath}</Text>
              <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                {describeInspect(targetInfo)}
              </div>
            </div>

            {targetInfo?.hasDb ? (
              <>
                <Alert
                  type="warning"
                  showIcon
                  className="mb-3"
                  message="这个目录里已经有知识库数据"
                  description={
                    <span style={{ fontSize: 12 }}>
                      如果这是你之前的笔记，请选「直接使用该目录的数据」。
                    </span>
                  }
                />
                <Radio.Group
                  value={migrateChoice}
                  onChange={(e) => setMigrateChoice(e.target.value)}
                  className="w-full"
                >
                  <Space direction="vertical" className="w-full">
                    <Radio value="useTarget">
                      <span className="ml-1">
                        <Text strong>直接使用该目录的数据</Text>
                        <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>
                          不迁移，重启后打开目标目录的笔记；当前目录的数据原样留着
                        </span>
                      </span>
                    </Radio>
                    <Radio value="replace">
                      <span className="ml-1">
                        <Text strong>用当前数据替换</Text>
                        <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>
                          把当前数据迁移过去；目标原有的库不会删除，会改名保留在该目录
                        </span>
                      </span>
                    </Radio>
                  </Space>
                </Radio.Group>
              </>
            ) : (
              <>
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
                        重启时弹独立窗口跑迁移，进度可见
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
                    <li>同盘迁移是直接搬过去，旧目录不再有这些文件；跨盘是复制，旧目录的文件还在，确认数据 OK 后可手动删除。旧目录都会写入 <Text code style={{ fontSize: 11 }}>_MIGRATED_README.txt</Text></li>
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
              </>
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
  trailing,
}: {
  label: string;
  path: string;
  tag?: { label: string; color: string } | null;
  dim?: boolean;
  onCopy: (p: string) => void;
  /** 行末尾自定义槽（如"选择新数据目录"按钮组），跟在复制按钮后面 */
  trailing?: React.ReactNode;
}) {
  const { token } = antdTheme.useToken();
  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 13 }}>
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
          minWidth: 200,
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
      {trailing}
    </div>
  );
}
