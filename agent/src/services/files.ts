/**
 * 文件读写 —— 她能看的、能写的东西。
 *
 * ## 为什么这个文件里大半是「拒绝」逻辑
 *
 * 给她文件访问权，等于把「她能碰到你硬盘上什么」这件事交出去了。
 * 这个项目对「看屏幕」已经做得很细（黑名单 / 暂停开关 / 多显示器 fail-closed），
 * 文件是**同一量级**的隐私能力 —— 甚至更敏感：
 * 屏幕是「此刻这一眼」，文件是「你硬盘上躺着的一切」。
 *
 * 所以这个模块的写法是**默认拒绝**：
 *   · 没设工作区 → 整个能力关闭（不是"默认全盘可读"）
 *   · 工作区外 → 拒绝
 *   · 命中黑名单 → 拒绝（即使在工作区内）
 *   · 符号链接指向外面 → 拒绝（否则工作区形同虚设）
 *   · 已存在的文件 → **不覆盖**（见 writeNewFile 的注释）
 *
 * ## 工作区怎么设
 *
 *     AGENT_WORKSPACE=D:\我的文档\给她看的东西
 *
 * **不设 = 关闭**。这是个 opt-in 的能力，不是默认开的。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, WORKSPACE } from '../config.js'

/** 单次读多少字节。超了就截断并说明 —— 整个文件塞进上下文会把请求撑爆。 */
const MAX_READ_BYTES = 200 * 1024

/** 一次最多列多少条 */
const MAX_LIST_ENTRIES = 300

/**
 * 硬拒绝的名字/后缀。**即使在工作区内也拒绝。**
 *
 * 判据是「这里面可能躺着凭据」—— 不是「我觉着危险」。
 * 一份 PDF 再大也无所谓，一个 `.env` 再小也不能给。
 */
const BLOCKED_NAMES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'login data',
  'cookies',
  'local state',
  'keychain',
])

/** 后缀命中就拒绝 */
const BLOCKED_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.jks', '.keystore'])

/** 路径里出现这些片段就拒绝（`.git/config` 里可能有 token） */
const BLOCKED_SEGMENTS = [path.join('.git', 'config'), '.env']

export class FileAccessError extends Error {}

/**
 * 工作区的落盘位置。
 *
 * 放在 agent 自己的数据目录里（`data/`，已 gitignore）而不是项目根 ——
 * 这是**这台机器上的运行期设置**，不是要跟着仓库走的东西。
 */
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json')

/*
 * ★ 为什么不是直接读环境变量
 *
 * 原来是 `WORKSPACE` 常量（来自 `AGENT_WORKSPACE`）—— 那意味着改工作区要**改 env + 重启服务**，
 * 而设置面板要能当场改。环境变量改不了。
 *
 * 所以：环境变量只作为**初始值**，之后由 `setWorkspace()` 改，落盘到 data/workspace.json。
 * 优先级：落盘的值 > 环境变量 > 关闭。
 */
let current: string | null = null
let loaded = false

function loadOnce(): void {
  if (loaded) return
  loaded = true

  // 落盘的值优先（用户从设置面板选的）
  try {
    const raw = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8')) as { path?: unknown }
    if (typeof raw.path === 'string' && raw.path) {
      current = raw.path
      return
    }
  } catch {
    /* 没这个文件 / 读坏了，退回环境变量 */
  }
  current = WORKSPACE || null
}

/**
 * 设置工作区。传空字符串 = 关掉。
 *
 * ★ 这里**不校验路径存不存在** —— 存了之后目录被删掉是很正常的事，
 *   那时候应该表现为"读不了"，而不是"设置莫名其妙丢了"。
 *   真正的校验在 workspaceRoot() 里，每次用的时候做。
 */
export function setWorkspace(dir: string): void {
  loaded = true
  current = dir.trim() || null
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify({ path: current }, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[files] 工作区落盘失败（这次设置只在内存里生效）', err)
  }
}

