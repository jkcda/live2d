"""OpenAI 兼容的 TTS 引擎（POST {base}/audio/speech）。

## 为什么走这个协议，而不是某一家厂商的私有协议

它已经是事实标准。除了 OpenAI 自己，**硅基流动（SiliconFlow）、以及一大批
自建 TTS 服务（GPT-SoVITS / fish-speech / IndexTTS 这些都有 OpenAI 兼容层）**
都认这个形状。

**一个适配器覆盖很多家，换供应商不用改代码** —— 这是"留个 API 接入方式"
这个需求的正解。厂商私有的协议每接一家就要写一个文件。

## 和 CosyVoice 那条路比，换来换去的是什么

|              | 本地 CosyVoice          | 这个（线上）        |
|--------------|------------------------|-------------------|
| 显存          | 实打实吃 2.65GB         | 不占              |
| 启动          | 加载 13~29 秒 + 预热    | 不用              |
| 延迟          | 首块 2~4 秒，GPU 忙更慢  | 看网络和供应商      |
| 音色克隆       | 有（参考音频注册）       | 看供应商支不支持    |
| 联网          | 不用                   | **要**            |
| 花钱          | 电费                   | 按量计费           |

一句话：**本地那条路的瓶颈是显存和 GPU 争抢，线上那条路的瓶颈是网络和钱。**
两条都留着，是因为它们**坏的时机不一样** —— 本地跑不动的时候线上能顶上，
没网或者不想花钱的时候本地能顶上。

## 配置

    NEXUS_TTS_ENGINE=openai
    NEXUS_TTS_API_URL=https://api.siliconflow.cn/v1
    NEXUS_TTS_API_KEY=sk-xxx
    NEXUS_TTS_API_MODEL=FunAudioLLM/CosyVoice2-0.5B
    NEXUS_TTS_API_VOICE=alex            # 不填就用供应商的默认音色

注意 URL 填到 `/v1` 为止（本文件会自己拼 `/audio/speech`）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request

from ..audio import decode_wav
from .base import TTSEngine

log = logging.getLogger(__name__)

#: 合成一句话给 30 秒。线上 TTS 一般 1~3 秒，给这么多是「网络抖了」和「挂了」的分界
_TIMEOUT_SECONDS = 30

#: 音色列表的缓存时长
_VOICE_CACHE_SECONDS = 600


class OpenAITtsEngine(TTSEngine):
    """调 OpenAI 兼容的 /audio/speech。"""

    name = "openai"

    def __init__(
        self,
        base_url: str = "",
        api_key: str = "",
        model: str = "tts-1",
        voice: str = "alloy",
        sample_rate: int = 24000,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._model = model or "tts-1"
        self._voice = voice or "alloy"
        self._configured_rate = sample_rate
        self._last_rate: int | None = None
        self._voice_cache: tuple[float, list[str]] | None = None

    # ---- 元信息 ----

    @property
    def sample_rate(self) -> int:
        # 以**实际拿到的**为准：供应商不一定按你要求的采样率给。
        # 拿不到才退回配置值（口型是按振幅驱动的，采样率错了音频就变调）。
        return self._last_rate or self._configured_rate

    def availability(self) -> tuple[bool, str]:
        if not self._base:
            return False, (
                "没配 API 地址。设 NEXUS_TTS_API_URL（例如 https://api.siliconflow.cn/v1），"
                "再配 NEXUS_TTS_API_KEY"
            )
        if not self._key:
            return False, "没配 API key。设 NEXUS_TTS_API_KEY"
        return True, f"线上语音（{self._base}，模型 {self._model}）"

    def voices(self) -> list[str]:
        """音色列表。

        **这个协议没有「列音色」的接口** —— 音色名是各家的私有约定。
        所以这里返回配置的音色 + 几个常见默认名，只是给设置面板一个能选的列表，
        不是权威清单。用户填什么就发什么，服务端认不认是服务端的事。
        """
        now = time.time()
        if self._voice_cache and now - self._voice_cache[0] < _VOICE_CACHE_SECONDS:
            return list(self._voice_cache[1])

        names = [self._voice]
        # OpenAI 的默认音色名。别的供应商大概率不认，但列表里多几个无害 ——
        # 反正真正能用的是用户自己填的那个。
        for extra in ("alloy", "echo", "fable", "onyx", "nova", "shimmer"):
            if extra not in names:
                names.append(extra)

        self._voice_cache = (now, names)
        return list(names)

    # ---- 合成 ----

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        payload = {
            "model": self._model,
            "input": text,
            "voice": voice or self._voice,
            # ★ 要 wav 而不是默认的 mp3。
            #   下游（口型/播放）拿的是 PCM，wav 能直接读出采样率；
            #   mp3 得再解一层，而多引一个解码库不值得。
            #   不支持的供应商会忽略这个字段 —— 那时拿回来的是 mp3，
            #   浏览器 decodeAudioData 照样能放（它按内容嗅探，不看 content-type）。
            "response_format": "wav",
            "speed": max(0.25, min(4.0, float(speed or 1.0))),
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base}/audio/speech",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._key}",
            },
        )

        def _call() -> bytes:
            # 同步阻塞的 urllib 放线程里，别把事件循环堵住（口型/打断还要靠它）
            try:
                with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
                    return resp.read()
            except Exception as err:  # noqa: BLE001
                # 翻成人话再抛 —— 这个字符串会一路显示到用户界面上
                raise RuntimeError(describe_http_error(err)) from err

        audio = await asyncio.to_thread(_call)
        if not audio:
            raise RuntimeError("线上 TTS 返回了空音频")

        # 是 wav 就记下真实采样率；不是也照样往下走（见上面 response_format 的注释）
        if audio[:4] == b"RIFF":
            try:
                _samples, rate = decode_wav(audio)
                if rate:
                    self._last_rate = rate
            except Exception as err:  # noqa: BLE001
                log.warning("wav 解析失败，沿用配置采样率：%s", err)
        else:
            log.info("供应商没按 wav 返回（前 4 字节 %r），按原样透传", audio[:4])

        return audio


def describe_http_error(err: Exception) -> str:
    """把 HTTP 错误翻成人话。

    线上 TTS 报错最常见的就是 key 不对和余额不够，而 urllib 抛出来的
    只有一串 `HTTP Error 401: Unauthorized` —— 不说为什么。
    FastAPI 的 detail 会原样显示给用户，所以这里值得多花几行。
    """
    if isinstance(err, urllib.error.HTTPError):
        try:
            detail = err.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            detail = ""
        hint = {
            401: "API key 不对或者没配",
            403: "这个 key 没权限用这个模型",
            404: "地址或模型名不对（URL 要填到 /v1 为止）",
            429: "被限流了，或者余额不够",
        }.get(err.code, "")
        return f"HTTP {err.code}{'（' + hint + '）' if hint else ''}：{detail}"
    return str(err)
