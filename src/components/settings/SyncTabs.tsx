/**
 * 同步与备份合一面板（T-024 epic 收尾 + T-S040 角色区分）
 *
 * 把"多端同步 V1"和"快照归档 V0"两个语义完全不同的能力放在 Tabs 里：
 * - 默认 tab = 多端实时同步（V1，推荐）：单笔记粒度增量，附件 CAS 去重，加密笔记跨端
 * - 第二 tab = 快照归档（V0）：整库 ZIP 推到云端做时间点快照，灾备 / 迁移用
 *
 * Phase 1-4 重构后，V1 已修复多端 ID 撞车/删除复活/笔记被吞/附件不同步等历史缺陷，
 * 推荐用户首选 V1。V0 仅保留为"周期性完整快照"用途。两者数据存储互不冲突。
 */
import { Card, Tabs, Typography, Tag, theme as antdTheme } from "antd";
import { CloudCog, Archive } from "lucide-react";
import { SyncSection } from "./SyncSection";
import { SyncV1Section } from "./SyncV1Section";

const { Text } = Typography;

export function SyncTabs() {
  const { token } = antdTheme.useToken();

  return (
    <Card
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <CloudCog size={16} style={{ color: token.colorPrimary }} />
          数据同步与备份
        </span>
      }
    >
      <div className="mb-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <Text strong style={{ fontSize: 12 }}>多端同步 vs 快照归档</Text> — 是两个不同的能力，可以同时使用。
        </Text>
        <ul className="my-1 pl-5" style={{ fontSize: 12, lineHeight: 1.7, color: "var(--ant-color-text-secondary)" }}>
          <li>
            <Text strong style={{ fontSize: 12 }}>多端实时同步（推荐）</Text>
            ：单笔记粒度增量，多台机器轮流改同一份笔记不会互相覆盖（last-write-wins + 冲突文件）。
            附件按内容 hash 去重上传 / 加密笔记跨端 / 删除会同步到其它端。
            适合「办公电脑 ↔ 家用电脑」「多设备 ↔ 云盘」等日常协作场景。
          </li>
          <li>
            <Text strong style={{ fontSize: 12 }}>快照归档</Text>
            ：把整个知识库（数据库 + 附件）打包成一个 ZIP 推到云端，是时间点快照。
            适合「误删找回」「重装系统迁移」「跨大版本回退」等灾备场景。
          </li>
          <li>
            两者数据存储互不冲突——同一个 WebDAV 目录里快照归档写
            <Text code style={{ fontSize: 11 }}>kb-sync-&lt;host&gt;.zip</Text>，多端同步写
            <Text code style={{ fontSize: 11 }}>manifest.json + notes/*.md + attachments/&lt;hash&gt;</Text>，互不覆盖。
          </li>
        </ul>
      </div>

      <Tabs
        defaultActiveKey="v1"
        items={[
          {
            key: "v1",
            label: (
              <span className="flex items-center gap-1.5">
                <CloudCog size={14} />
                多端实时同步
                <Tag color="blue" style={{ marginInlineStart: 4, lineHeight: "16px", fontSize: 11 }}>
                  推荐
                </Tag>
              </span>
            ),
            children: <SyncV1Section />,
          },
          {
            key: "v0",
            label: (
              <span className="flex items-center gap-1.5">
                <Archive size={14} />
                快照归档
              </span>
            ),
            children: <SyncSection />,
          },
        ]}
      />
    </Card>
  );
}
