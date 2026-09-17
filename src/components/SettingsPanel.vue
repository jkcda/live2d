<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
  characterState,
  initCharacter,
  listCharacterPacks,
  selectCharacter,
} from '@/core/character/selection'
import type { CharacterFeatures, CharacterPack } from '@/core/character/packs'
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

/**
 * 待机幅度。**不用刷新**：渲染循环每帧读 `idleRuntime.factor`，改完立刻生效
 * （调起来才不难受）。角色包可以在自己的 tuning 里覆盖它。
 */
const idleActivity = ref<IdleActivity>(loadIdleActivity())
watch(idleActivity, (v) => setIdleActivity(v))

/**
 * 角色：从清单里选。
 *
 * ★ 和过去的「渲染方式」不同，这里**不刷新页面** —— 舞台支持热插拔
 *   （见 CharacterStage.vue 的 mount/unmount）：先建新角色，成功了才销毁旧的，
 *   失败还会回退。所以正在说话时切角色也不会被打断。
 */
const packs = ref<CharacterPack[]>([])
const characterId = ref('')
const currentNote = ref('')
const features = ref<CharacterFeatures | null>(null)

const FEATURE_LABELS: Record<keyof CharacterFeatures, string> = {
  blink: '眨眼',
  gaze: '瞳孔跟随',
  mouthArt: '嘴差分',
  hairSway: '头发飘动',
  motions: '动作组',
  expressions: '表情',
  poses: '姿态（招手）',
}

const featureText = computed(() => {
  const f = features.value
  if (!f) return ''
  const kind = packs.value.find((p) => p.id === characterId.value)?.kind
  const on: string[] = []
  if (f.blink) on.push(FEATURE_LABELS.blink)
  if (f.gaze) on.push(FEATURE_LABELS.gaze)
  if (f.hairSway) on.push(FEATURE_LABELS.hairSway)
  if (f.motions) on.push(FEATURE_LABELS.motions)
  if (f.expressions) on.push(FEATURE_LABELS.expressions)
  if (f.poses) on.push(FEATURE_LABELS.poses)
  // 口型：立绘看差分张数，Live2D 是参数驱动 —— 不能混成一个数字，否则会误导
  on.push(
    kind === 'live2d'
      ? '口型（参数驱动）'
      : f.mouthArt > 0
        ? `嘴差分 ${f.mouthArt} 张`
        : '嘴（只剩拉下巴）',
  )

  // 缺什么也说出来 —— 免得以后加了功能，用户以为"点了没反应"
  const off: string[] = []
  if (!f.blink) off.push('眨眼（缺 eyes_closed.png）')
  if (!f.gaze) off.push('瞳孔跟随（缺独立眼睛图层）')
  if (!f.motions) off.push('动作组（需 Live2D 模型）')
  return on.join('、') + (off.length ? `　缺：${off.join('、')}` : '')
})

async function onCharacterChange() {
  try {
    const state = await selectCharacter(characterId.value)
    currentNote.value = state.pack.note ?? ''
    features.value = state.features
  } catch (err) {
    currentNote.value = `切换失败：${err instanceof Error ? err.message : String(err)}`
  }
}

function syncCharacterUI() {
  const s = characterState()
  if (!s) return
  characterId.value = s.pack.id
  currentNote.value = s.pack.note ?? ''
  features.value = s.features
}

/**
 * 切渲染模式的旧入口已经没有了 —— 模式现在是**角色的属性**
 * （`character.json` 里的 kind），选角色即选模式。
 * 开发期想强制某一种渲染器，用 `?portrait=1` / `?live2d=1`（见 packs.ts）。
 */

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

  // 角色清单：面板可能先于舞台打开，所以这里自己初始化一次（幂等）
  void initCharacter().then(async () => {
    packs.value = await listCharacterPacks()
    syncCharacterUI()
  })

  // 音色列表：服务可能还没起来，读不到就只是没有下拉可选（不影响其它设置）
  void loadVoices()
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

// ---------------------------------------------------------------- 音色管理

/**
 * 音色列表 + 克隆。
 *
 * 为什么要做进界面：声音这块以前只有命令行能操作（放文件、写 txt、重启服务），
 * 而"音色"恰恰是最需要**当场试**的东西 —— 录完一段、点一下、立刻听到像不像，
 * 这个闭环不该跨三个终端。
 *
 * 「能不能克隆」是**问服务**得出的（主服务对 edge/sapi 返回 501），
 * 不是本地写死的判断 —— 换引擎时界面自动跟着变。
 */
const voiceList = ref<string[]>([])
const voicesBusy = ref(false)
const canCloneVoice = ref(false)
const voiceFile = ref<File | null>(null)
const newVoiceName = ref('')
const newVoiceText = ref('')
const voiceBusy = ref(false)
const voiceMsg = ref('')

