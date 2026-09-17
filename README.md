# Nexus Live2D

AI 桌面伴侣。Live2D 角色常驻桌面，能听、能说、能记住你，并且能调用工具替你干活。

当前处于 **第一阶段（交互闭环）**，目标是把「说话 → 回应 → 出声 → 对口型 → 可打断」这条链路跑通。

---

## 核心设计决策

这几条决定了整个技术走向，改动前先读。

### 1. 口型只吃音频流，不吃文本

Live2D 的 `ParamMouthOpenY` 由 TTS 输出音频的**实时振幅包络**驱动，不是按文本长度或音节数估算。
只有读真实波形，口型才能对上停顿、拖长音和语气词。数据流是：

```
TTS 音频块 → AudioContext AnalyserNode → RMS 振幅 → 指数平滑 → ParamMouthOpenY
```

张嘴快（45ms 时间常数）、闭嘴慢（110ms），这是自然口型的关键。

### 2. Live2D 是主干，视频生成是素材工厂

| 层 | 驱动方式 | 能否预生成 |
|---|---|---|
| 口型 | 音频流实时驱动 Live2D 参数 | 否 |
| 身体动作 / 表情 | Live2D 参数动画播放 | 是 |
| 特殊演出 / 过场 | 视频片段播放 | 是（需接受硬切） |

**为什么不直接播视频动作片段**：片段之间无法平滑过渡（播完怎么回待机？），且视频里的口型是固定的，她一说活就得切回 Live2D —— 每句话切两次，体验会碎。

视频生成的正确定位是**生产 Live2D 动作资产**：

```
视频生成角色动作 → 姿态/表情关键点提取 → 映射为 Live2D 参数曲线 → 可混合播放的动作
```

这条路同时拿到视频的动作质量和 Live2D 的可混合、可打断、低延迟。

### 3. 打断（barge-in）是硬需求

用户一开口，必须立刻掐断 TTS 播放 + 清空音频队列 + 口型归零。
没有这个，交互从「陪伴」退化成「等它说完」。

### 4. 待机动作靠代码生成，不靠素材

呼吸、眨眼、视线游移、头部微摆由 `IdleAnimator` 程序化生成。
它们连续、随机、永远在跑 —— 从视频提取反而僵硬。

> **必须显式关掉引擎自带的同款效果**，否则它们会和 `IdleAnimator` 抢同一批参数、
> 而且幅度大得多。见 `src/core/live2d/engine.ts` 里 `Model.from()` 的选项：
>
> - **自动播放 Idle 动作组** → 模型作者放进 Idle 组的往往是一整段演出。
>   miara 的 Idle 组是 `Scene1/2/3`，曲线里带 `ParamMoveX` / `ParamAllX` / 双腿双臂，
>   结果角色会**一直原地走来走去**，还会盖掉口型。指到一个不存在的组名即可关掉，
>   显式 `playMotion()` 不受影响。
> - **`autoFocus` 焦点跟随** → 指针一动就把头转到 `ParamAngleX ±30°`
> - **`eyeBlink` / `breathDepth`** → 和 IdleAnimator 的眨眼呼吸重复，且 `breathDepth=1`
>   会叠加 ±15° 的全身摆动
>
> 关掉后待机时只有 7 个参数在动（实测），全部落在 IdleAnimator 的设计范围内。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron 44 | 透明无边框 + 置顶 + 点击穿透 |
| 前端 | Vue 3 + TypeScript + Vite 8 | |
| 渲染 | PixiJS 8 + `untitled-pixi-live2d-engine` | 支持 Cubism 2–5，内置 lip-sync 与并行动作混合 |
| 构建 | vite-plugin-electron | 主进程 / preload / 渲染进程统一构建 |
| 推理服务 | Python（独立进程：FastAPI + WebSocket） | CosyVoice 2 (TTS) + SAPI (Windows 过渡 TTS) + SenseVoice (ASR) + Silero VAD |

**为什么推理层用 Python 而不是 TS**：TTS / ASR / VAD 的生态在 Python，没有替代品。
但它被隔离成独立进程，通过 HTTP + WebSocket 通信，不影响前端技术栈。

**为什么不用 Rust**：性能瓶颈在模型推理和音频延迟，不在壳。用 Tauri 换 Electron 是后期优化，不是起点。