/** 工作区设了吗。没设的话整个文件能力是关的。 */
export function workspaceRoot(): string | null {
  loadOnce()
  if (!current) return null
  try {
    // realpath 而不是 resolve —— 工作区本身也可能是个符号链接，
    // 不归一化的话后面所有前缀比较都会错。
    const real = fs.realpathSync(current)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function isBlocked(abs: string): boolean {
  const lower = abs.toLowerCase()
  const name = path.basename(lower)

  if (BLOCKED_NAMES.has(name)) return true
  if (BLOCKED_EXT.has(path.extname(lower))) return true
  if (lower.startsWith('.env') || name.startsWith('.env.')) return true
  for (const seg of BLOCKED_SEGMENTS) {
    if (lower.includes(path.sep + seg.toLowerCase())) return true
  }
  return false
}

/**
 * 把一个（可能是相对的）路径解析成工作区内的绝对路径。
 *
 * ★ 必须走 realpath
 *
 * 只用 `path.resolve` 的话，工作区里一个指向 `C:\Users\你\.ssh` 的符号链接
 * 就能绕出去 —— 前缀检查看着是对的，实际读的是工作区外的文件。
 * **先 realpath 再比较前缀**，顺序不能反。
 *
 * 文件还不存在时（写新文件）realpath 会抛，这时退回 resolve 父目录。
 */
function resolveInside(input: string): string {
  const root = workspaceRoot()
  if (!root) {
    throw new FileAccessError(
      '文件功能没开。让用户在设置里选一个工作区目录，或者设环境变量 AGENT_WORKSPACE。',
    )
  }

  const abs = path.resolve(root, input)

  /*
   * 把 abs 归一化成真实路径（解掉符号链接），再拿它跟 root 比前缀。
   *
   * ★ 顺序不能反：先比较再 realpath 的话，工作区里一个指向
   *   `C:\Users\你\.ssh` 的符号链接就能绕出去 —— 前缀检查看着是对的，
   *   实际读的是工作区外的文件。
   *
   * ★ 目标可能还不存在（写新文件），所以**往上找第一个存在的祖先**再 realpath。
   *   直接 realpath 目标会抛 ENOENT，然后如果拿"父目录"当退路，
   *   就会把一个符号链接当成普通文件名放过去 —— 那等于绕过了检查。
   *   （第一版就是这么写的，测试里「符号链接逃逸」那项被 ENOENT 挡下来了：
   *     看着是通过了，其实是因为错误的原因通过，安全属性根本没验证。）
   */
  const tail: string[] = []
  let cur = abs
  let real: string | null = null
  for (;;) {
    try {
      const realCur = fs.realpathSync(cur)
      real = tail.length ? path.join(realCur, ...tail.slice().reverse()) : realCur
      break
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) break // 到盘符根了还没找到，说明路径本身有问题
      tail.push(path.basename(cur))
      cur = parent
    }
  }

  if (real === null) throw new FileAccessError(`路径解析不了：${input}`)

  // 前缀比较要带分隔符，否则 C:\foo 会"包含" C:\foobar
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new FileAccessError(`只能访问工作区内的文件。工作区是：${root}`)
  }
  if (isBlocked(real)) {
    throw new FileAccessError('这个路径被隐私规则挡住了（可能含凭据）。换一个。')
  }
  return real
}

/*
 * ⚠️ 符号链接逃逸这条路**没能在开发机上验证**。
 *
 * Windows 上创建真符号链接需要开发者模式或管理员权限。普通权限下
 * `fs.symlinkSync()` **会报告成功，但建出来的是个坏链接**（紧接着
 * `lstatSync` 就 ENOENT）—— 于是测试里那些"符号链接逃逸"用例
 * 其实是在跟坏链接较劲，**看起来通过了，安全属性根本没被验证**。
 *
 * 上面的 realpath + 前缀检查在逻辑上是对的（先归一化再比较，顺序不能反），
 * 但**这条路径需要在一个能建真链接的环境里复测一遍**：
 *
 *     mklink /D 工作区\链接 C:\Users\你\.ssh      # 管理员 cmd
 *
 * 然后确认读 `链接/id_rsa` 被拒。
 */

