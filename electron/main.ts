import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// node16 模块解析要求显式扩展名 —— 写 .js，即使源文件是 .ts
import { isSupported as nativeStyleSupported, setNoActivate } from './win-style.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const WIN_WIDTH = 420
const WIN_HEIGHT = 640
const MARGIN = 40

let win: BrowserWindow | null = null
let tray: Tray | null = null

/** 对话/设置面板是否开着。开着时窗口需要能拿焦点，否则输入框打不进字。 */
let panelOpen = false

/** koffi 是否可用。不可用时退回 Electron 的 focusable 方案（会有抢焦点问题，但至少能用） */
const hasNativeStyle = nativeStyleSupported()

/**
 * 取静态资源的绝对路径。
 *
 * 开发时主进程在 `dist-electron/`，静态资源在 `public/`；
 * 打包后两者分别落在 `dist-electron/` 和 `dist/`。
 * 不区分的话，开发能跑、打包后图标丢失。
 */
function assetPath(name: string): string {
  const base = app.isPackaged ? join(__dirname, '..', 'dist') : join(__dirname, '..', 'public')
  return join(base, name)
}

/**
 * 应用「不抢焦点」。
 *
 * ⚠️ 这里刻意**不用** Electron 的 `focusable: false` —— 它会把点击一起吃掉，
 * 详见 win-style.ts 顶部的说明。走 FFI 只打 WS_EX_NOACTIVATE 这一个样式位。
 */
function applyNoActivate(on: boolean): void {
  if (!win) return

  if (hasNativeStyle) {
    setNoActivate(win, on)
    return
  }

  /*
   * 降级路径：koffi 不可用（非 Windows，或依赖装坏了）。
   *
   * 只能用 Electron 的 focusable 开关，但那个**会把 mousedown 一起吃掉** ——
   * 等于「不抢焦点」和「点得动」二选一。
   *
   * 这里选「点得动」：抢焦点只是烦，点不动是坏掉。
   * 所以平时不动它，只在面板打开（需要键盘）时确保它是 true。
   */
  if (!on) win.setFocusable(true)
}

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
    // 保持 true —— 焦点控制交给 WS_EX_NOACTIVATE，见 applyNoActivate
    focusable: true,
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 置顶到 screen-saver 层级，避免被普通全屏窗口盖住
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 窗口一建好就打上「系统不激活我」的样式位
  applyNoActivate(true)

  /*
   * hide() → show() 之后必须重新武装两件事。
   *
   * ① setIgnoreMouseEvents(true, { forward: true }) 的转发会静默失效 ——
   *    穿透态下渲染层判断「鼠标在不在角色身上」的唯一信号就来自这个转发，
   *    失效之后窗口永远卡在穿透态，鼠标怎么移都翻不回可点态。
   * ② 渲染层自己维护的忽略状态并不知道主进程这边重置了，
   *    它记的还是旧值，后续的纠正调用会被它「值没变就不发」的防抖拦下。
   *    所以得通知它复位。
   */
  win.on('show', () => {
    if (!win) return
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.send('ui:reset-hover')
    if (!panelOpen) applyNoActivate(true)
    refreshTrayMenu()
  })

  win.on('hide', () => refreshTrayMenu())

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

// ── 托盘 ──

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    win.showInactive() // 不抢焦点地显示
  }
  refreshTrayMenu()
}

/** 通知渲染进程打开某个面板，并把窗口切到「可聚焦」 */
function openPanel(panel: 'chat' | 'settings') {
  if (!win) return
  panelOpen = true
  applyNoActivate(false)
  win.show()
  win.focus()
  win.webContents.send('ui:open-panel', panel)
}

function refreshTrayMenu() {
  if (!tray) return

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: win?.isVisible() ? '隐藏角色' : '显示角色',
        click: toggleWindow,
      },
      { type: 'separator' },
      { label: '和她说话…', click: () => openPanel('chat') },
      { label: '设置…', click: () => openPanel('settings') },
      { type: 'separator' },
      { label: `v${app.getVersion()}`, enabled: false },
      { label: '退出', click: () => app.quit() },
    ]),
  )
}