/** 读服务端有哪些音色；顺便探出"这个引擎支不支持克隆" */
async function loadVoices() {
  const url = ttsURL.value.trim()
  if (!url) return
  voicesBusy.value = true
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/voices`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { engine?: string; voices?: string[] }
    voiceList.value = data.voices ?? []
    canCloneVoice.value = /cosy/i.test(data.engine ?? '')
    if (!voiceList.value.includes(ttsVoice.value) && voiceList.value.length) {
      ttsVoice.value = voiceList.value[0]
    }
    voiceMsg.value = ''
  } catch (err) {
    // 读不到不算错：服务没起来时面板其余部分照样能用，只是没有下拉可选
    voiceMsg.value = `读不到音色列表（服务没起？）：${err instanceof Error ? err.message : err}`
    canCloneVoice.value = false
  } finally {
    voicesBusy.value = false
  }
}

function onVoiceFile(event: Event) {
  const input = event.target as HTMLInputElement
  voiceFile.value = input.files?.[0] ?? null
  if (voiceFile.value && !newVoiceName.value) {
    // 用文件名当默认名字，省一步输入（用户想改再改）
    newVoiceName.value = voiceFile.value.name.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '')
  }
}

/**
 * 上传参考音频并注册。
 *
 * 音频走 base64：省掉 multipart（服务端就少一个 python-multipart 依赖），
 * 10 秒的 wav 大约 2~3MB，本机回环传起来没感觉。
 */
async function addVoice() {
  const file = voiceFile.value
  const name = newVoiceName.value.trim()
  const text = newVoiceText.value.trim()
  const url = ttsURL.value.trim()
  if (!file || !url) return
  if (!name) {
    voiceMsg.value = '先给它起个名字'
    return
  }
  if (text.length < 4) {
    voiceMsg.value = '把录音里说的那句话填上（必须逐字一致，否则音色会飘）'
    return
  }

  voiceBusy.value = true
  voiceMsg.value = '读取音频…'
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('读文件失败'))
      reader.readAsDataURL(file)
    })

    voiceMsg.value = '注册中（模型要在 GPU 上跑一遍编码，约 1 秒）…'
    const resp = await fetch(`${url.replace(/\/+$/, '')}/voices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text, wav_base64: base64 }),
      signal: AbortSignal.timeout(120_000),
    })
    const data = (await resp.json().catch(() => ({}))) as { voices?: string[]; detail?: string }
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`)

    voiceList.value = data.voices ?? voiceList.value
    ttsVoice.value = name
    persistNow() // 立刻选中它并落盘，用户下一步就是"试听"
    voiceFile.value = null
    newVoiceText.value = ''
    voiceMsg.value = `音色「${name}」已就绪 —— 点上面的「试听」听听像不像`
  } catch (err) {
    voiceMsg.value = `失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    voiceBusy.value = false
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
          <span>角色</span>
          <select v-model="characterId" @change="onCharacterChange">
            <option v-for="p in packs" :key="p.id" :value="p.id">
              {{ p.name }}（{{ p.kind === 'portrait' ? '立绘' : 'Live2D' }}）
            </option>
          </select>
        </label>
        <p v-if="currentNote" class="note">{{ currentNote }}</p>
        <p v-if="features" class="note">
          当前能力：{{ featureText }}
        </p>
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
          两种渲染方式都吃这个设置；角色也可以在 <code>character.json</code> 里覆盖。
        </p>
        <p class="note">
          角色清单在 <code>public/characters/index.json</code>：加一条就多一个可切换的角色，
          <b>切换不用刷新页面</b>（正在说话也不会被打断）。立绘角色的素材放它自己的目录，
          三张图（<code>body.png</code> / <code>mouth_1.png</code> / <code>eyes_closed.png</code>）就能用。
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
          <span class="voice-row">
            <select v-if="voiceList.length" v-model="ttsVoice">
              <option v-for="v in voiceList" :key="v" :value="v">{{ v }}</option>
              <!-- 列表里没有但用户手填过的名字（比如还没刷新的）也要能选 -->
              <option v-if="ttsVoice && !voiceList.includes(ttsVoice)" :value="ttsVoice">
                {{ ttsVoice }}（手填）
              </option>
            </select>
            <input v-else v-model="ttsVoice" spellcheck="false" placeholder="default" />
            <button class="btn small" :disabled="voicesBusy" @click="loadVoices">
              {{ voicesBusy ? '读取中…' : '刷新' }}
            </button>
          </span>
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

        <!--
          克隆音色：只有在引擎真的支持时才出现（主服务对 edge/sapi 返回 501）。
          为什么做成"上传一个 wav + 填它说了什么"，而不是让用户去放文件：
          参考音频和它的文字必须**成对**给出，而且要逐字一致 ——
          这两件事分开做（放文件、再开记事本写 txt）太容易错，界面把它们绑在一起。
        -->
        <template v-if="canCloneVoice">
          <p class="note">
            克隆一个新音色：录 5~10 秒念一句话（内容自己定），把音频选进来、把那句话
            <strong>逐字</strong>填在下面。内容和音频不一致音色会飘。
          </p>

          <label>
            <span>参考音频</span>
            <input type="file" accept="audio/*,.wav,.mp3,.m4a" @change="onVoiceFile" />
          </label>

          <label>
            <span>名字</span>
            <input v-model="newVoiceName" spellcheck="false" placeholder="例如 mine（字母数字）" />
          </label>

          <label>
            <span>录音里说的那句</span>
            <textarea v-model="newVoiceText" rows="2" placeholder="例：今天天气不错，要不要一起出去走走"></textarea>
          </label>

          <div class="actions">
            <button class="btn" :disabled="voiceBusy || !voiceFile" @click="addVoice">
              {{ voiceBusy ? '注册中（约 1 秒）…' : '添加这个音色' }}
            </button>
            <span class="hint">{{ voiceMsg }}</span>
          </div>
        </template>
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

/* 音色那一行：下拉占满，刷新按钮贴右边 */
.voice-row {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.voice-row select,
.voice-row input {
  flex: 1;
  min-width: 0;
}

textarea {
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
  resize: vertical;
}

input[type='file'] {
  font-size: 11px;
  color: #a0a0aa;
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
