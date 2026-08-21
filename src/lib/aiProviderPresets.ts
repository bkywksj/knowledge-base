/**
 * AI provider 预置 —— 桌面 / 移动端**唯一**数据源。
 *
 * 🔴 别在页面里再抄一份。此前 `settings/index.tsx` 自己复制了一整套
 * （PROVIDERS / DEFAULT_URLS / MODEL_ID_PLACEHOLDERS / MODEL_PRESETS），
 * 与本文件"共用一份"的注释自相矛盾 —— 改一处忘另一处，两端就不一致。
 *
 * # 后端只认两种协议
 *
 * `services/ai.rs` 里是 `match provider { "ollama" => 原生, _ => OpenAI 兼容 }`。
 * 所以下面除 `ollama` 外**全部**走 OpenAI 兼容协议，provider 值只决定前端三件事：
 * 默认 baseUrl、模型候选、名称默认值。加一家新服务 = 在这里加一条，零后端改动。
 *
 * # 为什么 Claude 有两条
 *
 * `claude` = Anthropic 官方（2026-03 起官方提供 OpenAI 兼容端点，见
 * platform.claude.com/docs/en/api/openai-sdk）；`openrouter` = 聚合网关，
 * 上面能跑 Claude / Gemini / Llama 等几百个模型。
 * 早先把两者混成一条「Claude (经 OpenRouter 等代理)」，导致
 * 官方 API 反而选不了、OpenRouter 的多模型能力也看不出来。
 */

/** 一条 provider 预置。`desc` 是下拉里的副文本，别把说明挤进 `label` 括号 */
export interface ProviderPreset {
  value: string;
  label: string;
  desc: string;
}

export const PROVIDERS: ProviderPreset[] = [
  // ── 本地（不花钱，数据不出机器）─────────────────
  { value: "ollama", label: "Ollama", desc: "本地模型，走 Ollama 原生协议" },
  { value: "lmstudio", label: "LM Studio", desc: "本地，OpenAI 兼容端口" },
  { value: "vllm", label: "vLLM / 自建推理服务", desc: "自部署的 OpenAI 兼容端点" },

  // ── 国内 ───────────────────────────────────────
  { value: "deepseek", label: "DeepSeek", desc: "深度求索，性价比高" },
  { value: "zhipu", label: "智谱 AI (GLM)", desc: "清华系，GLM 系列" },
  { value: "qwen", label: "通义千问", desc: "阿里云百炼，兼容模式端点" },
  { value: "doubao", label: "字节豆包 (火山方舟)", desc: "模型 ID 填「接入点 ID」而非模型名" },
  { value: "kimi", label: "KIMI (月之暗面)", desc: "Moonshot，长上下文见长" },
  { value: "siliconflow", label: "SiliconFlow (硅基流动)", desc: "聚合多家开源模型" },
  { value: "minimax", label: "MiniMax", desc: "稀宇科技" },
  { value: "qianfan", label: "百度千帆", desc: "文心一言等" },
  { value: "hunyuan", label: "腾讯混元", desc: "腾讯云" },
  { value: "stepfun", label: "阶跃星辰", desc: "Step 系列" },
  { value: "baichuan", label: "百川智能", desc: "Baichuan 系列" },
  { value: "lingyi", label: "零一万物", desc: "Yi 系列" },
  { value: "mimo", label: "小米 MiMo", desc: "小米自研" },

  // ── 国际 ───────────────────────────────────────
  { value: "openai", label: "OpenAI", desc: "GPT 系列官方" },
  { value: "claude", label: "Claude (Anthropic 官方)", desc: "官方 OpenAI 兼容端点" },
  { value: "gemini", label: "Google Gemini", desc: "官方 OpenAI 兼容端点" },
  { value: "xai", label: "xAI (Grok)", desc: "马斯克旗下" },
  { value: "groq", label: "Groq", desc: "推理速度极快的托管服务" },
  { value: "together", label: "Together AI", desc: "开源模型托管" },
  { value: "openrouter", label: "OpenRouter", desc: "聚合网关，一个 key 打通上百家" },

  // ── 兜底 ───────────────────────────────────────
  {
    value: "custom",
    label: "自定义端点",
    desc: "任意 OpenAI 兼容服务：中转站 / 自建网关 / 未列出的厂商",
  },
];

