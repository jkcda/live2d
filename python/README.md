# Python 推理服务

独立进程，只负责模型推理。通过 HTTP + WebSocket 与 Electron 主进程通信。

**为什么单独拆出来**：TTS / ASR / VAD 的生态在 Python，没有替代品。拆成独立进程后，
它挂了不影响 UI，也能单独重启、单独升级、单独部署到带 GPU 的机器上。

---

## 职责

| 能力 | 选型 | 显存 | 说明 |
|---|---|---|---|
| TTS | **CosyVoice 2**（0.5B） | ~4GB | 流式首包 ~150ms，Apache 2.0 可商用，支持 `<情感:开心>` 指令控语气 |
| ASR | **SenseVoice-Small**（FunASR） | 很小 | 中文强、延迟低，本地 CPU 也能跑 |
| VAD | **Silero VAD** | 无 | 常开监听，判断用户是否在说话 |

### 为什么 TTS 选 CosyVoice 2 而不是 GPT-SoVITS

GPT-SoVITS 音色相似度更高、中文生态最完善（45k star），但**首包延迟约 1s** ——
实时对话里这 1s 直接毁掉体验。CosyVoice 2 的流式首包是 150ms 量级。

如果后期觉得音色不够像，可以用 GPT-SoVITS 微调一个音色版本做 A/B 对比，
但**实时通道必须是流式的**。

---

## 接口设计（待实现）

### `WS /stream` —— 实时对话主通道

双向流。上行是麦克风音频块，下行是 TTS 音频块 + 事件。

```
上行  { type: 'audio', pcm: <binary> }
      { type: 'interrupt' }              # 用户插话，立刻掐断当前 TTS

下行  { type: 'vad', state: 'speech' | 'silence' }
      { type: 'asr', text: '...', final: boolean }
      { type: 'tts_start', id: '...' }
      { type: 'audio', pcm: <binary> }   # 边合成边推
      { type: 'tts_end', id: '...' }
```

### `POST /tts` —— 非实时合成

给主动说话、预生成语音包用。返回完整音频。

---

## 关键工程约束

1. **必须流式**。LLM 出 token → 按标点切句 → 立刻送 TTS → 边合成边播。
   等整句合成完再播，延迟直接翻三倍。

2. **打断要贯穿全链路**。前端掐播放、服务端停合成、VAD 保持监听 —— 三者缺一不可。

3. **首包延迟预算**：

   | 环节 | 目标 |
   |---|---|
   | VAD 检测 | 200ms |
   | ASR | 300ms |
   | LLM 首 token | 400ms |
   | TTS 首包 | 150ms |
   | **合计** | **< 1.5s** |

   任何一环串行阻塞都会击穿这个预算。

---

## 启动（待实现）

```bash
cd python
uv sync                     # 或用 venv + pip
python -m service.main      # 默认监听 127.0.0.1:8100
```
