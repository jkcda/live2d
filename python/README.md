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

### `WS /stream` —— 实时输入通道

**为什么 TTS 不在这条通道上**：TTS 是「一句一个离散请求」，HTTP POST 更简单，
而且前端已经接好了。这条通道只承载**必须流式**的东西 —— 麦克风音频。

上行：

```
<binary>                      原始 PCM，int16 小端，16kHz 单声道，每块 512 采样
{"type":"interrupt"}          用户插话：重置 VAD、丢弃正在累积的语音
```

下行：

```json
{"type":"ready", "sample_rate":16000, "frame_samples":512,
 "vad":"energy", "vad_ready":true, "vad_detail":"...",
 "asr":null, "asr_ready":false, "asr_detail":"未启用"}

{"type":"vad", "state":"speech"|"silence", "probability":0.83}
{"type":"asr_start"}                              // 语音结束，开始识别
{"type":"asr", "text":"你好呀", "final":true}
{"type":"error", "message":"..."}
```

**帧格式必须严格对齐**：512 采样 / 16kHz / 32ms。
前端 `src/core/audio/mic.ts` 的 `FRAME_SAMPLES` 和服务端 `vad/base.py` 里写的是同一个数，
改动必须两边同步 —— 不一致的话 VAD 会持续读到错位的帧，表现为「怎么都不触发」。

**并发模型**（见 `stream.py` 顶部注释）：
- 收包循环只做「拆帧 + 喂 VAD」，**不做 ASR**。ASR 要几百毫秒，
  放在收包循环里的话，用户在这期间开口会被丢掉。
- ASR 丢到独立 task，结果走 outbox 队列。
- 发送统一走单独的 sender task —— Starlette 的 `WebSocket.send` 不是并发安全的，
  多个 task 直接 send 会串帧。

---

## VAD

| 引擎 | 依赖 | 说明 |
|---|---|---|
| **`energy`**（默认） | 无 | 能量法。自适应噪声底 + 迟滞判定，开箱即用 |
| **`silero`** | onnxruntime + 2MB 模型 | 有背景噪音时明显更准 |

**参数偏向敏感一侧**。误触发（把噪音当人声）的代价是 TTS 被掐断一次，可以接受；
漏触发（没听到用户开口）的代价是用户要等 TTS 说完才能插话，体验很差。

实测打断延迟：**约 96ms**（3 帧确认 × 32ms），远低于 200ms 的预算。

配了 `NEXUS_VAD_ENGINE=silero` 但依赖不全时**自动退回 energy**，不让服务起不来。

---

## ASR

| 引擎 | 依赖 | 说明 |
|---|---|---|
| `none`（默认） | 无 | 不启用 |
| `sensevoice` | `pip install -e ".[asr]"` | FunASR SenseVoice-Small，权重约 950MB，**CPU 可实时** |

**依赖不只是 funasr**：funasr 自己不声明 torch，而且特征提取还需要一个 fbank
后端（torchaudio 或 kaldi-native-fbank）。缺了这两样，模型权重照样能加载，
但要等到**第一句话**才炸在 fbank 上 —— 所以 `availability()` 会一并检查，
`/health` 的 `asr.detail` 会直接告诉你还缺什么。

首次运行从 ModelScope 下载权重到 `~/.cache/modelscope`。实测（i7-12650H，CPU）：

| 环节 | 耗时 |
|---|---|
| 加载权重（已缓存） | 3.7s |
| 首句权重下载（一次性） | ~107s |
| 识别 1.2s 音频 | 0.25s |

**ASR 不可用是合法状态，不是错误。** 没有它，VAD 和打断依然工作，
只是用户说的话进不了 LLM。所以 `/health` 会如实报告 `asr_ready: false`，
`WS /stream` 的 `ready` 事件里也会带上 `asr_detail`。

GPU 要留给 TTS，所以 ASR 默认跑 CPU（`NEXUS_ASR_DEVICE` 可改）。

---

## 引擎

| 引擎 | 依赖 | 用途 |
|---|---|---|
| **`tone`**（默认） | 无（只要 numpy） | **开发用**。按文本生成带音节节奏的类人声波形，用来验证整条链路 |
| **`sapi`** | `pip install -e ".[sapi]"`（仅 Windows） | **过渡用的真语音**。零模型下载，系统音色，语气平淡 |
| **`cosyvoice`** | torch + 模型权重 | 正式音色，支持零样本克隆与情感指令 |

### 为什么要有 `sapi`

真语音和「像不像在说话」是两件事。`tone` 的嗡嗡声能验证「有没有声音」，
但验证不了韵律、停顿、以及口型跟真实语音对不对得上 —— 那些得有声调、有辅音的声音才看得出来。

SAPI 的定位就是**在 CosyVoice 装好之前先把这条链路用真语音跑通**：

| | 实测 |
|---|---|
| 整句合成耗时 | 1.53s 音频 → **0.033s**（RTF 0.02） |
| 输出格式 | 22.05kHz / 16-bit / 单声道（**实际格式从产出文件读回上报**，不假设） |
| 中文音色 | 自动优先挑 `zh-CN`，不挑的话系统默认可能是英文音色，念中文会静默跳过 |

写文件流不受实时播放节流，所以它比实时快几十倍 —— 短板不是延迟，是**只有 Windows、音色一般、不能克隆**。

**一个坑**：`voice` 传 `default` 时，系统默认音色很可能是英文的（比如 Zira）。
拿它念中文不会报错，只是**不出声** —— 看起来像引擎坏了。所以 `_pick_voice()` 会先找 `zh-CN`。

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

想马上听到真语音（Windows，不用下任何模型）：

```bash
pip install -e ".[sapi]"
NEXUS_TTS_ENGINE=sapi python -m service.main
# 前端「设置 → 语音服务 → 试听」即可，不需要配 LLM key
```

装正式音色：

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
| `NEXUS_TTS_ENGINE` | `tone` | `tone` / `sapi`（Windows）/ `cosyvoice` |
| `NEXUS_TTS_VOICE` | `default` | 默认音色 |
| `NEXUS_SAMPLE_RATE` | `24000` | TTS 输出采样率 |
| `NEXUS_VAD_ENGINE` | `energy` | `energy` / `silero` |
| `NEXUS_ASR_ENGINE` | `none` | `none` / `sensevoice` |
| `NEXUS_ASR_DEVICE` | `cpu` | `cpu` / `cuda:0` |
| `NEXUS_COSYVOICE_DIR` | 空 | 模型目录，留空则找 `pretrained_models/CosyVoice2-0.5B` |
| `NEXUS_COSYVOICE_WARMUP` | `0` | 设 `1` 则启动时预加载模型（慢启动，但首次请求快） |
| `NEXUS_SILERO_MODEL` | 空 | silero_vad.onnx 路径，留空则找 `python/models/` |
| `NEXUS_CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔 |

---

## 克隆音色

见 [`voices/README.md`](voices/README.md)。简单说：在 `voices/` 放一对同名文件
（`mio.wav` + `mio.txt`），然后把应用的「音色」填成 `mio`。
