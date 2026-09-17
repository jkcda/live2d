"""CosyVoice 2 **远程**引擎：把合成转发给独立的模型服务。

为什么不在这里直接加载模型：
  1. 这个服务（`python/service`）的环境是轻量的（1.3GB，秒级启动），
     而 CosyVoice 要 Python 3.10 + torch cu121（约 7GB）—— 塞进来会让每次启动都变慢，
     而且依赖会打架；
  2. 更要紧的是**声纹要预先注册**、模型要预热：实测"每次都现算参考音频的声纹"
     RTF 是 1.12，"预先注册一次"是 0.89 —— 这些状态属于"长期活着的模型进程"，
     不属于"每个请求来处理一下"的服务进程。
  3. 项目环境里的 torch 是 **CPU 版**（2.14.0+cpu），在这边加载等于用 CPU 跑 TTS。

所以分工是：模型服务（`python/cosyvoice_server.py`，用 D:\\cosyvoice\\.venv 跑）
负责算，这个引擎只负责转发 —— 接口和本地引擎完全一样，上层无感。

启用：
    $env:NEXUS_TTS_ENGINE="cosyvoice"
    $env:NEXUS_COSYVOICE_URL="http://127.0.0.1:8788"
"""

from __future__ import annotations

import logging

import numpy as np

from ..audio import decode_wav, encode_wav
from .base import TTSEngine

log = logging.getLogger(__name__)

_INSTALL_HINT = (
    "远程 CosyVoice 服务没在跑。先启动它：\n"
    "  .\\tools\\start-cosyvoice.ps1        （模型加载约 10~15 秒）\n"
    "或者用 NEXUS_COSYVOICE_URL 指到别的地址。"
)


class CosyVoiceRemoteEngine(TTSEngine):
    """把 /tts 转发给 CosyVoice 模型服务。"""

    name = "cosyvoice-remote"

    def __init__(self, url: str, sample_rate: int = 24000) -> None:
        self._url = url.rstrip("/")
        self._sample_rate = sample_rate
        self._last_rate: int | None = None
        self._voices: list[str] = []

    @property
    def sample_rate(self) -> int:
        return self._last_rate or self._sample_rate

    def availability(self) -> tuple[bool, str]:
        """同步探活。

        为什么敢在这儿发同步请求：`/health` 是本机回环、而且模型服务的这个接口
        是纯读状态（不碰模型），实测 1~2ms。前端探活卡住的代价远大于这点开销。
        """
        import json
        import urllib.error
        import urllib.request

        try:
            with urllib.request.urlopen(f"{self._url}/health", timeout=2) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as err:
            return False, f"{_INSTALL_HINT}（连接失败：{err.reason}）"
        except Exception as err:  # noqa: BLE001
            return False, f"{_INSTALL_HINT}（{err}）"

        if not data.get("model_ready"):
            return False, "CosyVoice 服务起来了，但模型还没加载完 —— 再等十几秒"
        self._voices = list(data.get("voices") or [])
        return True, (
            f"远程 CosyVoice 2（{data.get('device', '?')}，"
            f"显存 {data.get('vram_gb', '?')}GB）｜音色：{', '.join(self._voices) or '无'}"
        )

    def voices(self) -> list[str]:
        if not self._voices:
            self.availability()
        return list(self._voices)

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        import asyncio
        import json
        import urllib.request

        payload = json.dumps({"text": text, "voice": voice, "speed": speed}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._url}/tts", data=payload, headers={"Content-Type": "application/json"}
        )

        def _call() -> tuple[bytes, int]:
            # 合成是同步阻塞的（模型不是线程安全的，服务端自己串行化）——
            # 放到线程里跑，别把事件循环堵住（口型/打断还要靠它）
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read(), int(resp.headers.get("X-Sample-Rate") or self._sample_rate)

        wav_bytes, rate = await asyncio.to_thread(_call)
        samples, actual_rate = decode_wav(wav_bytes)
        self._last_rate = actual_rate or rate

        # 兜一层归一化：服务端已经做过，但万一换了个后端，这里保证口型幅度稳定
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0:
            samples = samples / peak * 0.95
        return encode_wav(samples, self._last_rate)
