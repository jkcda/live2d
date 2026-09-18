"""推理服务入口。

跑起来：
    cd python
    python -m service.main

前端（src/core/audio/tts.ts）会调这两个接口：
    GET  /health  探活 + 报告引擎状态
    POST /tts     收 JSON、返 WAV
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .asr import create_asr
from .config import settings
from .stream import StreamSession
from .tts import AVAILABLE_ENGINES, create_engine
from .vad import create_vad

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("service")

app = FastAPI(
    title="Nexus Live2D 推理服务",
    version="0.1.0",
    description="TTS / ASR / VAD。当前实现 TTS。",
)

# 前端跑在 5176（dev server）或 file://（打包后），不配 CORS 浏览器会直接拦掉请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins) or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Engine", "X-Sample-Rate"],
)

engine = create_engine()

# VAD 每个连接一个实例 —— 它的噪声底是逐会话自适应的，共享会互相污染
_vad_probe = create_vad()
_asr = create_asr()


# ---------------------------------------------------------------- schemas


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="要合成的文本")
    voice: str = Field("default", description="音色标识")
    speed: float = Field(1.0, ge=0.25, le=4.0, description="语速倍率")


# ---------------------------------------------------------------- routes


@app.get("/health")
async def health() -> dict:
    """探活。

    注意：服务活着但引擎不可用是**两种不同状态**。
    前端据此显示「连不上服务」还是「服务在线但引擎不可用」，
    所以这里永远返回 200，把状态放在 body 里。
    """
    tts_ok, tts_reason = engine.availability()
    vad_ok, vad_reason = _vad_probe.availability()
    asr_ok, asr_reason = (False, "未启用") if _asr is None else _asr.availability()

    return {
        "ok": True,
        "engine": engine.name,
        "engine_ready": tts_ok,
        "engine_detail": tts_reason,
        "available_engines": list(AVAILABLE_ENGINES),
        "sample_rate": engine.sample_rate,
        "vad": {"name": _vad_probe.name, "ready": vad_ok, "detail": vad_reason},
        "asr": {
            "name": _asr.name if _asr else None,
            "ready": asr_ok,
            "detail": asr_reason,
        },
    }


@app.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    """实时输入通道：麦克风音频 → VAD → ASR。协议见 stream.py 顶部注释。"""
    # VAD 逐连接独立实例（噪声底需要自适应各自的麦克风环境）
    session = StreamSession(ws, vad=create_vad(), asr=_asr)
    await session.run()


@app.get("/voices")
async def voices() -> dict:
    return {"engine": engine.name, "voices": engine.voices()}


class VoiceRequest(BaseModel):
    """新增克隆音色。音频走 base64 而不是 multipart —— 省掉 python-multipart 依赖。"""

    name: str = Field(..., min_length=1, max_length=40)
    text: str = Field(..., min_length=1, description="参考音频里说的话，必须逐字一致")
    wav_base64: str = Field(..., min_length=16)


@app.post("/voices")
async def add_voice(req: VoiceRequest) -> dict:
    """注册一个新的克隆音色。

    ★ 为什么放在这里、而不是让界面直接连模型服务（8788）：
      应用只该认识**一个** TTS 地址。多记一个端口就多一处会配错的地方，
      而且报错信息会变得难懂（"连不上 8788" 对用户毫无意义）。
      引擎不支持时明确返回 501 —— 比如 edge / sapi 根本没有音色克隆这回事，
      界面据此把「克隆」那块藏起来，而不是让用户点了没反应。
    """
    if not hasattr(engine, "add_voice"):
        raise HTTPException(
            status_code=501,
            detail=f"当前引擎（{engine.name}）不支持克隆音色 —— 它是固定音色的引擎",
        )
    try:
        new_voices = await asyncio.to_thread(engine.add_voice, req.name, req.text, req.wav_base64)
    except Exception as err:  # noqa: BLE001
        detail = str(err)
        # urllib 的 HTTPError 里带着模型服务给的原因（"音频太短"之类），抠出来给用户看
        body = getattr(err, "read", None)
        if body:
            try:
                detail = json.loads(body().decode("utf-8")).get("detail", detail)
            except Exception:  # noqa: BLE001
                pass
        log.warning("注册音色失败：%s —— %s", req.name, detail)
        raise HTTPException(status_code=400, detail=f"注册失败：{detail}") from err
    return {"ok": True, "engine": engine.name, "voices": new_voices}


@app.delete("/voices/{name}")
async def remove_voice(name: str) -> dict:
    if not hasattr(engine, "remove_voice"):
        raise HTTPException(status_code=501, detail=f"当前引擎（{engine.name}）不支持删除音色")
    try:
        new_voices = await asyncio.to_thread(engine.remove_voice, name)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"删除失败：{err}") from err
    return {"ok": True, "voices": new_voices}


@app.post("/tts")
async def tts(req: TTSRequest) -> Response:
    """合成一段文本，返回 WAV。

    前端每凑够一句就调一次，所以这个接口会被高频并发调用 ——
    合成必须能并行（引擎内部自己串行化，路由层不加锁）。
    """
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    ready, reason = engine.availability()
    if not ready:
        raise HTTPException(status_code=503, detail=reason)

    try:
        wav = await engine.synthesize(text, req.voice, req.speed)
    except Exception as err:  # noqa: BLE001 - 统一转成 500，细节进日志
        log.exception("合成失败：%r", text[:40])
        raise HTTPException(status_code=500, detail=str(err)) from err

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Engine": engine.name,
            "X-Sample-Rate": str(engine.sample_rate),
            "Cache-Control": "no-store",
        },
    )


@app.post("/tts/stream")
async def tts_stream(req: TTSRequest) -> StreamingResponse:
    """流式合成：边合成边把音频吐给客户端。

    ★ 收益是「她多久开口」，不是「总共多快」

    非流式那条路要等整段合成完（实测 31 字：首块 3.8s、总计 7.6s），
    流式把「她开口」提前到首块到达的时刻，省掉的是后面那几秒。

    **但有两个前提，缺了它反而更糟：**
      · 短句常常只有 1~2 块 —— 首块 ≈ 总计，流式收益接近 0
      · RTF > 1 时生产慢于播放，播到中间会追不上合成而卡顿。
        这台机器上空闲 0.82、GPU 忙时 1.6，所以「会不会卡」取决于当时在跑什么

    ★ 引擎不支持时明确报 501，不假装成功

    其它引擎（edge / sapi / tone）没有流式实现。这里不能悄悄退回非流式 ——
    调用方是按流式的节奏去消费的，给它一整段 WAV 会解析失败。
    明确报错，前端据此走非流式那条路。
    """
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    ready, reason = engine.availability()
    if not ready:
        raise HTTPException(status_code=503, detail=reason)

    streamer = getattr(engine, "stream_raw", None)
    if streamer is None:
        raise HTTPException(status_code=501, detail=f"引擎 {engine.name} 不支持流式合成")

    return StreamingResponse(
        streamer(text, req.voice, req.speed),
        media_type="application/octet-stream",
        headers={
            "X-Engine": engine.name,
            "X-Sample-Rate": str(engine.sample_rate),
            "Cache-Control": "no-store",
            # 别让中间层缓冲 —— 否则「流式」到不了客户端
            "X-Accel-Buffering": "no",
        },
    )


@app.on_event("startup")
async def on_startup() -> None:
    tts_ok, tts_reason = engine.availability()
    log.info("TTS  %-10s %s", engine.name, "可用" if tts_ok else f"不可用 —— {tts_reason}")

    vad_ok, vad_reason = _vad_probe.availability()
    log.info("VAD  %-10s %s", _vad_probe.name, "可用" if vad_ok else f"不可用 —— {vad_reason}")

    if _asr is None:
        log.info("ASR  未启用（VAD 与打断不受影响，只是语音进不了 LLM）")
    else:
        asr_ok, asr_reason = _asr.availability()
        log.info("ASR  %-10s %s", _asr.name, "可用" if asr_ok else f"不可用 —— {asr_reason}")

    if settings.cosyvoice_load_on_start and tts_ok:
        log.info("预热中…")
        try:
            engine.warmup()
        except Exception:  # noqa: BLE001 - 预热失败不该阻止服务启动
            log.exception("预热失败，将在首次请求时重试")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "service.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