/**
 * 各 provider 的默认 baseUrl（**不含** `/chat/completions` 后缀）。
 *
 * 只在「新建模型」和「切换 provider」时填进表单，**不影响存量模型** ——
 * 那些用的是库里存的具体 URL。所以改这里的值对老用户无感。
 */
export const DEFAULT_URLS: Record<string, string> = {
  // 本地
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  vllm: "http://localhost:8000/v1",

  // 国内
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  // 北京地域；新加坡站为 dashscope-intl.aliyuncs.com
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  // 国内站；国际站为 https://api.moonshot.ai/v1
  kimi: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  minimax: "https://api.minimax.chat/v1",
  qianfan: "https://qianfan.baidubce.com/v2",
  hunyuan: "https://api.hunyuan.cloud.tencent.com/v1",
  stepfun: "https://api.stepfun.com/v1",
  baichuan: "https://api.baichuan-ai.com/v1",
  lingyi: "https://api.lingyiwanwu.com/v1",
  mimo: "https://api.xiaomimimo.com/v1",

  // 国际
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",

  // 兜底：留空，逼用户自己填
  custom: "",
};

export const MODEL_ID_PLACEHOLDERS: Record<string, string> = {
  ollama: "如: qwen3:8b / llama3.1:8b",
  lmstudio: "看 LM Studio 模型页右上角 Model 标识",
  vllm: "启动 vLLM 时 --served-model-name 指定的名字",

  deepseek: "如: deepseek-chat / deepseek-reasoner",
  zhipu: "如: glm-4-plus / glm-4-flash",
  qwen: "如: qwen-plus / qwen-max / qwen-turbo",
  // 火山方舟这点很容易踩坑，单独写清楚
  doubao: "填「接入点 ID」（形如 ep-2024xxxx-xxxxx），不是模型名",
  kimi: "如: kimi-k2.6 / moonshot-v1-128k",
  siliconflow: "如: Qwen/Qwen2.5-72B-Instruct / deepseek-ai/DeepSeek-V3",
  minimax: "如: MiniMax-M1 / abab6.5s-chat",
  qianfan: "如: ernie-4.5-turbo-128k",
  hunyuan: "如: hunyuan-turbos-latest / hunyuan-large",
  stepfun: "如: step-2-16k / step-1-flash",
  baichuan: "如: Baichuan4-Turbo / Baichuan3-Turbo",
  lingyi: "如: yi-lightning / yi-large",
  mimo: "如: mimo-v2-pro / mimo-v2-flash",

  openai: "如: gpt-4o-mini / gpt-4o",
  claude: "如: claude-sonnet-4-5-20250929",
  gemini: "如: gemini-2.5-pro / gemini-2.5-flash",
  xai: "如: grok-4 / grok-3-mini",
  groq: "如: llama-3.3-70b-versatile",
  together: "如: meta-llama/Llama-3.3-70B-Instruct-Turbo",
  // OpenRouter 的模型 ID 一律带厂商前缀，这点必须说明
  openrouter: "带厂商前缀，如: anthropic/claude-sonnet-4.6",

  custom: "填你目标服务的模型标识",
};

export const PROVIDER_NAME_MAP: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",

  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
  qwen: "通义千问",
  doubao: "豆包",
  kimi: "KIMI",
  siliconflow: "SiliconFlow",
  minimax: "MiniMax",
  qianfan: "百度千帆",
  hunyuan: "腾讯混元",
  stepfun: "阶跃星辰",
  baichuan: "百川",
  lingyi: "零一万物",
  mimo: "小米 MiMo",

  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  xai: "Grok",
  groq: "Groq",
  together: "Together",
  openrouter: "OpenRouter",

  custom: "自定义模型",
};

