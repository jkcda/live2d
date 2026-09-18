/**
 * 语音输出。
 *
 * 核心是「合成并行、播放串行」：
 *   LLM 按句吐出文本 → 每句立刻发起合成（并行，抢首包时间）
 *   → 播放严格按顺序排队（串行，避免抢话和断句错乱）
 *
 * 音频从哪来由 Python 推理服务决定（见 python/README.md 的接口约定），
 * 这里只负责调用和排队。服务没起来时静默降级为「只显示文字，不出声」。
 */
import type { AudioPlayer } from './player'
import { getSplitMaxChars, setSplitMaxChars } from '../agent/llm'

export interface TTSConfig {
  /** Python 推理服务地址，例如 http://127.0.0.1:8765 */
  baseURL: string
  /** 音色标识，由服务端定义（如 CosyVoice 的 spk_id 或参考音频名） */
  voice?: string
  /** 语速倍率 */
  speed?: number
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  baseURL: 'http://127.0.0.1:8765',
  voice: 'default',
  speed: 1,
}

/**
 * 短于这个字数就整句合成，不流式。
 *
 * **为什么不一律流式**
 *
 *   · 短句本来就只出 1 块（实测「嗯，我在。」1 块、「好，我看看。」1 块）——
 *     流式没有任何收益可言
 *   · 而且流式拿不到「整段峰值归一化」，只能用开机标定的固定增益，
 *     音量比整句那条路略低（口型是按振幅驱动的，幅度也跟着小一点）
 *   · 整句合成时模型一次看到完整的一句，重音和语调是一次定下来的
 *
 * **为什么长句要流式**：实测 31 字首块 3.96s、总计 8.14s —— 省 4.18 秒。
 *
 * 20 字是个折中：低于它的句子整句合成也就等 2~3 秒，不值得为它牺牲音质；
 * 高于它的句子等整段就明显了。
 */
const STREAM_MIN_CHARS = 20

export class VoiceOutput {
  /** 播放队列尾；每句话挂到它后面，保证串行 */
  private queue: Promise<void> = Promise.resolve()
  /** 代次计数：interrupt 时自增，队列里过期的句子据此丢弃 */
  private generation = 0
  /** 队列中未播完的句子数 */
  private pending = 0
  /** 一次「说话回合」共用一个 AbortController */
  private controller: AbortController | null = null

  private readonly player: AudioPlayer
  private readonly getConfig: () => TTSConfig

  constructor(player: AudioPlayer, getConfig: () => TTSConfig) {
    this.player = player
    this.getConfig = getConfig
  }

  /** 是否还有话没说完 */
  get busy(): boolean {
    return this.pending > 0
  }

  /**
   * 排入一句话。合成立刻发起，播放按顺序等待。
   * 这是接 LLM 流式输出的入口 —— 每凑够一句就调一次。
   */
  enqueue(sentence: string): void {
    const text = sentence.trim()
    if (!text) return

    const gen = this.generation
    const controller = this.ensureController()
    this.pending++

    /*
     * 每句都过这里，所以探引擎挂在这儿 —— 见 ensureEngineProbe 的注释。
     *
     * 为什么不挂在 interrupt()：那个不是每轮都调的
     * （session 里是 `if (this.controller) this.interrupt()`，第一句不调），
     * 挂在它上面会让「应用启动后第一次说话」用错切分粒度。
     *
     * 内部有 10 秒缓存，所以不是每句都发请求。
     */
    void this.ensureEngineProbe()

    /*
     * 短句整句、长句流式（见 STREAM_MIN_CHARS）。
     *
     * ★ 两条路都**立刻发起**，不等队列轮到 —— 「合成并行、播放串行」
     *   是这个类的立身之本。等到队列才发起的话，前一句在播的时候
     *   后一句的合成根本没开始，每句之间都要重新等一遍首块，比不流水还慢。
     */
    const short = text.length < STREAM_MIN_CHARS
    const whole = short ? this.synthesize(text, controller.signal) : null
    const opened = short ? null : this.openStream(text, controller.signal)

    this.queue = this.queue
      .then(async () => {
        // 这一句在排队期间被打断了，直接丢弃
        if (gen !== this.generation) return

        // 短句：整段合成 → 一次播完（拿得到整段峰值归一化）
        if (whole) {
          const buffer = await whole
          if (!buffer || gen !== this.generation) return
          await this.player.playBufferAndWait(buffer)
          return
        }

        const result = await opened!

        /*
         * ★ 被打断时**必须把响应体取消掉**。
         *
         * 直接 return 的话，这个响应体永远不会被读、也不会被取消 ——
         * 服务端那个生成器就一直卡在「往 socket 写」上（它还拿着模型锁），
         * 于是后面**每一个**请求都在等锁。
         *
         * 实测就是这样：首块 11s → 25s → 37s 一路递增，而生成本身只要 2 秒。
         * 这不是「资源慢慢泄漏」那种问题，是**一次打断就毒死整条链路**。
         */
        if (gen !== this.generation) {
          if (result.kind === 'stream') void result.resp.body?.cancel()
          return
        }

        if (result.kind === 'stream') {
          await this.playStream(result.resp, gen)
          return
        }

        if (result.kind === 'fallback') {
          // 服务端没实现 /tts/stream（老版本，或者换了引擎）→ 走整段那条路。
          // 明确降级，而不是让流式解析失败 —— 后者看起来像「没声音」。
          const buffer = await this.synthesize(text, controller.signal)
          if (!buffer || gen !== this.generation) return
          await this.player.playBufferAndWait(buffer)
        }
      })
      .catch((err) => {
        console.warn('[tts] 播放失败', err)
      })
      .finally(() => {
        if (gen === this.generation) this.pending--
      })
  }

