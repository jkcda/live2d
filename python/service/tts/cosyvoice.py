"""CosyVoice 2 引擎。

懒加载：模型只在第一次合成时载入，服务启动不会卡几十秒。
缺依赖或模型时给出可执行的补救指令，而不是抛一堆 ImportError 堆栈。

安装：
    pip install -e ".[cosyvoice]"
    # 再从官方仓库拉模型权重到 pretrained_models/CosyVoice2-0.5B

音色两种用法：
    1. 内置说话人 —— voice 传 '中文女' / '中文男' 这类官方 spk_id
    2. 克隆音色   —— 在 python/voices/ 放 <名字>.wav 和同名 <名字>.txt（参考音频的文本）
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path

import numpy as np

from ..audio import encode_wav
from .base import TTSEngine

log = logging.getLogger(__name__)

# 参考音频目录（克隆音色放这里）
VOICES_DIR = Path(__file__).resolve().parents[2] / "voices"

_INSTALL_HINT = (
    "CosyVoice 未安装。执行：\n"
    '  pip install -e ".[cosyvoice]"\n'
    "然后从 https://github.com/FunAudioLLM/CosyVoice 获取 CosyVoice2-0.5B 权重，\n"
    "放到 python/pretrained_models/CosyVoice2-0.5B，或用 NEXUS_COSYVOICE_DIR 指定路径。"
)


class CosyVoiceEngine(TTSEngine):
    """CosyVoice 2（0.5B）流式 TTS。"""

    name = "cosyvoice"

    def __init__(self, model_dir: str = "", sample_rate: int = 24000) -> None:
        self._model_dir = model_dir
        self._sample_rate = sample_rate
        self._model = None
        self._load_error: str | None = None
        # 模型加载与推理都不是线程安全的，串行化
        self._lock = threading.Lock()

    # ---- 元信息 ----

    @property
    def sample_rate(self) -> int:
        if self._model is not None:
            return int(getattr(self._model, "sample_rate", self._sample_rate))
        return self._sample_rate

    def availability(self) -> tuple[bool, str]:
        if self._load_error:
            return False, self._load_error

        try:
            import cosyvoice  # noqa: F401
        except ImportError:
            return False, _INSTALL_HINT

        path = self._resolve_model_dir()
        if path is None:
            return False, (
                f"没找到 CosyVoice 模型目录。用 NEXUS_COSYVOICE_DIR 指定，"
                f"或放到 python/pretrained_models/CosyVoice2-0.5B。"
            )

        return True, f"模型目录：{path}"

    def voices(self) -> list[str]:
        names: list[str] = []

        # 官方内置说话人
        if self._model is not None:
            try:
                names.extend(self._model.list_available_spks())
            except Exception:  # noqa: BLE001 - 不同版本 API 不一致，拿不到就算了
                pass

        # 用户克隆音色
        names.extend(profile.stem for profile in sorted(VOICES_DIR.glob("*.wav")))

        return names or ["中文女"]

    # ---- 加载与合成 ----

    def warmup(self) -> None:
        """提前把模型载入显存。服务启动时按需调用。"""
        self._ensure_model()

    async def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        # 推理是阻塞的且吃 GPU，扔到线程池避免堵住事件循环
        samples = await asyncio.to_thread(self._synthesize_sync, text, voice, speed)
        return encode_wav(samples, self.sample_rate)

    def _synthesize_sync(self, text: str, voice: str, speed: float) -> np.ndarray:
        model = self._ensure_model()

        profile = VOICES_DIR / f"{voice}.wav"
        chunks: list[np.ndarray] = []

        with self._lock:
            if profile.exists():
                chunks.extend(self._infer_zero_shot(model, text, profile, speed))
            else:
                chunks.extend(self._infer_sft(model, text, voice, speed))

        if not chunks:
            raise RuntimeError("CosyVoice 没有返回任何音频")

        return np.concatenate(chunks)

    def _infer_sft(self, model, text: str, voice: str, speed: float) -> list[np.ndarray]:
        """内置说话人。"""
        out: list[np.ndarray] = []
        for result in model.inference_sft(text, voice, stream=False, speed=speed):
            out.append(_to_numpy(result["tts_speech"]))
        return out

    def _infer_zero_shot(self, model, text: str, profile: Path, speed: float) -> list[np.ndarray]:
        """零样本克隆：用一段参考音频 + 它的文本，复刻音色。"""
        import torchaudio  # 延迟导入，只在真正用克隆音色时才需要

        prompt_text_file = profile.with_suffix(".txt")
        if not prompt_text_file.exists():
            raise FileNotFoundError(
                f"克隆音色缺少参考文本：{prompt_text_file.name}\n"
                f"请在该 wav 旁边放一个同名 .txt，内容为这段音频里说的话。"
            )

        prompt_text = prompt_text_file.read_text(encoding="utf-8").strip()
        prompt_speech, sr = torchaudio.load(str(profile))

        # CosyVoice 要求 16kHz 单声道参考音频
        if sr != 16000:
            prompt_speech = torchaudio.functional.resample(prompt_speech, sr, 16000)
        if prompt_speech.shape[0] > 1:
            prompt_speech = prompt_speech.mean(dim=0, keepdim=True)

        out: list[np.ndarray] = []
        for result in model.inference_zero_shot(
            text, prompt_text, prompt_speech, stream=False, speed=speed
        ):
            out.append(_to_numpy(result["tts_speech"]))
        return out

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        if self._load_error:
            raise RuntimeError(self._load_error)

        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2
        except ImportError as err:
            self._load_error = _INSTALL_HINT
            raise RuntimeError(self._load_error) from err

        path = self._resolve_model_dir()
        if path is None:
            self._load_error = (
                "没找到 CosyVoice 模型目录。用 NEXUS_COSYVOICE_DIR 指定，"
                "或放到 python/pretrained_models/CosyVoice2-0.5B。"
            )
            raise RuntimeError(self._load_error)

        log.info("载入 CosyVoice 2：%s", path)
        # fp16 省显存；JIT/TRT 加速默认关掉，兼容性优先
        self._model = CosyVoice2(str(path), load_jit=False, load_trt=False, fp16=True)
        log.info("CosyVoice 2 就绪，采样率 %d", self.sample_rate)
        return self._model

    def _resolve_model_dir(self) -> Path | None:
        if self._model_dir:
            p = Path(self._model_dir)
            return p if p.exists() else None

        default = Path(__file__).resolve().parents[2] / "pretrained_models" / "CosyVoice2-0.5B"
        return default if default.exists() else None


def _to_numpy(tensor) -> np.ndarray:
    """把 torch tensor 转成 float32 numpy 单声道。"""
    arr = tensor.detach().cpu().numpy()
    if arr.ndim > 1:
        arr = arr.squeeze()
    return arr.astype(np.float32)
