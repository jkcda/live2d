/// <reference types="vite/client" />

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

  /** 订阅托盘菜单的「打开面板」请求。返回取消订阅函数。 */
  onOpenPanel: (handler: (panel: 'chat' | 'settings') => void) => () => void

  /** 订阅「窗口重新显示，悬停状态该复位」。返回取消订阅函数。 */
  onResetHover: (handler: () => void) => () => void
}

interface Window {
  nexus?: NexusAPI
}