  /**
   * 打断：掐断播放、取消未完成的合成、丢弃排队的句子。
   * 用户一开口就调这个 —— 这是陪伴感的分水岭。
   */
  interrupt(): void {
    this.generation++
    this.pending = 0

    this.controller?.abort()
    this.controller = null

    this.player.stop()
  }

  /** 探一下推理服务在不在 */
  async health(): Promise<boolean> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return false
    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  /**
   * 需要时探一次引擎（带缓存，避免每句都发请求）。
   *
   * ★ 为什么不能只在启动时探一次
   *
   * 引擎是靠**环境变量 + 重启服务**切换的，应用这边收不到任何通知 ——
   * 启动时是云端就按云端配（整段），你切回本地它也不知道，还是整段，
   * 于是停顿又落回句子中间。
   *
   * 实测踩过：用户改 env 重启服务切回本地，应用没重启，切分粒度还是云端的那个。
   *
   * 所以**每轮对话开始时重探一次**（10 秒缓存）。探不到就保持现值 ——
   * 服务没起来不该让切分粒度被重置。
   */
  private probedAt = 0

  async ensureEngineProbe(): Promise<void> {
    if (Date.now() - this.probedAt < 10_000) return
    this.probedAt = Date.now()
    await this.probeEngine()
  }

  /** 探一次服务端用的是哪个引擎，按它的速度调整切分粒度。 */
  async probeEngine(): Promise<string> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return ''

    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!resp.ok) return ''

      const data = (await resp.json()) as { engine?: unknown }
      const name = typeof data.engine === 'string' ? data.engine : ''
      if (!name) return ''

      // cosyvoice-remote = 转发到本机那个模型（跑在同一块显卡上，RTF > 1）
      // openai / edge = 线上，快
      const slow = name.startsWith('cosyvoice')
      const next = slow ? 24 : 150

      // 变了才打日志 —— 排查「为什么还是断」时这一行是关键
      if (next !== getSplitMaxChars()) {
        console.log(
          `[tts] 引擎 ${name} → 每段最多 ${next} 字（${slow ? '本地，切短让停顿落在句号处' : '线上，整段合成'}）`,
        )
      }
      setSplitMaxChars(next)
      return name
    } catch {
      // 服务没起来：不改，保持现值
      return ''
    }
  }

  /**
   * 试听一句话。
   *
   * 和对话路径走的是同一条链路（合成 → 播放 → 振幅 → 口型），
   * 区别只有一点：**失败时把服务端给的原因抛出去**。
   * 对话路径不需要这个 —— 那里服务没起来就静默降级成「只显示文字」，
   * 但在设置面板里点「试听」却什么都不响、还不说为什么，就没法排查了。
   */
  async preview(text: string): Promise<void> {
    const cfg = this.getConfig()
    const body = text.trim()
    if (!body) return
    if (!cfg.baseURL) throw new Error('没填服务地址')

    this.interrupt()

    const resp = await fetch(`${trimSlash(cfg.baseURL)}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body, voice: cfg.voice, speed: cfg.speed }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!resp.ok) {
      // FastAPI 把原因放在 {"detail": "..."} 里 —— 引擎未就绪（503）时这句最关键
      const raw = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}${detailOf(raw)}`)
    }

    const data = await resp.arrayBuffer()
    if (data.byteLength === 0) throw new Error('服务返回了空音频')

    const buffer = await this.player.context.decodeAudioData(data)
    await this.player.playBufferAndWait(buffer)
  }

  /**
   * 打开一条流式合成。
   *
   * **立刻返回**（`fetch` 在响应头到达时就 resolve，不等音频）——
   * 这一点很重要：服务端会马上把首块产出来，等队列轮到这句时首块已经在本地了。
   */
  private async openStream(text: string, signal: AbortSignal): Promise<OpenedStream> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return { kind: 'error' }

    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: cfg.voice, speed: cfg.speed }),
        signal,
      })

      if (resp.ok) return { kind: 'stream', resp }

      // 404/405/501 = 服务端没有这个端点（老版本，或换了引擎）→ 降级
      if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
        return { kind: 'fallback' }
      }

      throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    } catch (err) {
      // 打断导致的取消是正常路径，不报错
      if (err instanceof DOMException && err.name === 'AbortError') return { kind: 'error' }
      if (err instanceof Error && err.name === 'TimeoutError') return { kind: 'error' }
      console.warn('[tts] 流式合成失败（服务未启动？）', err)
      return { kind: 'error' }
    }
  }

  /**
   * 消费一条流：边收边排给播放器。
   *
   * 帧协议（见 python/cosyvoice_server.py 的 /tts/stream）：
   *   [4 字节小端长度][内容]，长度 0 表示结束。
   *   第一帧是 JSON 头（采样率等），后面每帧是 s16le 单声道 PCM。
   *
   * 为什么不用 decodeAudioData：**它吃不了半截流**。WAV/MP3 这些格式
   * 得看到完整文件（或至少完整的头）才能解，而我们是拿到一块就要播一块。
   * 所以自己把 s16le 转成 Float32 —— 这也是服务端不直接发 WAV 的原因。
   */
  private async playStream(resp: Response, gen: number): Promise<void> {
    const reader = resp.body?.getReader()
    if (!reader) return

    let head: StreamHead | null = null
    // 显式标成默认泛型：reader.read() 给的是 Uint8Array<ArrayBufferLike>，
    // 不标的话会被推断成 Uint8Array<ArrayBuffer>，赋值时类型对不上
    let carry: Uint8Array = new Uint8Array(0)
    let started = false

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        // 被打断了：把连接也断掉，别让服务端继续合成
        if (gen !== this.generation) {
          void reader.cancel()
          return
        }

        carry = concatBytes(carry, value)

        // 尽量多解析几帧出来 —— 一次 read 可能带回好几帧，
        // 也可能只带回半帧（帧头都在中间断开）
        for (;;) {
          if (carry.length < 4) break
          const len = new DataView(carry.buffer, carry.byteOffset, 4).getUint32(0, true)

          if (len === 0) {
            // 结束标记。等已排期的块播完再返回 ——
            // 「这一句说完了」和「这一句开始播了」是两件事。
            carry = new Uint8Array(0)
            if (started) await this.player.endStream()
            return
          }

          if (carry.length < 4 + len) break // 帧还没收全

          const payload = carry.subarray(4, 4 + len)
          carry = carry.subarray(4 + len)

          if (!head) {
            head = JSON.parse(new TextDecoder().decode(payload)) as StreamHead
            this.player.beginStream(head.sampleRate)
            started = true
          } else {
            this.player.pushStreamChunk(pcm16ToFloat32(payload))
          }
        }
      }

      /*
       * 走到这里说明连接关了但**没收到结束标记** —— 服务端挂了，或者网络断了。
       *
       * 这时已经排期的那些照常播完（不 stop()），但必须 endStream()：
       * 不调的话播放器的等待者永远不 resolve，队列卡死，
       * 后面所有句子都播不出来，而且**不报错**。
       */
      if (started && gen === this.generation) await this.player.endStream()
    } finally {
      reader.releaseLock()
    }
  }

  private ensureController(): AbortController {
    if (!this.controller) this.controller = new AbortController()
    return this.controller
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<AudioBuffer | null> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return null

    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: cfg.voice, speed: cfg.speed }),
        signal,
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      }

      const data = await resp.arrayBuffer()
      if (data.byteLength === 0) return null

      return await this.player.context.decodeAudioData(data)
    } catch (err) {
      // 打断导致的取消是正常路径，不报错
      if (err instanceof DOMException && err.name === 'AbortError') return null
      if (err instanceof Error && err.name === 'TimeoutError') return null
      console.warn('[tts] 合成失败（服务未启动？）', err)
      return null
    }
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 从 FastAPI 的错误体里抠出 detail，抠不到就返回空串 */
function detailOf(raw: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return ` · ${parsed.detail}`
  } catch {
    // 不是 JSON，原样带上（截断，别把一屏堆栈塞进界面）
  }
  return ` · ${raw.slice(0, 120)}`
}

/** /tts/stream 第一帧里的格式信息 */
interface StreamHead {
  sampleRate: number
  channels: number
  format: string
  gain: number
  voice: string
  engine: string
}

/**
 * openStream 的三种结果。
 *
 * 用类型区分「有流」「该降级」「出错了」，而不是用 null + 标志位 ——
 * 「服务端没有这个端点」和「服务没起来」要走的处理完全不同，
 * 混在一起就会变成「明明该降级却报错」或者反过来。
 */
type OpenedStream =
  | { kind: 'stream'; resp: Response }
  | { kind: 'fallback' }
  | { kind: 'error' }

/** 拼两块字节。读流时一次 read 可能只带回半帧，得自己接起来 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * s16le → Float32（-1~1）。
 *
 * 用 DataView 而不是 `new Int16Array(bytes.buffer, offset, n)`：
 * 后者要求 offset 是 2 的倍数，而 `subarray` 出来的视图**不保证对齐** ——
 * 不对齐会直接抛异常，而且是「大部分时候没事、偶尔炸」的那种。
 * 这里量很小（一块几十万采样，一两毫秒），用安全的写法。
 */
function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1
  const out = new Float32Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}
