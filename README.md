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
│   ├── App.vue                  # 根组件
│   ├── components/
│   │   └── Live2DStage.vue      # Live2D 舞台 + 每帧参数合成
│   ├── core/
│   │   ├── audio/
│   │   │   └── player.ts        # 音频播放 + 振幅提取 + 打断
│   │   ├── live2d/
│   │   │   ├── engine.ts        # 渲染引擎适配层（隔离第三方 API）
│   │   │   ├── lipsync.ts       # 振幅 → 口型参数
│   │   │   └── idle.ts          # 程序化待机动画
│   │   └── agent/               # Agent 层（待建）
│   └── styles/
├── public/models/               # Live2D 模型（不入库，见下）
├── python/                      # 推理服务（待建）
└── docs/
```

---

## 快速开始

```bash
pnpm install

# 准备一个 Live2D 模型放到 public/models/ 下（见下一节）
# 然后在 src/components/Live2DStage.vue 里改 MODEL_PATH

pnpm dev
```

### 模型资源

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

Cubism 官方有免费示例模型（Haru / Hiyori / Mao 等）可用于开发测试，去 Live2D 官网下载后解压到 `public/models/`。

**注意**：模型要支持口型参数 `ParamMouthOpenY`。选模型或自制模型时确认这一点，否则口型驱动无处落地。

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
- [ ] Live2D 模型加载与渲染
- [ ] 接 LLM（流式输出）
- [ ] 人设系统提示词
- [ ] 接 CosyVoice 2 流式 TTS
- [ ] VAD 触发 ASR
- [ ] 打断闭环验证

## 后续阶段

- **二阶段**：记忆系统（jsonl 转录 + md 提炼 + 向量索引）、身份文件、MCP 工具调用
- **三阶段**：视频生成动作资产、实时数字人特写、插件系统
