"""CosyVoice 2 的独立服务 —— 用**你自己的音色**说话。

为什么单独一个进程（而不是并进 python/service）：
    CosyVoice 要 Python 3.10 + torch 2.3.1+cu121（约 7GB 环境），
    而 `python/service` 那个环境要的是轻量 + 快速启动（TTS/ASR/VAD 一共才 1.3GB）。
    把 7GB 的 CUDA 栈塞进去会让那边每次启动都慢，而且依赖会打架。
    所以：这个进程专门跑模型（D:\\cosyvoice\\.venv），主服务通过 HTTP 调它。

跑起来（用 cosy 环境，不是项目环境）：
    D:\\cosyvoice\\.venv\\Scripts\\python.exe python\\cosyvoice_server.py
或直接用 `tools\\start-cosyvoice.ps1`。

接口（和主服务的 /tts 对齐，方便主服务做纯转发）：
    GET  /health   → 模型就绪状态、音色列表、显存
    GET  /voices   → 可用音色
    POST /tts      → {text, voice, speed} → WAV（24kHz）

音色从哪来：`python/voices/<名字>.wav` + 同名 `<名字>.txt`（那句参考音频的**文字内容**）。
没有放任何音色时，会拿 CosyVoice 自带的示例音频注册一个 `default`，
所以"还没录自己的声音"也能先把链路跑通。

★ 两个实测出来的关键点（都写进注释了）：
  1. 参考音频传给模型的是**路径**，不是波形 —— frontend 会按 16k / 24k 各读一次；
  2. 声纹**注册一次**（add_zero_shot_spk）比每次现算快得多：RTF 1.12 → 0.89。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import struct
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

# ── 先把 CosyVoice 仓库挂进 sys.path，再 import ──
COSY_ROOT = Path(os.environ.get("NEXUS_COSY_ROOT", r"D:\cosyvoice"))
sys.path.insert(0, str(COSY_ROOT))
sys.path.insert(0, str(COSY_ROOT / "third_party" / "Matcha-TTS"))
os.chdir(COSY_ROOT)  # 它的相对路径（asset/、输出目录）都按仓库根算

# wetext 的文本正则小模型默认下到 C 盘 —— 指到 D 盘（用户明确不想占系统盘）
os.environ.setdefault("MODELSCOPE_CACHE", str(COSY_ROOT / "modelscope-cache"))

# ── 让 snapshot_download 优先用本地已有的模型，绝不联网 ──
#
# ★ 为什么必须打这个补丁
#
# wetext 每次构造 Normalizer 都会调 `snapshot_download("pengzhendong/wetext")`
# （见 wetext/wetext.py），**没有 local_files_only 参数** —— 也就是说哪怕模型
# 早就在本地缓存里，它也要去 ModelScope 问一次元数据。
#
# 网络一断（或没配 token，报 "Authentication token does not exist"）这一次问就会
# 卡住/失败，然后 frontend 建不起来 —— 表现是**合成产出 0 块音频**，
# 也就是"她完全没有语音"。实测：重启服务 + 网络不通 = 直接没声音，
# 而且日志里只有一行 "Downloading Model to directory: …"，看不出跟语音有关。
#
# 本地已经有模型了就绝不该联网：命中本地目录就直接返回，不命中才走原逻辑。
def _patch_modelscope_offline_first() -> None:
    try:
        import modelscope
    except ImportError:  # 没装就直接算了（正常装了 wetext 就一定有）
        return

    cache = Path(os.environ.get("MODELSCOPE_CACHE", ""))
    original = modelscope.snapshot_download

    def offline_first(repo: str, *args, **kwargs):
        local = cache / "hub" / repo
        if local.is_dir() and any(local.iterdir()):
            # 这里 logging 还没配好（补丁在 basicConfig 之前跑），直接 print
            print(f"[wetext] 用本地缓存，不联网：{local}", flush=True)
            return str(local)
        return original(repo, *args, **kwargs)

    modelscope.snapshot_download = offline_first


# 必须在 import cosyvoice（它会 import wetext，而 wetext 是
# `from modelscope import snapshot_download` —— 在它 import 的那一刻就把函数绑走了）之前打
_patch_modelscope_offline_first()

import numpy as np  # noqa: E402
import torch  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import Response, StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s | %(message)s", datefmt="%H:%M:%S"
)
log = logging.getLogger("cosy")

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("NEXUS_COSY_MODEL_DIR", COSY_ROOT / "pretrained_models" / "CosyVoice2-0.5B"))
VOICES_DIR = Path(os.environ.get("NEXUS_VOICES_DIR", PROJECT_ROOT / "voices"))
FALLBACK_PROMPT_WAV = COSY_ROOT / "asset" / "zero_shot_prompt.wav"
FALLBACK_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"

app = FastAPI(title="CosyVoice 2 服务", version="0.1.0")

model: CosyVoice2 | None = None
sample_rate = 24000
# 模型不是线程安全的（同一份 KV cache / 解码状态），合成本身也吃满 GPU —— 串行化
_lock = threading.Lock()

#: 已注册的音色 → 参考音频路径（排查"为什么我的音色没生效"时看它）
registered: dict[str, str] = {}

# ── 流式 ──
#
# 非流式那条路能对**整段**做峰值归一化（除完乘 0.95），流式不行 ——
# 块是一块一块吐的，拿不到全段峰值。所以改成开机时标定一个固定增益。
#
# 为什么固定增益可行：同一个音色、同一套风格，模型输出的峰值是稳定的
# （见上面 tts() 里那句注释：峰值只有 0.6~0.7）。标定几句有代表性的，
# 取其中**最大的**那个峰值反推增益 —— 宁可整体略轻也不要削波，
# 削波毁的是音色，音量轻一点只是轻一点。
stream_gain = 1.0

# 流式的帧协议：4 字节小端长度 + 内容，长度 0 表示结束。
# 第一帧是 JSON 头（采样率/声道/增益），后面每帧是 s16le 的 PCM。
#
# 为什么不用 chunked WAV：WAV 头里的长度字段在流式下是假的，
# 而浏览器的 decodeAudioData **吃不了半截流** —— 客户端反正要自己解析，
# 那就用一个最省事、最好调的格式。
_STREAM_HEADER_FMT = "<I"


def stream_frame(payload: bytes) -> bytes:
    """一帧：4 字节长度 + 内容"""
    return struct.pack(_STREAM_HEADER_FMT, len(payload)) + payload


def to_pcm16(samples) -> bytes:
    """float32 [-1,1] → s16le。乘固定增益后夹紧。"""
    scaled = np.clip(np.asarray(samples, dtype=np.float32) * stream_gain, -1.0, 1.0)
    return (scaled * 32767).astype("<i2").tobytes()


def calibrate_stream_gain(voice: str) -> None:
    """标定流式用的固定增益（开机跑一次）。

    代价是启动多花几秒（两句合成）。这个代价只在启动时付一次，
    而它换来的是「流式和流式之间音量一致」—— 不标定的话只能拍一个数，
    而这个数直接决定口型幅度（口型是按振幅驱动的），拍错了嘴就不动。

    取多句里的**最大峰值**：宁可整体轻一点，也不要削波。
    """
    global stream_gain

    probes = ["嗯，我在。", "今天天气还不错，你要是想出去走走的话，记得带件外套，晚上会凉。"]
    peaks: list[float] = []
    t0 = time.time()

    for text in probes:
        try:
            for out in model.inference_zero_shot(text, "", "", voice, stream=True, speed=1.0):
                wav = out["tts_speech"].squeeze(0).cpu().numpy()
                peak = float(np.max(np.abs(wav))) if wav.size else 0.0
                if peak > 0:
                    peaks.append(peak)
        except Exception as err:  # noqa: BLE001
            log.warning("增益标定失败（用默认 1.0）：%r", err)
            return

    if not peaks:
        log.warning("增益标定没拿到音频，用默认 1.0")
        return

    # 取最大峰值，再留 5% 余量 —— 标定的两句不可能覆盖所有句子，
    # 留点余量比事后削波强（削波毁音色，音量低一点只是低一点）
    worst = max(peaks) * 1.05
    stream_gain = round(0.95 / worst, 3) if worst > 0 else 1.0

    # 实测（8 句不同长度）：原始峰值 0.624~0.848，1.36x = 2.7 dB。
    # 也就是说固定增益带来的句间音量差最多 2.7 dB —— 在正常说话起伏范围内，
    # 不会听出「音量在跳」。这个数要是再大（比如 6 dB 以上）就得换方案了。
    log.info(
        "流式增益标定 %.3f（标定峰值 %.3f~%.3f，%.1fs）",
        stream_gain,
        min(peaks),
        max(peaks),
        time.time() - t0,
    )


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice: str = Field("default")
    speed: float = Field(1.0, ge=0.5, le=2.0)


def discover_voices() -> list[tuple[str, Path, str]]:
    """扫 voices/ 目录：`<名字>.wav` + `<名字>.txt`（文字内容）。

    为什么文字必须一起给：零样本克隆要"参考音频 + 它对应的文字"这一对，
    模型靠这段文字对齐音素；只给音频不给文字，音色会飘。
    """
    found: list[tuple[str, Path, str]] = []
    if not VOICES_DIR.exists():
        return found
    for wav in sorted(VOICES_DIR.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if not txt.exists():
            log.warning("跳过 %s：缺同名 .txt（参考音频的文字内容）", wav.name)
            continue
        text = txt.read_text(encoding="utf-8").strip()
        if not text:
            log.warning("跳过 %s：.txt 是空的", wav.name)
            continue
        found.append((wav.stem, wav, text))
    return found


def load_model(fp16: bool, jit: bool = False) -> None:
    global model, sample_rate
    if not MODEL_DIR.exists():
        raise SystemExit(f"找不到模型目录：{MODEL_DIR}")

    t0 = time.time()
    # load_trt 保持关着：本机没装 tensorrt（ModuleNotFoundError），
    # 而且 CosyVoice 的 TRT 路径（runtime/triton_trtllm/）是给 Triton 容器用的，
    # 进程内开它并不是官方主推的用法。
    model = CosyVoice2(str(MODEL_DIR), load_jit=jit, load_trt=False, fp16=fp16)
    sample_rate = model.sample_rate
    vram = torch.cuda.max_memory_allocated() / 1e9 if torch.cuda.is_available() else 0
    log.info(
        "模型加载完成 %.1fs（%.2f GB 显存，%d Hz，jit=%s）",
        time.time() - t0,
        vram,
        sample_rate,
        jit,
    )

    # 注册音色：用户的优先，一个都没有就用自带示例
    voices = discover_voices()
    if voices:
        for name, wav, text in voices:
            t = time.time()
            model.add_zero_shot_spk(text, str(wav), name)
            registered[name] = str(wav)
            log.info("已注册音色 %s（%.2fs）", name, time.time() - t)
    else:
        model.add_zero_shot_spk(FALLBACK_PROMPT_TEXT, str(FALLBACK_PROMPT_WAV), "default")
        registered["default"] = str(FALLBACK_PROMPT_WAV)
        log.info(
            "没找到自己的音色，先用自带示例注册了 default。"
            "想换成你的声音：把 5~10 秒的 %s 和同名 .txt（那句话的文字）放进 %s",
            "<名字>.wav",
            VOICES_DIR,
        )

    # 声纹落盘：下次启动直接读，不用再算一遍（0.35s/个，不大但没必要）
    try:
        model.save_spkinfo()
    except Exception as err:  # noqa: BLE001
        log.warning("声纹持久化失败（不影响使用）：%s", err)

    # 预热：第一次推理含 CUDA 内核预热，实测比热调用多花 1~2 秒。
    # 不预热的话，用户听到的第一句话会明显卡一下。
    t1 = time.time()
    with _lock:
        for _ in model.inference_zero_shot("嗯，我在。", "", "", list(registered)[0], stream=True):
            pass
    log.info("预热完成 %.1fs｜可用音色：%s", time.time() - t1, ", ".join(registered))

    # 流式的固定增益：标定挂在预热后面（内核已经热了，量出来才准）
    with _lock:
        calibrate_stream_gain(list(registered)[0])


@app.get("/health")
def health() -> dict:
    return {
        "ok": model is not None,
        "engine": "cosyvoice2",
        "model_ready": model is not None,
        "sample_rate": sample_rate,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "vram_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2) if torch.cuda.is_available() else 0,
        "voices": list(registered),
        "voices_dir": str(VOICES_DIR),
    }


@app.get("/voices")
def voices() -> dict:
    return {"engine": "cosyvoice2", "voices": list(registered)}


class VoiceRequest(BaseModel):
    """新增音色。wav 用 base64 传 —— 省掉 multipart 解析（少一个依赖）。

    10 秒的 WAV 约 1~2MB，base64 之后 2~3MB，本机回环一次性传完没有压力。
    """

    name: str = Field(..., min_length=1, max_length=40)
    text: str = Field(..., min_length=1, description="这段录音里说的话，必须逐字一致")
    wav_base64: str = Field(..., min_length=16)


@app.post("/voices")
def add_voice(req: VoiceRequest) -> dict:
    """运行时注册一个新音色 —— **不用重启服务**。

    为什么重要：重启要重新加载模型（10~15 秒）。而 add_zero_shot_spk 本身只要 0.35 秒，
    完全可以当场注册。用户录完音、填上文字，点一下就能立刻听到自己的声音。
    """
    import base64
    import re

    if model is None:
        raise HTTPException(status_code=503, detail="模型还没加载完")

    name = re.sub(r"[^\w\-]", "", req.name.strip())[:40]
    if not name:
        raise HTTPException(status_code=400, detail="名字只能是字母/数字/下划线/连字符")

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = VOICES_DIR / f"{name}.wav"
    try:
        raw = base64.b64decode(req.wav_base64.split(",")[-1], validate=True)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"音频不是合法的 base64：{err}") from err

    if len(raw) < 1000:
        raise HTTPException(status_code=400, detail="音频太短了（至少得有一两秒）")

    # ★ 检查"音频长度"和"文字字数"是否匹配 —— 这是克隆最常见的失败方式，而且**是静默的**：
    #   零样本克隆靠"参考音频 + 它逐字对应的文字"对齐音素。文字只写了开头几个字、
    #   或者干脆写错，模型不会报错，它会**自己编** ——
    #   表现是"合成的语音和要说的内容对不上"（实测：喂 13 个字吐出 10.4 秒音频，
    #   正常只要 2.5~3.5 秒；用户就是这么被坑的，一个 7.3 秒的录音只写了 7 个字）。
    #   所以这里按语速区间卡一道：中文正常 4~6 字/秒，放宽到 3~8 字/秒。
    try:
        import io as _io
        import wave as _wave

        with _wave.open(_io.BytesIO(raw)) as w:
            seconds = w.getnframes() / float(w.getframerate() or 1)
    except Exception:  # noqa: BLE001 - 不是 wav 就跳过这道检查（模型那边会自己判）
        seconds = 0.0

    chars = len(req.text.strip())
    if seconds > 1:
        if chars < seconds * 3:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"文字和录音对不上：音频 {seconds:.1f} 秒大约说 {int(seconds*4)}~{int(seconds*6)} 个字，"
                    f"但只填了 {chars} 个字。请把录音里说的**整句话**逐字填上 —— "
                    "只写一部分会让音色乱飘（模型会自己编内容）。"
                ),
            )
        if chars > seconds * 8:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"文字比录音长太多：音频 {seconds:.1f} 秒最多约 {int(seconds*8)} 个字，"
                    f"你填了 {chars} 个字。是不是填了别的内容？"
                ),
            )

    wav_path.write_bytes(raw)
    wav_path.with_suffix(".txt").write_text(req.text.strip(), encoding="utf-8")

    try:
        with _lock:
            model.add_zero_shot_spk(req.text.strip(), str(wav_path), name)
    except Exception as err:  # noqa: BLE001
        wav_path.unlink(missing_ok=True)
        wav_path.with_suffix(".txt").unlink(missing_ok=True)
        log.exception("注册音色失败：%s", name)
        raise HTTPException(
            status_code=400,
            detail=f"注册失败：{err}。常见原因：参考音频太短/太长，或者音频不是语音",
        ) from err

    registered[name] = str(wav_path)
    try:
        model.save_spkinfo()
    except Exception:  # noqa: BLE001
        pass
    log.info("已注册音色 %s（来自界面）｜当前：%s", name, ", ".join(registered))
    return {"ok": True, "name": name, "voices": list(registered)}


@app.delete("/voices/{name}")
def delete_voice(name: str) -> dict:
    """删掉一个音色（连同它的参考音频文件）。"""
    if name not in registered:
        raise HTTPException(status_code=404, detail=f"没有这个音色：{name}")

    path = Path(registered.pop(name))
    if VOICES_DIR in path.parents:
        path.unlink(missing_ok=True)
        path.with_suffix(".txt").unlink(missing_ok=True)
    if model is not None and name in getattr(model.frontend, "spk2info", {}):
        del model.frontend.spk2info[name]
    if not registered:
        # 一个都不剩就退回自带示例，免得服务处于"没有音色"的状态
        if model is not None:
            model.add_zero_shot_spk(FALLBACK_PROMPT_TEXT, str(FALLBACK_PROMPT_WAV), "default")
            registered["default"] = str(FALLBACK_PROMPT_WAV)

    log.info("已删除音色 %s｜当前：%s", name, ", ".join(registered))
    return {"ok": True, "voices": list(registered)}


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    if model is None:
        raise HTTPException(status_code=503, detail="模型还没加载完")

    voice = req.voice if req.voice in registered else (list(registered)[0] if registered else "")
    if not voice:
        raise HTTPException(status_code=503, detail="没有任何可用音色")

    try:
        with _lock:
            # 计时：首块到得多快、整体多慢 —— 这两个数决定了"要不要做端到端流式"
            t0 = time.time()
            first_at = 0.0
            chunks = []
            for out in model.inference_zero_shot(
                req.text.strip(), "", "", voice, stream=True, speed=req.speed
            ):
                if not first_at:
                    first_at = time.time() - t0
                chunks.append(out["tts_speech"])
            total = time.time() - t0
            log.info("合成 %d 字｜首块 %.2fs｜总计 %.2fs｜%d 块", len(req.text.strip()), first_at, total, len(chunks))
    except Exception as err:  # noqa: BLE001
        log.exception("合成失败：%r", req.text[:40])
        raise HTTPException(status_code=500, detail=str(err)) from err

    if not chunks:
        raise HTTPException(status_code=500, detail="模型没有产出音频")

    wav = torch.cat(chunks, dim=1).squeeze(0).cpu().numpy()

    # 观测：首块延迟 / 总耗时 / RTF。这三个数决定"值不值得做端到端流式"：
    # 首块快而总时长慢（RTF>1）说明流式能让她早开口，但中途会补给不上。
    audio_sec = wav.shape[-1] / sample_rate if wav.size else 0.0
    log.info(
        "合成 %d 字｜首块 %.2fs｜总计 %.2fs｜音频 %.2fs｜RTF %.2f",
        len(req.text.strip()),
        first_at,
        total,
        audio_sec,
        (total / audio_sec) if audio_sec else 0.0,
    )
    # 归一化：模型输出的峰值只有 0.6~0.7，而口型是按振幅驱动的 ——
    # 不归一化的话她的嘴会比实际说话幅度小一截（edge 引擎那边同理）
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0:
        wav = wav / peak * 0.95
    pcm = (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2")

    # 自己拼 WAV 头（16-bit 单声道）—— 和主服务一样不引额外依赖，
    # 浏览器 decodeAudioData 直接能吃
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())

    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={
            "X-Engine": "cosyvoice2",
            # ★ 音色名要**百分号编码**才能进响应头。
            #   HTTP 头是 latin-1 编码的，音色名却可以是中文（用户就注册了一个叫「少女」的）——
            #   直接把中文塞进头里，starlette 构造响应时就会抛
            #   UnicodeEncodeError: 'latin-1' codec can't encode ...，
            #   表现是整个 /tts 500（而且是"只有中文名音色才 500"这种最难猜的规律）。
            "X-Voice": quote(voice, safe=""),
            "X-Sample-Rate": str(sample_rate),
        },
    )


@app.post("/tts/stream")
def tts_stream(req: TTSRequest) -> StreamingResponse:
    """边合成边发。

    ★ 为什么要有它

    非流式那条路是「攒齐所有块 → torch.cat → 拼 WAV → 一次返回」，
    于是首块那几秒完全是干等。实测（tools/bench-tts.py，空闲机器）：

        5 字   首块 2.03s / 总计 2.75s   → 首块占 74%
        31 字  首块 3.77s / 总计 7.57s   → 流式能省 3.8s

    **回复越长收益越大；短句本来就一两块，收益接近 0。**

    ★ 和 /tts 的区别不止「分块发」

    /tts 对整段做峰值归一化（除完乘 0.95），流式做不到 ——
    所以流式用**开机标定的固定增益**（见 calibrate_stream_gain）。
    两条路音量可能有细微差别，但都保证不削波。
    """
    if model is None:
        raise HTTPException(status_code=503, detail="模型还没加载完")

    voice = req.voice if req.voice in registered else (list(registered)[0] if registered else "")
    if not voice:
        raise HTTPException(status_code=503, detail="没有任何可用音色")

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    # 第一帧是 JSON 头：客户端得先知道采样率才能把 PCM 包成 AudioBuffer
    header = json.dumps(
        {
            "sampleRate": sample_rate,
            "channels": 1,
            "format": "s16le",
            "gain": stream_gain,
            "voice": voice,
            "engine": "cosyvoice2",
        },
        ensure_ascii=False,
    ).encode("utf-8")

    def gen():
        yield stream_frame(header)

        # 合成不是线程安全的（同一份 KV cache），串行化。
        # 锁要**跨整个生成过程**持有 —— 和 /tts 一样，区别只是这次中途会 yield。
        # 客户端断开时生成器被关闭，with 退出，锁正常释放。
        t0 = time.time()
        first_at = 0.0
        chunks = 0
        samples = 0

        with _lock:
            for out in model.inference_zero_shot(text, "", "", voice, stream=True, speed=req.speed):
                wav = out["tts_speech"].squeeze(0).cpu().numpy()
                if not wav.size:
                    continue
                if not first_at:
                    first_at = time.time() - t0
                chunks += 1
                samples += wav.shape[0]
                yield stream_frame(to_pcm16(wav))

        # 计时和 /tts 对齐（首块/总计/音频/RTF）——
        # 这两个数放在一起才能判断「流式到底省了多少」。
        # 它也是「流式真的被用上了」的唯一现场证据：日志里出现「流式合成」就说明前端走了这条路。
        audio = samples / sample_rate if sample_rate else 0.0
        total = time.time() - t0
        log.info(
            "流式合成 %d 字｜首块 %.2fs｜总计 %.2fs｜音频 %.2fs｜RTF %.2f｜%d 块",
            len(text),
            first_at,
            total,
            audio,
            total / audio if audio else 0.0,
            chunks,
        )

        # 长度 0 = 结束。这也是客户端唯一能区分
        # 「正常说完」和「连接断了」的信号。
        yield stream_frame(b"")

    return StreamingResponse(
        gen(),
        media_type="application/octet-stream",
        headers={
            "X-Engine": "cosyvoice2",
            "X-Voice": quote(voice, safe=""),
            "X-Sample-Rate": str(sample_rate),
            "Cache-Control": "no-store",
            # 别让中间层缓冲 —— 否则「流式」根本到不了客户端
            "X-Accel-Buffering": "no",
        },
    )


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="CosyVoice 2 独立服务")
    parser.add_argument("--port", type=int, default=int(os.environ.get("NEXUS_COSY_PORT", 8788)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--fp32", action="store_true", help="关掉 fp16（更慢、更占显存，一般不需要）")
    parser.add_argument(
        "--jit",
        action="store_true",
        default=os.environ.get("NEXUS_COSY_JIT") == "1",
        help="开启 JIT 融合（也可用环境变量 NEXUS_COSY_JIT=1，方便从启动脚本控制）。"
        "本机实测能加载（11.2s vs 基线 18.2s），但推理快多少要自己量 —— "
        "打开前后各跑几轮，比日志里的 RTF。",
    )
    args = parser.parse_args()

    log.info("CosyVoice 2 服务启动中（模型目录 %s）", MODEL_DIR)
    load_model(fp16=not args.fp32, jit=args.jit)
    log.info("就绪：http://%s:%d/tts", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
