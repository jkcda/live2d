<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IDLE_LABELS,
  LLM_PRESETS,
  loadIdleActivity,
  loadLLMConfig,
  loadTTSConfig,
  saveLLMConfig,
  saveTTSConfig,
  setIdleActivity,
  type IdleActivity,
} from '@/core/settings'
import {
  CHARACTER_LABELS,
  loadCharacterKind,
  saveCharacterKind,
  type CharacterKind,
} from '@/core/character/mode'
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

/** 角色渲染模式：Live2D 模型 / 立绘差分 */
const characterKind = ref<CharacterKind>(loadCharacterKind())

/**
 * 待机幅度。和渲染模式不同，这个**不用刷新**：
 * 渲染循环每帧读 `idleRuntime.factor`，改完立刻生效（调起来才不难受）。
 */
const idleActivity = ref<IdleActivity>(loadIdleActivity())
watch(idleActivity, (v) => setIdleActivity(v))

/**
 * 切换渲染模式。
 *
 * 两种渲染器创建的 Pixi 舞台不一样，热切换要重建整个舞台 ——
 * 直接刷新页面最稳，也避免留下半初始化的画布。
 */
function onCharacterKindChange() {
  saveCharacterKind(characterKind.value)
  window.location.reload()
}

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

/*
 * ★ 边改边存。
 *
 * 为什么不能只靠「保存」按钮：面板的输入框只在点保存那一刻才落盘，
 * 关掉面板（或只点了「试听」这种只落盘 TTS 的按钮）就会把刚填的内容丢掉 ——
 * 用户看到的现象是「每次打开设置都是重置的」。
 * 对桌面应用来说，设置面板不该存在「忘了保存」这种失败模式。
 *
 * 所以：输入变化 → 400ms 后落盘；面板关闭 → 立刻落盘兜底。
 */
let persistTimer: number | undefined

/** 立即把当前输入框的值落盘 */
function persistNow(): void {
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
}

/** 落盘并让新配置对当前会话生效 */
function persistAndApply(notify = false): void {
  persistNow()
  reconfigureSession()
  if (notify) {
    llmTest.value = '已保存'
    ttsTest.value = ''
  }
}

function schedulePersist(): void {
  window.clearTimeout(persistTimer)
  // 防抖：别每敲一个字符就重建会话
  persistTimer = window.setTimeout(() => persistAndApply(), 400)
}

watch([baseURL, apiKey, model, temperature, ttsURL, ttsVoice, ttsSpeed], schedulePersist)

onUnmounted(() => {
  // 关面板/切走时兜底 —— 这时防抖可能还没触发
  window.clearTimeout(persistTimer)
  persistNow()
})

function applyPreset(id: string) {
  const p = LLM_PRESETS.find((x) => x.id === id)
  if (!p) return
  baseURL.value = p.baseURL
  model.value = p.model
}

function save() {
  window.clearTimeout(persistTimer)
  persistAndApply(true)
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
  // 先把输入框的值落盘，否则探测用的是上一次保存的地址
  persistNow()
  const ok = await voiceOutput.health()
  ttsTest.value = ok ? '服务在线' : '连不上（服务未启动？）'
}

/** 试听用的句子。短、含中文声调和常见音素，能听出音色和口型对不对 */
const TRIAL_TEXT = '你好呀，我是 Nexus。现在你听到的是我在说话。'

/**
 * 试听。
 *
 * 为什么值得单独做：它是**不用配 LLM key** 就能听到声音的唯一入口。
 * 没有它，验证「语音输出」这条链路必须先去搞一个 API key，
 * 一旦没声音还分不清是 key、是服务、还是引擎。
 */
async function trialTTS() {
  // 先把输入框里的值落盘 —— preview 读的是已保存的配置
  persistNow()

  ttsTest.value = '试听中…'
  try {
    await voiceOutput.preview(TRIAL_TEXT)
    ttsTest.value = '试听完成'
  } catch (err) {
    ttsTest.value = `失败：${err instanceof Error ? err.message : String(err)}`
  }
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
        <h3>角色</h3>
        <p class="note">
          立绘模式用几张差分图（嘴/眼）就能换成自己的角色，素材放
          <code>public/portrait/</code>；Live2D 模型放 <code>public/models/</code>。
        </p>
        <label>
          <span>渲染方式</span>
          <select v-model="characterKind" @change="onCharacterKindChange">
            <option v-for="(label, key) in CHARACTER_LABELS" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </label>
        <label>
          <span>待机动作</span>
          <select v-model="idleActivity">
            <option v-for="(label, key) in IDLE_LABELS" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </label>
        <p class="note">
          待机是永远在跑的动作（呼吸浮动、身体微摆、视线游移），<b>眨眼不受影响</b> ——
          幅度大一点就像在飘，完全关掉又像贴图，按自己看着舒服的调。
          两种渲染方式都吃这个设置。
        </p>
      </section>

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
          推理服务地址：Windows 上可以用内置 SAPI 出真语音（<code>NEXUS_TTS_ENGINE=sapi</code>），
          正式音色是 CosyVoice 2。服务没起来时只是不出声，不影响文字对话。
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
          <button class="btn" @click="trialTTS">试听</button>
          <span class="hint">{{ ttsTest }}</span>
        </div>
      </section>
    </div>

    <footer class="foot">
      <span class="saved-hint">改动会自动保存</span>
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
input:not([type]),
select {
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

select {
  /* 下拉里的选项由系统绘制，不设背景会出现白底黑字和其他控件不一致 */
  background-color: #24242a;
}

input:focus,
select:focus {
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
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.saved-hint {
  flex: 1;
  font-size: 11px;
  color: #6a6a74;
}

.foot .btn {
  flex: 0 0 auto;
  padding: 7px 18px;
}
</style>
