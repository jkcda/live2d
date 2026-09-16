"""Edge TTS 引擎（微软 Edge 的在线语音）。

定位：**现在就能听到的真人级语音**，零模型下载、零 GPU、装一个包就用。

为什么先做它而不是直接上 CosyVoice 2：
  · CosyVoice 2 要 GPU、要 4GB 权重、还要它自己那套 requirements（Windows 上
    pynini / WeTextProcessing 是出名的卡点），装到能出声可能是一小时，也可能是一晚上；
  · 而"她的声音"这件事的影响面是**全部**：陪伴感、语气、打断的手感，
    全都建立在一个像人说话的声音上。先用一个十分钟能通的真实语音把链路跑顺，
    再换音色引擎只是改一个环境变量（引擎接口是统一的，见 base.py）。
  · 音色克隆、情感控制这些只有 CosyVoice 那条路有 —— 那是它的位置，不是这里的。

代价说清楚：
    - **要联网**（语音在微软的服务上合成），断网就没有声音；
    - 音色是固定的那几十个，不能克隆你自己的声音；
    - 有被墙/服务变动的风险 —— 所以它只适合当第一跳，不适合当唯一一跳。

装：
    pip install edge-tts

音色：传 `default` 或留空时用 DEFAULT_VOICE；其它常用中文音色见 FALLBACK_VOICES。
"""

from __future__ import annotations

import asyncio
import io
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from ..audio import encode_wav
from .base import TTSEngine

log = logging.getLogger(__name__)

_INSTALL_HINT = (
    "edge-tts 未安装。这是一个包的事：\n"
    "  pip install edge-tts\n"
    "（它会从微软的在线服务合成语音，需要联网）"
)

#: 默认音色：晓晓，中文女声里最自然的一档
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"

#: 网络拿不到完整音色表时的兜底（挑的都是中文，够用了）
FALLBACK_VOICES = (
    "zh-CN-XiaoxiaoNeural",  # 女·温柔
    "zh-CN-XiaoyiNeural",  # 女·活泼
    "zh-CN-liaoning-XiaobeiNeural",  # 女·东北
    "zh-CN-shaanxi-XiaoniNeural",  # 女·陕西
    "zh-CN-YunxiNeural",  # 男·少年
    "zh-CN-YunyangNeural",  # 男·新闻
    "zh-CN-YunjianNeural",  # 男·浑厚
    "zh-TW-HsiaoChenNeural",  # 台普·女
)

#: 音色表的缓存时长 —— 这张表基本不变，不必每次 /voices 都去问一次
_VOICE_CACHE_SECONDS = 3600

#: 首包/整句的超时。合成一句话本来 200~600ms，给到 15 秒是"网络抖了"和"挂了"的分界
_TIMEOUT_SECONDS = 15


def _run_sync(coro):
    """在同步函数里跑一个协程。

    为什么不能直接 `asyncio.run`：`/voices` 是 **async 路由**，事件循环已经在跑，
    在它里面再 `asyncio.run` 会直接 RuntimeError。这时另开一个线程 ——
    那个线程没有事件循环，`asyncio.run` 就是合法的。
    只有第一次拉音色表会走这条路（之后有缓存），所以线程开销无所谓。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


class EdgeEngine(TTSEngine):
    """用 edge-tts 合成。异步原生，不需要线程池。"""

    name = "edge"

    def __init__(self, sample_rate: int = 24000) -> None:
        self._configured_rate = sample_rate
        self._last_rate: int | None = None
        self._voice_cache: tuple[float, list[str]] | None = None

    # ---- 元信息 ----

    @property
    def sample_rate(self) -> int:
        # 真实采样率第一次合成后才知道（edge 固定输出 24kHz mp3，但别假设）
        return self._last_rate or self._configured_rate

    def availability(self) -> tuple[bool, str]:
        try:
            import edge_tts  # noqa: F401
        except ImportError:
            return False, _INSTALL_HINT
        return True, f"在线语音（默认音色 {DEFAULT_VOICE}，需要联网）"

    def voices(self) -> list[str]:
        """中文音色列表。

        为什么允许去网上拉：音色是这个引擎唯一可调的东西，用户在设置面板里
        应该看到能选什么。但**拉不到不能算失败** —— 用兜底表继续，
        合成时照样能指定音色（服务端认的是音色名，不是这张表）。
        """
        now = time.time()
        if self._voice_cache and now - self._voice_cache[0] < _VOICE_CACHE_SECONDS:
            return list(self._voice_cache[1])

        voices: list[str] = []
        try:
            import edge_tts

            listed = _run_sync(edge_tts.list_voices())
            voices = sorted(
                v["ShortName"]
                for v in listed
                # 只留中文：这个项目是中文人设，几十个英文音色列出来只会让人挑花眼
                if str(v.get("Locale", "")).startswith(("zh-CN", "zh-TW", "zh-HK"))
            )
        except Exception as err:  # noqa: BLE001 —— 任何原因都退回兜底表
            log.info("拿不到 edge 音色表（%s），用内置列表", err)

        if not voices:
            voices = list(FALLBACK_VOICES)

        self._voice_cache = (now, voices)
        return list(voices)

    # ---- 合成 ----

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        import edge_tts

        picked = voice if voice and voice != "default" else DEFAULT_VOICE
        # edge 的语速是百分比字符串（"+20%" / "-10%"），我们对外是倍率
        rate_pct = int(round((float(speed or 1.0) - 1.0) * 100))
        rate = f"{rate_pct:+d}%"

        communicate = edge_tts.Communicate(
            text,
            picked,
            rate=rate,
            connect_timeout=_TIMEOUT_SECONDS,
            receive_timeout=_TIMEOUT_SECONDS,
        )

        mp3 = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio":
                data = chunk.get("data")
                if data:
                    mp3.extend(data)

        if not mp3:
            raise RuntimeError(
                "edge-tts 没有返回音频 —— 多半是网络不通，或者音色名不对"
                f"（当前音色 {picked}）"
            )

        samples, rate_hz = self._decode_mp3(bytes(mp3))
        if samples.size == 0:
            raise RuntimeError("解出来的音频是空的（edge 返回了内容但解不出波形）")

        # 兜一层：在线语音偶尔整段偏小，做一次归一化让口型幅度稳定
        peak = float(np.max(np.abs(samples)))
        if peak > 0:
            samples = samples / peak * 0.95

        self._last_rate = rate_hz
        return encode_wav(samples, rate_hz)

    @staticmethod
    def _decode_mp3(data: bytes) -> tuple[np.ndarray, int]:
        """MP3 → float32 单声道波形。

        用 soundfile（libsndfile ≥1.1 自带 MP3 解码），不额外引 ffmpeg ——
        为了听一句话去装一个视频工具链不值得。
        """
        import soundfile as sf

        samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        mono = samples.mean(axis=1) if samples.shape[1] > 1 else samples[:, 0]
        return np.ascontiguousarray(mono, dtype=np.float32), int(rate)
