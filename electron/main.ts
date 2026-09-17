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
import { ActivityObserver, activitySnapshot, foregroundWindow, isObservable } from './observer.js'
import { captureForeground, captureRect, ScreenGate, type ScreenFrame } from './screen.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const WIN_WIDTH = 420
const WIN_HEIGHT = 640
const MARGIN = 40

let win: BrowserWindow | null = null
let tray: Tray | null = null

/** 对话/设置面板是否开着。开着时窗口需要能拿焦点，否则输入框打不进字。 */
let panelOpen = false

/**
 * 窗口当前是不是「点击穿透」。
 *
 * 为什么主进程要记这个：穿透态下窗口在忽略鼠标，页面上任何按钮都点不到，
 * 用户可能就此卡死。所以托盘菜单必须知道这个状态，好给他一个不依赖鼠标的出口。
 */
let clickThrough = false

/**
 * 穿透态下唯一还接收鼠标的一小块区域（提示条），窗口内的 CSS 像素坐标。
 *
 * ⚠️ 为什么要在主进程盯着光标，而不是靠 Electron 的
 * `setIgnoreMouseEvents(true, { forward: true })`：
 * **实测那条路在这里根本不送事件**。窗口进入穿透后，页面收到的 mousemove
 * 数量是 0（同一坐标在非穿透态下是正常收到的），也就是说「靠 hover 把交互打开」
 * 这个思路在 Windows + 透明窗口上不成立 —— 提示条就成了一个
 * 「需要用鼠标才能点到的、专门用来恢复鼠标的按钮」，逻辑上死锁。
 *
 * 主进程有一样东西不受窗口输入状态影响：`screen.getCursorScreenPoint()`
 * （全局光标位置）。所以改成主进程自己盯着光标：压到提示条上就把窗口的
 * 交互临时打开，移开就恢复穿透。点得到、也点得回去。
 */
let island: { x: number; y: number; width: number; height: number } | null = null
let islandHot = false
let islandTimer: NodeJS.Timeout | null = null

/** koffi 是否可用。不可用时退回 Electron 的 focusable 方案（会有抢焦点问题，但至少能用） */
const hasNativeStyle = nativeStyleSupported()

/**
 * 前台窗口观察器。
 *
 * 隐私边界在它内部：黑名单命中的窗口连标题都不记录（见 observer.ts）。
 * 这里只负责生命周期和对外暴露快照。
 */
const observer = new ActivityObserver()

/**
 * 截图变化门控。
 *
 * 和 observer 的「(进程, 标题) 变了才更新」是同一个思路，
 * 只是判据从字符串相等换成了感知哈希距离。
 */
const screenGate = new ScreenGate()

/**
 * 最近一张抓好的截图（**只留一帧**，见 screen.ts 的生命周期契约）。
 *
 * 为什么主进程要留一帧、而且**提前**抓好：见 warmScreen() 的注释 ——
 * 简单说就是"抓图那 100~300ms 不能卡在他和请求之间"。
 */
let lastFrame: ScreenFrame | null = null

/**
 * 复用旧帧的上限。
 *
 * 比这更旧的画面宁可这次不给图 —— 让她描述一个 10 分钟前的屏幕，
 * 比让她说"我看看"要糟得多。
 */
const FRAME_MAX_AGE_MS = 30_000

/** 缓存超过这个时间就允许重新抓（同一个窗口里内容也会变，比如翻页、滚动） */
const SCREEN_REFRESH_MS = 15_000

/** 上一次预热用的矩形，用来判断"窗口是不是换了/动了" */
let lastWarmedKey = ''
let warmTimer: NodeJS.Timeout | null = null
let warming = false

/**
 * 这一轮该抓哪块屏幕。
 *
 * ★ 前台是她自己时，用观察器记住的**最后一个可看窗口**。
 *
 * 他问「你在看什么」的那一刻，前台窗口恰恰是她自己（面板要能打键盘），
 * 所以只认实时前台的话，真实使用里一张图都送不出去 —— 实测就是这样：
 * 她只能说出窗口标题，图根本抓不到。
 */
