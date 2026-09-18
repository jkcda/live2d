<script setup lang="ts">
import { marked } from 'marked'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  bargeIn,
  chatSession,
  sendTurn,
  subscribeTurns,
  subscribeVoiceEvents,
  subscribeVoiceRound,
  subscribeVoiceStatus,
  toggleVoiceRound,
  type TurnEvent,
  type VoiceRoundState,
  voiceInput,
} from '@/core/runtime'
import type { VoiceInputStatus } from '@/core/audio/stream'
import { isLLMReady, loadLLMConfig } from '@/core/settings'
import { DEFAULT_PERSONA } from '@/core/agent/persona'
import { toDisplayText } from '@/core/agent/emotion'

const emit = defineEmits<{ close: []; settings: [] }>()

interface Bubble {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
  /** 这一轮她调过哪些工具（对齐 nexus 面板的 chip：干活时用户得看得见） */
  chips?: ToolChip[]
}

interface ToolChip {
  label: string
  summary: string
  status: 'running' | 'done'
}

/**
 * 工具名 → 人话。
 *
 * 为什么要映射：MCP 的工具名是 `playwright__browser_click` 这种，
 * 直接显示出来用户只会看到一串英文标识符，等于没反馈。
 * 内置工具用自己的说法，MCP 的剥掉前缀再美化。
 */
function toolLabel(tool: string): string {
  const builtin: Record<string, string> = {
    search_web: '联网查',
    get_time: '看时间',
    remember: '记下来',
    show_expression: '换个表情',
    respond: '说话',
  }
  if (builtin[tool]) return builtin[tool]
  const bare = tool.includes('__') ? tool.split('__').slice(1).join('__') : tool
  return bare.replace(/_/g, ' ')
}

/** 参数摘要：挑一个最能说明"她在干什么"的字段 */
function toolSummary(args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const text = pick('query') || pick('text') || pick('content') || pick('url') || pick('command')
  if (text) return text.length > 36 ? `${text.slice(0, 36)}…` : text
  const first = Object.values(args).find((v) => typeof v === 'string')
  return typeof first === 'string' ? (first.length > 36 ? `${first.slice(0, 36)}…` : first) : ''
}

/**
 * Markdown 渲染 —— 和 nexus 前端同一套（`marked` 的 `breaks: true`）。
 *
 * ★ 为什么必须渲染 markdown 而不是直接显示纯文本：
 *   模型的回复本来就是 markdown，段落之间是 `\n\n`。
 *   纯文本 + `white-space: pre-wrap` 会把它原样变成**一个空行** ——
 *   看起来像"莫名多了一行"，而 markdown 渲染会把它变成正常的段间距（有 margin），
 *   观感是完全不同的两件事。同一个 `\n\n`，一个像 bug，一个像排版。
 *
 * `breaks: true` 是关键：单个换行也当换行（否则模型爱用的"每句一行"会挤成一坨）。
 */
function renderMarkdown(text: string): string {
  if (!text) return ''
  // 先过语气标记（[laughter] → （笑）、呼吸类删掉、末尾不完整的扣住），再交给 markdown。
  // 必须在 markdown 之前 —— 否则方括号会被当成链接语法。
  return marked.parse(normalizeProse(toDisplayText(text)), { breaks: true }) as string
}

/**
 * 把模型爱用的「每句一行」压回一整段。
 *
 * ★ 为什么要动它
 *
 * `breaks: true` 会把**单个换行变 <br>、空行变新 <p>**。
 * 而模型经常把两句话各写一行 —— 于是界面上「两句话 = 两个段落」，
 * 中间多出一截段间距。用户的原话：「对 2 句话要用两个 p 标签换行，没必要」。
 *
 * 中文正文本来就不靠换行断句（有标点），所以**普通行之间的换行直接去掉**。
 *
 * 但**结构性换行必须保留**：列表、标题、引用、代码块、表格 ——
 * 去掉它们 markdown 就散了（列表会挤成一坨）。
 * 判据就是行首那个标记。
 */
