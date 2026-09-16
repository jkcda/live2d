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

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron 44 | 透明无边框 + 置顶 + 点击穿透 |
| 前端 | Vue 3 + TypeScript + Vite 8 | |
| 渲染 | PixiJS 8 + `untitled-pixi-live2d-engine` | 支持 Cubism 2–5，内置 lip-sync 与并行动作混合 |
| 构建 | vite-plugin-electron | 主进程 / preload / 渲染进程统一构建 |
| 推理服务 | Python（独立进程，待建） | CosyVoice 2 (TTS) + SenseVoice (ASR) + Silero VAD |

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
│   │   ├── Live2DStage.vue      # Live2D 舞台 + 每帧参数合成
│   │   ├── ChatPanel.vue        # 对话界面（流式显示 + 打断）
│   │   └── SettingsPanel.vue    # LLM / 语音服务配置 + 连接测试
│   ├── core/
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
│   ├── lib/                     # Cubism Core 运行时（不入库）
│   └── models/                  # Live2D 模型（不入库，见下）
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
│   └── voices/                  # 克隆音色的参考音频（不入库）
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

下载后解压到 `public/models/<名字>/` 即可，**通常不用改代码** —— `src/core/live2d/models.ts` 会自动按常见命名探测（Haru / Hiyori / Kei / Mao / Natori / Rice / Wanko / Shizuku / Mark / MIO）。命名不常见时，在 `Live2DStage.vue` 顶部把 `EXPLICIT_MODEL` 填成相对路径，例如 `'Haru/Haru.model3.json'`。

| 模型 | 说明 |
|---|---|
| **Hiyori Momose** | 最经典的标准模型，参数齐全，**首选** |
| **Kei** | 官方为演示 motion-sync 而做，**专为真实口型同步设计** |
| **Haru** | 标准模型，结构简单，适合先跑通 |
| **Shizuku** | Shizuku Talk 同款 |

**必须确认模型带 `ParamMouthOpenY` 参数** —— 这是口型驱动的落点，没有它整条口型链路无处可去。

**许可**：这些模型可免费下载用于学习与开发，但各有条款（商用限制等），下载前请阅读官网说明。因此 `public/models/` 不入库。

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
- [ ] 切到 CosyVoice 2 真实 TTS
- [ ] 启用 SenseVoice ASR（`NEXUS_ASR_ENGINE=sensevoice`）

> **现在就能验证的完整链路**：起 `python -m service.main`（默认 tone 引擎，不需要 GPU 和模型），
> 再起 `pnpm dev:web`，填个 API key，打开麦克风 —— 说话时她会立刻闭嘴（barge-in），
> 出文字后她会回答并且口型跟着动。
> 只差 ASR 那一步需要装 SenseVoice 才能真正听懂你说了什么。

## 后续阶段

- **二阶段**：记忆系统（jsonl 转录 + md 提炼 + 向量索引）、身份文件、MCP 工具调用
- **三阶段**：视频生成动作资产、实时数字人特写、插件系统