function screenTargetRect(): { x: number; y: number; width: number; height: number } | null {
  const fg = foregroundWindow()
  if (fg && fg.rect && isObservable(fg)) return fg.rect
  return observer.lastWindow()?.rect ?? null
}

/**
 * 后台预热：把"这一轮可能要用到的截图"先抓好，发请求时直接用缓存。
 *
 * ★ 为什么不能等到发请求那一刻再抓
 *
 * 抓一次图要 100~300ms（desktopCapturer 会把整块屏渲染成全分辨率位图再编码），
 * 而它正好卡在「他按下回车」和「请求发出去」之间 —— 表现就是
 * **每一句回复都慢了一截**（用户的原话："回复也变慢了很多"）。
 *
 * 预热是事件驱动的：窗口换了（矩形变了）或者缓存超过 15 秒才抓一次，
 * 平时什么都不做。
 */
async function warmScreen(): Promise<void> {
  if (warming || !win || observer.paused || !win.isVisible()) return

  const rect = screenTargetRect()
  if (!rect) return

  const key = `${rect.x},${rect.y},${rect.width}x${rect.height}`
  const fresh = lastFrame !== null && Date.now() - lastFrame.at < SCREEN_REFRESH_MS
  if (key === lastWarmedKey && fresh) return

  warming = true
  let hidden = false
  try {
    /*
     * 她自己的窗口正压在这块区域上时，先把自己藏起来再抓。
     *
     * 不算这一步的话图里会有她自己（她永远置顶），
     * 模型会看到"画面角上有个女孩"，很怪。
     * 只在**真的重叠**时才藏 —— 大多数时候她那一小块不挡事，不需要闪。
     */
    const phys = screen.dipToScreenRect(null, win.getBounds())
    const overlaps =
      phys.x < rect.x + rect.width &&
      rect.x < phys.x + phys.width &&
      phys.y < rect.y + rect.height &&
      rect.y < phys.y + phys.height

    if (overlaps) {
      win.setOpacity(0)
      hidden = true
      // 让这一帧先真的不可见再抓（否则抓到的还是上一帧合成结果）
      await new Promise((done) => setTimeout(done, 60))
    }

    const frame = await captureRect(rect)
    if (frame) {
      lastFrame = frame
      lastWarmedKey = key
    }
  } catch (err) {
    console.warn('[screen] 预热失败：', err instanceof Error ? err.message : err)
  } finally {
    // 无论如何都要把她显示回来 —— 绝不能因为一次抓图失败让她隐形
    if (hidden && win && !win.isDestroyed()) win.setOpacity(1)
    warming = false
  }
}

/**
 * 允许渲染层用 `force` 绕过变化门控。
 *
 * **只有验证脚本该开这个**（tools/verify-screen.mjs 会设）。
 * 默认关着 —— 一个从页面就能调的「跳过限流」后门不该在生产里可达。
 */
const ALLOW_FORCE_CAPTURE = process.env.NEXUS_ALLOW_FORCE_CAPTURE === '1'

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
    clickThrough = true // 上面这一行刚把窗口变成穿透态，托盘菜单要如实反映
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
  /*
   * 穿透态下窗口在忽略鼠标 —— 面板就算弹出来也是点不动的，
   * 所以这里先无条件摘掉穿透（渲染层那边会跟着把 passthrough 置 false）。
   */
  clickThrough = false
  win.setIgnoreMouseEvents(false, { forward: true })
  win.show()
  win.focus()
  win.webContents.send('ui:open-panel', panel)
  refreshTrayMenu()
}

/** 退出穿透。托盘菜单里那条出口走这里 */
function exitClickThrough() {
  clickThrough = false
  island = null
  islandHot = false
  stopIslandWatch()
  win?.setIgnoreMouseEvents(false, { forward: true })
  win?.webContents.send('ui:exit-passthrough')
  refreshTrayMenu()
}

/**
 * 穿透期间盯着光标：只在提示条上给窗口留一块能点的区域。
 *
 * 120ms 一次是权衡：更快没必要（人的手不会瞬移），更慢会在
 * 「移上去 → 点下去」之间漏掉一拍，表现就是偶尔点不动。
 */