---

## 目录结构

```
live2d/
├── electron/
│   ├── main.ts                  # 窗口：透明/置顶/点击穿透/全局快捷键
│   └── preload.ts               # 暴露给渲染进程的桥接口
├── src/
│   ├── App.vue                  # 根组件：舞台 + 控制条 + 面板挂载
│   ├── components/
│   │   ├── CharacterStage.vue   # 角色舞台（选渲染器 + 每帧参数合成 + 悬浮/点击）
│   │   ├── ChatPanel.vue        # 对话界面（流式显示 + 打断）
│   │   └── SettingsPanel.vue    # LLM / 语音服务 / 角色渲染方式
│   ├── core/
│   │   ├── agent/               # 对话编排（会话 / 人设 / LLM 客户端 / agent 服务客户端）
│   │   │   ├── session.ts       # 历史 + 切句 + 打断；优先走 agent 服务，不行退回直连
│   │   │   ├── agentClient.ts   # agent 服务（8766）的 SSE 客户端
│   │   │   ├── llm.ts           # 直连 OpenAI 兼容接口（降级路径）+ 按标点切句
│   │   │   └── persona.ts       # 人设提示词
│   │   ├── character/           # 角色：角色包 / 能力探测 / 两个渲染器的共同接口
│   │   │   ├── types.ts         # CharacterStage / CharacterFrame：两个渲染器的共同接口
│   │   │   ├── packs.ts         # 角色包：清单、素材探测、能力表、按角色调参
│   │   │   ├── selection.ts     # 当前角色 + 订阅（热插拔的触发源）
│   │   │   ├── live2d.ts        # Live2D 渲染器 → 接口适配（口型落点、点击反应）
│   │   │   └── mode.ts          # 记住上次用的渲染类型（兜底角色用）
│   │   ├── portrait/            # 立绘（PNGTuber）渲染器
│   │   │   ├── assets.ts        # 素材加载与校验（缺哪张就降级）
│   │   │   ├── expressions.ts   # 表情差分的名字表（id / 中文名 / 情绪 / 别名）
│   │   │   ├── poses.ts         # 姿势差分的名字表（招手…）
│   │   │   └── stage.ts         # 图层合成 + 参数语义解释 + 轮廓命中
│   │   ├── runtime.ts           # 全局单例（播放器 / 语音输出 / 会话）
│   │   ├── settings.ts          # 配置读写（localStorage）
│   │   ├── audio/
│   │   │   ├── player.ts        # 音频播放 + 振幅提取 + 可等待播放
│   │   │   ├── tts.ts           # 语音输出队列（合成并行 / 播放串行）
│   │   │   ├── mic.ts           # 麦克风采集 → 16kHz int16 / 512 采样帧
│   │   │   └── stream.ts        # WS 客户端（VAD/ASR 事件，barge-in 触发源）
│   │   ├── live2d/
│   │   │   ├── engine.ts        # 渲染引擎适配层（隔离第三方 API）
│   │   │   ├── cubism.ts        # Cubism Core 运行时加载
│   │   │   ├── models.ts        # 模型自动探测
│   │   │   ├── lipsync.ts       # 振幅 → 口型参数
│   │   │   └── idle.ts          # 程序化待机动画
│   │   └── agent/
│   │       ├── types.ts         # AgentEvent / ChatMessage / LLMConfig
│   │       ├── llm.ts           # SSE 流式客户端 + 按标点切句
│   │       ├── persona.ts       # 人设 → system prompt
│   │       └── session.ts       # 对话编排（历史裁剪 / 逐句回调 / 打断）
│   └── styles/
├── public/
│   ├── characters/              # 角色清单（入库）：index.json = id/名字/类型/素材目录
│   ├── lib/                     # Cubism Core 运行时（不入库）
│   └── models/                  # Live2D 模型（不入库，见下）
├── vendor/                      # 本地素材仓：SDK 原始包 / 模型压缩包 / Cubism 工程文件（不入库）
├── python/                      # 推理服务（TTS / VAD / ASR）
│   ├── service/
│   │   ├── main.py              # FastAPI 路由（HTTP + WS）
│   │   ├── stream.py            # WS /stream 会话：音频 → VAD → ASR
│   │   ├── audio.py             # WAV 编解码
│   │   ├── tts/
│   │   │   ├── base.py          # 引擎接口
│   │   │   ├── tone.py          # 内置合成音（零依赖，开发用）
│   │   │   └── cosyvoice.py     # CosyVoice 2（懒加载 + 音色克隆）
│   │   ├── vad/
│   │   │   ├── base.py          # 帧格式约定（512 采样 / 16kHz）
│   │   │   ├── energy.py        # 能量法（零依赖，默认）
│   │   │   └── silero.py        # Silero（可选，噪音环境更准）
│   │   └── asr/
│   │       ├── base.py
│   │       └── sensevoice.py    # FunASR SenseVoice-Small（可选）
│   ├── tools/                   # 立绘素材工具（抠背景 / 做差分）
│   └── voices/                  # 克隆音色的参考音频（不入库）
├── tools/                       # 仓库工具脚本（立绘自动验证等）
└── docs/
```

