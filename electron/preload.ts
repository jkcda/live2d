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
