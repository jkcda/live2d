/**
 * 前台窗口观察。
 *
 * ══ 为什么放在主进程 ══
 *
 * 桌面的真实状态只有桌面应用知道。而且 koffi 装在根 package.json 里，
 * agent 服务（agent/）有自己独立的一套依赖，它没有 koffi —— 放过去要重复装一遍。
 *
 * ══ 隐私边界在这里 ══
 *
 * **黑名单在主进程过滤，命中的连标题都不记录。**
 * 这是刻意的：敏感窗口标题从一开始就不该进入内存、更不该进 IPC 和网络。
 * 事后过滤（「送出去再删掉」）不算数。
 *
 * ══ 为什么必须有变化门控 ══
 *
 * 每秒轮询一次、每次都往上送的话，token 会爆，而且噪音会把真正有用的信号淹掉。
 * 只在 (进程, 标题) 真的变了才更新，并且对高频切换留一个最小间隔。
 */

import { createRequire } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)

/** 轮询间隔。1 秒足够 —— 人切换窗口不会比这更快，再快只是浪费 */
const POLL_MS = 1000

/** 两次「活动变化」之间的最小间隔。防止在几个窗口间反复横跳时刷屏 */
const MIN_CHANGE_GAP_MS = 2000

/** 单个标题的长度上限。有些网页标题能到几百字，截断省 token */
const MAX_TITLE_LEN = 120

export interface Activity {
  /** 进程名，如 Code.exe */
  process: string
  /** 窗口标题（已截断） */
  title: string
  /** 这个活动从什么时候开始（epoch ms） */
  since: number
}

/**
 * 默认黑名单。
 *
 * 两个维度：
 *   · 进程名 —— 密码管理器这类，整个进程都不该被看
 *   · 标题关键词 —— 进程名无害但标题会泄露内容的场景（浏览器、编辑器、聊天工具）
 *
 * 第二类才是关键：`chrome.exe` 本身无害，但
 * 「搜索：离婚律师 - Chrome」和「离职申请.docx - WPS」是有害的。
 */
const DEFAULT_BLOCKED_PROCESSES = [
  '1password.exe',
  'keepass.exe',
  'keepassxc.exe',
  'bitwarden.exe',
  'lastpass.exe',
  'dashlane.exe',
  'authenticator.exe',
]

const DEFAULT_BLOCKED_TITLE_PATTERNS = [
  '密码',
  'password',
  '登录',
  '验证码',
  '银行',
  '支付',
  '转账',
  '身份证',
  '银行卡',
  '简历',
  '离职',
  '工资',
  '薪资',
  '体检',
  '病历',
  '诊断',
]

/* eslint-disable @typescript-eslint/no-explicit-any */
let api: {
  GetForegroundWindow: () => bigint
  GetWindowTextW: (hwnd: bigint, buf: Uint16Array, max: number) => number
  GetWindowThreadProcessId: (hwnd: bigint, pid: Uint32Array) => number
  GetWindowRect: (hwnd: bigint, rect: Int32Array) => boolean
  OpenProcess: (access: number, inherit: boolean, pid: number) => bigint
  QueryFullProcessImageNameW: (
    handle: bigint,
    flags: number,
    buf: Uint16Array,
    size: Uint32Array,
  ) => boolean
  CloseHandle: (handle: bigint) => boolean
} | null = null

let initFailed = false

function ensureApi(): typeof api {
  if (api || initFailed) return api
  if (process.platform !== 'win32') {
    initFailed = true
    return null
  }
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    api = {
      GetForegroundWindow: user32.func('uint64 GetForegroundWindow()'),
      GetWindowTextW: user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)'),
      GetWindowRect: user32.func('bool GetWindowRect(uint64 hWnd, _Out_ int32 *rect)'),
      OpenProcess: kernel32.func('uint64 OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool QueryFullProcessImageNameW(uint64 handle, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)',
      ),
      CloseHandle: kernel32.func('bool CloseHandle(uint64 handle)'),
    }
  } catch (err) {
    console.warn('[observer] koffi 加载失败，前台窗口观察不可用', err)
    initFailed = true
  }
  return api
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

function readForeground(): { process: string; title: string; pid: number } | null {
  const fn = ensureApi()
  if (!fn) return null

  const hwnd = fn.GetForegroundWindow()
  if (!hwnd) return null

  // 标题
  const titleBuf = new Uint16Array(512)
  const len = fn.GetWindowTextW(hwnd, titleBuf, 512)
  if (len <= 0) return null
  const title = Buffer.from(titleBuf.buffer, 0, len * 2).toString('utf16le')

  // 进程名
  const pidBuf = new Uint32Array(1)
  fn.GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf[0]
  if (!pid) return null

  const handle = fn.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return { process: `pid:${pid}`, title, pid }

  try {
    const pathBuf = new Uint16Array(1024)
    const sizeBuf = new Uint32Array([1024])
    const ok = fn.QueryFullProcessImageNameW(handle, 0, pathBuf, sizeBuf)
    if (!ok || sizeBuf[0] === 0) return { process: `pid:${pid}`, title, pid }

    const full = Buffer.from(pathBuf.buffer, 0, sizeBuf[0] * 2).toString('utf16le')
    return { process: basename(full), title, pid }
  } finally {
    fn.CloseHandle(handle)
  }
}

