"""内置合成音引擎（开发用）。

不是真实语音 —— 它按文本生成一段带音节节奏的类人声波形。

存在的意义：让整条链路（切句 → 合成 → 排队 → 播放 → 口型 → 打断）
在**不装 CosyVoice、不需要 GPU** 的前提下就能验证。
切到 cosyvoice 引擎后，前端一行都不用改。
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

import numpy as np

from ..audio import encode_wav
from .base import TTSEngine

# 各类字符的时长（秒），语速会在此基础上整体缩放
_SYLLABLE_SEC = 0.185
_PAUSE_MINOR = 0.16  # ，、,:
_PAUSE_MAJOR = 0.34  # 。！？.!?;
_PAUSE_SPACE = 0.07

_MINOR_PUNCT = set("，、,:：")
_MAJOR_PUNCT = set("。！？!?;；")

# 不同音色的基频
_BASE_PITCH = {"default": 190.0, "low": 138.0, "high": 252.0}

# 最长合成时长，防止异常输入把服务拖死
_MAX_SECONDS = 30.0


@dataclass
class Segment:
    kind: str  # 'syllable' | 'pause'
    duration: float
    pitch: float = 0.0


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF or 0x3040 <= code <= 0x30FF


def plan(text: str) -> list[Segment]:
    """把文本拆成音节与停顿的序列。"""
    segments: list[Segment] = []
    latin_run = 0

    def flush_latin() -> None:
        """连续的拉丁字母/数字按平均 2.5 字符一个音节折算。"""
        nonlocal latin_run
        if latin_run <= 0:
            return
        count = max(1, math.ceil(latin_run / 2.5))
        per = _SYLLABLE_SEC * latin_run / count
        for _ in range(count):
            segments.append(Segment("syllable", per))
        latin_run = 0

    for ch in text:
        if ch in _MAJOR_PUNCT:
            flush_latin()
            segments.append(Segment("pause", _PAUSE_MAJOR))
        elif ch in _MINOR_PUNCT:
            flush_latin()
            segments.append(Segment("pause", _PAUSE_MINOR))
        elif ch.isspace():
            flush_latin()
            segments.append(Segment("pause", _PAUSE_SPACE))
        elif _is_cjk(ch):
            flush_latin()
            segments.append(Segment("syllable", _SYLLABLE_SEC))
        else:
            latin_run += 1

    flush_latin()
    return segments


def render(text: str, sample_rate: int, speed: float = 1.0, voice: str = "default") -> np.ndarray:
    """按文本渲染波形。同样的文本产出同样的音频（便于复现问题）。"""
    segments = plan(text)
    if not segments:
        # 空文本也要给一个极短的静音，避免前端拿到空 buffer
        return np.zeros(int(sample_rate * 0.05), dtype=np.float32)

    speed = max(0.25, min(4.0, speed))
    base_pitch = _BASE_PITCH.get(voice, _BASE_PITCH["default"])

    # 用文本做种子 —— 同一句话每次听起来一致，方便对比调试
    rng = random.Random(hash(text) & 0xFFFFFFFF)

    total = sum(s.duration for s in segments) / speed
    if total > _MAX_SECONDS:
        scale = _MAX_SECONDS / total
        for s in segments:
            s.duration *= scale

    out = np.zeros(int(sample_rate * _MAX_SECONDS), dtype=np.float32)
    cursor = 0
    voiced_index = 0
    voiced_total = max(1, sum(1 for s in segments if s.kind == "syllable"))

    for seg in segments:
        length = int(sample_rate * seg.duration / speed)
        if length <= 0:
            continue
        if cursor + length > out.size:
            break

        if seg.kind == "pause":
            cursor += length
            continue

        # 音高：整体缓慢下行的语调 + 逐音节抖动
        progress = voiced_index / voiced_total
        contour = 1.0 + 0.10 * (1.0 - progress) - 0.05 * progress
        jitter = 1.0 + rng.uniform(-0.07, 0.07)
        f0 = base_pitch * contour * jitter

        t = np.arange(length, dtype=np.float32) / sample_rate
        phase = t / max(seg.duration / speed, 1e-6)

        # 音节包络：起音快、收尾慢
        env = np.sin(np.pi * np.clip(phase, 0.0, 1.0)) ** 1.4

        # 轻微颤音，让长音不那么死板
        vibrato = 1.0 + 0.012 * np.sin(2 * np.pi * 5.2 * t)

        # 基频 + 三次谐波，模拟人声的丰富度（纯正弦听起来像电子音）
        wave_ = (
            np.sin(2 * np.pi * f0 * t * vibrato)
            + 0.50 * np.sin(2 * np.pi * f0 * 2 * t * vibrato)
            + 0.26 * np.sin(2 * np.pi * f0 * 3 * t * vibrato)
            + 0.12 * np.sin(2 * np.pi * f0 * 4 * t * vibrato)
        ) / 1.88

        out[cursor : cursor + length] = wave_ * env * 0.34
        cursor += length
        voiced_index += 1

    return out[:cursor]


class ToneEngine(TTSEngine):
    """零依赖的合成音引擎。"""

    name = "tone"

    def __init__(self, sample_rate: int = 24000) -> None:
        self._sample_rate = sample_rate

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def availability(self) -> tuple[bool, str]:
        return True, "内置合成音（开发用，非真实语音）"

    def voices(self) -> list[str]:
        return list(_BASE_PITCH.keys())

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        samples = render(text, self._sample_rate, speed, voice)
        return encode_wav(samples, self._sample_rate)
