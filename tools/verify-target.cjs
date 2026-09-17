/**
 * 给「前台窗口观察」验证用的靶子窗口。
 *
 * 为什么需要它：观察器测的是「当前前台窗口是谁」。要断言这件事，
 * 就得有一个**完全受控**的前台窗口 —— 不能借用户自己的记事本/浏览器，
 * 那既打扰他，标题也不受我们指挥。
 *
 * 两个设计点：
 *   · 标题由**文件**驱动（每 200ms 读一次）。验证要测「标题变了观察器跟不跟得上」，
 *     而换标题不能靠重启进程 —— 重启会连窗口句柄一起换掉，测的就不是同一件事了。
 *   · 普通带边框的可激活窗口（不是应用那种无边框置顶的），
 *     这样它才会正常成为前台窗口。
 *
 * 用法（由 tools/verify-activity.mjs 自动启动，不需要手敲）：
 *   electron tools/verify-target.cjs --user-data-dir=<临时目录>
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

const TITLE_FILE = process.env.NEXUS_TITLE_FILE
const INITIAL = process.env.NEXUS_TARGET_TITLE || 'NEXUS 验证靶子'

const HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
height:100vh;background:#12141a;color:#e8eaf0;font-family:system-ui,'Microsoft YaHei',sans-serif">
<div style="font-size:44px">🎯</div>
<div style="font-size:18px;margin-top:12px">前台窗口验证靶子</div>
<div style="font-size:13px;opacity:.6;margin-top:8px">这个窗口是验证脚本开的，验证完会自动关掉</div>
</body>`

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    title: INITIAL,
    autoHideMenuBar: true,
  })

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  win.setTitle(INITIAL)

  /*
   * data: URL 的文档没有 <title>，Chromium 会把窗口标题设成 URL 本身，
   * 所以标题得**持续**按压（而不是设一次就完）。
   */
  const timer = setInterval(() => {
    if (!TITLE_FILE) return
    try {
      const t = fs.readFileSync(TITLE_FILE, 'utf8').trim()
      if (t && t !== win.getTitle()) win.setTitle(t)
    } catch {
      /* 文件还没写到，下一轮再说 */
    }
  }, 200)
  timer.unref?.()

  console.log(`[target] 靶子窗口已打开，标题=${INITIAL}`)
})

app.on('window-all-closed', () => app.quit())