function normalizeProse(text: string): string {
  /** 这一行是不是 markdown 的结构行（列表项 / 标题 / 引用 / 代码围栏 / 表格 / 缩进代码） */
  const isStructural = (s: string): boolean =>
    /^([-*+]|\d+[.)]|#{1,6}\s|>|```|\|| {4})/.test(s)

  const out: string[] = []

  for (const line of text.split('\n')) {
    const t = line.trim()

    // 空行、结构行、上一行是结构行 —— 都原样保留换行
    if (!t || isStructural(t) || (out.length && isStructural(out[out.length - 1].trim()))) {
      out.push(line)
      continue
    }

    // 普通行：接到上一行后面
    if (out.length) {
      const prev = out[out.length - 1]
      // 两边都是英文/数字才补空格，否则中文会被撑开
      const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(t)
      out[out.length - 1] = prev + (needSpace ? ' ' : '') + t
    } else {
      out.push(line)
    }
  }

  return out.join('\n')
}

const bubbles = ref<Bubble[]>([])
const input = ref('')
const busy = ref(false)
const error = ref('')
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)

const micOn = ref(false)
const voiceStatus = ref<VoiceInputStatus>('idle')
const hearing = ref(false)
const recognizing = ref(false)

const name = DEFAULT_PERSONA.name

let unsubscribeEvents: (() => void) | null = null
let unsubscribeStatus: (() => void) | null = null
let unsubscribeTurns: (() => void) | null = null
let unsubscribeRound: (() => void) | null = null

onMounted(() => {
  inputEl.value?.focus()

  /*
   * ★ 把会话里已有的历史铺回气泡。
   *
   * 面板是**每次打开都重新挂载**的（父组件用 v-if 控制），而气泡只是组件内的局部状态 ——
   * 以前的表现就是"每次打开对话都是空的"，即使会话本身还留着上下文。
   *
   * 这里走 `hydrate()` 而不是直接读 `chatSession.messages`：本地那份存在
   * localStorage，而它**按 origin 隔离** —— 浏览器（http://localhost:5176）和
   * 桌面窗口是两个 origin，各存各的，于是「浏览器里聊过的，桌面打开看不到」。
   *
   * hydrate() 以**服务端转录**为准（谁连上来都是同一份），服务连不上才退回本地。
   */
  void (async () => {
    try {
      const history = await chatSession.hydrate()
      const visible = history.filter((m) => m.role !== 'system')
      if (!visible.length) return
      bubbles.value = visible.map((m) => ({
        role: m.role as 'user' | 'assistant',
        text: m.content,
      }))
      scrollToBottom()
    } catch (err) {
      // 恢复失败不该影响能不能聊
      console.warn('[chat] 恢复历史失败', err)
    }
  })()

  /*
   * 一轮对话的渲染。打字 / 麦克风 / 快捷键三个入口的消息都从这里过 ——
   * 所以三条路的显示必然一致。
   */
  unsubscribeTurns = subscribeTurns(onTurn)

  /*
   * 语音回合状态（唯一的一份状态机在 runtime）。
   * 面板只是读它、画按钮 —— 不再自己维护 micOn。
   */
  unsubscribeRound = subscribeVoiceRound((state: VoiceRoundState) => {
    micOn.value = state !== 'idle'
    recognizing.value = state === 'recognizing'
    if (state === 'idle') hearing.value = false
  })

  unsubscribeStatus = subscribeVoiceStatus((status, detail) => {
    voiceStatus.value = status
    if (status === 'error') error.value = detail ?? '语音输入出错'
    if (status !== 'listening') {
      micOn.value = false
      hearing.value = false
    }
  })

  unsubscribeEvents = subscribeVoiceEvents((event) => {
    if (event.type === 'vad') {
      // 只在「正在听」时才显示，否则回放 TTS 时会被自己的声音点亮
      hearing.value = micOn.value && event.state === 'speech'
    } else if (event.type === 'asr_start') {
      recognizing.value = true
    } else if (event.type === 'asr') {
      recognizing.value = false
      /*
       * ★ 这里**不再发消息**。
       *
       * 「识别结果 → 关麦 → 发给她」整条链在 runtime 里（见 voiceInput 的
       * onEvent）—— 因为快捷键说话时这个面板压根没挂载，收不到这个事件。
       * 在这里再发一次就是**发两遍**。
       */
      if (!event.text.trim() && micOn.value) error.value = '没听清，再说一次？'
    } else if (event.type === 'error') {
      recognizing.value = false
      error.value = event.message
    }
  })
})

