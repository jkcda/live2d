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
import logging
import os
import sys
import threading
import time
from pathlib import Path

# ── 先把 CosyVoice 仓库挂进 sys.path，再 import ──
COSY_ROOT = Path(os.environ.get("NEXUS_COSY_ROOT", r"D:\cosyvoice"))
sys.path.insert(0, str(COSY_ROOT))
sys.path.insert(0, str(COSY_ROOT / "third_party" / "Matcha-TTS"))
os.chdir(COSY_ROOT)  # 它的相对路径（asset/、输出目录）都按仓库根算

# wetext 的文本正则小模型默认下到 C 盘 —— 指到 D 盘（用户明确不想占系统盘）
os.environ.setdefault("MODELSCOPE_CACHE", str(COSY_ROOT / "modelscope-cache"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import Response  # noqa: E402
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


def load_model(fp16: bool) -> None:
    global model, sample_rate
    if not MODEL_DIR.exists():
        raise SystemExit(f"找不到模型目录：{MODEL_DIR}")

    t0 = time.time()
    model = CosyVoice2(str(MODEL_DIR), load_jit=False, load_trt=False, fp16=fp16)
    sample_rate = model.sample_rate
    vram = torch.cuda.max_memory_allocated() / 1e9 if torch.cuda.is_available() else 0
    log.info("模型加载完成 %.1fs（%.2f GB 显存，%d Hz）", time.time() - t0, vram, sample_rate)

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


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    if model is None:
        raise HTTPException(status_code=503, detail="模型还没加载完")

    voice = req.voice if req.voice in registered else (list(registered)[0] if registered else "")
    if not voice:
        raise HTTPException(status_code=503, detail="没有任何可用音色")

    try:
        with _lock:
            chunks = [
                out["tts_speech"]
                for out in model.inference_zero_shot(
                    req.text.strip(), "", "", voice, stream=True, speed=req.speed
                )
            ]
    except Exception as err:  # noqa: BLE001
        log.exception("合成失败：%r", req.text[:40])
        raise HTTPException(status_code=500, detail=str(err)) from err

    if not chunks:
        raise HTTPException(status_code=500, detail="模型没有产出音频")

    wav = torch.cat(chunks, dim=1).squeeze(0).cpu().numpy()
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
        headers={"X-Engine": "cosyvoice2", "X-Voice": voice, "X-Sample-Rate": str(sample_rate)},
    )


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="CosyVoice 2 独立服务")
    parser.add_argument("--port", type=int, default=int(os.environ.get("NEXUS_COSY_PORT", 8788)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--fp32", action="store_true", help="关掉 fp16（更慢、更占显存，一般不需要）")
    args = parser.parse_args()

    log.info("CosyVoice 2 服务启动中（模型目录 %s）", MODEL_DIR)
    load_model(fp16=not args.fp32)
    log.info("就绪：http://%s:%d/tts", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
