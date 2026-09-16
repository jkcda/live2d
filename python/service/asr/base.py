"""ASR 引擎接口。

ASR 是**可选**的 —— 没有它，VAD 依然能工作，打断（barge-in）依然成立。
只有「说完话 → 转文字 → 送给 LLM」这一步需要它。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np


class ASREngine(ABC):
    """所有 ASR 实现的统一接口。"""

    name: str = "base"

    @abstractmethod
    def availability(self) -> tuple[bool, str]:
        """是否可用。不可用不能抛异常。"""

    @abstractmethod
    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str:
        """把一段 16kHz 单声道 float32 波形转成文字。

        返回空字符串表示「没听清 / 无有效语音」，不是错误。
        """