---

## 快速开始

```bash
pnpm install

# 1. 放入 Cubism Core 运行时（必需，见下）
# 2. 放入一个 Live2D 模型（必需，见下）

pnpm dev        # Electron 桌面窗口
pnpm dev:web    # 纯浏览器调试（不加载 Electron，UI 改动看这个更快）
```

> **浏览器里访问 `http://localhost:5176`** —— 不是 Vite 默认的 5173。
> 端口在 `vite.config.ts` 的 `server.port` 里，刻意避开默认值以免和别的项目撞。

> **`pnpm dev` 报 "Electron failed to install correctly"？**
> `pnpm install` 时 Electron 的二进制需要从 GitHub Releases 单独下载，网络不稳就会失败。
> 补装：`pnpm rebuild electron`（或 `node node_modules/electron/install.js`）。
> 在那之前可以先用 `pnpm dev:web` 在浏览器里开发，功能基本一致（只少了窗口透明/置顶/穿透）。

### 第一步：Cubism Core 运行时（必需）

Cubism 3/4/5 模型依赖一个外部运行时 `live2dcubismcore.min.js`，它**不随 npm 包分发**，必须自己获取。

1. 打开 <https://www.live2d.com/download/cubism-sdk/download-web/>，下载 **Cubism SDK for Web**
2. 从解压后的 `Core/` 目录里取出 `live2dcubismcore.min.js`
3. 放到本项目的 `public/lib/` 下

```
public/lib/
└── live2dcubismcore.min.js
```

> **为什么不从 npm 装**：社区里存在若干第三方再分发包，但它们的来源和授权状态都无法确认（有的甚至给 Live2D 的专有二进制标了宽松开源协议）。这个文件受 Live2D SDK 授权条款约束，请走官方渠道，使用即表示接受其条款。

缺这个文件时不会白屏 —— 控制台会给出明确提示和下载地址。

> **⚠️ Core 6 与渲染引擎不兼容，我们踩了两个坑**
>
> SDK for Web `5-r.5` 带的是 **Cubism Core 6.0.1**，而引擎
> `untitled-pixi-live2d-engine@1.3.5` 只声明支持 Cubism 2–5。实测有两处 API 断裂：
>
> | 断裂点 | 表现 | 处理位置 |
> |---|---|---|
> | `Model.renderOrders` 变成私有，公开入口改为 `getRenderOrders()` | 每帧在 `doDrawModel` 抛 `TypeError ... reading '0'`，**画布始终空白**，而界面不报错、资源全部 200 | `src/core/live2d/cubism.ts` 把新方法挂回 `drawables.renderOrders` |
> | 参数 ID → 索引的查表是错的（`getParameterIndex('ParamMouthOpenY')` 返回 **147**，模型只有 138 个参数） | `setParameterValueById` 写进越界槽位，被 `Float32Array` **静默丢弃** —— 呼吸 / 眨眼 / 视线 / **口型全都不动**；而引擎自带效果照旧在动，看上去一切正常 | `src/core/live2d/engine.ts` 自己从 Core 的 ID 表建索引，改走 `setParameterValueByIndex` |
>
> 两处都是**静默失败**，所以排查时先问这两句：
> 画布是空的 → 查第一行；角色在动但你的参数不生效 → 查第二行。
>
> **更省事的选择**：用 Cubism Core 5.x（早于 `5-r.5` 的 SDK），两处补丁都不需要。
> 继续用 Core 6 的话，这两处补丁别删。

