/**
 * 本地图片 → 能塞进模型请求的 data URL。
 *
 * ## 为什么必须转 base64（以及为什么这不叫"多此一举"）
 *
 * 模型是**远端服务**，它打不开你的 `D:\照片\猫.png` —— 给路径它只拿到一串字符，
 * 像素从来没进过请求。而 OpenAI 兼容格式里图片只有两种给法：
 *
 *     {"type":"image_url","image_url":{"url":"https://…"}}          ← 公网 URL
 *     {"type":"image_url","image_url":{"url":"data:image/jpeg;…"}}   ← data URL
 *
 * 本地文件没有公网 URL，所以只能走 data URL。**转换没得省，只能决定在哪转。**
 * 答案是在这里转一次 —— 渲染层只拿到一个字符串，不关心背后是截屏还是本地图片。
 *
 * ## 为什么不走工具（tool）那条路
 *
 * 试过这个思路：让 `read_file` 读出图片内容返回给模型。
 * **不行** —— OpenAI 兼容格式里 **tool result 只能是字符串**，
 * 图片必须挂在 `messages` 的 `image_url` 上。工具返回的 base64 模型只会当文本看。
 *
 * 所以图片和文本走两条路：
 *     · 文本文件 → 工具（读出来就是文字，能塞进 tool result）
 *     · 图片     → 挂在消息上（跟截屏一模一样）
 *
 * ## 尺寸：这是唯一真正影响代价的参数
 *
 * base64 只加 33% 体积，**尺寸才决定量级**：
 *
 *     1280px JPEG   ≈ 150KB  → base64 后 ≈ 200KB   随便发
 *     4K 原图        ≈ 5MB   → base64 后 ≈ 6.7MB   ✗ 又慢又贵，有些网关直接拒
 *
 * 所以缩放到最长边 1280 —— 对"看图"来说已经绰绰有余（多模态模型的输入分辨率
 * 普遍在这个量级，再大也会被内部降采样）。
 */

import { dialog, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { nativeImage } from 'electron'

/** 最长边超过它就缩。见文件顶部关于尺寸的说明。 */
const MAX_EDGE = 1280

/**
 * JPEG 质量。
 *
 * 比截屏那条路（80）稍高：截屏是"整个屏幕"，图片可能是**一份文档的截图**，
 * 字糊了就白给了。80→85 的体积代价很小，可读性的收益不小。
 */
const JPEG_QUALITY = 85

/** 支持的扩展名。不在这里的让系统对话框自己挡掉。 */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']

export interface PickedImage {
  /** data URL，可直接塞进 image_url */
  dataUrl: string
  /** 文件名（不含路径）—— 给她一个称呼它的方式，同时不泄露目录结构 */
  name: string
  width: number
  height: number
  /** 原始字节数（缩放前的），用来告诉她"这图多大" */
  originalBytes: number
}

/**
 * 把一张图读进来、缩好、编码成 data URL。
 *
 * 图片可能很大，所以**必须缩放**；`nativeImage` 是 Electron 自带的，
 * 不用引第三方图像库（那要多装几十兆依赖，只为了 resize）。
 */
export async function imageToDataUrl(filePath: string): Promise<PickedImage> {
  const buf = await readFile(filePath)
  const img = nativeImage.createFromBuffer(buf)

  if (img.isEmpty()) {
    throw new Error(`读不出这张图：${basename(filePath)}（格式不支持？）`)
  }

  const size = img.getSize()
  const longest = Math.max(size.width, size.height)
  const scaled =
    longest > MAX_EDGE
      ? img.resize({
          width: Math.round((size.width * MAX_EDGE) / longest),
          height: Math.round((size.height * MAX_EDGE) / longest),
          quality: 'good',
        })
      : img

  const jpeg = scaled.toJPEG(JPEG_QUALITY)
  if (!jpeg.length) throw new Error('编码失败（这张图可能没有有效像素）')

  const final = scaled.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    name: basename(filePath),
    width: final.width,
    height: final.height,
    originalBytes: buf.length,
  }
}

/**
 * 弹系统对话框让她挑一张图。取消返回 null。
 *
 * 用系统的文件对话框而不是自绘：用户对它有肌肉记忆（最近位置、搜索、拖拽），
 * 而且**权限归系统管** —— 他选了什么就是什么，我不去猜路径。
 */
export async function pickImage(win: BrowserWindow | null): Promise<PickedImage | null> {
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: '挑一张图给她看',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: IMAGE_EXT }],
  })

  if (result.canceled || !result.filePaths.length) return null
  return imageToDataUrl(result.filePaths[0])
}

/**
 * 弹系统对话框让她挑一个**工作区目录**。
 *
 * 用系统的目录选择器而不是让用户手敲路径：手敲容易打错，
 * 而且打错的后果是"文件功能静默不可用"（路径不存在 → workspaceRoot() 返回 null），
 * 那种失败很难查。
 */
export async function pickDirectory(win: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: '选一个目录给她读写',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
}
