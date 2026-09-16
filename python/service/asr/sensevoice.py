"""SenseVoice-Small ASR（FunASR）。

选它的理由：中文识别质量强、延迟低、模型小（约 250MB），
**CPU 上就能跑到实时**，不需要占 GPU —— GPU 要留给 TTS。

安装：
    pip install -e ".[asr]"

首次运行会自动从 ModelScope 下载模型（约 250MB）。
国内网络下 ModelScope 比 HuggingFace 稳，所以走它的默认源。
"""

from __future__ import annotations

import asyncio
import logging
import threading

import numpy as np

from .base import ASREngine

log = logging.getLogger(__name__)

_MODEL_ID = "iic/SenseVoiceSmall"

_INSTALL_HINT = (
    "SenseVoice 未安装。执行：\n"
    '  pip install -e ".[asr]"\n'
    "首次运行会自动下载模型（约 250MB）。"
)


class SenseVoiceASR(ASREngine):
    name = "sensevoice"

    def __init__(self, model_id: str = _MODEL_ID, device: str = "cpu") -> None:
        self._model_id = model_id
        self._device = device
        self._model = None
        self._error: str | None = None
        # 模型推理不是线程安全的
        self._lock = threading.Lock()

    def availability(self) -> tuple[bool, str]:
        if self._error:
            return False, self._error
        try:
            import funasr  # noqa: F401
        except ImportError:
            return False, _INSTALL_HINT
        return True, f"模型：{self._model_id}（{self._device}）"

    async def transcribe(self, pcm: np.ndarray, sample_rate: int) -> str:
        # 推理阻塞且吃 CPU，扔线程池，别堵事件循环
        return await asyncio.to_thread(self._transcribe_sync, pcm, sample_rate)

    def _transcribe_sync(self, pcm: np.ndarray, sample_rate: int) -> str:
        model = self._ensure_model()

        audio = np.asarray(pcm, dtype=np.float32).reshape(-1)
        if audio.size == 0:
            return ""

        # SenseVoice 要求 16kHz
        if sample_rate != 16000:
            audio = _resample(audio, sample_rate, 16000)

        # 太短的片段基本是噪音，送进去只会得到幻觉文本
        if audio.size < 16000 * 0.2:
            return ""

        with self._lock:
            result = model.generate(
                input=audio,
                cache={},
                language="zh",
                use_itn=True,
                batch_size_s=60,
            )

        if not result:
            return ""

        raw = result[0].get("text", "")
        return _postprocess(raw)

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        if self._error:
            raise RuntimeError(self._error)

        try:
            from funasr import AutoModel
        except ImportError as err:
            self._error = _INSTALL_HINT
            raise RuntimeError(self._error) from err

        log.info("载入 SenseVoice：%s（首次会下载模型）", self._model_id)
        self._model = AutoModel(
            model=self._model_id,
            device=self._device,
            # 关掉内置 VAD —— 我们已经在上游做了 VAD 和切段，
            # 再套一层会把短句切碎
            disable_pbar=True,
            disable_update=True,
        )
        log.info("SenseVoice 就绪")
        return self._model


def _postprocess(raw: str) -> str:
    """去掉 SenseVoice 输出里的富文本标记。

    原始输出形如 `<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好呀`，
    这些标记是给下游做情感/语种分析用的，直接显示会很脏。
    """
    try:
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        return rich_transcription_postprocess(raw).strip()
    except Exception:  # noqa: BLE001 - 拿不到就用兜底逻辑
        import re

        return re.sub(r"<\|[^|]*\|>", "", raw).strip()


def _resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """线性插值重采样。

    对语音识别足够用 —— 它关心的是频谱包络，不是高保真度。
    真要讲究可以用 librosa / torchaudio，但没必要为此多装依赖。
    """
    if src_rate == dst_rate or audio.size == 0:
        return audio
    duration = audio.size / src_rate
    target_len = int(duration * dst_rate)
    src_idx = np.linspace(0, audio.size - 1, target_len)
    return np.interp(src_idx, np.arange(audio.size), audio).astype(np.float32)