onUnmounted(() => {
  unsubscribeEvents?.()
  unsubscribeStatus?.()
  unsubscribeTurns?.()
  unsubscribeRound?.()
  voiceInput.stop()
})

function scrollToBottom() {
  void nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/**
 * 发一句话。
 *
 * ★ 它**不再自己驱动会话** —— 只做前置检查，然后交给 runtime 的 `sendTurn()`。
 *
 * 原因：发消息的入口不止这一个（还有全局快捷键直接说话，那时面板压根没挂载）。
 * 每个入口自己驱动会话 = 两套渲染逻辑，而且必然出现
 * 「快捷键说的那句，面板里看不到」。
 *
 * 现在：**runtime 负责发，面板负责画**，中间用 `subscribeTurns` 接上。
 */
async function sendText(text: string) {
  const trimmed = text.trim()
  if (!trimmed || busy.value) return

  const cfg = loadLLMConfig()
  if (!isLLMReady(cfg)) {
    error.value = '还没配置 LLM。点右上角齿轮填 baseURL 和 API key。'
    return
  }

  error.value = ''
  await sendTurn(trimmed)
}

/**
 * 把 runtime 广播的那一轮事件画成气泡。
 *
 * 打字、点麦克风、按快捷键 —— 三个入口的消息都从这里过，
 * 所以三条路的显示效果**必然一致**（不会出现「快捷键发的看不到」）。
 */
function onTurn(e: TurnEvent) {
  if (e.type === 'start') {
    error.value = ''
    busy.value = true
    bubbles.value.push({ role: 'user', text: e.text })
    bubbles.value.push({ role: 'assistant', text: '' })
    scrollToBottom()
    return
  }

  if (e.type === 'end') {
    busy.value = false
    // 一个字都没吐出来就说明这轮没成，把空泡删掉免得留个空气泡
    const last = bubbles.value[bubbles.value.length - 1]
    if (last && last.role === 'assistant' && !last.text) bubbles.value.pop()
    scrollToBottom()
    return
  }

  // ---- 以下是 agent 事件 ----
  const replyIndex = bubbles.value.length - 1
  if (replyIndex < 0) return
  const ev = e.event

  if (ev.type === 'delta') {
    // 必须经由数组下标写入才能触发响应式 —— 直接改局部变量对象不会更新视图
    bubbles.value[replyIndex].text += ev.content
    scrollToBottom()
  } else if (ev.type === 'tool_call') {
    /*
     * 工具调用要**当场显示**：agent 干活可能要好几秒（联网、开浏览器），
     * 这段时间界面如果不给任何反馈，用户看到的就是"她卡住了/她变笨了"。
     */
    const chip: ToolChip = {
      label: toolLabel(ev.tool),
      summary: toolSummary(ev.args),
      status: 'running',
    }
    const cur = bubbles.value[replyIndex]
    cur.chips = [...(cur.chips ?? []), chip]
    scrollToBottom()
  } else if (ev.type === 'tool_result') {
    // 把最后一个"进行中"的 chip 标成完成（同一个工具可能被调多次）
    const chips = bubbles.value[replyIndex].chips ?? []
    for (let i = chips.length - 1; i >= 0; i--) {
      if (chips[i].status === 'running') {
        chips[i].status = 'done'
        break
      }
    }
  } else if (ev.type === 'error') {
    error.value = ev.message
    bubbles.value[replyIndex].failed = true
  }
}

function send() {
  const text = input.value
  input.value = ''
  void sendText(text)
}

/** 打断：掐断生成 + 掐断语音 + 让服务端丢掉正在累积的语音 */
function stop() {
  bargeIn()
  voiceInput.resetServer()
  busy.value = false
}

/**
 * 麦克风按钮。
 *
 * ★ 它和快捷键（Ctrl+Shift+V）走的是**同一个** `toggleVoiceRound()`。
 *
 * 这里曾经有一套自己的状态机（`finishing` 标志、3 秒兜底、手动顺序……），
 * 和 runtime 那套并行 —— 那是必然要出「面板显示在录、其实没录」这类事的。
 * 现在**只有一份状态机在 runtime**，面板只是读它、画它。
 */
function toggleMic() {
  void toggleVoiceRound()
}

function onKeydown(e: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="panel no-drag">
    <header class="head">
      <span class="title">{{ name }}</span>
      <span v-if="busy" class="status">说话中…</span>
      <span v-else-if="recognizing" class="status">识别中…</span>
      <span v-else-if="hearing" class="status hearing">在听…</span>
      <div class="spacer" />
      <button class="icon" title="设置" @click="emit('settings')">⚙</button>
      <button class="icon" title="关闭" @click="emit('close')">✕</button>
    </header>

    <div ref="listEl" class="list">
      <p v-if="!bubbles.length" class="empty">
        说点什么吧。Enter 发送，Shift+Enter 换行。<br />
        也可以点下面的麦克风直接说话。
      </p>

      <div v-for="(b, i) in bubbles" :key="i" class="row" :class="b.role">
        <!--
          一条消息 = 工具 chip + 气泡，装在同一个**纵向**容器里。
          ★ 之前把 .chips 和 .bubble 做成 .row 的直接子节点，而 .row 是 flex ——
            于是 chip 横着占位，把回复挤到旁边去了（用户原话："工具调用都把回复挤到哪里去了"）。
        -->
        <div class="stack">
          <div v-if="b.chips?.length" class="chips">
            <span
              v-for="(chip, ci) in b.chips"
              :key="ci"
              class="chip"
              :class="chip.status"
              :title="chip.summary"
            >
              <span class="chip-dot" />
              {{ chip.label }}<template v-if="chip.summary">：{{ chip.summary }}</template>
            </span>
          </div>
          <div class="bubble" :class="{ failed: b.failed }">
            <span v-if="!b.text" class="typing">…</span>
            <!-- eslint-disable-next-line vue/no-v-html —— 内容来自本地 LLM，和 nexus 前端同一套渲染 -->
            <div v-else class="msg-content" v-html="renderMarkdown(b.text)" />
          </div>
        </div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <footer class="foot">
      <button
        class="mic"
        :class="{ on: micOn, hearing }"
        :title="micOn ? '关闭麦克风' : '打开麦克风'"
        @click="toggleMic"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </svg>
      </button>

      <textarea
        ref="inputEl"
        v-model="input"
        class="input"
        rows="1"
        placeholder="和她说点什么…"
        @keydown="onKeydown"
      />

      <button v-if="busy" class="send stop" @click="stop">打断</button>
      <button v-else class="send" :disabled="!input.trim()" @click="send">发送</button>
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
  background: rgba(22, 22, 26, 0.9);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.title {
  font-size: 13px;
  font-weight: 500;
  color: #e8e8ec;
}

.status {
  font-size: 11px;
  color: #7a9ad0;
}

.status.hearing {
  color: #7ad0a0;
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

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty {
  margin: auto;
  color: #6a6a72;
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}

.row {
  display: flex;
}

.row.user {
  justify-content: flex-end;
}

/*
 * 一条消息的纵向容器（工具 chip 在上、气泡在下）。
 * 宽度约束放在这里，气泡自己不再设 max-width —— 否则会变成 84% 的 84%，
 * 回复的可用宽度凭空少一截。
 */
.stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 84%;
}

.row.user .stack {
  align-items: flex-end;
}

.bubble {
  max-width: 100%;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  /*
   * ★ markdown 渲染之后这里**必须**是 normal：
   *   `pre-wrap` 会把 markdown 生成的 <p> 之间那些换行也画出来 ——
   *   于是段间距被算两遍（markdown 的 margin + 源码里的空行），
   *   表现就是"隔开一行"。占位符「…」用 inline 元素渲染，不受影响。
   */
  white-space: normal;
  word-break: break-word;
}

/* markdown 输出的排版：段落紧凑一点，代码块有底色 */
.msg-content > :first-child {
  margin-top: 0;
}

.msg-content > :last-child {
  margin-bottom: 0;
}

.msg-content p {
  margin: 0 0 6px;
}

.msg-content ul,
.msg-content ol {
  margin: 0 0 6px;
  padding-left: 18px;
}

.msg-content li {
  margin: 2px 0;
}

.msg-content code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.msg-content pre {
  margin: 0 0 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  overflow-x: auto;
}

.msg-content pre code {
  padding: 0;
  background: none;
}

.msg-content a {
  color: #8ab4f8;
}

.msg-content strong {
  color: #f0f0f4;
}

.row.assistant .bubble {
  background: rgba(255, 255, 255, 0.08);
  color: #dcdce2;
  border-bottom-left-radius: 3px;
}

.row.user .bubble {
  background: rgba(90, 120, 200, 0.42);
  color: #f0f0f4;
  border-bottom-right-radius: 3px;
}

.bubble.failed {
  background: rgba(160, 60, 60, 0.3);
}

.typing {
  color: #6a6a72;
}

.err {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(160, 60, 60, 0.22);
  color: #e0a0a0;
  font-size: 12px;
  line-height: 1.5;}

.foot {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.mic {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #9a9aa2;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.mic:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #d8d8dc;
}

.mic.on {
  background: rgba(90, 160, 200, 0.35);
  border-color: rgba(110, 180, 220, 0.6);
  color: #cfe8f4;
}

.mic.hearing {
  background: rgba(90, 200, 140, 0.4);
  border-color: rgba(110, 220, 160, 0.7);
  color: #d4f4e2;
}

.input {
  flex: 1;
  resize: none;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #e8e8ec;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  padding: 6px 9px;
  max-height: 88px;
  outline: none;
}

.input:focus {
  border-color: rgba(120, 150, 220, 0.55);
}

.input::placeholder {
  color: #6a6a72;
}

.send {
  flex-shrink: 0;
  height: 30px;
  border: none;
  border-radius: 8px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 12px;
  color: #e8e8ec;
  background: rgba(90, 120, 200, 0.65);
  cursor: pointer;
}

.send:hover:not(:disabled) {
  background: rgba(110, 140, 220, 0.8);
}

.send:disabled {
  background: rgba(255, 255, 255, 0.08);
  color: #6a6a72;
  cursor: default;
}

.send.stop {
  background: rgba(180, 70, 70, 0.7);
}

.send.stop:hover {
  background: rgba(200, 80, 80, 0.85);
}

/* 工具调用 chip：她干活时露出来的痕迹（进行中会呼吸，完成后变暗） */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(90, 120, 200, 0.18);
  border: 1px solid rgba(120, 150, 220, 0.28);
  color: #b8c8e0;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.done {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
  color: #8a8a94;
}

.chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7aa2ff;
  animation: chip-pulse 1.1s ease-in-out infinite;
}

.chip.done .chip-dot {
  background: #5a5a66;
  animation: none;
}

@keyframes chip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
</style>
