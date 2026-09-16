"""TTS 引擎接口。

换引擎只改实现，路由层不感知具体是 CosyVoice 还是内置合成音。
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class TTSEngine(ABC):
    """所有 TTS 引擎的统一接口。"""

    #: 引擎标识，用于日志和 /health 回显
    name: str = "base"

    @property
    @abstractmethod
    def sample_rate(self) -> int:
        """输出采样率。"""

    @abstractmethod
    def availability(self) -> tuple[bool, str]:
        """引擎是否可用。返回 (可用, 原因说明)。

        不可用时不能抛异常 —— /health 要能如实报告状态，
        前端据此显示「服务在线但引擎不可用」而不是当成服务挂了。
        """

    @abstractmethod
    def voices(self) -> list[str]:
        """可用音色列表。"""

    @abstractmethod
    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        """合成一段文本，返回 WAV 字节。"""

    def warmup(self) -> None:
        """预热（加载模型等）。默认什么都不做。

        故意不放进 __init__ —— 模型加载要几十秒，
        放在构造里会让服务启动看起来像卡死了。
        """
