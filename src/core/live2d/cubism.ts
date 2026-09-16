/**
 * Cubism Core 加载器。
 *
 * Live2D 的 Cubism 3/4/5 模型依赖一个外部运行时 `live2dcubismcore.min.js`，
 * 它不随 npm 包分发（渲染引擎只负责引用全局变量 `Live2DCubismCore`）。
 *
 * ⚠️ 请从官方渠道获取，不要用第三方 npm 包：
 *     https://www.live2d.com/download/cubism-sdk/download-web/
 *   下载 Cubism SDK for Web，从 Core/ 目录取出 live2dcubismcore.min.js，
 *   放到本项目的 public/lib/ 下。
 *
 * 之所以坚持官方渠道：这个文件受 Live2D 的 SDK 授权条款约束，
 * 使用即表示接受其条款；第三方再分发版本的来源与授权状态都无法确认。
 */

/** 运行时脚本位置（跟随 Vite 的 base，兼容 Electron 打包后的 file:// 加载） */
export const CUBISM_CORE_URL = `${import.meta.env.BASE_URL}lib/live2dcubismcore.min.js`

declare global {
  interface Window {
    Live2DCubismCore?: unknown
  }
}

/** 正在进行中的加载，避免并发重复注入 */
let pending: Promise<void> | null = null

function missingMessage(): string {
  return (
    `Cubism Core 未加载：${CUBISM_CORE_URL}\n` +
    '请前往 https://www.live2d.com/download/cubism-sdk/download-web/ 下载 Cubism SDK for Web，\n' +
    '取出 live2dcubismcore.min.js 放到 public/lib/ 目录下。'
  )
}

/**
 * 确保 Cubism Core 已就绪。
 *
 * - 已加载 → 直接 resolve
 * - 正在加载 → 复用同一个 Promise
 * - 未加载 → 注入 <script> 并等待
 */
export function ensureCubismCore(): Promise<void> {
  if (typeof window !== 'undefined' && window.Live2DCubismCore) {
    return Promise.resolve()
  }
  if (pending) return pending

  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = CUBISM_CORE_URL
    script.async = true

    script.onload = () => {
      if (window.Live2DCubismCore) {
        resolve()
      } else {
        pending = null
        reject(new Error(`${missingMessage()}\n脚本已加载但未导出 Live2DCubismCore。`))
      }
    }

    script.onerror = () => {
      pending = null
      script.remove()
      reject(new Error(missingMessage()))
    }

    document.head.appendChild(script)
  })

  return pending
}