function createTray() {
  /*
   * 不要把 32 的图 resize 成 16。
   *
   * Windows 托盘按 SM_CXSMICON 渲染 —— 100% 缩放是 16px，150% 是 24px，200% 是 32px。
   * 预先压到 16 的话，在 150% / 200% 下会被**放大**回去，边缘直接糊。
   * 直接把 32 交给系统缩：200% 下 1:1，其余情况是缩小 —— 都比放大好。
   */
  const icon = nativeImage.createFromPath(assetPath('tray.png'))
  const image = icon.isEmpty() ? nativeImage.createEmpty() : icon

  tray = new Tray(image)
  tray.setToolTip('澪')
  refreshTrayMenu()

  // 左键单击 = 显隐（Windows 上托盘图标最常见的预期）
  tray.on('click', toggleWindow)
}

// ── 窗口控制 ──

ipcMain.handle('window:setInteractive', (_e, interactive: boolean) => {
  if (!win) return false
  // forward: true 让穿透状态下仍能收到 mousemove，用于判断何时恢复交互
  win.setIgnoreMouseEvents(!interactive, { forward: true })
  return true
})

/**
 * 面板开 / 关。
 *
 * 关着的时候窗口带 WS_EX_NOACTIVATE —— 点她不会抢走你正在打字的焦点。
 * 开着的时候必须摘掉，否则输入框拿不到键盘焦点，打不进字。
 */
ipcMain.handle('window:setPanelOpen', (_e, open: boolean) => {
  if (!win) return false
  panelOpen = open
  applyNoActivate(!open)
  if (open) {
    win.show()
    win.focus()
  }
  return true
})

ipcMain.handle('window:hide', () => {
  /*
   * 没有托盘时拒绝隐藏。
   *
   * 藏起来就再也叫不出来了 —— Ctrl+Shift+H 能救回来，但用户不知道这个快捷键。
   * 返回 false，调用方可以据此提示；什么都不做也好过变成看不见的幽灵。
   */
  if (!tray) {
    console.warn('[main] 没有托盘，拒绝隐藏窗口（否则无法再唤出）')
    return false
  }
  win?.hide()
  refreshTrayMenu()
  return true
})

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('app:quit', () => {
  app.quit()
})

app.whenReady().then(() => {
  if (!hasNativeStyle && process.platform === 'win32') {
    console.warn('[main] koffi 不可用，窗口会退回 focusable 方案：点击角色时可能抢走焦点')
  }

  createWindow()

  try {
    createTray()
  } catch (err) {
    /*
     * 托盘建不起来（精简系统、权限受限、explorer 异常都会）。
     * 不能就这么算了 —— 没有托盘又没有窗口，进程就成了「看不见也关不掉」的幽灵。
     * 这里把 tray 置空，让 window-all-closed 恢复「关掉即退出」，
     * 并且 window:hide 会拒绝隐藏（见那里的注释）。
     */
    tray = null
    console.error('[main] 托盘创建失败，已退回「关窗即退出」模式', err)
  }

  // 全局快捷键：H 显隐，Q 退出
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleWindow()
  })

  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit()
  })

  console.log('[main] 快捷键：Ctrl+Shift+H 显隐角色，Ctrl+Shift+Q 退出')
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
})

/*
 * 有托盘时：窗口全关 ≠ 退出。
 * 桌宠的预期是「关掉角色，她还在托盘里待着」；这里 app.quit() 的话，
 * 用户点一次关闭她整个人就没了，下次还得重新启动 —— 托盘就白做了。
 *
 * 没有托盘时：必须退出。否则没有窗口也没有托盘，进程就变成幽灵了。
 */
app.on('window-all-closed', () => {
  if (!tray) app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
