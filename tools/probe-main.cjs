/**
 * 给验证脚本用的最小 Electron 宿主。
 *
 * 为什么不用应用自己的 electron/main.ts：那个是给用户看的桌宠窗口 ——
 * 无边框、透明、置顶、还会自动开 DevTools。做自动化验证时这些全是干扰
 * （透明窗口截出来是花的，DevTools 会抢焦点）。
 * 这个宿主只做一件事：把一个普通窗口指向 dev server，好让 CDP 连上去。
 *
 * 用法（由 tools/verify-portrait.mjs 自动启动，不需要手敲）：
 *   electron tools/probe-main.cjs --remote-debugging-port=9333
 */
const { app, BrowserWindow } = require('electron')

const url = process.env.PROBE_URL || 'http://localhost:5176/?portrait=1'
const width = Number(process.env.PROBE_WIDTH || 900)
const height = Number(process.env.PROBE_HEIGHT || 1100)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width,
    height,
    backgroundColor: '#202226',
    webPreferences: {
      // 后台窗口会被 Chromium 降频 rAF，动画就不动了 —— 验证口型必须关掉
      backgroundThrottling: false,
    },
  })
  win.loadURL(url)
  console.log(`[probe] ${url} @ ${width}×${height}`)
})

app.on('window-all-closed', () => app.quit())
