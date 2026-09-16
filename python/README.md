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

## 接口

### `GET /health` —— 探活

```json
{
  "ok": true,
  "engine": "tone",
  "engine_ready": true,
  "engine_detail": "内置合成音（开发用，非真实语音）",
  "available_engines": ["tone", "cosyvoice"],
  "sample_rate": 24000
}
```

**注意 `ok` 与 `engine_ready` 是两件事**：服务活着但引擎不可用（比如 CosyVoice 没装）
依然返回 200，状态放在 body 里。前端据此区分「连不上服务」和「服务在线但引擎没就绪」。

### `GET /voices` —— 音色列表

### `POST /tts` —— 合成

```json
{ "text": "你好呀", "voice": "default", "speed": 1.0 }
```

返回 `audio/wav`（16-bit PCM 单声道），响应头带 `X-Engine` 和 `X-Sample-Rate`。

前端每凑够一句就调一次，所以这个接口会被**高频并发**调用。
引擎内部的串行化由引擎自己负责（见 `tts/cosyvoice.py` 的锁），路由层不加锁。

错误码：`400` 空文本 / `422` 参数越界 / `503` 引擎未就绪 / `500` 合成失败。

### `WS /stream` —— 实时对话主通道（待实现）

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

---

## 引擎

| 引擎 | 依赖 | 用途 |
|---|---|---|
| **`tone`**（默认） | 无（只要 numpy） | **开发用**。按文本生成带音节节奏的类人声波形，用来验证整条链路 |
| **`cosyvoice`** | torch + 模型权重 | 真实 TTS，支持零样本音色克隆 |

### 为什么默认是 tone

装 CosyVoice 要 GPU、要拉几个 G 的权重、还要编译一堆东西。
但「切句 → 合成 → 排队 → 播放 → 口型 → 打断」这条链路**跟音色好不好听无关**，
用 tone 就能完整验证。切到 cosyvoice 后前端一行都不用改。

tone 的波形不是随便糊的：它按文本估算音节数、逐音节做包络、
在标点处插停顿，RMS 落在 0.05~0.15（和真实 TTS 同量级），
所以前端 `amplitude() * 3.5` 的放大系数不用调，口型幅度就是对的。

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

## 启动

```bash
cd python

# 方式一：venv
python -m venv .venv
.venv/Scripts/activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -r requirements.txt

# 方式二：uv
uv sync

python -m service.main        # 默认监听 127.0.0.1:8765
```

装真实 TTS：

```bash
pip install -e ".[cosyvoice]"
# 再把 CosyVoice2-0.5B 权重放到 python/pretrained_models/，
# 或用 NEXUS_COSYVOICE_DIR 指定路径
NEXUS_TTS_ENGINE=cosyvoice python -m service.main
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEXUS_HOST` | `127.0.0.1` | 监听地址 |
| `NEXUS_PORT` | `8765` | 监听端口（改了要同步改前端的「服务地址」） |
| `NEXUS_TTS_ENGINE` | `tone` | `tone` / `cosyvoice` |
| `NEXUS_TTS_VOICE` | `default` | 默认音色 |
| `NEXUS_SAMPLE_RATE` | `24000` | 输出采样率 |
| `NEXUS_COSYVOICE_DIR` | 空 | 模型目录，留空则找 `pretrained_models/CosyVoice2-0.5B` |
| `NEXUS_COSYVOICE_WARMUP` | `0` | 设 `1` 则启动时预加载模型（慢启动，但首次请求快） |
| `NEXUS_CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔 |

---

## 克隆音色

见 [`voices/README.md`](voices/README.md)。简单说：在 `voices/` 放一对同名文件
（`mio.wav` + `mio.txt`），然后把应用的「音色」填成 `mio`。
