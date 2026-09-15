/**
 * 设置页「待办提醒 → 提醒提示音」面板。
 *
 * 能配的东西：
 * - 总开关（关掉后只弹窗/闪任务栏，不出声）
 * - 普通提醒音 / 紧急提醒铃声分开选（紧急是循环响到用户处理，跟普通场景诉求不同）
 * - 主音量 + 普通提醒连响遍数（"提示音不够明显"最直接的两个旋钮）
 * - 导入自己的音频文件，导入后自动设为普通提醒音并试听一次
 *
 * 设置落在 app_config 表（不是 tauri-plugin-store），因为紧急提醒是**独立 webview 窗口**，
 * 走 DB 才能让两个窗口读到同一份值。
 */
import { useEffect, useRef, useState } from "react";
import { Button, Popconfirm, Select, Slider, Switch, Tooltip, Typography, message } from "antd";
import { Play, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { configApi, reminderSoundApi } from "@/lib/api";
import type { CustomReminderSound } from "@/types";
import {
  CFG_ENABLED,
  CFG_NORMAL,
  CFG_REPEAT,
  CFG_URGENT,
  CFG_VOLUME,
  DEFAULT_SETTINGS,
  clearCustomSoundCache,
  getReminderSoundSettings,
  invalidateReminderSoundSettings,
  playSound,
  primeReminderSoundSettings,
  serializeSoundSpec,
  type ReminderSoundSettings,
  type SoundSpec,
} from "@/lib/audio/reminderSound";
import {
  DEFAULT_PRESET_ID,
  DEFAULT_URGENT_PRESET_ID,
  REMINDER_PRESETS,
  getPreset,
} from "@/lib/audio/soundPresets";

const { Text } = Typography;

/** 原生对话框里放行的音频后缀，与 Rust 侧 ALLOWED_EXT 保持一致 */
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "webm", "oga"];

const REPEAT_OPTIONS = [1, 2, 3, 5].map((n) => ({
  value: n,
  label: n === 1 ? "响 1 遍" : `连响 ${n} 遍`,
}));

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 选中项的一句话说明：预设给音色描述，自定义给文件名 */
function describeSpec(spec: SoundSpec, customs: CustomReminderSound[]): string {
  if (spec.kind === "preset") return getPreset(spec.id).hint;
  const hit = customs.find((c) => c.file_name === spec.fileName);
  return hit ? `自定义音频 · ${fmtSize(hit.size)}` : `自定义音频（文件已丢失，将回退内置音）`;
}

