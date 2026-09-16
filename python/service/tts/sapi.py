"""Windows SAPI TTS 引擎。

定位：**过渡用的真实语音**。CosyVoice 2 要 GPU、要 4GB 权重、要单独的 Python 环境，
在它装好之前，这条链路（切句 → 合成 → 排队 → 播放 → 口型 → 打断）用真人的语音
才能验得准 —— 内置 tone 引擎的嗡嗡声只能验证「有没有声音」，验不了「像不像在说话」。

代价说清楚（不是延迟）：
    - 只有 Windows 能用，音色就是系统里装的那几个，语气平淡
    - 非流式：一次渲染一整句。但实测整句只要 30~80ms（RTF ≈ 0.01~0.02，
      写文件流不受实时播放节流），所以延迟反而不是短板
    - 音色克隆、情感指令这些都没有 —— 那是 CosyVoice 2 的事

装：
    pip install -e ".[sapi]"

音色：不传或传 `default` 时**优先挑中文音色**（见 _pick_voice 的注释），
      也可以直接传音色描述里的一段，例如 `Huihui`。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np

from ..audio import decode_wav, encode_wav
from .base import TTSEngine

log = logging.getLogger(__name__)

_INSTALL_HINT = (
    "SAPI 不可用。这是 Windows 专用的过渡引擎，装它只需要：\n"
    '  pip install -e ".[sapi]"'
)

# SAPI 的文件流写入标志（SSFMCreateForWrite）
_SSFMCreateForWrite = 3

# SpeechAudioFormatType 枚举里的「24kHz / 16-bit / 单声道」。
# 只是**尽力而为**：实测在这台机器上 SpVoice 会忽略它，仍按自己偏好的 22.05kHz 输出。
# 所以下面总是从产出的 WAV 里读回真实采样率上报，绝不假设自己设置成功了。
_SAFT_24KHZ_16BIT_MONO = 26

#: 中文（简体）的 LCID
_ZH_CN_LCID = 0x804


class SapiEngine(TTSEngine):
    """用系统 SAPI（SpVoice）合成。"""

    name = "sapi"

    def __init__(self, sample_rate: int = 24000) -> None:
        self._configured_rate = sample_rate
        self._last_rate: int | None = None
        # COM 对象不能跨线程共用，且每个线程都要自己 CoInitialize
        self._local = threading.local()

    # ---- 元信息 ----

    @property
    def sample_rate(self) -> int:
        # 实际采样率由 SAPI 输出的格式决定，第一次合成之后才知道
        return self._last_rate or self._configured_rate

    def availability(self) -> tuple[bool, str]:
        if sys.platform != "win32":
            return False, "SAPI 只在 Windows 上可用（其它平台请用 tone 或 cosyvoice）"

        try:
            import pythoncom  # noqa: F401
            import win32com.client  # noqa: F401
        except ImportError:
            return False, _INSTALL_HINT

        try:
            voice = self._voice()
            default = self._voice_description(voice)
        except Exception as err:  # noqa: BLE001 - 探活不能抛
            return False, f"SAPI 初始化失败：{err}"

        names = self.voices()
        return True, f"系统音色 {len(names)} 个，默认使用「{default}」"

    def voices(self) -> list[str]:
        try:
            self._com_init()
            import win32com.client

            collection = win32com.client.Dispatch("SAPI.SpVoice").GetVoices()
            return [
                str(collection.Item(i).GetDescription())
                for i in range(collection.Count)
            ]
        except Exception:  # noqa: BLE001 - 拿不到就报空，别让 /voices 挂掉
            log.debug("枚举 SAPI 音色失败", exc_info=True)
            return []

    # ---- 合成 ----

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        # SAPI 的 Speak 是阻塞调用，扔线程池，别堵事件循环
        samples, rate = await asyncio.to_thread(self._synthesize_sync, text, voice, speed)
        self._last_rate = rate
        return encode_wav(samples, rate)

    def _synthesize_sync(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        import win32com.client

        sp = self._voice()

        token = self._pick_voice(sp, voice)
        if token is not None:
            sp.Voice = token
        sp.Rate = _rate_from_speed(speed)

        # SAPI 只能写文件流（没有内存流），用临时文件接一下
        fd, path = tempfile.mkstemp(suffix=".wav", prefix="nexus-sapi-")
        os.close(fd)

        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        try:
            stream.Open(path, _SSFMCreateForWrite, False)
            # 显式指定格式；个别音色不支持时要能退回默认格式，不能因为格式设置失败就不出声
            with contextlib.suppress(Exception):
                stream.Format.Type = _SAFT_24KHZ_16BIT_MONO

            sp.AudioOutputStream = stream
            sp.Speak(text)
            stream.Close()

            data = Path(path).read_bytes()
        finally:
            with contextlib.suppress(Exception):
                stream.Close()
            with contextlib.suppress(OSError):
                os.unlink(path)

        if not data:
            raise RuntimeError("SAPI 没有产出音频")

        samples, rate = decode_wav(data)
        return samples, rate

    # ---- COM 细节 ----

    def _com_init(self) -> None:
        import pythoncom

        # 同一个线程重复调用是安全的（返回 S_FALSE）
        pythoncom.CoInitialize()

    def _voice(self):
        """取当前线程的 SpVoice 实例。"""
        voice = getattr(self._local, "voice", None)
        if voice is None:
            self._com_init()
            import win32com.client

            voice = win32com.client.Dispatch("SAPI.SpVoice")
            self._local.voice = voice
        return voice

    def _voice_description(self, sp) -> str:
        try:
            return str(sp.Voice.GetDescription())
        except Exception:  # noqa: BLE001
            return "未知"

    def _pick_voice(self, sp, wanted: str):
        """挑音色。

        `default` 时**优先中文**：系统默认音色很可能是英文的（比如 Zira），
        拿它念中文会直接跳过不发声 —— 那种失败看起来像「引擎坏了」，
        其实是选错了音色。
        """
        key = (wanted or "").strip()
        if key and key.lower() not in ("default", "auto"):
            try:
                collection = sp.GetVoices()
                for i in range(collection.Count):
                    token = collection.Item(i)
                    if key.lower() in str(token.GetDescription()).lower():
                        return token
                log.warning("没找到音色 %r，改用默认", key)
            except Exception:  # noqa: BLE001
                log.debug("按名字挑音色失败", exc_info=True)
            return None

        try:
            collection = sp.GetVoices()
            best = None
            for i in range(collection.Count):
                token = collection.Item(i)
                lang = str(token.GetAttribute("Language") or "")
                try:
                    lcid = int(lang, 16)
                except ValueError:
                    lcid = -1
                if lcid == _ZH_CN_LCID:
                    return token
                if best is None and "chinese" in str(token.GetDescription()).lower():
                    best = token
            return best
        except Exception:  # noqa: BLE001
            log.debug("挑中文音色失败，交给系统默认", exc_info=True)
            return None


def _rate_from_speed(speed: float) -> int:
    """把前端的语速倍率映射到 SAPI 的 Rate（-10~10）。

    SAPI 的 Rate 不是线性的，这里只做近似映射 ——
    它是过渡引擎，语速精度不值得为它建一张标定表。
    """
    try:
        value = float(speed)
    except (TypeError, ValueError):
        value = 1.0
    value = min(max(value, 0.25), 4.0)
    return int(round(max(-10.0, min(10.0, (value - 1.0) * 4.0))))
