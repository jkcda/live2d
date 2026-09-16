"""能量法 VAD（零依赖）。

不是最准的，但**开箱即用**：不需要模型文件、不需要 onnxruntime。
对于「用户对着麦克风说话」这个场景足够 —— 关键是它足够快（32ms 一帧，
3 帧确认 = 96ms 就能触发打断），而打断的及时性比准确率重要得多。

误触发（把噪音当人声）的代价是 TTS 被掐断一次，可以接受；
漏触发（没听到用户开口）的代价是用户要等 TTS 说完才能插话，体验很差。
所以参数偏向**敏感**一侧。
"""

from __future__ import annotations

import numpy as np

from .base import FRAME_SAMPLES, VadEvent, VADEngine


class EnergyVAD(VADEngine):
    name = "energy"

    #: 判定为语音的能量倍数（相对自适应噪声底）
    RATIO = 2.8
    #: 绝对能量下限，避免在绝对安静时噪声底趋近 0 导致误触发
    MIN_RMS = 0.006
    #: 连续多少帧超阈值才确认「开始说话」（3 × 32ms ≈ 96ms）
    ATTACK_FRAMES = 3
    #: 连续多少帧低于阈值才确认「说完了」（20 × 32ms ≈ 640ms）
    RELEASE_FRAMES = 20

    #: 噪声底跟踪系数 —— 下降快（快速跟上安静环境）、上升慢（别把说话声当噪声）
    NOISE_DOWN = 0.30
    NOISE_UP = 0.004

    def __init__(self) -> None:
        self.reset()

    def availability(self) -> tuple[bool, str]:
        return True, "能量法 VAD（零依赖，对安静环境足够）"

    def reset(self) -> None:
        self._noise = 0.01
        self._speaking = False
        self._above = 0
        self._below = 0
        self._since_change = 0

    def process(self, frame: np.ndarray) -> VadEvent | None:
        samples = np.asarray(frame, dtype=np.float32).reshape(-1)
        if samples.size == 0:
            return None

        rms = float(np.sqrt(np.mean(samples * samples)))
        self._since_change += int(1000 * samples.size / 16000)

        # 噪声底：非语音段更新，且下降快、上升慢
        if rms < self._noise:
            self._noise = (1 - self.NOISE_DOWN) * self._noise + self.NOISE_DOWN * rms
        else:
            self._noise = (1 - self.NOISE_UP) * self._noise + self.NOISE_UP * rms
        self._noise = max(self._noise, 1e-5)

        threshold = max(self._noise * self.RATIO, self.MIN_RMS)
        is_loud = rms > threshold

        # 语音概率：超过阈值后线性归一，供前端做灵敏度可视化
        probability = float(np.clip((rms - threshold) / max(threshold, 1e-5), 0.0, 1.0))

        if is_loud:
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


__all__ = ["EnergyVAD", "FRAME_SAMPLES"]
