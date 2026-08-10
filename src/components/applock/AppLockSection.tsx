import { useEffect, useState } from "react";
import {
  Card,
  Button,
  Space,
  Modal,
  Input,
  Form,
  Alert,
  Select,
  message,
  Tag,
  Typography,
} from "antd";
import { Lock } from "lucide-react";
import { appLockApi } from "@/lib/api";
import { useAppStore } from "@/store";

const { Text } = Typography;

type ModalMode = null | "set" | "change" | "disable";

/** 闲置自动锁定可选档位（分钟）；0 = 关闭 */
const AUTO_LOCK_OPTIONS = [
  { value: 0, label: "关闭" },
  { value: 1, label: "1 分钟" },
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "60 分钟" },
];

/**
 * 设置页"应用启动锁"区块（软锁 / 全局进入密码）。
 *
 * 与 HiddenPin / Vault 完全独立：这是"打开软件就要输密码"的全局门禁。
 * 默认关闭，用户设密码后才生效；可选开启"闲置自动锁定"。
 * 这是 UX 门禁不是加密——挡公用电脑顺手翻，数据库里仍是明文，真加密请用 Vault。
 */
export function AppLockSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [mode, setMode] = useState<ModalMode>(null);
  const autoMinutes = useAppStore((s) => s.appLockAutoMinutes);
  const setAppLockEnabled = useAppStore((s) => s.setAppLockEnabled);
  const setAppLockAutoMinutes = useAppStore((s) => s.setAppLockAutoMinutes);
  const lockAppNow = useAppStore((s) => s.lockAppNow);

  async function refresh() {
    try {
      const st = await appLockApi.status();
      setEnabled(st.enabled);
      // 同步 store，保证 ActivityBar"立即锁定"按钮、自动锁定计时与后端真相一致
      setAppLockEnabled(st.enabled);
      setAppLockAutoMinutes(st.autoLockMinutes);
    } catch (e) {
      message.error(`应用锁状态查询失败: ${e}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeModal() {
    setMode(null);
  }

  async function afterMutate() {
    closeModal();
    await refresh();
  }

  async function handleAutoMinutesChange(value: number) {
    // 乐观更新 store 让计时立即生效；失败回滚
    const prev = autoMinutes;
    setAppLockAutoMinutes(value);
    try {
      await appLockApi.setAutoMinutes(value);
    } catch (e) {
      setAppLockAutoMinutes(prev);
      message.error(`保存失败: ${e}`);
    }
  }

  return (
    <Card
      id="settings-app-lock"
      title={
        <span className="flex items-center gap-2">
          <Lock size={16} />
          应用启动锁
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <Space size={8}>
            <Text>状态</Text>
            {enabled === null ? (
              <Text type="secondary">查询中…</Text>
            ) : enabled ? (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                已启用
              </Tag>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>未启用</Tag>
            )}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            启用后，每次打开软件都要先输入进入密码。适合公用电脑——挡住别人顺手翻看你的日记。
            这是访问门禁不是加密，数据库里仍是明文；如需真加密请用编辑器右上角的「加密保险库」。
          </Text>
        </div>
        <Space>
          {enabled ? (
            <>
              <Button size="small" onClick={() => setMode("change")}>
                修改密码
              </Button>
              <Button size="small" danger onClick={() => setMode("disable")}>
                关闭
              </Button>
            </>
          ) : (
            <Button size="small" type="primary" onClick={() => setMode("set")}>
              启用
            </Button>
          )}
        </Space>
      </div>

      {/* 已启用时：闲置自动锁定 + 立即锁定 */}
      {enabled && (
        <div className="mt-4 flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--kb-border, rgba(0,0,0,0.06))" }}>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Text>闲置自动锁定</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                离开座位超过设定时长无操作，自动回到锁屏。
              </Text>
            </div>
            <Select
              size="small"
              style={{ width: 120 }}
              value={autoMinutes}
              options={AUTO_LOCK_OPTIONS}
              onChange={handleAutoMinutesChange}
            />
          </div>
          <div className="flex items-center justify-between">
            <Text type="secondary" style={{ fontSize: 12 }}>
              临时离开时可手动立即锁定。
            </Text>
            <Button size="small" icon={<Lock size={14} />} onClick={lockAppNow}>
              立即锁定
            </Button>
          </div>
        </div>
      )}

      {mode === "set" && (
        <SetPasswordModal isChange={false} onClose={closeModal} onDone={afterMutate} />
      )}
      {mode === "change" && (
        <SetPasswordModal isChange={true} onClose={closeModal} onDone={afterMutate} />
      )}
      {mode === "disable" && <DisableModal onClose={closeModal} onDone={afterMutate} />}
    </Card>
  );
}

// ─── 子 Modal：设置 / 修改密码 ────────────────────────────────

interface SetPasswordModalProps {
  isChange: boolean;
  onClose: () => void;
  onDone: () => void;
}

function SetPasswordModal({ isChange, onClose, onDone }: SetPasswordModalProps) {
  const [form] = Form.useForm<{
    oldPassword?: string;
    newPassword: string;
    confirmPassword: string;
    hint?: string;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 修改密码时预填现有提示 —— 提交永远按"框里是什么就存什么"处理，
  // 不预填的话用户只想改密码就会把旧提示静默清掉。
  useEffect(() => {
    if (!isChange) return;
    void appLockApi
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
      oldPassword?: string;
      newPassword: string;
      confirmPassword: string;
      hint?: string;
    };
    try {
      values = await form.validateFields();
    } catch {
      return; // 表单校验失败，已自动展示
    }
    if (values.newPassword !== values.confirmPassword) {
      setErrorMsg("两次输入的新密码不一致");
      return;
    }
    // 前端预校验：提示不能直接包含密码（后端也会再校验一次）
    const hintTrimmed = (values.hint ?? "").trim();
    if (
      hintTrimmed &&
      hintTrimmed.toLowerCase().includes(values.newPassword.toLowerCase())
    ) {
      setErrorMsg("提示不能包含密码本身（这会使保护失效）");
      return;
    }
    setSubmitting(true);
    try {
      // 永远传 hint 字段（"" = 清空），让"修改密码时不写提示"也能去掉旧提示
      await appLockApi.setPassword(
        isChange ? values.oldPassword ?? "" : null,
        values.newPassword,
        hintTrimmed,
      );
      message.success(isChange ? "密码已修改" : "应用锁已启用");
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
      title={isChange ? "修改进入密码" : "启用应用锁"}
      okText={isChange ? "保存" : "启用"}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
      mask={{ closable: false }}
    >
      {!isChange && (
        <Alert
          type="info"
          showIcon
          className="mb-3"
          message="启用后下次打开软件就要输此密码。忘记密码可在设置页关闭后重设（数据不会丢失）。"
        />
      )}
      <Form form={form} layout="vertical" preserve={false}>
        {isChange && (
          <Form.Item
            name="oldPassword"
            label="当前密码"
            rules={[{ required: true, message: "请输入当前密码" }]}
          >
            <Input.Password autoFocus autoComplete="off" maxLength={64} />
          </Form.Item>
        )}
        <Form.Item
          name="newPassword"
          label={isChange ? "新密码" : "进入密码"}
          rules={[
            { required: true, message: "请输入密码" },
            { min: 4, message: "至少 4 位" },
            { max: 64, message: "最多 64 位" },
          ]}
          extra="建议 4-8 位数字或简短组合，方便每次启动快速输入"
        >
          <Input.Password
            autoFocus={!isChange}
            autoComplete="off"
            maxLength={64}
            placeholder="4-64 位"
          />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
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
              忘记密码时会显示在锁屏；
              <Text type="warning" style={{ fontSize: 12 }}>
                不能写出密码本身
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

// ─── 子 Modal：关闭应用锁 ────────────────────────────────────

function DisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleOk() {
    if (!password.trim()) {
      setErrorMsg("请输入当前密码");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await appLockApi.disable(password);
      message.success("已关闭应用锁");
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
      title="关闭应用锁"
      okText="关闭"
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
        message="关闭后，打开软件将不再需要输入密码"
        className="mb-3"
      />
      <Input.Password
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onPressEnter={handleOk}
        placeholder="请输入当前密码以确认"
        autoFocus
        autoComplete="off"
        maxLength={64}
      />
      {errorMsg && <Alert type="error" message={errorMsg} showIcon className="mt-2" />}
    </Modal>
  );
}
