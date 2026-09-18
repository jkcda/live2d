import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('nexus', {
  /** 鼠标是否落在角色身上；false 时窗口对鼠标透明 */
  setInteractive: (interactive: boolean) => ipcRenderer.invoke('window:setInteractive', interactive),

  /**
   * 面板开 / 关。
   *
   * 关着时窗口带 WS_EX_NOACTIVATE —— 点她不会抢走你正在打字的焦点。
   * 开着时摘掉，否则输入框拿不到键盘焦点。
   */
  setPanelOpen: (open: boolean) => ipcRenderer.invoke('window:setPanelOpen', open),

  hide: () => ipcRenderer.invoke('window:hide'),
  version: () => ipcRenderer.invoke('app:version'),
  quit: () => ipcRenderer.invoke('app:quit'),

  /**
   * 当前前台窗口快照。
   *
   * 返回 null 表示：没在观察 / 已暂停 / 命中黑名单 / 读不到。
   * 黑名单的过滤在主进程完成 —— 敏感标题根本不会走到这里。
   */
  getActivity: () => ipcRenderer.invoke('window:getActivity'),

  /** 暂停 / 恢复观察 */
  setObservePaused: (paused: boolean) => ipcRenderer.invoke('observe:setPaused', paused),
  observeStatus: () => ipcRenderer.invoke('observe:status'),

  /**
   * 抓一张前台窗口的截图。
   *
   * 返回 null 表示：观察暂停 / 命中黑名单 / 前台是应用自己 / 画面没怎么变。
   * **拿到就说明这张图是可以看的** —— 黑名单在主进程里就拦掉了，
   * 渲染层不需要（也不应该）再判一遍。
   *
   * force=true 绕过变化门控，只给验证脚本用。
   */
  captureScreen: (force = false) => ipcRenderer.invoke('screen:capture', force),

  /**
   * 取一张「这一轮可以附给她的」截图。
   *
   * 和 captureScreen 的区别：这条是给**对话**用的 —— 门控拦下新抓取时会退回
   * 最近一帧并带上 `ageSeconds`（画面没变，恰恰说明那张旧图还是准的），
   * 但比 30 秒更旧的就返回 null（宁可这次不给图，也别让她描述过时的画面）。
   *
   * 返回 null 表示：暂停观察 / 命中黑名单 / 前台是她自己 / 手上没有足够新的帧。
   * **拿到它只说明这张图是可以给她看的** —— 过滤在主进程完成。
   */
  screenForTurn: () =>
    ipcRenderer.invoke('screen:forTurn') as Promise<{
      dataUrl: string
      width: number
      height: number
      ageSeconds: number
    } | null>,

  /** 清掉变化门控的状态（下一个测试用例要一张干净的基准图时用） */
  resetScreenGate: () => ipcRenderer.invoke('screen:gateReset'),

  /**
   * 订阅「托盘菜单要求打开某个面板」。
   * 返回取消订阅函数 —— 组件卸载时不注销会在热更新后重复触发。
   */
  onOpenPanel: (handler: (panel: 'chat' | 'settings') => void) => {
    const listener = (_e: IpcRendererEvent, panel: 'chat' | 'settings') => handler(panel)
    ipcRenderer.on('ui:open-panel', listener)
    return () => {
      ipcRenderer.removeListener('ui:open-panel', listener)
    }
  },

  /**
   * 订阅「语音回合」快捷键（默认 Ctrl+Shift+V）。
   *
   * 按一次开始录、再按一次结束。**窗口不用显示** —— 渲染进程在隐藏状态下
   * 照样活着（主进程里 backgroundThrottling 关掉了）。
   */
  onToggleVoice: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('voice:toggle', listener)
    return () => {
      ipcRenderer.removeListener('voice:toggle', listener)
    }
  },

  /**
   * 报告「穿透态下哪一块还能点」（窗口内的 CSS 像素矩形），退出穿透时传 null。
   *
   * 穿透时窗口整个在忽略鼠标，主进程靠这个矩形 + 全局光标位置
   * 决定什么时候临时把交互打开（详见 main.ts 里 island 的注释）。
   */
  setPassthroughIsland: (rect: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.invoke('window:passthroughIsland', rect),

  /**
   * 订阅「托盘菜单要求恢复交互」。
   *
   * 穿透态下窗口在忽略鼠标，页面上的按钮点不到 —— 这是那条状态下
   * 唯一不依赖鼠标的出口，所以必须留着。
   */
  onExitPassthrough: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('ui:exit-passthrough', listener)
    return () => {
      ipcRenderer.removeListener('ui:exit-passthrough', listener)
    }
  },

  /**
   * 订阅「窗口刚被显示，你的悬停状态该复位了」。
   *
   * hide() → show() 之后主进程会把穿透转发重新武装，但渲染层记的还是旧值，
   * 需要它把本地的忽略状态清掉，否则后续的纠正调用会被防抖拦下。
   */
  onResetHover: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('ui:reset-hover', listener)
    return () => {
      ipcRenderer.removeListener('ui:reset-hover', listener)
    }
  },
})
