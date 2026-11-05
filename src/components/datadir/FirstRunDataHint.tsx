/**
 * 「之前有数据吗？」提示
 *
 * 记录数据目录的指针文件丢了（卸载时勾了删除数据、清理工具、重装系统）之后，软件不知道数据在哪，
 * 只能打开默认目录的空库，看起来就是笔记全没了，接着用户很可能在错误的状态下继续操作。
 * 所以在默认目录打开空库时问一次，判定在 Rust 侧（get_first_run_data_hint）。
 *
 * 仅挂在主窗口（见 App.tsx）。
 */
import { useEffect, useState } from "react";
import { Button, Modal, Typography } from "antd";
import { dataDirApi } from "@/lib/api";

const { Paragraph } = Typography;

export function FirstRunDataHint() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setOpen(await dataDirApi.getFirstRunHint());
      } catch {
        // 读不到就不打扰用户：本来就是兜底提示
      }
    })();
  }, []);

  async function dismiss() {
    setOpen(false);
    try {
      await dataDirApi.dismissFirstRunHint();
    } catch {
      // 没记上顶多下次再问一遍
    }
  }

  async function goChooseDir() {
    await dismiss();
    window.location.hash = "#/settings";
    // 设置页是懒加载的，等它渲染出来再滚过去
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById("settings-data-dir");
      if (el) el.scrollIntoView({ block: "start" });
      tries += 1;
      if (el || tries > 30) window.clearInterval(timer);
    }, 100);
  }

  return (
    <Modal
      title="之前用过知识库吗？"
      open={open}
      closable={false}
      maskClosable={false}
      keyboard={false}
      width={520}
      footer={[
        <Button key="new" onClick={() => void dismiss()}>
          我是新用户，开始使用
        </Button>,
        <Button key="old" type="primary" onClick={() => void goChooseDir()}>
          我之前有数据，去选择目录
        </Button>,
      ]}
    >
      <Paragraph>当前打开的是默认目录下的一个空知识库。</Paragraph>
      <Paragraph style={{ marginBottom: 0 }}>
        如果你之前有笔记（比如放在别的盘，或者刚重装过软件），它们很可能还在原来的文件夹里。
        可以到「设置 → 数据目录」选择那个文件夹，并选「直接使用该目录的数据」。
      </Paragraph>
    </Modal>
  );
}
