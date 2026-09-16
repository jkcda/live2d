/// <reference types="vite/client" />

/**
 * Electron 主进程通过 preload 暴露的桥接口。
 * 浏览器环境下 window.nexus 为 undefined，调用前需判空。
 */
interface NexusAPI {
  /** 鼠标是否落在角色身上；传 false 时窗口对鼠标透明（点击穿透到桌面） */
  setInteractive: (interactive: boolean) => Promise<boolean>
  hide: () => Promise<boolean>
  version: () => Promise<string>
  quit: () => Promise<void>
}

interface Window {
  nexus?: NexusAPI
}
