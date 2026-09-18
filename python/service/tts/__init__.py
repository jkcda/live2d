"""TTS 引擎注册。"""

from __future__ import annotations

from ..config import settings
from .base import TTSEngine
from .tone import ToneEngine

__all__ = ["TTSEngine", "ToneEngine", "create_engine", "AVAILABLE_ENGINES"]

AVAILABLE_ENGINES = ("tone", "edge", "sapi", "cosyvoice", "openai")


def create_engine(name: str | None = None) -> TTSEngine:
    """按名字创建引擎。名字无效时退回 tone —— 开发服务不该因为配错就起不来。"""
    key = (name or settings.engine or "tone").strip().lower()

    if key == "openai":
        # 任何 OpenAI 兼容的线上 TTS（/v1/audio/speech）。
        # 不占显存、不用预热，代价是联网 + 按量计费。见 openai_tts.py 顶部的对比。
        from .openai_tts import OpenAITtsEngine

        return OpenAITtsEngine(
            base_url=settings.tts_api_url,
            api_key=settings.tts_api_key,
            model=settings.tts_api_model,
            voice=settings.tts_api_voice or settings.default_voice,
            sample_rate=settings.sample_rate,
        )

    if key == "edge":
        # 在线语音：一个包 + 联网，十分钟就能听到真人级的声音（推荐的第一跳）
        from .edge import EdgeEngine

        return EdgeEngine(sample_rate=settings.sample_rate)

    if key == "sapi":
        # Windows 专用的过渡引擎：真语音、零模型下载、不联网
        from .sapi import SapiEngine

        return SapiEngine(sample_rate=settings.sample_rate)

    if key == "cosyvoice":
        # ★ 优先走「远程模式」：CosyVoice 跑在它自己的环境里（Python 3.10 + cu121 torch，
        #   约 7GB），而且声纹要预先注册、模型要预热 —— 那些状态属于**长期活着的模型进程**，
        #   不属于每个请求来处理一下的服务进程。实测：注册前 RTF 1.12、注册后 0.89。
        #   设了 NEXUS_COSYVOICE_URL 就转发过去（推荐路径）；
        #   没设才尝试本地加载 —— 那要求本环境有 GPU 版 torch，一般不会满足。
        import os

        remote = (os.environ.get("NEXUS_COSYVOICE_URL") or "").strip()
        if remote:
            from .cosyvoice_remote import CosyVoiceRemoteEngine

            return CosyVoiceRemoteEngine(url=remote, sample_rate=settings.sample_rate)

        from .cosyvoice import CosyVoiceEngine

        return CosyVoiceEngine(
            model_dir=settings.cosyvoice_model_dir,
            sample_rate=settings.sample_rate,
        )

    return ToneEngine(sample_rate=settings.sample_rate)
