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
  GetClientRect: (hwnd: bigint, rect: Int32Array) => boolean
  ClientToScreen: (hwnd: bigint, pt: Int32Array) => boolean
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
      GetClientRect: user32.func('bool GetClientRect(uint64 hWnd, _Out_ int32 *rect)'),
      ClientToScreen: user32.func('bool ClientToScreen(uint64 hWnd, _Inout_ int32 *pt)'),
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

/** 窗口在屏幕坐标系里的矩形（物理像素） */
export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ForegroundWindow {
  process: string
  title: string
  pid: number
  /** 拿不到有效矩形时为 null（最小化的窗口就是这样） */
  rect: WindowRect | null
}

/**
 * 读一次前台窗口：进程 / 标题 / pid / 屏幕矩形。
 *
 * ★ 为什么必须是「一次读、一个结果」
 *
 * 判断（这个窗口能不能看）和裁剪（截哪一块）如果分两次读，
 * 中间前台窗口就可能换人 —— **判的是 A、裁的是 B，敏感窗口就这么漏出去了**。
 * 这不是理论风险：实测前台窗口每秒都在翻。
 *
 * 所以观察和截图都走这一个函数，判和裁用同一份数据。
 */
export function foregroundWindow(): ForegroundWindow | null {
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

  const rect = readRect(hwnd)

  const handle = fn.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return { process: `pid:${pid}`, title, pid, rect }

  try {
    const pathBuf = new Uint16Array(1024)
    const sizeBuf = new Uint32Array([1024])
    const ok = fn.QueryFullProcessImageNameW(handle, 0, pathBuf, sizeBuf)
    if (!ok || sizeBuf[0] === 0) return { process: `pid:${pid}`, title, pid, rect }

    const full = Buffer.from(pathBuf.buffer, 0, sizeBuf[0] * 2).toString('utf16le')
    return { process: basename(full), title, pid, rect }
  } finally {
    fn.CloseHandle(handle)
  }
}

/**
 * 最小化窗口的坐标哨兵值。
 *
 * ★ 只查 width/height 是不够的（踩过）：
 *   最小化窗口的 GetWindowRect 是 (-32000, -32000, -31840, -31972) ——
 *   **宽高是正的**（160×28），所以 `width <= 0` 那个检查根本拦不住它。
 *   放过去之后裁剪坐标会变成负数，被 clamp 夹到 0，
 *   结果截出来是**桌面左上角那块无关内容** —— 既错又是隐私问题。
 */
const MINIMIZED_COORD = -30000

/**
 * 读窗口的**客户区**（去掉标题栏和边框），屏幕坐标。
 *
 * ══ 为什么不用 GetWindowRect ══
 *
 * 两个原因，都在微软文档里写着：
 *
 * 1. **它含标题栏**。而标题栏里就是窗口标题 ——
 *    「离职申请.docx - WPS」这种，黑名单不一定命中，但图一出去就漏了。
 *    想只去掉隐形边框的话可以用 DWMWA_EXTENDED_FRAME_BOUNDS，
 *    但它给的是「**可见**窗口边界」，标题栏属于可见部分，**照样去不掉**。
 *    要去干净只能走客户区。
 *
 * 2. **它是 DPI 虚拟化的**（文档原话）。DPI-unaware 的进程拿到的
 *    是缩放后的坐标 —— 实测同一块屏上 GetWindowRect 给 2062×1118，
 *    而 EXTENDED_FRAME_BOUNDS 给 2560×1380（=屏幕物理尺寸，比值 1.24 ≈ 125%）。
 *    客户区这一路同样会虚拟化，所以**坐标空间的问题没有消失**，
 *    见 screen.ts 里那道自检。
 */
function readRect(hwnd: bigint): WindowRect | null {
  const fn = ensureApi()
  if (!fn) return null

  // GetClientRect 给的是**客户区在窗口内的坐标**（左上角通常是 0,0），
  // 要再 ClientToScreen 一次才是屏幕坐标
  const c = new Int32Array(4)
  if (!fn.GetClientRect(hwnd, c)) return null

  const pt = new Int32Array([c[0], c[1]])
  if (!fn.ClientToScreen(hwnd, pt)) return null

  const left = pt[0]
  const top = pt[1]
  const width = c[2] - c[0]
  const height = c[3] - c[1]

  // 最小化 / 坐标离谱 → 当作没有有效矩形，别让下游拿到一个会裁错的框
  if (left <= MINIMIZED_COORD || top <= MINIMIZED_COORD) return null
  if (width <= 0 || height <= 0) return null

  return { x: left, y: top, width, height }
}