### 第二步：模型资源

`public/models/` 目录不入库 —— Live2D 模型受官方许可约束，随仓库分发会有版权问题。

放置结构：

```
public/models/
└── <模型名>/
    ├── <模型名>.model3.json
    ├── <模型名>.moc3
    ├── <模型名>.physics3.json
    └── textures/
```

### 推荐模型

Cubism 官方提供一批免费示例模型：<https://www.live2d.com/en/learn/sample/>

下载后解压到 `public/models/<名字>/` 即可，**通常不用改代码** —— `src/core/live2d/models.ts` 会自动按常见命名探测（Haru / Hiyori / Kei / Mao / Natori / Rice / Wanko / Shizuku / Mark / MIO）。命名不常见时，在 `CharacterStage.vue` 顶部把 `EXPLICIT_MODEL` 填成相对路径，例如 `'Haru/Haru.model3.json'`；开发期也可以用 `?model=<目录>/<文件>.model3.json` 临时换，不用改代码。

| 模型 | 说明 |
|---|---|
| **Hiyori Momose** | 最经典的标准模型，参数齐全，**首选** |
| **Kei** | 官方为演示 motion-sync 而做，**专为真实口型同步设计** |
| **Haru** | 标准模型，结构简单，适合先跑通 |
| **Shizuku** | Shizuku Talk 同款 |

**必须确认模型带 `ParamMouthOpenY` 参数** —— 这是口型驱动的落点，没有它整条口型链路无处可去。

**许可**：这些模型可免费下载用于学习与开发，但各有条款（商用限制等），下载前请阅读官网说明。因此 `public/models/` 不入库。

---

## 换成自己的角色

两条路，成本差很多：

| | 立绘差分（PNGTuber） | Live2D 模型 |
|---|---|---|
| 素材 | 几张差分图（嘴 1~2 张 + 眼 1 张，可选瞳孔/头发/表情层） | 需要建模（自己做或委托） |
| 成本 | 极低 —— 从现有 PSD 导出即可 | 学习曲线陡，或委托建模师 |
| 能做到 | 张嘴说话、随机眨眼、瞳仁跟随鼠标、呼吸微摆、摸头/戳身体反应、**表情差分**、**姿势差分（招手/挥手）** | 上面全部 + 立体转头、发丝物理、复杂动作 |
| 素材放哪 | `public/portrait/` | `public/models/<名字>/` |
| 怎么切 | 设置 → 角色（或 `?portrait=1`） | 同左（或 `?live2d=1`） |

**立绘的完整素材规格见 [`docs/portrait-assets.md`](docs/portrait-assets.md)** —— 要准备哪几张图、
`portrait.json` 怎么写、差分图怎么做、素材没生效时怎么排查，都在里面。

### 角色是可以插拔的（多个角色并存，切换不用刷新）

角色清单：`public/characters/index.json`。加一个角色 = 加一条 + 把素材放进它自己的目录：

```jsonc
{
  "current": "me",
  "characters": [
    { "id": "me",   "name": "我的角色", "kind": "portrait", "dir": "portrait" },
    { "id": "haru", "name": "Haru（官方示例）", "kind": "live2d",
      "model": "Haru/Haru.model3.json" },
    // 同一个角色的另一套素材也能并存，用来对比：
    { "id": "me-alt", "name": "我的角色（备用）", "kind": "portrait", "dir": "portrait-alt",
      "tuning": { "motion": { "swayDegrees": 0.4 }, "mouth": { "minOpenScale": 0.5 } } }
  ]
}
```

设置 → 角色 里直接切，**不刷新页面**（先建新的、成功了才销毁旧的，失败会自动回退，
正在说话也不会被打断）。`tuning` 可以按角色覆盖待机幅度、口型映射、口型手感。

能力是**探测出来的**而不是配置里声明的：探测结果（有没有眼差分、几档嘴型、有没有瞳孔图层、
有没有表情差分、有没有头发图层）会显示在设置面板里，视线跟随/头发飘动/表情都先查这张表，
缺素材就自动退化 —— 所以换个角色不会出现"点了没反应"。

