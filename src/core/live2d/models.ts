/**
 * 模型发现。
 *
 * 项目不内置任何 Live2D 模型（示例模型受 Live2D 授权条款限制，不能随仓库分发），
 * 需要使用者自行下载后放进 `public/models/<名字>/`。
 *
 * 为了免去「每次都要改代码」的麻烦，这里按一组常见命名去探测，
 * 命中第一个能加载的就用。全部落空时给出明确的放置指引。
 */

/** 官方示例模型的常见目录/文件名组合（Cubism 3/4/5） */
const CANDIDATES = [
  'Haru/Haru.model3.json',
  'haru/haru_greeter_t03.model3.json',
  'Hiyori/Hiyori.model3.json',
  'Kei/Kei.model3.json',
  'Mao/Mao.model3.json',
  'Natori/Natori.model3.json',
  'Rice/Rice.model3.json',
  'Wanko/Wanko.model3.json',
  'Shizuku/Shizuku.model3.json',
  'Mark/Mark.model3.json',
  'MIO/MIO.model3.json',
  'mio/MIO.model3.json',
]

/** 探测单个 URL 是否可访问 */
async function probe(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * 找到第一个可用的模型 URL。
 *
 * @param explicit 显式指定的路径（相对于 public/models/），给了就只用它
 */
export async function resolveModelUrl(explicit?: string): Promise<string> {
  const base = `${import.meta.env.BASE_URL}models/`

  if (explicit) {
    const url = base + explicit.replace(/^\/+/, '')
    if (await probe(url)) return url
    throw new Error(`指定的模型不存在：${url}`)
  }

  for (const rel of CANDIDATES) {
    const url = base + rel
    if (await probe(url)) return url
  }

  throw new Error(
    `在 public/models/ 下没有找到任何模型。\n` +
      `请下载一个模型（Cubism 3/4/5 格式，含 .model3.json）解压到 public/models/<名字>/，\n` +
      `例如 public/models/Haru/Haru.model3.json。\n` +
      `下载地址：https://www.live2d.com/en/learn/sample/`,
  )
}
