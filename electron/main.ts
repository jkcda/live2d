import { app, BrowserWindow, ipcMain, screen, globalShortcut } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const WIN_WIDTH = 420
const WIN_HEIGHT = 640
const MARGIN = 40

let win: BrowserWindow | null = null

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: Math.max(0, width - WIN_WIDTH - MARGIN),
    y: Math.max(0, height - WIN_HEIGHT - MARGIN),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 置顶到 screen-saver 层级，避免被普通全屏窗口盖住
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }

  win.on('closed', () => {
    win = null
  })
}

// ── 点击穿透 ──
// 渲染进程根据鼠标是否落在角色身上上报，非角色区域穿透到桌面
ipcMain.handle('window:setInteractive', (_e, interactive: boolean) => {
  if (!win) return false
  // forward: true 让穿透状态下仍能收到 mousemove，用于判断何时恢复交互
  win.setIgnoreMouseEvents(!interactive, { forward: true })
  return true
})

ipcMain.handle('window:hide', () => {
  win?.hide()
  return true
})

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('app:quit', () => {
  app.quit()
})

app.whenReady().then(() => {
  createWindow()

  // 全局快捷键：H 显隐，Q 退出
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!win) return
    win.isVisible() ? win.hide() : win.show()
  })

  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
