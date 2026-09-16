"""推理服务入口。

跑起来：
    cd python
    python -m service.main

前端（src/core/audio/tts.ts）会调这两个接口：
    GET  /health  探活 + 报告引擎状态
    POST /tts     收 JSON、返 WAV
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .config import settings
from .tts import AVAILABLE_ENGINES, create_engine

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
    ok, reason = engine.availability()
    return {
        "ok": True,
        "engine": engine.name,
        "engine_ready": ok,
        "engine_detail": reason,
        "available_engines": list(AVAILABLE_ENGINES),
        "sample_rate": engine.sample_rate,
    }


@app.get("/voices")
async def voices() -> dict:
    return {"engine": engine.name, "voices": engine.voices()}


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


@app.on_event("startup")
async def on_startup() -> None:
    ok, reason = engine.availability()
    log.info("引擎：%s（%s）", engine.name, "可用" if ok else "不可用")
    if not ok:
        log.warning("引擎不可用：%s", reason)

    if settings.cosyvoice_load_on_start and ok:
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
