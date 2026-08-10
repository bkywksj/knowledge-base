import { useEffect, useState } from "react";
import {
  Card,
  Button,
  Space,
  Modal,
  Input,
  Form,
  Alert,
  message,
  Tag,
  Typography,
} from "antd";
import { EyeOff } from "lucide-react";
import { hiddenPinApi } from "@/lib/api";
import { useAppStore } from "@/store";

const { Text } = Typography;

type ModalMode = null | "set" | "change" | "clear";

/**
 * 设置页"隐藏笔记访问保护"区块。
 *
 * 与 Vault 设置完全独立 —— 这里只是 UX 门禁，挡随手访问 /hidden 入口；
 * 隐藏笔记内容在数据库里仍是明文，需强加密请用 Vault。
 */
export function HiddenPinSection() {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [mode, setMode] = useState<ModalMode>(null);
  const clearHiddenUnlock = useAppStore((s) => s.clearHiddenUnlock);

  async function refresh() {
    try {
      setHasPin(await hiddenPinApi.isSet());
    } catch (e) {
      message.error(`PIN 状态查询失败: ${e}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function closeModal() {
    setMode(null);
  }

  async function afterMutate() {
    closeModal();
    // 任何变更都让会话失效，避免"刚改完密码但旧解锁会话还有效"的错觉
    clearHiddenUnlock();
    await refresh();
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <EyeOff size={16} />
          隐藏笔记访问保护
        </span>
      }
    >
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <Space size={8}>
            <Text>状态</Text>
            {hasPin === null ? (
              <Text type="secondary">查询中…</Text>
            ) : hasPin ? (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                已启用
              </Tag>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>未启用</Tag>
            )}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            设置 PIN 后，点左下角「隐藏笔记」需先输入 PIN 才能进入。这是 UX
            门禁不是加密，数据库里仍是明文；如需真加密请用编辑器右上角的「加密保险库」。
          </Text>
        </div>
        <Space>
          {hasPin ? (
            <>
              <Button size="small" onClick={() => setMode("change")}>
                修改
              </Button>
              <Button size="small" danger onClick={() => setMode("clear")}>
                清除
              </Button>
            </>
          ) : (
            <Button size="small" type="primary" onClick={() => setMode("set")}>
              启用 PIN
            </Button>
          )}
        </Space>
      </div>

      {mode === "set" && (
        <SetPinModal isChange={false} onClose={closeModal} onDone={afterMutate} />
      )}
      {mode === "change" && (
        <SetPinModal isChange={true} onClose={closeModal} onDone={afterMutate} />
      )}
      {mode === "clear" && <ClearPinModal onClose={closeModal} onDone={afterMutate} />}
    </Card>
  );
}

// ─── 子 Modal：设置 / 修改 PIN ────────────────────────────────

interface SetPinModalProps {
  isChange: boolean;
  onClose: () => void;
  onDone: () => void;
}

function SetPinModal({ isChange, onClose, onDone }: SetPinModalProps) {
  const [form] = Form.useForm<{
    oldPin?: string;
    newPin: string;
    confirmPin: string;
    hint?: string;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 修改 PIN 时预填现有提示 —— 提交永远按"框里是什么就存什么"处理，
  // 不预填的话用户只想改 PIN 就会把旧提示静默清掉。
  useEffect(() => {
    if (!isChange) return;
    void hiddenPinApi
      .getHint()
      .then((h) => {
        if (h && h.trim()) form.setFieldValue("hint", h);
      })
      .catch(() => {
        /* 拉不到就当没提示，不打扰用户 */
      });
  }, [isChange, form]);

  async function handleOk() {
    setErrorMsg(null);
    let values: {
      oldPin?: string;
      newPin: string;
      confirmPin: string;
      hint?: string;
    };
    try {
      values = await form.validateFields();
    } catch {
      return; // 表单校验失败，已自动展示
    }
    if (values.newPin !== values.confirmPin) {
      setErrorMsg("两次输入的新 PIN 不一致");
      return;
    }
    // 前端预校验：提示不能直接包含 PIN（后端也会再校验一次）
    const hintTrimmed = (values.hint ?? "").trim();
    if (hintTrimmed && hintTrimmed.toLowerCase().includes(values.newPin.toLowerCase())) {
      setErrorMsg("提示不能包含 PIN 本身（这会使保护失效）");
      return;
    }
    setSubmitting(true);
    try {
      // 永远传 hint 字段（"" = 清空），让"修改 PIN 时不写提示"也能去掉旧提示
      await hiddenPinApi.set(
        isChange ? values.oldPin ?? "" : null,
        values.newPin,
        hintTrimmed,
      );
      message.success(isChange ? "PIN 已修改" : "PIN 已启用");
      onDone();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title={isChange ? "修改隐藏笔记 PIN" : "启用隐藏笔记 PIN"}
      okText={isChange ? "保存" : "启用"}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
      mask={{ closable: false }}
    >
      <Form form={form} layout="vertical" preserve={false}>
        {isChange && (
          <Form.Item
            name="oldPin"
            label="当前 PIN"
            rules={[{ required: true, message: "请输入当前 PIN" }]}
          >
            <Input.Password autoFocus autoComplete="off" maxLength={64} />
          </Form.Item>
        )}
        <Form.Item
          name="newPin"
          label={isChange ? "新 PIN" : "PIN"}
          rules={[
            { required: true, message: "请输入 PIN" },
            { min: 4, message: "至少 4 位" },
            { max: 64, message: "最多 64 位" },
          ]}
          extra="建议 4-8 位数字或简短组合，方便快速输入"
        >
          <Input.Password
            autoFocus={!isChange}
            autoComplete="off"
            maxLength={64}
            placeholder="4-64 位"
          />
        </Form.Item>
        <Form.Item
          name="confirmPin"
          label="再次输入"
          rules={[{ required: true, message: "请再次输入" }]}
        >
          <Input.Password autoComplete="off" maxLength={64} />
        </Form.Item>
        <Form.Item
          name="hint"
          label="密码提示（可选）"
          extra={
            <span>
              忘记 PIN 时会显示在解锁框；
              <Text type="warning" style={{ fontSize: 12 }}>
                不能写出 PIN 本身
              </Text>
              。例如「我家小狗的名字」。
            </span>
          }
          rules={[{ max: 100, message: "最多 100 字符" }]}
        >
          <Input
            placeholder="留空则不设提示"
            maxLength={100}
            showCount
            autoComplete="off"
          />
        </Form.Item>
      </Form>
      {errorMsg && <Alert type="error" message={errorMsg} showIcon className="mt-2" />}
    </Modal>
  );
}

// ─── 子 Modal：清除 PIN ────────────────────────────────────

function ClearPinModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleOk() {
    if (!pin.trim()) {
      setErrorMsg("请输入当前 PIN");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await hiddenPinApi.clear(pin);
      message.success("已清除 PIN");
      onDone();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title="清除隐藏笔记 PIN"
      okText="清除"
      okButtonProps={{ danger: true }}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
      mask={{ closable: false }}
    >
      <Alert
        type="warning"
        showIcon
        message="清除后，点「隐藏笔记」将不再需要 PIN"
        className="mb-3"
      />
      <Input.Password
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        onPressEnter={handleOk}
        placeholder="请输入当前 PIN 以确认"
        autoFocus
        autoComplete="off"
        maxLength={64}
      />
      {errorMsg && <Alert type="error" message={errorMsg} showIcon className="mt-2" />}
    </Modal>
  );
}