function startIslandWatch() {
  if (islandTimer) return
  islandTimer = setInterval(() => {
    if (!win) return

    if (!clickThrough || !island) {
      if (islandHot) {
        islandHot = false
        win.setIgnoreMouseEvents(true, { forward: true })
      }
      return
    }

    const p = screen.getCursorScreenPoint() // DIP 屏幕坐标，和窗口 bounds / CSS 像素同一套
    const b = win.getBounds()
    // 留一点余量：渲染层量矩形和光标位置之间总有一点点时序差，差几像素不该点不动
    const SLACK = 6
    const inside =
      p.x >= b.x + island.x - SLACK &&
      p.x <= b.x + island.x + island.width + SLACK &&
      p.y >= b.y + island.y - SLACK &&
      p.y <= b.y + island.y + island.height + SLACK

    if (inside === islandHot) return
    islandHot = inside
    win.setIgnoreMouseEvents(!inside, { forward: true })
  }, 120)
  islandTimer.unref?.()
}

function stopIslandWatch() {
  if (islandTimer) clearInterval(islandTimer)
  islandTimer = null
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
      {
        /*
         * 穿透态下的救命出口。
         *
         * 穿透时窗口整个在忽略鼠标，页面上的「点击恢复交互」是一个
         * 需要先用鼠标才能点到的按钮 —— 逻辑上就是个死锁。
         * 托盘菜单是唯一不受影响的入口，所以这条必须在。
         */
        label: clickThrough ? '恢复交互（当前穿透中）' : '恢复交互',
        enabled: clickThrough,
        click: exitClickThrough,
      },
      {
        // 观察开关放托盘而不是只放设置面板：这是隐私相关的开关，
        // 用户想关的时候应该一步就能关到，而不是翻两层菜单。
        label: observer.paused ? '恢复观察' : '暂停观察',
        enabled: observer.available,
        click: () => {
          observer.setPaused(!observer.paused)
          refreshTrayMenu()
        },
      },
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
  // forward: true 是给「窗口被忽略时还能收到 mousemove」准备的，但实测它不送事件
  // （见 island 的注释），真正的兜底是主进程自己盯光标。
  win.setIgnoreMouseEvents(!interactive, { forward: true })
  if (clickThrough !== !interactive) {
    clickThrough = !interactive
    // 托盘里那条「恢复交互」的可用状态跟着变
    refreshTrayMenu()
  }
  return true
})

/**
 * 渲染层报告「穿透态下哪一块还能点」。
 *
 * 穿透开着的时候传提示条的矩形，退出时传 null。
 */
