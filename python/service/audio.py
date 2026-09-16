"""音频编解码工具。

只用标准库 + numpy —— 不引入 soundfile，避免为了跑通链路先装一堆东西。
"""

from __future__ import annotations

import io
import wave

import numpy as np

# 16-bit PCM 的满量程
_PCM_MAX = 32767.0


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """把 [-1, 1] 的浮点单声道波形编码成 16-bit PCM WAV。

    浏览器的 decodeAudioData 能直接吃这个格式。
    """
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (clipped * _PCM_MAX).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """解码 WAV 为 (float32 单声道波形, 采样率)。"""
    with wave.open(io.BytesIO(data), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())

    if width != 2:
        raise ValueError(f"只支持 16-bit PCM，收到 {width * 8}-bit")

    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / _PCM_MAX

    # 多声道下混为单声道 —— 前端只做单声道口型分析
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)

    return pcm, rate
