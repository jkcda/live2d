/// <reference types="vite/client" />

/**
 * 前台窗口快照（主进程观察器的产物）。
 *
 * 已经过黑名单过滤 —— 拿到它就说明这个窗口是可以看的。
 */
interface ActivitySnapshot {
  /** 进程名，如 Code.exe */
  process: string
  /** 窗口标题 */
  title: string
  /** 这个活动开始的时刻（epoch ms） */
  since: number
  /** 已经持续了多少秒 */
  forSeconds: number
}

/**
 * Electron 主进程通过 preload 暴露的桥接口。
 * 浏览器环境下 window.nexus 为 undefined，调用前需判空。
 */
interface NexusAPI {
  /** 鼠标是否落在角色身上；传 false 时窗口对鼠标透明（点击穿透到桌面） */
  setInteractive: (interactive: boolean) => Promise<boolean>

  /**
   * 面板开 / 关。
   *
   * 关着时窗口带 WS_EX_NOACTIVATE —— 点她不会抢走你正在打字的焦点
   * （注意不是 Electron 的 focusable:false，那个会把点击一起吃掉）。
   * 开着时摘掉，否则输入框拿不到键盘焦点。
   */
  setPanelOpen: (open: boolean) => Promise<boolean>

  hide: () => Promise<boolean>
  version: () => Promise<string>
  quit: () => Promise<void>

  /**
   * 当前前台窗口快照。
   *
   * 返回 null 表示：没在观察 / 已暂停 / 命中黑名单 / 读不到。
   * 黑名单过滤在主进程完成，敏感标题不会走到这里。
   */
  getActivity: () => Promise<ActivitySnapshot | null>

  /** 暂停 / 恢复观察 */
  setObservePaused: (paused: boolean) => Promise<boolean>
  observeStatus: () => Promise<{ available: boolean; paused: boolean }>

  /** 订阅托盘菜单的「打开面板」请求。返回取消订阅函数。 */
  onOpenPanel: (handler: (panel: 'chat' | 'settings') => void) => () => void

  /** 订阅「窗口重新显示，悬停状态该复位」。返回取消订阅函数。 */
  onResetHover: (handler: () => void) => () => void

  /** 订阅托盘菜单的「恢复交互」（穿透态下唯一点得到的出口）。返回取消订阅函数。 */
  onExitPassthrough: (handler: () => void) => () => void

  /** 报告穿透态下仍可点击的矩形（窗口内 CSS 像素），退出穿透传 null */
  setPassthroughIsland: (
    rect: { x: number; y: number; width: number; height: number } | null,
  ) => Promise<boolean>
}

interface Window {
  nexus?: NexusAPI
}