**表情**在立绘上就是一张张画好的差分（`expr_<id>.png`，id 声明情绪，见
[`docs/portrait-assets.md`](docs/portrait-assets.md) 第五节）：脸的差分常驻，
唯独里面那张嘴在说话时让位给口型（否则两张嘴会同时出现）。触发方式和 Live2D **共用一套编排**
（摸头想要开心/害羞、戳身体想要惊讶/不满），区别只在情绪从哪来 —— Live2D 从参数推，
立绘只能由文件名声明。悬浮到她身上会浮出「生气 / 伤心」按钮，点一下就能看效果。

两个配套脚本（都不需要人眼盯屏幕）：

| 脚本 | 作用 |
|---|---|
| `python/tools/prepare_portrait.py 立绘.png` | 一条命令备好底图：备份原图 → 抠背景 → 报出取景参数 |
| `python/tools/make_differential.py --base … --variant …` | 拿「AI 改过的整张图」自动做差分图：只取真正改动的像素，框外漂移自动丢弃 |
| `python/tools/extract_pupils.py` | 抠出瞳孔图层 + 把底图补成眼白（让眼睛能跟着鼠标动），带自检和对比预览图 |
| `python/tools/make_pose.py` | 把「AI 改过的整身图」做成姿态差分（招手之类）：抠底 + **把脸恢复成底图那张**，带自检（脸被改了就直接报错）；第二帧加 `--head-from 第一帧` 保证两帧的头连发丝边都一致 |
| `node tools/verify-portrait.mjs` | 自动验证：素材状态、口型换图/对位、**表情图层与说话时的遮嘴**、点击反应的选脸规则、待机漂移、**热插拔**（切角色不刷新页面） |
| `node tools/smoke-ui.mjs` | UI 烟测：控制条悬浮浮现 → 打开设置 → 读下拉内容 → 用界面真的切一次角色（走用户路径，能抓到"点开是空的"这类问题） |

两条路共用同一套交互层（悬浮浮现、点击反应、口型、待机），区别只是渲染器：
`core/portrait/stage.ts` 与 `core/live2d/engine.ts` 实现同一个 `CharacterStage` 接口
（见 `core/character/types.ts`）。所以将来从立绘升级到 Live2D，界面和手感不用重做。

> 立绘渲染层把待机/口型的**参数帧**当成语义来解释：呼吸 → 上下浮动，头部偏转 → 位移+旋转，
> 口型 → 换嘴差分（没有差分就拉伸下巴分界线以下）。参数来源（IdleAnimator + LipSyncDriver）
> 两边完全相同，所以节奏一致。

---

## 快捷方式 / 服务

四个进程，各管一段：

| 服务 | 端口 | 跑什么 | 不在时会怎样 |
|---|---|---|---|
| 应用（`pnpm dev:web` / Electron） | 5176 | 渲染 + 语音 + 界面 | —— |
| 推理服务（`python -m service.main`） | 8765 | TTS / ASR / VAD | 静默降级成"只显示文字" |
| **agent 服务**（`cd agent && pnpm dev`） | 8766 | 工具 / MCP / 记忆 / 历史压缩 | **退回直连 LLM**：还能聊天，但没有工具和记忆 |
| **CosyVoice 模型服务**（`.\tools\start-cosyvoice.ps1`） | 8788 | 她自己的音色（克隆） | 主服务报"引擎不可用"，换 edge/sapi 仍有声音 |

### 一键拉起（推荐）

```powershell
.\tools\start-all.ps1              # 全部拉起，已起的自动跳过
.\tools\start-all.ps1 -Electron    # 前端用 Electron 桌宠窗口（默认是 dev server）
.\tools\start-all.ps1 -Skip agent  # 只起前三个
.\tools\stop-all.ps1               # 停掉全部（按 PID 精确停，端口只作兜底）
.\tools\stop-all.ps1 -KeepWeb      # 只重启后端时留着前端
```

`start-all` 会**真探活**再报告（不是"进程起来了"就算成功 —— 模型加载要十几秒，
那期间端口通但接口还没好），最后打印一张真实状态表；日志在 `logs\`。

> **这台机器的一个坑**：vite 只绑 IPv6（`::1`），所以前端要用
> `http://localhost:5176/`，写 `127.0.0.1` 会连接被拒。脚本里的探活已经按这个来。

