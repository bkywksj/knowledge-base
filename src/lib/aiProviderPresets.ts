/**
 * AI provider 预置（与桌面 settings/index.tsx 保持一致）。
 *
 * 后端走 OpenAI 兼容协议；这里的 provider 值只是给前端用来：
 * - 选 default API URL
 * - 选模型 ID 下拉候选
 * - 给"名称"字段一个合理默认
 *
 * 桌面 / 移动端共用一份，未来加新 provider 只需改这里。
 */

export const PROVIDERS = [
  { value: "ollama", label: "Ollama (本地)" },
  { value: "lmstudio", label: "LM Studio (本地 OpenAI 兼容)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "智谱 AI (GLM)" },
  { value: "claude", label: "Claude (经 OpenRouter 等代理)" },
  { value: "minimax", label: "Minimax" },
  { value: "siliconflow", label: "SiliconFlow (硅基流动)" },
  { value: "mimo", label: "小米 MiMo" },
  { value: "kimi", label: "KIMI (月之暗面 Moonshot)" },
  { value: "custom", label: "自定义 (OpenAI 兼容)" },
];

export const DEFAULT_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  claude: "https://openrouter.ai/api/v1",
  minimax: "https://api.minimax.chat/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  mimo: "https://api.xiaomimimo.com/v1",
  // 国内站；国际站为 https://api.moonshot.ai/v1（可在表单里手动改）
  kimi: "https://api.moonshot.cn/v1",
  custom: "",
};

export const MODEL_ID_PLACEHOLDERS: Record<string, string> = {
  ollama: "如: qwen2.5:7b / llama3.2:3b",
  lmstudio: "看 LM Studio 模型页右上角 Model 标识",
  openai: "如: gpt-4o-mini / gpt-4o",
  deepseek: "如: deepseek-chat / deepseek-reasoner",
  zhipu: "如: glm-4-plus / glm-4-flash / glm-4-air",
  claude: "如: anthropic/claude-sonnet-4.6 (经 OpenRouter 等兼容代理)",
  minimax: "如: abab6.5s-chat / MiniMax-M1",
  siliconflow: "如: Qwen/Qwen2.5-72B-Instruct / deepseek-ai/DeepSeek-V3",
  mimo: "如: mimo-v2-pro / mimo-v2-flash",
  kimi: "如: kimi-k2.6 / moonshot-v1-32k",
  custom: "填你目标服务的模型标识",
};

export const PROVIDER_NAME_MAP: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
  claude: "Claude",
  minimax: "Minimax",
  siliconflow: "SiliconFlow",
  mimo: "小米 MiMo",
  kimi: "KIMI",
  custom: "自定义模型",
};

export const MODEL_PRESETS: Record<
  string,
  { value: string; label: string }[]
> = {
  ollama: [
    { value: "qwen3:4b", label: "qwen3:4b (千问3 / 入门)" },
    { value: "qwen3:8b", label: "qwen3:8b (千问3 / 推荐)" },
    { value: "qwen3:14b", label: "qwen3:14b (千问3 / 进阶)" },
    { value: "qwen3:32b", label: "qwen3:32b (千问3 / 旗舰)" },
    { value: "qwq:32b", label: "qwq:32b (千问推理)" },
    { value: "qwen2.5:7b", label: "qwen2.5:7b" },
    { value: "qwen2.5:14b", label: "qwen2.5:14b" },
    { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b (编程)" },
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "gemma2:9b", label: "gemma2:9b" },
  ],
  openai: [
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    { value: "gpt-4-turbo", label: "gpt-4-turbo" },
    { value: "o1-mini", label: "o1-mini" },
    { value: "o1-preview", label: "o1-preview" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "deepseek-chat (V3 通用)" },
    { value: "deepseek-reasoner", label: "deepseek-reasoner (推理)" },
  ],
  zhipu: [
    { value: "glm-4-plus", label: "glm-4-plus (旗舰)" },
    { value: "glm-4-air", label: "glm-4-air (轻量)" },
    { value: "glm-4-flash", label: "glm-4-flash (免费)" },
    { value: "glm-4-long", label: "glm-4-long (长上下文)" },
  ],
  claude: [
    { value: "anthropic/claude-sonnet-4.6", label: "claude-sonnet-4.6 (OpenRouter)" },
    { value: "anthropic/claude-opus-4.7", label: "claude-opus-4.7 (OpenRouter)" },
    { value: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" },
  ],
  lmstudio: [],
  minimax: [
    { value: "abab6.5s-chat", label: "abab6.5s-chat (高速)" },
    { value: "MiniMax-M1", label: "MiniMax-M1" },
  ],
  siliconflow: [
    { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen/Qwen2.5-72B-Instruct" },
    { value: "deepseek-ai/DeepSeek-V3", label: "deepseek-ai/DeepSeek-V3" },
    { value: "deepseek-ai/DeepSeek-R1", label: "deepseek-ai/DeepSeek-R1 (推理)" },
  ],
  mimo: [
    { value: "mimo-v2-pro", label: "mimo-v2-pro (旗舰)" },
    { value: "mimo-v2-flash", label: "mimo-v2-flash (高速)" },
  ],
  kimi: [
    { value: "kimi-k2.6", label: "kimi-k2.6 (旗舰 / 256K)" },
    { value: "kimi-k2.7-code", label: "kimi-k2.7-code (编程)" },
    { value: "kimi-k2.5", label: "kimi-k2.5" },
    { value: "kimi-latest", label: "kimi-latest (跟随最新)" },
    { value: "moonshot-v1-128k", label: "moonshot-v1-128k (长上下文)" },
    { value: "moonshot-v1-32k", label: "moonshot-v1-32k" },
    { value: "moonshot-v1-8k", label: "moonshot-v1-8k" },
  ],
  custom: [],
};

/**
 * 新建 AI 模型时「最大上下文 token」的默认值。
 *
 * 这个数不只是个显示项 —— 后端拿它算 RAG 检索预算和挂载笔记预算
 * （见 services/ai.rs 的 compute_context_budget）。填小了 AI 就只能
 * 看到被截断的片段作答。老默认值 32000 是 2024 年的保守估计，
 * 如今主流模型普遍 128K 起步，故抬到 128000（schema v51 同步抬了存量）。
 *
 * 真·小窗口模型（本地 7B 等）请手动改小，后端有下限保护但不会自动降。
 */
export const DEFAULT_MAX_CONTEXT = 128000;
