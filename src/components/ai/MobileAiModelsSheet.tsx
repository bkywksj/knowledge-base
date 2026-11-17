import { useCallback, useEffect, useState } from "react";
import { message, Modal } from "antd";
import { Bot, Pencil, Plus, Star, Trash2, Zap } from "lucide-react";
import { aiModelApi } from "@/lib/api";
import type { AiModel } from "@/types";
import { MSheet } from "@/components/mobile/MSheet";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";

/**
 * 移动端「模型服务」管理面板（入口：「我的」页 → 模型服务）。
 *
 * 以前那一行直接跳到 AI 对话页，手机上只能加模型、不能改也不能删（用户反馈）。
 * 这里列出全部模型：点一行出操作（编辑 / 设为默认 / 测试连接 / 删除），底部「新建模型服务」。
 * 编辑和新建共用 MobileAiModelModal；Key 不回显，测试走 testSaved（后端自取明文）。
 */
export function MobileAiModelsSheet({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** 列表变化后回报条数（「我的」页那一行的「N 个」） */
  onChanged?: (count: number) => void;
}) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionModel, setActionModel] = useState<AiModel | null>(null);
  /** 编辑弹窗：undefined = 关；null = 新建；模型 = 编辑它 */
  const [formTarget, setFormTarget] = useState<AiModel | null | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await aiModelApi.list();
      setModels(list);
      onChanged?.(list.length);
    } catch (e) {
      message.error(`加载模型失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function setDefault(m: AiModel) {
    try {
      await aiModelApi.setDefault(m.id);
      message.success(`已将 ${m.name} 设为默认`);
      void load();
    } catch (e) {
      message.error(`设置失败: ${e}`);
    }
  }

  async function test(m: AiModel) {
    const hide = message.loading(`正在测试 ${m.name}…`, 0);
    try {
      const r = await aiModelApi.testSaved(m.id);
      hide();
      if (r.ok) message.success(`连接正常（${r.latency_ms} ms）`);
      else message.error("连接失败");
    } catch (e) {
      hide();
      message.error(`连接失败: ${e}`);
    }
  }

  function confirmDelete(m: AiModel) {
    Modal.confirm({
      title: `删除「${m.name}」？`,
      // ai_conversations.model_id 是 ON DELETE CASCADE（库里开着 foreign_keys），对话会跟着删
      content: "用这个模型的对话会一并删除，不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        try {
          await aiModelApi.delete(m.id);
          message.success("已删除");
          void load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  const actions: ActionSheetItem[] = actionModel
    ? [
        { key: "edit", label: "编辑", icon: <Pencil size={20} />, onClick: () => setFormTarget(actionModel) },
        ...(actionModel.is_default
          ? []
          : [{ key: "default", label: "设为默认", icon: <Star size={20} />, onClick: () => void setDefault(actionModel) }]),
        { key: "test", label: "测试连接", icon: <Zap size={20} />, onClick: () => void test(actionModel) },
        { key: "delete", label: "删除", icon: <Trash2 size={20} />, danger: true, onClick: () => confirmDelete(actionModel) },
      ]
    : [];

  return (
    <>
      <MSheet open={open} title="模型服务" caption="点一项可编辑、设为默认或删除" onClose={onClose} cancelText="完成">
        <div className="m-group">
          {models.map((m) => (
            <button key={m.id} type="button" className="m-row m-row-icon" onClick={() => setActionModel(m)}>
              <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink3)" }}>
                <Bot size={20} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="truncate text-[15px]">{m.name}</span>
                <span className="m-t-cap truncate">{m.model_id}</span>
              </span>
              {m.is_default && <span className="m-t-meta shrink-0" style={{ color: "var(--m-accent-ink)" }}>默认</span>}
            </button>
          ))}
          {!loading && models.length === 0 && (
            <div className="m-row m-t-cap justify-center">还没有模型</div>
          )}
          <button type="button" className="m-row m-row-icon" style={{ color: "var(--m-accent-ink)" }} onClick={() => setFormTarget(null)}>
            <span className="flex w-6 shrink-0 justify-center">
              <Plus size={20} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-[15px]">新建模型服务</span>
          </button>
        </div>
      </MSheet>
      {/* 放在 MSheet 后面：同为 .m-sheet-mask（z-index 相同），后渲染的盖在上面 */}
      <ActionSheet
        open={actionModel != null}
        title={actionModel?.name}
        subtitle={actionModel?.model_id}
        items={actions}
        onClose={() => setActionModel(null)}
      />
      <MobileAiModelModal
        open={formTarget !== undefined}
        editing={formTarget ?? null}
        onClose={() => setFormTarget(undefined)}
        onSaved={() => void load()}
      />
    </>
  );
}