ipcMain.handle('window:passthroughIsland', (_e, rect: { x: number; y: number; width: number; height: number } | null) => {
  island = rect
  if (rect) {
    islandHot = false
    startIslandWatch()
  } else {
    islandHot = false
    stopIslandWatch()
  }
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

/**
 * 取当前前台窗口快照。
 *
 * 渲染层在发对话请求前调这个，把结果一起带给 agent ——
 * 这样「她看得见你在干嘛」不需要一条常驻推送通道。
 * 返回 null 表示：没在观察 / 已暂停 / 命中黑名单 / 读不到。
 */
ipcMain.handle('window:getActivity', () => activitySnapshot(observer))

ipcMain.handle('observe:setPaused', (_e, paused: boolean) => {
  observer.setPaused(paused)
  refreshTrayMenu()
  return observer.paused
})

ipcMain.handle('observe:status', () => ({
  available: observer.available,
  paused: observer.paused,
}))

/**
 * 抓一张前台窗口的截图。
 *
 * ★ 黑名单那一道闸门**不在这里**，在 captureForeground 里面 ——
 * 因为它必须和裁剪用**同一次读**的前台窗口。放在这儿判的话就是拿
 * `observer.snapshot()`（1 秒轮询、只在变化时更新）去判，而裁的是实时窗口，
 * 中间能对不上：切到敏感窗口后 ≤1s 内抓图，判的是 A、裁的是 B。
 *
 * 所以这里只管「变化门控」这一道（它是对已抓到的图做判断，没有窗口期问题）。
 */
ipcMain.handle('screen:capture', async (_e, force = false) => {
  /*
   * 「暂停观察」必须同时断掉截图。
   *
   * isObservable() 只管「是不是黑名单 / 是不是她自己」，**它不管暂停开关** ——
   * 少这一句的话，用户点了托盘的「暂停观察」之后，标题看不到了、图却照样能抓。
   * 那正是这个开关最不该有的样子：他按下去的意思是"别看了"，不是"少看一样"。
   */
  if (observer.paused) return null

  const frame = await captureForeground()
  if (!frame) return null

  /*
   * force 只有验证脚本能用。
   *
   * 它是从渲染层传进来的参数，等于把「绕过速率限制」暴露给了页面 ——
   * 黑名单仍然管用（那道闸门在 captureForeground 里，不经过这里），
   * 但调试用的后门不该在生产里可达。用环境变量把它关在门外。
   */
  const bypass = force === true && ALLOW_FORCE_CAPTURE
  if (!bypass && !screenGate.accept(frame)) return null

  return frame
})

/**
 * 取一张「这一轮可以附给她的」截图。
 *
 * ★ 这里**不抓图**，只拿后台预热好的那张。
 *
 * 抓图要 100~300ms，正好卡在"他按下回车"和"请求发出去"之间 ——
 * 之前就是这么写的，用户的第一反应是"回复变慢了很多"。
 * 现在抓图在后台（warmScreen），这里只做一次内存读取，零延迟。
 *
 * 代价是这一帧可能比"此刻"旧十几秒 —— 所以 ageSeconds 一定会带上，
 * 她那边的文字里会写明"这是几秒前抓的"（见 agent 的 userContent）。
 * 超过 FRAME_MAX_AGE_MS 就宁可不给：让她描述一张过时的画面比不给更糟。
 */
ipcMain.handle('screen:forTurn', () => {
  if (observer.paused) return null

  const f = lastFrame
  if (!f || Date.now() - f.at > FRAME_MAX_AGE_MS) {
    // 手上没有能用的 —— 让后台去补一张，但**不阻塞这一轮**
    void warmScreen()
    return null
  }

  return {
    dataUrl: f.dataUrl,
    width: f.width,
    height: f.height,
    ageSeconds: Math.round((Date.now() - f.at) / 1000),
  }
})

ipcMain.handle('screen:gateReset', () => {
  screenGate.reset()
  return true
})

ipcMain.handle('app:quit', () => {
  app.quit()
})

app.whenReady().then(() => {
  if (!hasNativeStyle && process.platform === 'win32') {
    console.warn('[main] koffi 不可用，窗口会退回 focusable 方案：点击角色时可能抢走焦点')
  }

  createWindow()

  try {
    /*
     * 验证钩子：NEXUS_NO_TRAY=1 强制走「托盘创建失败」那条路。
     *
     * 这条兜底在健康的机器上**没法自然触发**，而它恰恰是最该验的一段
     * （失败了会变成看不见也关不掉的幽灵进程）。所以留一个显式的开关，
     * 让 tools/verify-pet-window.mjs --no-tray 能真的跑到。
     */
    if (process.env.NEXUS_NO_TRAY) throw new Error('NEXUS_NO_TRAY 要求模拟托盘创建失败')
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

  if (observer.available) {
    observer.start()
    console.log('[main] 前台窗口观察已启动（默认开启；托盘菜单可暂停）')

    /*
     * 截图预热：每秒看一次"该不该补一张"，只在窗口换了或缓存过期时才真的抓。
     * 为什么放在主进程而不是渲染层：抓图要上百毫秒，放在发请求那一刻
     * 就是"每一句回复都慢一截"。
     */
    void warmScreen()
    warmTimer = setInterval(() => void warmScreen(), 1000)
    warmTimer.unref?.()
  } else {
    console.warn('[main] 前台窗口观察不可用（非 Windows 或 koffi 加载失败）')
  }

  console.log('[main] 快捷键：Ctrl+Shift+H 显隐角色，Ctrl+Shift+Q 退出')
})

app.on('will-quit', () => {
  observer.stop()
  stopIslandWatch()
  if (warmTimer) clearInterval(warmTimer)
  warmTimer = null
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
