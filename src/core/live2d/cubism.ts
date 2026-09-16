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

/* ──────────────────────────────────────────────────────────────
 * Core 6 兼容补丁
 *
 * Cubism Core 6（随 SDK for Web 5-r.5 分发）改了 API：
 * `Model.renderOrders` 变成私有字段，公开入口是 `model.getRenderOrders()`。
 * 但渲染引擎（untitled-pixi-live2d-engine 1.3.5，自称支持 Cubism 2–5）
 * 仍按 Core 5 的字段名去读 `model.drawables.renderOrders`。
 *
 * 后果很有迷惑性：模型**加载成功**（moc3 / 贴图 / physics 全部 200，
 * 应用自己的 status 也清空了），但每帧绘制都在 doDrawModel 里
 * `renderOrder[i]` 抛 TypeError —— 画布从始至终是空的，只有 console 里有异常。
 *
 * 所以加载 Core 之后必须立刻把新方法挂回旧字段名。纯字段搬迁，语义一致：
 * getRenderOrders() 返回的就是长度等于 drawableCount 的 Int32Array。
 * ────────────────────────────────────────────────────────────── */

interface CoreModelLike {
  drawables?: { renderOrders?: unknown }
  getRenderOrders?: () => unknown
}

interface CoreLike {
  Model?: { fromMoc?: (moc: unknown) => CoreModelLike }
}

let coreCompatInstalled = false

function installCoreCompat(core: unknown): void {
  if (coreCompatInstalled) return

  const ModelClass = (core as CoreLike | undefined)?.Model
  const originalFromMoc = ModelClass?.fromMoc
  // 老版本 Core 本来就带 drawables.renderOrders，没什么要补的
  if (!ModelClass || typeof originalFromMoc !== 'function') return

  ModelClass.fromMoc = function patchedFromMoc(this: unknown, moc: unknown) {
    const model = originalFromMoc.call(this, moc)
    const drawables = model?.drawables
    if (
      drawables &&
      drawables.renderOrders === undefined &&
      typeof model.getRenderOrders === 'function'
    ) {
      drawables.renderOrders = model.getRenderOrders()
    }
    return model
  }

  coreCompatInstalled = true
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
    installCoreCompat(window.Live2DCubismCore)
    return Promise.resolve()
  }
  if (pending) return pending

  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = CUBISM_CORE_URL
    script.async = true

    script.onload = () => {
      if (window.Live2DCubismCore) {
        installCoreCompat(window.Live2DCubismCore)
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