/** 工作区内的相对路径，给模型看的（绝对路径对它没意义，还泄露用户名） */
function rel(abs: string): string {
  const root = workspaceRoot()!
  return path.relative(root, abs) || '.'
}

export function listDir(input = '.'): string {
  const dir = resolveInside(input)
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  const rows: string[] = []
  let skipped = 0
  for (const e of entries) {
    if (rows.length >= MAX_LIST_ENTRIES) {
      skipped++
      continue
    }
    if (isBlocked(path.join(dir, e.name))) {
      rows.push(`  ${e.name}  [被隐私规则挡住]`)
      continue
    }
    if (e.isDirectory()) {
      rows.push(`  ${e.name}/`)
      continue
    }
    let size = 0
    try {
      size = fs.statSync(path.join(dir, e.name)).size
    } catch {
      /* 读不到就算了 */
    }
    rows.push(`  ${e.name}  (${formatSize(size)})`)
  }

  if (!rows.length) return `${rel(dir)} 是空的。`
  const tail = skipped ? `\n（还有 ${skipped} 项没列出来，太多了）` : ''
  return `${rel(dir)} 下有 ${rows.length} 项：\n${rows.join('\n')}${tail}`
}

export function readTextFile(input: string): string {
  const abs = resolveInside(input)
  const st = fs.statSync(abs)
  if (st.isDirectory()) {
    throw new FileAccessError(`${input} 是个目录，不是文件。用 list_dir 看里面有什么。`)
  }

  const buf = fs.readFileSync(abs)
  const truncated = buf.length > MAX_READ_BYTES
  const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf

  // 二进制文件读出来是乱码，不如直接说清楚
  if (slice.includes(0)) {
    throw new FileAccessError(
      `${input} 像是二进制文件（${formatSize(st.size)}），读不出文字。图片要用别的方式给她看。`,
    )
  }

  const text = slice.toString('utf-8')
  return truncated
    ? `${rel(abs)}（只读了前 ${formatSize(MAX_READ_BYTES)}，原文件 ${formatSize(st.size)}）：\n\n${text}`
    : `${rel(abs)}：\n\n${text}`
}

/**
 * 写一个新文件。
 *
 * ★ **已存在的文件一律拒绝，不覆盖。**
 *
 * 这是个刻意的取舍。让她能覆盖 = 她可能毁掉你写了三小时的东西，
 * 而「她以为自己在帮忙」这件事**不构成免责**。
 *
 * 想改已有文件？让她先读、把新内容给你看、你自己决定 —— 或者她换个文件名写。
 *
 * 这样也省掉了「每次写都要弹确认」那套协议：**新建是安全的，覆盖才危险**，
 * 那把危险的直接禁掉就行了，不用打扰用户。
 */
export function writeNewFile(input: string, content: string): string {
  const abs = resolveInside(input)

  if (fs.existsSync(abs)) {
    throw new FileAccessError(
      `${rel(abs)} 已经存在了，不能覆盖。换个文件名，或者先让用户处理掉原来的。`,
    )
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
  return `写好了：${rel(abs)}（${formatSize(Buffer.byteLength(content, 'utf-8'))}）`
}

/** 工作区当前状态，给提示词和设置面板用 */
export function workspaceStatus(): { enabled: boolean; root: string | null } {
  const root = workspaceRoot()
  return { enabled: root !== null, root }
}

/** 设置面板要显示的：路径 + 是不是真的可用（目录可能被删了） */
export function workspaceDetail(): { enabled: boolean; path: string | null; error?: string } {
  loadOnce()
  if (!current) return { enabled: false, path: null }
  const root = workspaceRoot()
  if (!root) return { enabled: false, path: current, error: '这个目录现在打不开（被删了？）' }
  return { enabled: true, path: root }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
