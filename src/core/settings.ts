/**
 * 应用设置：LLM 与语音服务的配置读写。
 *
 * 存在 localStorage —— 单人桌面应用，不需要更重的方案。
 * API key 明文存本地是这里的正常取舍；要同步到多设备时再换系统钥匙串。
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
