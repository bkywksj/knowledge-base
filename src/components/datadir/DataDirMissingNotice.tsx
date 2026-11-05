/**
 * 「原数据目录找不到了」提示
 *
 * 文件夹被改名 / 移动，或移动硬盘没插时，指针指向的目录不存在。Rust 侧不会再新建空目录，
 * 而是回落默认目录并报告路径。默认目录的库通常是空的，不提示的话用户看到的就是「笔记全没了」，
 * 接着很可能去改目录、重装，反而把真实数据弄丢（2026-11-05 线上事故的前半段就是这样）。
 *
 * 仅挂在主窗口（见 App.tsx）。
 */
import { useEffect, useState } from "react";
import { Modal, Typography } from "antd";
import { dataDirApi } from "@/lib/api";

const { Text, Paragraph } = Typography;

export function DataDirMissingNotice() {
  const [missingDir, setMissingDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const info = await dataDirApi.getInfo();
        if (!info.missingDir) return;
        setMissingDir(info.missingDir);
        setDefaultDir(info.defaultDir);
      } catch {
        // 读不到就不打扰用户：本来就是兜底提示
      }
    })();
  }, []);

  return (
    <Modal
      title="找不到原来的数据目录"
      open={missingDir != null}
      onOk={() => setMissingDir(null)}
      onCancel={() => setMissingDir(null)}
      okText="知道了"
      cancelButtonProps={{ style: { display: "none" } }}
      width={560}
    >
      <Paragraph>
        你设置的数据目录现在不存在：
        <br />
        <Text code>{missingDir}</Text>
      </Paragraph>
      <Paragraph>
        <Text strong>看到内容变空，不代表笔记被删了</Text>，可能只是软件暂时找不到它们。这次先打开了默认目录：
        <br />
        <Text code>{defaultDir}</Text>
      </Paragraph>
      <Paragraph style={{ marginBottom: 0 }}>
        请先检查文件夹是否被改名、移动，或者移动硬盘是否没插好。恢复原路径后重启软件即可。
        如果文件夹换了位置，到「设置 → 数据目录」选择它的新位置，并选「直接使用该目录的数据」。
      </Paragraph>
    </Modal>
  );
}
