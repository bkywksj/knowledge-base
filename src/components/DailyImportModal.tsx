/**
 * 「导入日记」弹窗 —— 两个 Tab，覆盖历史日记搬家的两种处境：
 *
 *   ① 从文件夹导入：日记还在磁盘上（别的软件刚导出来），一步到位落成日记
 *   ② 整理已有笔记：日记已经按普通 Markdown 导进库了，把它们认回日记
 *
 * 两者共用同一套日期识别（services/daily_import.rs），行为一致：
 * 「日期文件夹 / 笔记.md」结构 → 文件夹名优先、文件名兜底，识别成 YYYY-MM-DD。
 *
 * ⚠️ 一律**先看后做**：
 *   · 导入 Tab 选完文件夹先扫描预览，显示识别到多少天，确认才导
 *   · 整理 Tab 扫描是只读的，展示计划（含哪些要合并、哪些冲突）后才动数据
 *   · 合并有损（改主笔记正文 + 被并入的进回收站），界面上写死不让用户猜
 */
import { useState, useMemo, useEffect } from "react";
import {
  Modal,
  Button,
  Radio,
  Statistic,
  Row,
  Col,
  Alert,
  Collapse,
  Tag,
  Empty,
  Spin,
  Tabs,
  Checkbox,
  message,
  Typography,
} from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CalendarCheck, RefreshCw, FolderInput } from "lucide-react";
import { dailyApi, importApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type {
  DailyConvertPlan,
  DailyConvertResult,
  MultiFileStrategy,
  DailyConflictStrategy,
  ScannedFile,
} from "@/types";

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 数据变更后回调（调用方据此刷新自己的局部缓存，如日历圆点） */
  onDone?: () => void;
}

export function DailyImportModal({ open, onClose, onDone }: Props) {
  const [tab, setTab] = useState<"import" | "convert">("import");

  // 每次打开都回到「从文件夹导入」。
  //
  // 本组件被父页面**常驻挂载**（只切 open），`tab` 又是外层组件的 state ——
  // Modal 的 destroyOnClose 只销毁子节点（Tabs 及两个面板），管不到它。
  // 不重置的话：用户上次切到「整理已有笔记」，下次打开还停在那一页。
  useEffect(() => {
    if (open) setTab("import");
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <span className="flex items-center gap-2">
          <CalendarCheck size={18} />
          导入日记
        </span>
      }
      width={720}
      footer={null}
      destroyOnClose
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as "import" | "convert")}
        items={[
          {
            key: "import",
            label: (
              <span className="flex items-center gap-1.5">
                <FolderInput size={14} />
                从文件夹导入
              </span>
            ),
            children: <ImportPane onClose={onClose} onDone={onDone} />,
          },
          {
            key: "convert",
            label: (
              <span className="flex items-center gap-1.5">
                <CalendarCheck size={14} />
                整理已有笔记
              </span>
            ),
            children: <ConvertPane onClose={onClose} onDone={onDone} />,
          },
        ]}
      />
    </Modal>
  );
}

// ─── Tab ①：从文件夹导入 ────────────────────────────────────────