/**
 * 屏蔽规则。
 *
 * ★ 为什么是模块级的单例，而不是观察器的实例字段
 *
 * 以前它是 `ActivityObserver` 的私有字段，于是**截图那条路根本拿不到它** ——
 * 结果是判断和裁剪走了两套东西（见 foregroundWindow 的注释）。
 * 名单要是再各抄一份，后果不是「功能不对」而是**隐私边界漏了**：
 * 观察挡住了、截图没挡，图就出去了。
 *
 * 所以：一份名单，一个判断函数，两条路都调它。
 */
class Blocklist {
  private processes = new Set(DEFAULT_BLOCKED_PROCESSES)
  private patterns = [...DEFAULT_BLOCKED_TITLE_PATTERNS]

  /** 追加用户自定义的屏蔽词（进程名或标题关键词都走这里） */
  add(words: string[]): void {
    for (const raw of words) {
      const w = raw.trim()
      if (!w) continue
      if (w.toLowerCase().endsWith('.exe')) this.processes.add(w.toLowerCase())
      else this.patterns.push(w)
    }
  }

  has(processName: string, title: string): boolean {
    if (this.processes.has(processName.toLowerCase())) return true
    const lower = title.toLowerCase()
    return this.patterns.some((p) => lower.includes(p.toLowerCase()))
  }
}

export const blocklist = new Blocklist()

/**
 * 这个窗口此刻该不该被看。
 *
 * 两条：**不在黑名单**、且**不是应用自己**。
 *
 * 观察和截图都必须过这一关 —— 而且**必须用同一次读到的数据**。
 * 拆成两个函数、两次读，中间前台窗口换人就会漏（见 foregroundWindow）。
 */
export function isObservable(fg: ForegroundWindow): boolean {
  // 她自己的窗口不算「他在干嘛」：面板打开时主进程会 focus()，
  // 所以「他问我在干嘛」的那一刻前台恰恰是应用自己
  if (fg.pid === process.pid) return false
  return !blocklist.has(fg.process, fg.title)
}

export class ActivityObserver {
  private timer: NodeJS.Timeout | null = null
  private current: Activity | null = null
  private lastChangeAt = 0
  private _paused = false

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
  /** 追加用户自定义的屏蔽词（转发给模块级那份名单，见 Blocklist 的注释） */
  addBlocked(words: string[]): void {
    blocklist.add(words)
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

    const fg = foregroundWindow()
    if (!fg) return

    /*
     * ★ 该不该看，走的是和截图**同一个** isObservable()。
     *
     * 这一条是整块功能最容易踩空的地方：对话面板必须能打键盘，所以主进程
     * 在面板打开时会 focus() —— 也就是说**他问「我在干嘛」的那一刻，
     * 前台窗口恰恰是应用自己**。不排掉的话，她看到的永远是
     * 「Nexus Live2D」，而且是在最该看准的那个场景里看错。
     *
     * 命中时用 return 而不是清空 current：他自己的窗口不该把上一次真实的活动抹掉
     * （他不是"不干什么了"，只是在跟她说话）。
     */
    if (!isObservable(fg)) {
      // 黑名单命中时要把 current 清掉（否则她会一直以为他还在那个敏感窗口）；
      // 但「是应用自己」不清 —— 两种情况的处理不一样，所以分开判
      if (blocklist.has(fg.process, fg.title) && this.current !== null) {
        this.current = null
        console.log('[observer] 前台窗口命中屏蔽规则，已隐藏')
      }
      return
    }

    const title = fg.title.slice(0, MAX_TITLE_LEN)
    const processName = fg.process

    // 没变就什么都不做 —— 这是变化门控的核心
    if (this.current && this.current.process === processName && this.current.title === title) {
      return
    }

    const now = Date.now()
    if (now - this.lastChangeAt < MIN_CHANGE_GAP_MS) return
    this.lastChangeAt = now

    this.current = { process: processName, title, since: now }
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


