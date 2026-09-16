/**
 * 应用设置：LLM 与语音服务的配置读写。
 *
 * 存在 localStorage —— 单人桌面应用，不需要更重的方案。
 * API key 明文存本地是这里的正常取舍；要同步到多设备时再换系统钥匙串。
 *
 * **写入时机**：由设置面板在输入变化时自动落盘（防抖 400ms，关面板再兜底一次），
 * 不依赖用户点「保存」。见 `SettingsPanel.vue` 的 persistNow/schedulePersist。
 * 不要改回「只在点保存时写」—— 那种模式下关掉面板就会丢掉刚填的内容，
 * 用户看到的现象是「设置每次都重置」。
 */
import type { TTSConfig } from './audio/tts'
import type { LLMConfig } from './agent/types'

const LLM_KEY = 'nexus.llm.config'
const TTS_KEY = 'nexus.tts.config'

/** 常见服务商的 OpenAI 兼容端点，省得手敲 baseURL */
export interface LLMPreset {
  id: string
  label: string
  baseURL: string
  model: string
}

export const LLM_PRESETS: LLMPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', label: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
]

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseURL: LLM_PRESETS[0].baseURL,
  apiKey: '',
  model: LLM_PRESETS[0].model,
  temperature: 0.85,
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  baseURL: 'http://127.0.0.1:8765',
  voice: 'default',
  speed: 1,
}

function readJSON<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...fallback }
    const parsed = JSON.parse(raw) as Partial<T>
    // 逐字段兜底：旧版本配置缺字段时不应让整条链路挂掉
    return { ...fallback, ...parsed }
  } catch {
    return { ...fallback }
  }
}

function writeJSON(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.warn('[settings] 保存失败', err)
  }
}

export function loadLLMConfig(): LLMConfig {
  return readJSON<LLMConfig>(LLM_KEY, DEFAULT_LLM_CONFIG)
}

export function saveLLMConfig(cfg: LLMConfig): void {
  writeJSON(LLM_KEY, cfg)
}

export function loadTTSConfig(): TTSConfig {
  return readJSON<TTSConfig>(TTS_KEY, DEFAULT_TTS_CONFIG)
}

export function saveTTSConfig(cfg: TTSConfig): void {
  writeJSON(TTS_KEY, cfg)
}

/** 配置是否可用（有 key 且有端点） */
export function isLLMReady(cfg: LLMConfig): boolean {
  return Boolean(cfg.apiKey.trim() && cfg.baseURL.trim() && cfg.model.trim())
}

// ---------------------------------------------------------------- agent 服务

/**
 * agent 服务（工具 / MCP / 记忆）。
 *
 * ★ 默认**开着**，理由：服务不在时是**自动**退回直连 LLM 的（见 session.ts），
 *   代价只是一次本地连接失败。所以默认开着 = "她随时可能多出工具和记忆"，
 *   而不是"用户得先搞懂有这么个服务"。
 *
 * sessionId 现在固定 default：等有了多角色/多会话，它就是分开记记忆的依据。
 */
const AGENT_KEY = 'nexus.agent.config'

export interface AgentConfig {
  url: string
  enabled: boolean
  sessionId?: string
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  url: 'http://127.0.0.1:8766',
  enabled: true,
  sessionId: 'default',
}

export function loadAgentConfig(): AgentConfig {
  return readJSON<AgentConfig>(AGENT_KEY, DEFAULT_AGENT_CONFIG)
}

export function saveAgentConfig(cfg: AgentConfig): void {
  writeJSON(AGENT_KEY, cfg)
}

// ---------------------------------------------------------------- 待机动作

/**
 * 待机幅度。
 *
 * 为什么要做成设置：待机是**永远在跑**的底色，幅度只差一点点，观感差别巨大 ——
 * 稍微大一点就像在飘，完全关掉又像贴图。这个只能本人看着调，代码里猜不准。
 */
export type IdleActivity = 'off' | 'calm' | 'normal'

const IDLE_KEY = 'nexus.idle.activity'

/** 幅度倍率：0 = 不动，1 = 标准 */
export const IDLE_FACTOR: Record<IdleActivity, number> = {
  off: 0,
  calm: 0.45,
  normal: 1,
}

export const IDLE_LABELS: Record<IdleActivity, string> = {
  off: '静止（只眨眼）',
  calm: '轻微',
  normal: '标准',
}

export function loadIdleActivity(): IdleActivity {
  try {
    const raw = localStorage.getItem(IDLE_KEY)
    if (raw === 'off' || raw === 'calm' || raw === 'normal') return raw
  } catch {
    // 读不到就用默认
  }
  return 'normal'
}

/**
 * 当前幅度倍率。
 *
 * ★ 用可变对象而不是函数：渲染循环每帧都要读它，
 *   而设置面板改了要**立刻**生效（不能靠刷新页面，那样调起来太难受）。
 *   读一个对象的字段是零成本，读 localStorage 每帧就是自找麻烦。
 */
export const idleRuntime = { factor: IDLE_FACTOR[loadIdleActivity()] }

export function setIdleActivity(value: IdleActivity): void {
  idleRuntime.factor = IDLE_FACTOR[value]
  try {
    // 存原始字符串（不是 JSON），和 loadIdleActivity 的读法对齐
    localStorage.setItem(IDLE_KEY, value)
  } catch (err) {
    console.warn('[settings] 保存待机幅度失败', err)
  }
}
