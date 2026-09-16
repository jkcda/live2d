import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('nexus', {
  /** 鼠标是否落在角色身上；false 时窗口对鼠标透明 */
  setInteractive: (interactive: boolean) => ipcRenderer.invoke('window:setInteractive', interactive),
  hide: () => ipcRenderer.invoke('window:hide'),
  version: () => ipcRenderer.invoke('app:version'),
  quit: () => ipcRenderer.invoke('app:quit'),
})
