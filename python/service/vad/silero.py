"""Silero VAD（可选，需要 onnxruntime + 模型文件）。

比能量法准得多，尤其在**有背景噪音**的环境下（空调、键盘、音乐）。
代价是要装 onnxruntime 并下载一个约 2MB 的模型。

获取模型：
    pip install onnxruntime
    # 模型来自 https://github.com/snakers4/silero-vad
    # 放到 python/models/silero_vad.onnx，或用 NEXUS_SILERO_MODEL 指定
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np

from .base import FRAME_SAMPLES, SAMPLE_RATE, VadEvent, VADEngine

log = logging.getLogger(__name__)

DEFAULT_MODEL = Path(__file__).resolve().parents[2] / "models" / "silero_vad.onnx"

_INSTALL_HINT = (
    "Silero VAD 不可用。需要：\n"
    "  pip install onnxruntime\n"
    "  并下载 silero_vad.onnx 放到 python/models/，"
    "或用 NEXUS_SILERO_MODEL 指定路径。\n"
    "（当前会退回能量法 VAD）"
)


class SileroVAD(VADEngine):
    name = "silero"

    #: 判定为语音的概率阈值
    THRESHOLD = 0.5
    #: 确认开始说话所需帧数（2 × 32ms ≈ 64ms，比能量法更快）
    ATTACK_FRAMES = 2
    #: 确认结束所需帧数（16 × 32ms ≈ 512ms）
    RELEASE_FRAMES = 16

    def __init__(self, model_path: str = "") -> None:
        self._model_path = model_path
        self._session = None
        self._error: str | None = None
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._speaking = False
        self._above = 0
        self._below = 0
        self._since_change = 0

    def availability(self) -> tuple[bool, str]:
        if self._error:
            return False, self._error

        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            return False, _INSTALL_HINT

        path = self._resolve_model()
        if path is None:
            return False, _INSTALL_HINT

        return True, f"模型：{path}"

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._speaking = False
        self._above = 0
        self._below = 0
        self._since_change = 0

    def process(self, frame: np.ndarray) -> VadEvent | None:
        session = self._ensure_session()
        if session is None:
            return None

        samples = np.asarray(frame, dtype=np.float32).reshape(-1)
        if samples.size != FRAME_SAMPLES:
            # Silero 只接受固定 512 采样，长度不对就补齐/截断
            samples = np.resize(samples, FRAME_SAMPLES)

        # 一次 run 同时拿到概率和更新后的 state —— 分两次调会让 LSTM 状态推进两帧
        outputs = session.run(
            None,
            {
                "input": samples.reshape(1, -1),
                "state": self._state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            },
        )
        probability = float(outputs[0].item())
        self._state = outputs[1]

        self._since_change += int(1000 * samples.size / SAMPLE_RATE)
        is_speech = probability >= self.THRESHOLD

        if is_speech:
            self._above += 1
            self._below = 0
        else:
            self._below += 1
            self._above = 0

        changed = False
        if not self._speaking and self._above >= self.ATTACK_FRAMES:
            self._speaking = True
            changed = True
        elif self._speaking and self._below >= self.RELEASE_FRAMES:
            self._speaking = False
            changed = True

        if not changed:
            return None

        event = VadEvent(
            state="speech" if self._speaking else "silence",
            probability=probability,
            elapsed_ms=self._since_change,
        )
        self._since_change = 0
        return event

    def _ensure_session(self):
        if self._session is not None:
            return self._session
        if self._error:
            return None

        try:
            import onnxruntime as ort
        except ImportError:
            self._error = _INSTALL_HINT
            return None

        path = self._resolve_model()
        if path is None:
            self._error = _INSTALL_HINT
            return None

        log.info("载入 Silero VAD：%s", path)
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        return self._session

    def _resolve_model(self) -> Path | None:
        candidates = []
        env = self._model_path or os.environ.get("NEXUS_SILERO_MODEL", "")
        if env:
            candidates.append(Path(env))
        candidates.append(DEFAULT_MODEL)

        for path in candidates:
            if path.exists():
                return path
        return None
