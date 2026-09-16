"""VAD 引擎接口。

VAD 是打断（barge-in）的唯一依据 —— 用户一开口就要掐掉 TTS，
而这个「一开口」只能靠 VAD 判断，不能等 ASR 出结果（那要多等 300ms）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

# Silero 与绝大多数流式 VAD 的标准帧长：16kHz 下的 512 采样 = 32ms
FRAME_SAMPLES = 512
SAMPLE_RATE = 16000


@dataclass
class VadEvent:
    """VAD 状态变化。state 只在变化时上报，避免刷屏。"""

    state: str  # 'speech' | 'silence'
    #: 当前帧的语音概率 0~1（能量法用归一化能量近似）
    probability: float
    #: 距上次状态变化累计的毫秒数
    elapsed_ms: int


class VADEngine(ABC):
    """所有 VAD 实现的统一接口。"""

    name: str = "base"

    @abstractmethod
    def availability(self) -> tuple[bool, str]:
        """是否可用。不可用不能抛异常 —— /health 要能如实报告。"""

    @abstractmethod
    def reset(self) -> None:
        """重置状态。每轮对话开始、或用户打断后调用。"""

    @abstractmethod
    def process(self, frame) -> VadEvent | None:
        """喂入一帧 16kHz 单声道 float32（长度 = FRAME_SAMPLES）。

        返回 VadEvent 仅当状态**发生变化**时；否则返回 None。
        """