function ImportPane({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone?: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [dailyMode, setDailyMode] = useState(true);
  const [done, setDone] = useState<{ imported: number; daily: number; extra: number } | null>(
    null,
  );

  /** 识别出日期的文件数 / 覆盖天数（同一天多篇只算一天） */
  const stats = useMemo(() => {
    const dated = (files ?? []).filter((f) => f.detected_date);
    return {
      total: files?.length ?? 0,
      dated: dated.length,
      days: new Set(dated.map((f) => f.detected_date)).size,
    };
  }, [files]);

  /** 同一天有多篇的天数 —— 导入时每天只认领第一篇，要提前说清楚 */
  const multiDays = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const f of files ?? []) {
      if (f.detected_date) byDate.set(f.detected_date, (byDate.get(f.detected_date) ?? 0) + 1);
    }
    return [...byDate.values()].filter((n) => n > 1).length;
  }, [files]);

  async function handlePick() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择日记文件夹（内含「日期文件夹 / 笔记.md」）",
      });
      if (typeof picked !== "string") return;
      setRootPath(picked);
      setDone(null);
      setScanning(true);
      setFiles(await importApi.scan(picked));
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleImport() {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      const r = await importApi.importSelected(
        files.map((f) => f.path),
        null, // 导到根；日期文件夹层级由后端按相对路径重建
        rootPath,
        false,
        "skip",
        dailyMode,
      );
      setDone({
        imported: r.imported,
        daily: r.daily_marked ?? 0,
        extra: r.daily_extra_notes ?? 0,
      });
      setFiles(null);
      useAppStore.getState().bumpNotesRefresh();
      onDone?.();
    } catch (e) {
      message.error(`导入失败: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  if (done) {
    return (
      <div>
        <Row gutter={16} className="mb-3">
          <Col span={8}>
            <Statistic title="导入笔记" value={done.imported} suffix="篇" />
          </Col>
          <Col span={8}>
            <Statistic title="其中日记" value={done.daily} suffix="天" />
          </Col>
          <Col span={8}>
            <Statistic title="同日多篇" value={done.extra} suffix="篇" />
          </Col>
        </Row>
        {done.extra > 0 && (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message={`有 ${done.extra} 篇与当天日记同一天，仍是普通笔记`}
            description="日记是一天一篇，导入时每天只认领第一篇。想把它们合并进当天，切到「整理已有笔记」再跑一次即可。"
          />
        )}
        <div className="text-right">
          <Button type="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Spin spinning={scanning} tip="正在扫描…">
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        选一个日记文件夹（里面是「<Text code>日期文件夹 / 笔记.md</Text>
        」这种结构），导入时自动按日期落成日记。
      </Paragraph>

      <div className="mb-3">
        <Button icon={<FolderInput size={14} />} onClick={handlePick}>
          {rootPath ? "重新选择文件夹" : "选择文件夹"}
        </Button>
        {rootPath && (
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            {rootPath}
          </Text>
        )}
      </div>

      {files && files.length === 0 && (
        <Empty description="这个文件夹里没有找到 .md 文件" />
      )}

      {files && files.length > 0 && (
        <>
          <Row gutter={16} className="mb-3">
            <Col span={8}>
              <Statistic title="共扫到" value={stats.total} suffix="个文件" />
            </Col>
            <Col span={8}>
              <Statistic title="识别为日记" value={stats.days} suffix="天" />
            </Col>
            <Col span={8}>
              <Statistic title="同日多篇" value={multiDays} suffix="天" />
            </Col>
          </Row>

          {stats.days > 0 ? (
            <div className="mb-3">
              <Checkbox
                checked={dailyMode}
                onChange={(e) => setDailyMode(e.target.checked)}
              >
                按日期文件夹识别为日记
                <Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                  不勾选则全部按普通笔记导入
                </Text>
              </Checkbox>
              {dailyMode && multiDays > 0 && (
                <Alert
                  type="info"
                  showIcon
                  className="mt-2"
                  message={`有 ${multiDays} 天存在多篇，每天只认领第一篇为日记`}
                  description="其余仍是普通笔记；导完切到「整理已有笔记」可把它们合并进当天。"
                />
              )}
            </div>
          ) : (
            <Alert
              type="warning"
              showIcon
              className="mb-3"
              message="没有识别到日期文件夹"
              description="支持 2020-05-15 / 20200515 / 2020年5月15日 / 2020/05/15 等写法。仍可继续导入，但会作为普通笔记。"
            />
          )}

          <Collapse
            size="small"
            items={[
              {
                key: "files",
                label: `文件清单（${files.length}）`,
                children: (
                  <div className="max-h-48 overflow-auto text-xs">
                    {files.slice(0, 200).map((f) => (
                      <div key={f.path} className="mb-1">
                        {f.detected_date ? (
                          <Tag color="blue">{f.detected_date}</Tag>
                        ) : (
                          <Tag>普通</Tag>
                        )}
                        {f.relative_dir ? `${f.relative_dir} / ` : ""}
                        {f.name}
                        {f.date_conflict && (
                          <Tag color="orange" className="ml-1">
                            文件夹与文件名日期不一致
                          </Tag>
                        )}
                      </div>
                    ))}
                    {files.length > 200 && (
                      <Text type="secondary">…只列前 200 条</Text>
                    )}
                  </div>
                ),
              },
            ]}
          />

          <div className="text-right mt-3">
            <Button onClick={onClose} className="mr-2">
              取消
            </Button>
            <Button type="primary" loading={importing} onClick={handleImport}>
              开始导入（{files.length} 个文件）
            </Button>
          </div>
        </>
      )}
    </Spin>
  );
}

// ─── Tab ②：整理已有笔记 ────────────────────────────────────────

function ConvertPane({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone?: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<DailyConvertPlan | null>(null);
  const [result, setResult] = useState<DailyConvertResult | null>(null);
  const [multiFile, setMultiFile] = useState<MultiFileStrategy>("merge");
  const [conflict, setConflict] = useState<DailyConflictStrategy>("skip");

  async function handleScan() {
    setScanning(true);
    setResult(null);
    try {
      setPlan(await dailyApi.scanConvert());
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleApply() {
    if (!plan) return;
    setApplying(true);
    try {
      const r = await dailyApi.applyConvert(plan, { multiFile, conflict });
      setResult(r);
      setPlan(null); // 转换后 plan 已过期，清掉避免重复点
      // 日记侧栏 / 笔记树都靠 notesRefreshTick 重拉；不 bump 就得切页才看得到
      useAppStore.getState().bumpNotesRefresh();
      onDone?.();
      if (r.errors.length === 0) {
        message.success(`已整理 ${r.convertedDays} 天的日记`);
      } else {
        message.warning(`完成，但有 ${r.errors.length} 条出错`);
      }
    } catch (e) {
      message.error(`整理失败: ${e}`);
    } finally {
      setApplying(false);
    }
  }

  const totalDays = plan
    ? plan.single.length + plan.multi.length + plan.conflicts.length
    : 0;

  // ── 结果态 ──
  if (result) {
    return (
      <div>
        <Row gutter={16} className="mb-4">
          <Col span={6}>
            <Statistic title="转为日记" value={result.convertedDays} suffix="天" />
          </Col>
          <Col span={6}>
            <Statistic title="追加到已有" value={result.appendedDays} suffix="天" />
          </Col>
          <Col span={6}>
            <Statistic title="合并的笔记" value={result.mergedNotes} suffix="篇" />
          </Col>
          <Col span={6}>
            <Statistic title="跳过" value={result.skippedDays} suffix="天" />
          </Col>
        </Row>
        {result.mergedNotes > 0 && (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message={`${result.mergedNotes} 篇笔记已并入当天日记，原笔记在回收站里，需要时可以还原。`}
          />
        )}
        {/* 日记已从日期文件夹里摘走 —— 不说明的话，用户会奇怪笔记树里的日期文件夹怎么没了 */}
        {result.foldersRemoved > 0 && (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message={`日记已移出日期文件夹（日记只按日期组织），${result.foldersRemoved} 个空掉的日期文件夹已一并清理。`}
          />
        )}
        {result.errors.length > 0 && (
          <Collapse
            size="small"
            items={[
              {
                key: "err",
                label: `${result.errors.length} 条出错`,
                children: (
                  <div className="max-h-40 overflow-auto text-xs">
                    {result.errors.map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}
        <div className="text-right mt-3">
          <Button type="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    );
  }

  // ── 初始态 ──
  if (!plan) {
    return (
      <Spin spinning={scanning} tip="正在扫描…">
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          日记已经按普通 Markdown 导进来了、日记页看不到？这里扫一遍库里「
          <Text code>日期文件夹</Text>」下的笔记，把它们认回日记。
        </Paragraph>
        <Alert
          type="info"
          showIcon
          message="扫描只读，不会改动任何数据"
          description="扫完会先告诉你「将会发生什么」，你确认之后才真正整理。"
        />
        <div className="text-right mt-4">
          <Button onClick={onClose} className="mr-2">
            取消
          </Button>
          <Button type="primary" loading={scanning} onClick={handleScan}>
            开始扫描
          </Button>
        </div>
      </Spin>
    );
  }

  // ── 预览态 ──
  return (
    <div>
      {totalDays === 0 ? (
        <>
          <Empty
            description={
              <div>
                <div>没有找到日期命名的文件夹</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  支持 2020-05-15 / 20200515 / 2020年5月15日 / 2020/05/15 等写法
                </Text>
              </div>
            }
          />
          <div className="text-right">
            <Button onClick={onClose}>关闭</Button>
          </div>
        </>
      ) : (
        <>
          <Row gutter={16} className="mb-3">
            <Col span={8}>
              <Statistic title="共识别" value={totalDays} suffix="天" />
            </Col>
            <Col span={8}>
              <Statistic
                title="单篇（直接转，无损）"
                value={plan.single.length}
                suffix="天"
              />
            </Col>
            <Col span={8}>
              <Statistic title="多篇" value={plan.multi.length} suffix="天" />
            </Col>
          </Row>

          {plan.dateFrom && plan.dateTo && (
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              日期范围：{plan.dateFrom} ~ {plan.dateTo}
            </Paragraph>
          )}

          {plan.multi.length > 0 && (
            <div className="mb-3">
              <div className="mb-1">
                有 <b>{plan.multi.length}</b> 天存在多篇笔记，怎么处理？
              </div>
              <Radio.Group
                value={multiFile}
                onChange={(e) => setMultiFile(e.target.value)}
              >
                <Radio value="merge">合并成一篇（每段前加原标题）</Radio>
                <Radio value="keepFirst">只转一篇，其余保持普通笔记</Radio>
                <Radio value="skip">跳过这些天</Radio>
              </Radio.Group>
              {multiFile === "merge" && (
                <Alert
                  type="warning"
                  showIcon
                  className="mt-2"
                  message="合并会改动笔记正文，被并入的笔记将移入回收站（可还原）"
                />
              )}
            </div>
          )}

          {plan.conflicts.length > 0 && (
            <div className="mb-3">
              <div className="mb-1">
                有 <b>{plan.conflicts.length}</b> 天已经存在日记，怎么处理？
              </div>
              <Radio.Group
                value={conflict}
                onChange={(e) => setConflict(e.target.value)}
              >
                <Radio value="skip">跳过，保留已有日记不动</Radio>
                <Radio value="append">追加到已有日记末尾</Radio>
              </Radio.Group>
            </div>
          )}

          <Collapse
            size="small"
            items={
              [
                plan.multi.length > 0 && {
                  key: "multi",
                  label: `多篇的 ${plan.multi.length} 天`,
                  children: (
                    <div className="max-h-48 overflow-auto text-xs">
                      {plan.multi.map((c) => (
                        <div key={c.date} className="mb-1">
                          <Tag>{c.date}</Tag>
                          {c.titles.join(" ｜ ")}
                        </div>
                      ))}
                    </div>
                  ),
                },
                plan.conflicts.length > 0 && {
                  key: "conflict",
                  label: `与已有日记冲突的 ${plan.conflicts.length} 天`,
                  children: (
                    <div className="max-h-48 overflow-auto text-xs">
                      {plan.conflicts.map((c) => (
                        <div key={c.date} className="mb-1">
                          <Tag color="orange">{c.date}</Tag>
                          {c.titles.join(" ｜ ")}
                        </div>
                      ))}
                    </div>
                  ),
                },
                plan.skippedFolders.length > 0 && {
                  key: "skipped",
                  label: `没认出日期的文件夹（${plan.skippedFolders.length}）`,
                  children: (
                    <div className="max-h-48 overflow-auto text-xs">
                      {plan.skippedFolders.map((f) => (
                        <Tag key={f} className="mb-1">
                          {f}
                        </Tag>
                      ))}
                    </div>
                  ),
                },
              ].filter(Boolean) as {
                key: string;
                label: string;
                children: React.ReactNode;
              }[]
            }
          />

          <div className="flex items-center justify-between mt-3">
            <Button
              size="small"
              type="link"
              icon={<RefreshCw size={12} />}
              loading={scanning}
              onClick={handleScan}
              className="px-0"
            >
              重新扫描
            </Button>
            <div>
              <Button onClick={onClose} className="mr-2">
                取消
              </Button>
              <Button type="primary" loading={applying} onClick={handleApply}>
                确认整理（{totalDays} 天）
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
