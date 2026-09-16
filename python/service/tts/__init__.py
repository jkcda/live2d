"""TTS 引擎注册。"""

from __future__ import annotations

from ..config import settings
from .base import TTSEngine
from .tone import ToneEngine

__all__ = ["TTSEngine", "ToneEngine", "create_engine", "AVAILABLE_ENGINES"]

AVAILABLE_ENGINES = ("tone", "edge", "sapi", "cosyvoice")


def create_engine(name: str | None = None) -> TTSEngine:
    """按名字创建引擎。名字无效时退回 tone —— 开发服务不该因为配错就起不来。"""
    key = (name or settings.engine or "tone").strip().lower()

    if key == "edge":
        # 在线语音：一个包 + 联网，十分钟就能听到真人级的声音（推荐的第一跳）
        from .edge import EdgeEngine

        return EdgeEngine(sample_rate=settings.sample_rate)

    if key == "sapi":
        # Windows 专用的过渡引擎：真语音、零模型下载、不联网
        from .sapi import SapiEngine

        return SapiEngine(sample_rate=settings.sample_rate)

    if key == "cosyvoice":
        # 延迟导入：没装 torch 的人不该因为 import 就起不来服务
        from .cosyvoice import CosyVoiceEngine

        return CosyVoiceEngine(
            model_dir=settings.cosyvoice_model_dir,
            sample_rate=settings.sample_rate,
        )

    return ToneEngine(sample_rate=settings.sample_rate)
