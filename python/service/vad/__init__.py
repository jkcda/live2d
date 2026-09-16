"""VAD 引擎注册。

默认 energy —— 零依赖、开箱即用。
配了 onnxruntime 和模型就自动升级到 silero（有背景噪音时明显更准）。
"""

from __future__ import annotations

from ..config import settings
from .base import FRAME_SAMPLES, SAMPLE_RATE, VadEvent, VADEngine
from .energy import EnergyVAD

__all__ = [
    "VADEngine",
    "VadEvent",
    "EnergyVAD",
    "create_vad",
    "FRAME_SAMPLES",
    "SAMPLE_RATE",
]


def create_vad(name: str | None = None) -> VADEngine:
    """创建 VAD。请求 silero 但不可用时**自动退回 energy**，不让服务起不来。"""
    key = (name or settings.vad_engine or "energy").strip().lower()

    if key == "silero":
        from .silero import SileroVAD

        engine = SileroVAD()
        ok, reason = engine.availability()
        if ok:
            return engine
        import logging

        logging.getLogger(__name__).warning("Silero 不可用，退回能量法：%s", reason)

    return EnergyVAD()