/**
 * 模型 ID 候选。**只是候选**，输入框是 AutoComplete，用户可以填任意值 ——
 * 所以模型迭代快的厂商这里没列全也不影响使用。
 */
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
    { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b (编程)" },
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "gemma2:9b", label: "gemma2:9b" },
  ],
  lmstudio: [],
  vllm: [],

  deepseek: [
    { value: "deepseek-chat", label: "deepseek-chat (通用)" },
    { value: "deepseek-reasoner", label: "deepseek-reasoner (推理)" },
  ],
  zhipu: [
    { value: "glm-4-plus", label: "glm-4-plus (旗舰)" },
    { value: "glm-4-air", label: "glm-4-air (轻量)" },
    { value: "glm-4-flash", label: "glm-4-flash (免费)" },
    { value: "glm-4-long", label: "glm-4-long (长上下文)" },
  ],
  qwen: [
    { value: "qwen-max", label: "qwen-max (旗舰)" },
    { value: "qwen-plus", label: "qwen-plus (均衡)" },
    { value: "qwen-turbo", label: "qwen-turbo (高速)" },
    { value: "qwen-long", label: "qwen-long (长上下文)" },
  ],
  doubao: [],
  kimi: [
    { value: "kimi-k2.6", label: "kimi-k2.6 (旗舰 / 256K)" },
    { value: "kimi-k2.7-code", label: "kimi-k2.7-code (编程)" },
    { value: "kimi-latest", label: "kimi-latest (跟随最新)" },
    { value: "moonshot-v1-128k", label: "moonshot-v1-128k (长上下文)" },
    { value: "moonshot-v1-32k", label: "moonshot-v1-32k" },
  ],
  siliconflow: [
    { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen/Qwen2.5-72B-Instruct" },
    { value: "deepseek-ai/DeepSeek-V3", label: "deepseek-ai/DeepSeek-V3" },
    { value: "deepseek-ai/DeepSeek-R1", label: "deepseek-ai/DeepSeek-R1 (推理)" },
  ],
  minimax: [
    { value: "MiniMax-M1", label: "MiniMax-M1" },
    { value: "abab6.5s-chat", label: "abab6.5s-chat (高速)" },
  ],
  qianfan: [{ value: "ernie-4.5-turbo-128k", label: "ernie-4.5-turbo-128k" }],
  hunyuan: [
    { value: "hunyuan-turbos-latest", label: "hunyuan-turbos-latest" },
    { value: "hunyuan-large", label: "hunyuan-large" },
  ],
  stepfun: [
    { value: "step-2-16k", label: "step-2-16k" },
    { value: "step-1-flash", label: "step-1-flash (高速)" },
  ],
  baichuan: [
    { value: "Baichuan4-Turbo", label: "Baichuan4-Turbo" },
    { value: "Baichuan3-Turbo-128k", label: "Baichuan3-Turbo-128k" },
  ],
  lingyi: [
    { value: "yi-lightning", label: "yi-lightning (高速)" },
    { value: "yi-large", label: "yi-large" },
  ],
  mimo: [
    { value: "mimo-v2-pro", label: "mimo-v2-pro (旗舰)" },
    { value: "mimo-v2-flash", label: "mimo-v2-flash (高速)" },
  ],

  openai: [
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    { value: "gpt-4-turbo", label: "gpt-4-turbo" },
    { value: "o1-mini", label: "o1-mini" },
  ],
  claude: [
    { value: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5 (均衡)" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5 (高速)" },
  ],
  gemini: [
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash (高速)" },
  ],
  xai: [
    { value: "grok-4", label: "grok-4" },
    { value: "grok-3-mini", label: "grok-3-mini" },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile" },
    { value: "qwen-2.5-32b", label: "qwen-2.5-32b" },
  ],
  together: [
    {
      value: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      label: "Llama-3.3-70B-Instruct-Turbo",
    },
  ],
  openrouter: [
    { value: "anthropic/claude-sonnet-4.6", label: "anthropic/claude-sonnet-4.6" },
    { value: "anthropic/claude-opus-4.7", label: "anthropic/claude-opus-4.7" },
    { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    { value: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
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