export function ReminderSoundSection() {
  const [settings, setSettings] = useState<ReminderSoundSettings>(DEFAULT_SETTINGS);
  const [customs, setCustoms] = useState<CustomReminderSound[]>([]);
  const [importing, setImporting] = useState(false);
  /** 正在试听的 stop 函数；同时用来显示"停止"按钮 */
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const stopPreviewRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 设置页每次进入都读一次最新值（用户可能在别处改过）
      invalidateReminderSoundSettings();
      const [s, list] = await Promise.all([
        getReminderSoundSettings(),
        reminderSoundApi.list().catch(() => [] as CustomReminderSound[]),
      ]);
      if (cancelled) return;
      setSettings(s);
      setCustoms(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 离开设置页必须停掉试听，否则声音会一直响到下次导航
  useEffect(() => {
    return () => {
      stopPreviewRef.current?.();
      stopPreviewRef.current = null;
    };
  }, []);

  function stopPreview() {
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    setPlayingKey(null);
  }

  /**
   * 试听。`repeat` 只对普通提醒槽生效——紧急是循环铃，试听连响没意义。
   * 试听不看总开关：用户正是在这里调音，关着开关也得能听见自己选了什么。
   */
  function preview(key: string, spec: SoundSpec, repeat = 1) {
    stopPreview();
    const stop = playSound(spec, {
      volume: settings.volume,
      repeat,
      fallbackPreset: key === "urgent" ? DEFAULT_URGENT_PRESET_ID : DEFAULT_PRESET_ID,
    });
    stopPreviewRef.current = stop;
    setPlayingKey(key);
    // 自定义音长度未知，按最长预设 + 连响遍数给个保守上限后自动复位按钮状态
    const holdMs = 2200 * Math.max(1, repeat);
    window.setTimeout(() => {
      setPlayingKey((cur) => (cur === key ? null : cur));
    }, holdMs);
  }

  async function save(next: Partial<ReminderSoundSettings>) {
    const merged = { ...settings, ...next };
    setSettings(merged);
    // 立刻灌进缓存：下一条提醒到点时不必再等一次 DB 往返，也保证用的是新值
    primeReminderSoundSettings(merged);
    const jobs: Promise<void>[] = [];
    if (next.enabled !== undefined)
      jobs.push(configApi.set(CFG_ENABLED, next.enabled ? "1" : "0"));
    if (next.normal) jobs.push(configApi.set(CFG_NORMAL, serializeSoundSpec(next.normal)));
    if (next.urgent) jobs.push(configApi.set(CFG_URGENT, serializeSoundSpec(next.urgent)));
    if (next.volume !== undefined) jobs.push(configApi.set(CFG_VOLUME, String(next.volume)));
    if (next.repeat !== undefined) jobs.push(configApi.set(CFG_REPEAT, String(next.repeat)));
    try {
      await Promise.all(jobs);
    } catch (e) {
      message.error(`保存提示音设置失败：${e}`);
      // 写失败就把缓存作废，下次提醒重新从 DB 读，避免内存值与磁盘不一致
      invalidateReminderSoundSettings();
    }
  }

  async function handleImport() {
    if (importing) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "音频文件", extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    setImporting(true);
    try {
      const sound = await reminderSoundApi.import(picked);
      clearCustomSoundCache(sound.file_name);
      const list = await reminderSoundApi.list();
      setCustoms(list);
      const spec: SoundSpec = { kind: "custom", fileName: sound.file_name };
      // 导入即选用：用户专门去挑了个文件，十有八九就是要拿它当提示音
      await save({ normal: spec });
      message.success(`已导入「${sound.display_name}」并设为普通提醒音`);
      preview("normal", spec);
    } catch (e) {
      message.error(`导入提示音失败：${e}`);
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(sound: CustomReminderSound) {
    try {
      stopPreview();
      await reminderSoundApi.delete(sound.file_name);
      clearCustomSoundCache(sound.file_name);
      setCustoms((prev) => prev.filter((c) => c.file_name !== sound.file_name));
      // 正被使用的音被删掉 → 立刻回退到内置预设，否则到点提醒只能走运行期兜底
      const patch: Partial<ReminderSoundSettings> = {};
      if (settings.normal.kind === "custom" && settings.normal.fileName === sound.file_name) {
        patch.normal = { kind: "preset", id: DEFAULT_PRESET_ID };
      }
      if (settings.urgent.kind === "custom" && settings.urgent.fileName === sound.file_name) {
        patch.urgent = { kind: "preset", id: DEFAULT_URGENT_PRESET_ID };
      }
      if (Object.keys(patch).length > 0) {
        await save(patch);
        message.success(`已删除「${sound.display_name}」，相关提醒已切回内置音`);
      } else {
        message.success(`已删除「${sound.display_name}」`);
      }
    } catch (e) {
      message.error(`删除失败：${e}`);
    }
  }

  const soundOptions = [
    {
      label: "内置预设",
      options: REMINDER_PRESETS.map((p) => ({
        value: `preset:${p.id}`,
        label: p.label,
      })),
    },
    ...(customs.length > 0
      ? [
          {
            label: "我的音频",
            options: customs.map((c) => ({
              value: `custom:${c.file_name}`,
              label: c.display_name,
            })),
          },
        ]
      : []),
  ];

  /** 下拉值 ↔ SoundSpec 的互转（Select 只认字符串） */
  function toSpec(value: string): SoundSpec {
    return value.startsWith("custom:")
      ? { kind: "custom", fileName: value.slice("custom:".length) }
      : { kind: "preset", id: getPreset(value.slice("preset:".length)).id };
  }

  const disabled = !settings.enabled;

  function renderSoundRow(
    key: "normal" | "urgent",
    title: string,
    desc: string,
    spec: SoundSpec,
    repeat: number,
  ) {
    return (
      <div className="flex items-center justify-between py-1" style={rowStyle}>
        <div style={{ minWidth: 0, paddingRight: 12 }}>
          <div>{title}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {desc} · {describeSpec(spec, customs)}
          </Text>
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <Select
            value={serializeSoundSpec(spec)}
            onChange={(v) => {
              const next = toSpec(v);
              void save(key === "normal" ? { normal: next } : { urgent: next });
              preview(key, next, key === "normal" ? repeat : 1);
            }}
            options={soundOptions}
            disabled={disabled}
            style={{ width: 180 }}
          />
          <Tooltip title={playingKey === key ? "停止试听" : "试听"}>
            <Button
              icon={playingKey === key ? <Square size={14} /> : <Play size={14} />}
              onClick={() =>
                playingKey === key
                  ? stopPreview()
                  : preview(key, spec, key === "normal" ? repeat : 1)
              }
            />
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 总开关 */}
      <div className="flex items-center justify-between py-1" style={rowStyle}>
        <div>
          <div className="flex items-center gap-2">
            <Volume2 size={15} />
            提醒提示音
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            关闭后待办到点只弹窗、闪任务栏，不出声
          </Text>
        </div>
        <Switch
          checked={settings.enabled}
          onChange={(v) => {
            if (!v) stopPreview();
            void save({ enabled: v });
          }}
        />
      </div>

      {renderSoundRow(
        "normal",
        "普通提醒音",
        "非紧急待办到点时响",
        settings.normal,
        settings.repeat,
      )}

      {renderSoundRow(
        "urgent",
        "紧急提醒铃声",
        "紧急待办的置顶弹窗循环响铃",
        settings.urgent,
        1,
      )}

      {/* 音量 */}
      <div className="flex items-center justify-between py-1" style={rowStyle}>
        <div>
          <div>提示音音量</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            嫌不够明显就调大；松开滑块会按新音量试听一次
          </Text>
        </div>
        <div className="flex items-center gap-3" style={{ width: 240 }}>
          <Slider
            style={{ flex: 1 }}
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.volume * 100)}
            disabled={disabled}
            onChange={(v) => setSettings((s) => ({ ...s, volume: v / 100 }))}
            onChangeComplete={(v) => {
              const volume = v / 100;
              void save({ volume });
              if (volume > 0) {
                stopPreview();
                const stop = playSound(settings.normal, { volume, repeat: 1 });
                stopPreviewRef.current = stop;
              }
            }}
          />
          <Text type="secondary" style={{ fontSize: 12, width: 34, textAlign: "right" }}>
            {Math.round(settings.volume * 100)}%
          </Text>
        </div>
      </div>

      {/* 连响遍数 */}
      <div className="flex items-center justify-between py-1" style={rowStyle}>
        <div>
          <div>普通提醒连响次数</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            一遍容易漏听就调成连响；紧急提醒本身就是循环响铃，不受此项影响
          </Text>
        </div>
        <Select
          value={settings.repeat}
          onChange={(v) => {
            void save({ repeat: v });
            preview("normal", settings.normal, v);
          }}
          options={REPEAT_OPTIONS}
          disabled={disabled}
          style={{ width: 120 }}
        />
      </div>

      {/* 自定义音频管理 */}
      <div className="py-1" style={rowStyle}>
        <div className="flex items-center justify-between">
          <div>
            <div>自定义提示音</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持 {AUDIO_EXTENSIONS.join(" / ")}，单个 8 MB 以内；文件会复制进应用数据目录，
              之后删除原文件也不影响
            </Text>
          </div>
          <Button
            icon={<Upload size={14} />}
            loading={importing}
            onClick={() => void handleImport()}
          >
            导入音频
          </Button>
        </div>

        {customs.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {customs.map((c) => {
              const spec: SoundSpec = { kind: "custom", fileName: c.file_name };
              const usedBy = [
                settings.normal.kind === "custom" && settings.normal.fileName === c.file_name
                  ? "普通提醒"
                  : null,
                settings.urgent.kind === "custom" && settings.urgent.fileName === c.file_name
                  ? "紧急铃声"
                  : null,
              ].filter(Boolean) as string[];
              const key = `custom:${c.file_name}`;
              return (
                <div
                  key={c.file_name}
                  className="flex items-center justify-between gap-2"
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    background: "var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={c.path}
                    >
                      {c.display_name}
                    </div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {fmtSize(c.size)}
                      {usedBy.length > 0 ? ` · 正用于${usedBy.join(" / ")}` : ""}
                    </Text>
                  </div>
                  <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
                    <Tooltip title={playingKey === key ? "停止试听" : "试听"}>
                      <Button
                        size="small"
                        type="text"
                        icon={playingKey === key ? <Square size={14} /> : <Play size={14} />}
                        onClick={() =>
                          playingKey === key ? stopPreview() : preview(key, spec)
                        }
                      />
                    </Tooltip>
                    <Popconfirm
                      title="删除这个提示音？"
                      description={
                        usedBy.length > 0
                          ? `正被${usedBy.join(" / ")}使用，删除后会切回内置音`
                          : "音频文件会从应用数据目录里移除"
                      }
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void handleDelete(c)}
                    >
                      <Button size="small" type="text" danger icon={<Trash2 size={14} />} />
                    </Popconfirm>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** 与「待办提醒」卡片里其它行一致的分隔线 */
const rowStyle: React.CSSProperties = {
  borderTop: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
  marginTop: 8,
  paddingTop: 12,
};

export default ReminderSoundSection;
