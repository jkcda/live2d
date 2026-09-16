<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  LLM_PRESETS,
  loadLLMConfig,
  loadTTSConfig,
  saveLLMConfig,
  saveTTSConfig,
} from '@/core/settings'
import { reconfigureSession, voiceOutput } from '@/core/runtime'
import { streamChat } from '@/core/agent/llm'

const emit = defineEmits<{ close: [] }>()

const baseURL = ref('')
const apiKey = ref('')
const model = ref('')
const temperature = ref(0.85)

const ttsURL = ref('')
const ttsVoice = ref('')
const ttsSpeed = ref(1)

const llmTest = ref('')
const ttsTest = ref('')
const testing = ref(false)

onMounted(() => {
  const llm = loadLLMConfig()
  baseURL.value = llm.baseURL
  apiKey.value = llm.apiKey
  model.value = llm.model
  temperature.value = llm.temperature ?? 0.85

  const tts = loadTTSConfig()
  ttsURL.value = tts.baseURL
  ttsVoice.value = tts.voice ?? 'default'
  ttsSpeed.value = tts.speed ?? 1
})

function applyPreset(id: string) {
  const p = LLM_PRESETS.find((x) => x.id === id)
  if (!p) return
  baseURL.value = p.baseURL
  model.value = p.model
}

function save() {
  saveLLMConfig({
    baseURL: baseURL.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    temperature: temperature.value,
  })
  saveTTSConfig({
    baseURL: ttsURL.value.trim(),
    voice: ttsVoice.value.trim() || 'default',
    speed: ttsSpeed.value,
  })
  reconfigureSession()
  llmTest.value = '已保存'
  ttsTest.value = ''
}

/** 用最小成本验证 key 是否可用：只要一个 token */
async function testLLM() {
  testing.value = true
  llmTest.value = '测试中…'
  try {
    let got = false
    for await (const ev of streamChat(
      [{ role: 'user', content: '说"好"' }],
      {
        baseURL: baseURL.value.trim(),
        apiKey: apiKey.value.trim(),
        model: model.value.trim(),
        maxTokens: 8,
      },
    )) {
      if (ev.type === 'delta') got = true
      if (ev.type === 'error') {
        llmTest.value = `失败：${ev.message}`
        testing.value = false
        return
      }
    }
    llmTest.value = got ? '连接正常' : '连上了但没返回内容'
  } catch (err) {
    llmTest.value = `失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    testing.value = false
  }
}

async function testTTS() {
  ttsTest.value = '探测中…'
  saveTTSConfig({
    baseURL: ttsURL.value.trim(),
    voice: ttsVoice.value.trim() || 'default',
    speed: ttsSpeed.value,
  })
  const ok = await voiceOutput.health()
  ttsTest.value = ok ? '服务在线' : '连不上（服务未启动？）'
}
</script>

<template>
  <div class="panel no-drag">
    <header class="head">
      <span class="title">设置</span>
      <div class="spacer" />
      <button class="icon" @click="emit('close')">✕</button>
    </header>

    <div class="body">
      <section>
        <h3>对话模型</h3>

        <div class="presets">
          <button
            v-for="p in LLM_PRESETS"
            :key="p.id"
            class="chip"
            :class="{ on: baseURL === p.baseURL }"
            @click="applyPreset(p.id)"
          >
            {{ p.label }}
          </button>
        </div>

        <label>
          <span>接口地址</span>
          <input v-model="baseURL" spellcheck="false" placeholder="https://…/v1" />
        </label>

        <label>
          <span>API Key</span>
          <input v-model="apiKey" type="password" spellcheck="false" placeholder="sk-…" />
        </label>

        <label>
          <span>模型</span>
          <input v-model="model" spellcheck="false" placeholder="deepseek-chat" />
        </label>

        <label>
          <span>温度 {{ temperature.toFixed(2) }}</span>
          <input v-model.number="temperature" type="range" min="0" max="1.5" step="0.05" />
        </label>

        <div class="actions">
          <button class="btn" :disabled="testing" @click="testLLM">测试连接</button>
          <span class="hint">{{ llmTest }}</span>
        </div>
      </section>

      <section>
        <h3>语音服务</h3>
        <p class="note">
          CosyVoice 2 推理服务，跑在本地或云 GPU 上。服务没起来时只是不出声，不影响文字对话。
        </p>

        <label>
          <span>服务地址</span>
          <input v-model="ttsURL" spellcheck="false" placeholder="http://127.0.0.1:8765" />
        </label>

        <label>
          <span>音色</span>
          <input v-model="ttsVoice" spellcheck="false" placeholder="default" />
        </label>

        <label>
          <span>语速 {{ ttsSpeed.toFixed(2) }}</span>
          <input v-model.number="ttsSpeed" type="range" min="0.5" max="2" step="0.05" />
        </label>

        <div class="actions">
          <button class="btn" @click="testTTS">探测服务</button>
          <span class="hint">{{ ttsTest }}</span>
        </div>
      </section>
    </div>

    <footer class="foot">
      <button class="btn primary" @click="save">保存</button>
    </footer>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-radius: 12px;
  background: rgba(22, 22, 26, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.title {
  font-size: 13px;
  font-weight: 500;
  color: #e8e8ec;
}

.spacer {
  flex: 1;
}

.icon {
  border: none;
  background: transparent;
  color: #8a8a92;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
}

.icon:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #d8d8dc;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 12px 4px;
}

section + section {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}

h3 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 500;
  color: #a8a8b2;
  letter-spacing: 0.02em;
}

.note {
  margin: 0 0 10px;
  font-size: 11px;
  line-height: 1.6;
  color: #6a6a72;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}

.chip {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #b8b8c0;
  font-family: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 20px;
  cursor: pointer;
}

.chip:hover {
  background: rgba(255, 255, 255, 0.1);
}

.chip.on {
  border-color: rgba(120, 150, 220, 0.7);
  background: rgba(90, 120, 200, 0.35);
  color: #dce4f4;
}

label {
  display: block;
  margin-bottom: 9px;
}

label > span {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  color: #8a8a92;
}

input[type='text'],
input[type='password'],
input:not([type]) {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.06);
  color: #e8e8ec;
  font-family: inherit;
  font-size: 12px;
  padding: 6px 9px;
  outline: none;
}

input:focus {
  border-color: rgba(120, 150, 220, 0.55);
}

input[type='range'] {
  width: 100%;
  accent-color: #6a8fd0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.hint {
  font-size: 11px;
  color: #7a9ad0;
  line-height: 1.4;
  word-break: break-word;
}

.btn {
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  padding: 5px 12px;
  font-family: inherit;
  font-size: 12px;
  color: #d8d8dc;
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}

.btn:disabled {
  color: #6a6a72;
  cursor: default;
}

.btn.primary {
  background: rgba(90, 120, 200, 0.6);
  border-color: transparent;
  color: #f0f0f4;
}

.btn.primary:hover {
  background: rgba(110, 140, 220, 0.75);
}

.foot {
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.foot .btn {
  width: 100%;
  padding: 7px;
}
</style>
