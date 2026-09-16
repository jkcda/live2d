"""ASR 引擎注册。

返回 `None` 表示 ASR 不可用 —— 这是**合法状态**，不是错误。
没有 ASR 时 VAD 和打断依然工作，只是用户说的话进不了 LLM。
"""

from __future__ import annotations

import logging

from ..config import settings
from .base import ASREngine

__all__ = ["ASREngine", "create_asr"]

log = logging.getLogger(__name__)


def create_asr(name: str | None = None) -> ASREngine | None:
    """创建 ASR 引擎。不可用时返回 None，由调用方决定怎么降级。"""
    key = (name or settings.asr_engine or "none").strip().lower()

    if key in ("", "none", "off", "disabled"):
        return None

    if key == "sensevoice":
        from .sensevoice import SenseVoiceASR

        engine = SenseVoiceASR(device=settings.asr_device)
        ok, reason = engine.availability()
        if ok:
            return engine
        log.warning("SenseVoice 不可用：%s", reason)
        return None

    log.warning("未知的 ASR 引擎 %r，按不可用处理", key)
    return None
