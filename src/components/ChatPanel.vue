<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { chatSession, voiceOutput } from '@/core/runtime'
import { isLLMReady, loadLLMConfig } from '@/core/settings'
import { DEFAULT_PERSONA } from '@/core/agent/persona'

const emit = defineEmits<{ close: []; settings: [] }>()

interface Bubble {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

const bubbles = ref<Bubble[]>([])
const input = ref('')
const busy = ref(false)
const error = ref('')
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)

const name = DEFAULT_PERSONA.name

onMounted(() => inputEl.value?.focus())

function scrollToBottom() {
  void nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function send() {
  const text = input.value.trim()
  if (!text || busy.value) return

  const cfg = loadLLMConfig()
  if (!isLLMReady(cfg)) {
    error.value = '还没配置 LLM。点右上角齿轮填 baseURL 和 API key。'
    return
  }

  input.value = ''
  error.value = ''
  busy.value = true

  bubbles.value.push({ role: 'user', text })
  bubbles.value.push({ role: 'assistant', text: '' })
  const replyIndex = bubbles.value.length - 1
  scrollToBottom()

  try {
    for await (const ev of chatSession.send(text)) {
      if (ev.type === 'delta') {
        // 必须经由数组下标写入才能触发响应式 —— 直接改局部变量对象不会更新视图
        bubbles.value[replyIndex].text += ev.content
        scrollToBottom()
      } else if (ev.type === 'error') {
        error.value = ev.message
        bubbles.value[replyIndex].failed = true
      }
    }
  } finally {
    busy.value = false
    // 一个字都没吐出来就说明这轮没成，把空泡删掉免得留个空气泡
    if (!bubbles.value[replyIndex].text) bubbles.value.splice(replyIndex, 1)
    scrollToBottom()
  }
}

/** 打断：掐断生成 + 掐断语音，这是陪伴感的硬需求 */
function stop() {
  chatSession.interrupt()
  voiceOutput.interrupt()
  busy.value = false
}

function onKeydown(e: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}
</script>

<template>
  <div class="panel no-drag">
    <header class="head">
      <span class="title">{{ name }}</span>
      <span v-if="busy" class="status">说话中…</span>
      <div class="spacer" />
      <button class="icon" title="设置" @click="emit('settings')">⚙</button>
      <button class="icon" title="关闭" @click="emit('close')">✕</button>
    </header>

    <div ref="listEl" class="list">
      <p v-if="!bubbles.length" class="empty">
        说点什么吧。Enter 发送，Shift+Enter 换行。
      </p>

      <div v-for="(b, i) in bubbles" :key="i" class="row" :class="b.role">
        <div class="bubble" :class="{ failed: b.failed }">
          <span v-if="!b.text" class="typing">…</span>
          <template v-else>{{ b.text }}</template>
        </div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <footer class="foot">
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
  text-align: center;
}

.row {
  display: flex;
}

.row.user {
  justify-content: flex-end;
}

.bubble {
  max-width: 84%;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
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
  line-height: 1.5;
}

.foot {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
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
</style>
