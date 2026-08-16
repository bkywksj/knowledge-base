import { useEffect, useState } from "react";
import { Button, Input, Space, Typography, message } from "antd";
import { configApi } from "@/lib/api";

const { Text } = Typography;

/** 与 Rust 侧 `web_clip::JINA_KEY_CONFIG` 保持一致 */
const JINA_KEY_CONFIG = "web_clip_jina_key";

/**
 * 网页剪藏的 Jina Reader API Key 设置（可选兜底）
 *
 * 剪藏默认直连原网页本地提取正文，不需要任何 Key。这里配的 Key 只在直连失败时
 * （对方站点反爬、需登录、页面纯 JS 渲染）作为第二次尝试，留空 = 不启用兜底。
 *
 * 做成自包含组件：设置页已有几十个 useState，这个边缘可选项没必要再往里塞，
 * 自己管加载 / 保存即可。
 */
export function WebClipJinaKeySetting() {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 后端返回 Option<String>，没配过时是 null
        const saved = await configApi.get(JINA_KEY_CONFIG);
        if (alive) setKey(saved ?? "");
      } catch {
        // 读不到就当没配（例如该 key 从未写入），不打扰用户
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await configApi.set(JINA_KEY_CONFIG, key.trim());
      message.success(key.trim() ? "已保存 Jina API Key" : "已清空，剪藏只走直连");
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 pt-3" style={{ borderTop: "1px solid #f0f0f0" }}>
      <div style={{ fontSize: 14 }}>网页剪藏兜底（Jina API Key）</div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        网页剪藏默认直连原网页提取正文，<b>无需配置</b>。只有遇到反爬严格、需登录或纯 JS
        渲染的页面才会抓不到；此时若填了 Jina Reader 的 API Key，会自动用它再试一次。
        留空即不启用。
      </Text>
      <Space.Compact className="mt-2" style={{ width: "100%", maxWidth: 460 }}>
        <Input.Password
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="jina_...（可选，留空则只走直连）"
          disabled={loading || saving}
          autoComplete="off"
        />
        <Button type="primary" onClick={handleSave} loading={saving} disabled={loading}>
          保存
        </Button>
      </Space.Compact>
    </div>
  );
}