启动后设置面板/控制台可查：`GET http://127.0.0.1:8766/health`（MCP 状态、记忆条数）、
`GET /memory`（她记得什么）。详见 [`agent/README.md`](agent/README.md)。

---

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + Shift + H` | 显示 / 隐藏角色 |
| `Ctrl/Cmd + Shift + Q` | 退出 |

---

## 第一阶段清单

- [x] 项目骨架（Electron + Vue3 + Vite + TS）
- [x] 透明置顶窗口 + 点击穿透接口
- [x] 音频播放器 + 振幅提取 + 打断
- [x] 口型驱动（振幅 → 参数）
- [x] 程序化待机动画
- [x] Live2D 渲染链路（引擎注册 + Cubism Core 加载 + 模型自动探测）
- [x] 接 LLM（SSE 流式输出 + 按标点切句）
- [x] 人设系统提示词（结构化，与代码解耦）
- [x] 对话编排（历史裁剪 / 逐句回调 / 打断）
- [x] 文字对话界面（对话面板 + 设置面板 + 连接测试）
- [x] 语音输出队列（合成并行、播放串行）
- [x] Python 推理服务（`/health` `/voices` `/tts`，含零依赖的 tone 引擎）
- [x] VAD（`WS /stream` 通道 + 零依赖能量法，实测打断延迟 ~96ms）
- [x] 语音输入闭环（麦克风采集 → VAD → 打断 → ASR → 送 LLM）
- [x] Windows SAPI 过渡引擎（真语音，不用等 CosyVoice 装好）
- [ ] 切到 CosyVoice 2 真实 TTS
- [x] 启用 SenseVoice ASR（`NEXUS_ASR_ENGINE=sensevoice`）
- [x] 角色包 + 热插拔（多角色并存，切换角色不刷新页面）
- [x] 立绘（PNGTuber）渲染器：只有立绘也能用自己的角色（嘴 1~2 档 + 眨眼 + 瞳仁跟随）
- [x] 表情差分（`expr_<id>.png`）：脸常驻、说话时嘴让位给口型，点击按情绪选脸
- [x] 姿势差分（`pose_<id>.png`）：整身替换 + 交叉淡入淡出；两帧交替 = **真的在挥手**，
      她登场/你切回来（离开超过 45 秒）时招手打招呼
- [x] **agent 服务**（`agent/`，8766）：LangChain 工具循环 + MCP（Playwright 26 个工具）
      + 持久记忆（自动提取 + `remember` 工具）+ 渐进式历史压缩
- [x] agent → 界面的 `command` 通道：她说话时的情绪**真的会落到脸上**（`show_expression`）
- [x] 在线语音引擎（`edge`，真人级音色、零模型下载）；CosyVoice 2 音色克隆进行中
- [ ] CosyVoice 2 本地克隆音色（装依赖 + 下权重中）

> **现在就能验证的完整链路**：起 `python -m service.main`（默认 tone 引擎，不需要 GPU 和模型），
> 再起 `pnpm dev:web`，填个 API key，打开麦克风 —— 说话时她会立刻闭嘴（barge-in），
> 说完她会把话识别成文字送进 LLM，回答时口型跟着动。
> 装上 ASR 后这条链路才是闭环的：`pip install -e ".[asr]"` + `NEXUS_ASR_ENGINE=sensevoice`。
>
> **想先听真语音**（Windows，不用下模型、不用配 key）：
> `pip install -e ".[sapi]"` + `NEXUS_TTS_ENGINE=sapi`，
> 然后「设置 → 语音服务 → 试听」。
>
> 想不开口就验证「麦克风 → VAD → ASR」这一段，可以拿系统 TTS 合成的语音喂 `/stream`
> （Windows 上是 `System.Speech` 的 Huihui zh-CN），实测能原样识别回来。

## 后续阶段

- **二阶段**：记忆系统（jsonl 转录 + md 提炼 + 向量索引）、身份文件、MCP 工具调用
- **三阶段**：视频生成动作资产、实时数字人特写、插件系统
