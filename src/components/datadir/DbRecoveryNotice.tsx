/**
 * 「数据库损坏，已自动恢复」提示
 *
 * 只有 SQLite 明确报告文件损坏才会走恢复（见 Rust 侧 db_recovery）。恢复后看到的内容可能比之前少，
 * 甚至是空的，不说清楚用户只会以为笔记没了，也不知道原库还留着。
 * 记录存在数据目录的文件里，点「知道了」才清除，中途关软件也不会漏看。
 *
 * 仅挂在主窗口（见 App.tsx）。
 */
import { useEffect, useState } from "react";
import { Modal, Typography } from "antd";
import { dataDirApi } from "@/lib/api";
import type { DbRecoveryNotice as Notice } from "@/types";

const { Text, Paragraph } = Typography;

export function DbRecoveryNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setNotice(await dataDirApi.getRecoveryNotice());
      } catch {
        // 读不到就不打扰用户：本来就是兜底提示
      }
    })();
  }, []);

  async function handleClose() {
    setNotice(null);
    try {
      await dataDirApi.dismissRecoveryNotice();
    } catch {
      // 没清掉顶多下次再提示一遍
    }
  }

  return (
    <Modal
      title="数据库文件损坏，已自动恢复"
      open={notice != null}
      onOk={handleClose}
      onCancel={handleClose}
      okText="知道了"
      cancelButtonProps={{ style: { display: "none" } }}
      maskClosable={false}
      width={600}
    >
      {notice && (
        <>
          <Paragraph>
            {notice.at} 启动时，数据库文件无法读取（{notice.error}）。
          </Paragraph>
          <Paragraph>
            {notice.restoredFrom ? (
              <>
                <Text strong>现在显示的是备份里的内容，比损坏前的内容旧，最近的修改可能不在里面。</Text>
                <br />
                使用的备份：<Text code>{notice.restoredFrom}</Text>
              </>
            ) : (
              <Text strong>没有找到可用的备份，所以现在是一个空的知识库。</Text>
            )}
          </Paragraph>
          {notice.archivedPath && (
            <Paragraph style={{ marginBottom: 0 }}>
              损坏的原文件没有删除，已改名保留，请不要清理它，可能还能修复出内容：
              <br />
              <Text code>{notice.archivedPath}</Text>
            </Paragraph>
          )}
        </>
      )}
    </Modal>
  );
}
