/**
 * Windows 窗口扩展样式操作（走 FFI 直调 user32）。
 *
 * ══ 为什么不能用 Electron 的 focusable: false ══
 *
 * 桌宠要的是「点她不会抢走你正在打字的焦点」。直觉是建窗时传 focusable: false，
 * 但 Electron 这个选项**同时关掉了两件事**：
 *
 *   1. Chromium 层的「可激活」标志      ← 我们想要的
 *   2. Windows 的 WM_MOUSEACTIVATE 处理  ← 我们不想要的
 *
 * 第 2 件事会让 Windows 在收到 WM_MOUSEACTIVATE 时返回 MA_NOACTIVATEANDEAT ——
 * **操作系统直接把这次点击的 mousedown 吃掉**。mousemove / mouseup 不涉及激活判定，
 * 照常放行，所以现象是：悬停有反应、点击完全没动静、拖拽纹丝不动。
 * 这和「网页层事件没绑对」的表现一模一样，极难排查。
 *
 * 正解是只要第 1 件事：保持 focusable 为 true，自己给窗口句柄打上
 * WS_EX_NOACTIVATE（0x08000000）。系统不再激活它，但点击照常送达。
 *
 * ══ 两个必须防的坑 ══
 *
 * GetWindowLongW **失败时也返回 0**。如果不判断直接 `0 | WS_EX_NOACTIVATE` 写回去，
 * 会把窗口原有的扩展样式整个覆盖掉 —— LAYERED（透明）、TOPMOST（置顶）、
 * TRANSPARENT（穿透）全丢，窗口当场变成一个不透明的普通方块。
 * 所以读到 0 必须当失败处理，绝不能拿它做位运算。
 *
 * SetWindowLongW 失败时**不抛异常也不改任何东西**，不回读就会误以为生效了。
 */

import type { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

const WS_EX_NOACTIVATE = 0x0800_0000
const GWL_EXSTYLE = -20

/*
 * 主进程产物是 ESM，`require` 在那儿是不存在的 —— 用 createRequire 拿一个。
 * 也顺便让 koffi 保持延迟加载：非 Windows 平台根本不该去碰它。
 */
const require = createRequire(import.meta.url)

let api: {
  GetWindowLongW: (hwnd: bigint, index: number) => number
  SetWindowLongW: (hwnd: bigint, index: number, value: number) => number
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
    api = {
      GetWindowLongW: user32.func('int32 GetWindowLongW(uint64 hWnd, int32 nIndex)'),
      SetWindowLongW: user32.func('int32 SetWindowLongW(uint64 hWnd, int32 nIndex, uint32 dwNewLong)'),
    }
  } catch (err) {
    console.warn('[win-style] koffi 加载失败，将退回 Electron 的 focusable 方案', err)
    initFailed = true
  }
  return api
}

function hwndOf(win: BrowserWindow): bigint | null {
  try {
    const buf = win.getNativeWindowHandle()
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  } catch {
    return null
  }
}

/**
 * 给窗口打上 / 摘掉 WS_EX_NOACTIVATE。
 *
 * @returns 是否成功。失败时调用方应退回 Electron 的 focusable 方案（会有抢焦点问题，但至少能用）
 */
export function setNoActivate(win: BrowserWindow, on: boolean): boolean {
  const fn = ensureApi()
  if (!fn) return false
  if (win.isDestroyed()) return false

  const hwnd = hwndOf(win)
  if (hwnd === null) return false

  // int32 的返回值按无符号解读 —— 扩展样式的高位是有意义的
  const current = fn.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0

  // ★ 读到 0 当失败：拿它做位运算会把透明/置顶/穿透全部抹掉
  if (current === 0) {
    console.warn('[win-style] 读窗口扩展样式失败（返回 0），放弃设置')
    return false
  }

  const wanted = on ? current | WS_EX_NOACTIVATE : current & ~WS_EX_NOACTIVATE
  if (wanted === current) return true

  fn.SetWindowLongW(hwnd, GWL_EXSTYLE, wanted)

  // 回读确认：SetWindowLongW 失败时不抛异常，不回读会误判成成功
  const after = fn.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0
  const ok = on ? (after & WS_EX_NOACTIVATE) !== 0 : (after & WS_EX_NOACTIVATE) === 0

  if (!ok) {
    console.warn(`[win-style] 设置 WS_EX_NOACTIVATE=${on} 未生效（样式仍为 0x${after.toString(16)}）`)
  }
  return ok
}

/** 当前是否已经带上 WS_EX_NOACTIVATE */
export function hasNoActivate(win: BrowserWindow): boolean {
  const fn = ensureApi()
  if (!fn || win.isDestroyed()) return false
  const hwnd = hwndOf(win)
  if (hwnd === null) return false
  const current = fn.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0
  return current !== 0 && (current & WS_EX_NOACTIVATE) !== 0
}

/** koffi 是否可用（不可用时调用方需要降级） */
export function isSupported(): boolean {
  return process.platform === 'win32' && ensureApi() !== null
}