export class ActivityObserver {
  private timer: NodeJS.Timeout | null = null
  private current: Activity | null = null
  private lastChangeAt = 0
  private _paused = false

  private blockedProcesses: Set<string>
  private blockedPatterns: string[]

  constructor() {
    this.blockedProcesses = new Set(DEFAULT_BLOCKED_PROCESSES)
    this.blockedPatterns = [...DEFAULT_BLOCKED_TITLE_PATTERNS]
  }

  get paused(): boolean {
    return this._paused
  }

  /** 观察是否可用（非 Windows 或 koffi 挂了时为 false） */
  get available(): boolean {
    return process.platform === 'win32' && ensureApi() !== null
  }

  setPaused(paused: boolean): void {
    this._paused = paused
    if (paused) {
      // 暂停时立刻清掉，别留着上一次的快照被读到
      this.current = null
    }
    console.log(`[observer] 观察${paused ? '已暂停' : '已恢复'}`)
  }

  /** 追加用户自定义的屏蔽词（进程名或标题关键词都走这里） */
  addBlocked(words: string[]): void {
    for (const raw of words) {
      const w = raw.trim()
      if (!w) continue
      if (w.toLowerCase().endsWith('.exe')) this.blockedProcesses.add(w.toLowerCase())
      else this.blockedPatterns.push(w)
    }
  }

  start(): void {
    if (this.timer || !this.available) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
    // 别让定时器拖住进程退出
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.current = null
  }

  /** 当前活动快照。暂停中、命中黑名单、或读不到时返回 null */
  snapshot(): Activity | null {
    return this.current
  }

  private tick(): void {
    if (this._paused) return

    const raw = readForeground()
    if (!raw) return

    /*
     * ★ 她自己的窗口不算「他在干嘛」。
     *
     * 这一条是整块功能最容易踩空的地方：对话面板必须能打键盘，所以主进程
     * 在面板打开时会 focus() —— 也就是说**他问「我在干嘛」的那一刻，
     * 前台窗口恰恰是应用自己**。不排掉的话，她看到的永远是
     * 「Nexus Live2D」，而且是在最该看准的那个场景里看错。
     *
     * 这里用 return 而不是清空 current：他自己的窗口不该把上一次真实的活动抹掉
     * （他不是"不干什么了"，只是在跟她说话）。
     */
    if (raw.pid === process.pid) return

    // ★ 黑名单在这里拦。命中的连标题都不往 current 里放。
    if (this.isBlocked(raw.process, raw.title)) {
      if (this.current !== null) {
        this.current = null
        console.log('[observer] 前台窗口命中屏蔽规则，已隐藏')
      }
      return
    }

    const title = raw.title.slice(0, MAX_TITLE_LEN)
    const processName = raw.process

    // 没变就什么都不做 —— 这是变化门控的核心
    if (this.current && this.current.process === processName && this.current.title === title) {
      return
    }

    const now = Date.now()
    if (now - this.lastChangeAt < MIN_CHANGE_GAP_MS) return
    this.lastChangeAt = now

    this.current = { process: processName, title, since: now }
  }

  private isBlocked(processName: string, title: string): boolean {
    if (this.blockedProcesses.has(processName.toLowerCase())) return true
    const lower = title.toLowerCase()
    return this.blockedPatterns.some((p) => lower.includes(p.toLowerCase()))
  }
}

/** 给渲染层用的可序列化快照（附带「持续了多久」） */
export function activitySnapshot(observer: ActivityObserver): Record<string, unknown> | null {
  const a = observer.snapshot()
  if (!a) return null
  return {
    process: a.process,
    title: a.title,
    since: a.since,
    forSeconds: Math.round((Date.now() - a.since) / 1000),
  }
}

/**
 * 前台窗口在**屏幕坐标系**里的矩形（物理像素）。
 *
 * 截图要按它裁 —— 只截前台窗口那一块，不截全桌面。
 * 多显示器下截全屏等于一半是空白，还顺带把另一块屏上的东西也送出去了。
 *
 * 注意这是**物理像素**，Electron 的 screen 模块用的是 DIP，
 * 两者在高 DPI 下不一样，转换在 screen.ts 里做。
 *
 * 返回 null 表示读不到（非 Windows / koffi 挂了 / 窗口最小化了）。
 */
export function foregroundWindowRect(): {
  x: number
  y: number
  width: number
  height: number
} | null {
  const fn = ensureApi()
  if (!fn) return null

  const hwnd = fn.GetForegroundWindow()
  if (!hwnd) return null

  // RECT 是 4 个 int32：left, top, right, bottom
  const rect = new Int32Array(4)
  if (!fn.GetWindowRect(hwnd, rect)) return null

  const [left, top, right, bottom] = rect
  const width = right - left
  const height = bottom - top

  // 最小化的窗口会给出离谱的负坐标（-32000 那类），挡掉
  if (width <= 0 || height <= 0) return null

  return { x: left, y: top, width, height }
}
