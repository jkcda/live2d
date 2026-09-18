"""服务配置。

全部通过环境变量覆盖，默认值面向「本地开发、开箱即跑」。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    """运行时配置。实例化时读取一次环境变量。"""

    # ---- 服务 ----
    host: str
    port: int
    # 允许的跨域来源。前端在 5176 端口跑，不配 CORS 浏览器会直接拦掉请求
    cors_origins: tuple[str, ...]

    # ---- 引擎 ----
    # tone = 内置合成音，零依赖，用来验证链路；cosyvoice = 真实 TTS
    engine: str
    default_voice: str
    sample_rate: int

    # ---- CosyVoice ----
    # 模型目录，留空则用官方默认下载路径
    cosyvoice_model_dir: str
    cosyvoice_load_on_start: bool

    # ---- 线上 TTS（engine=openai）----
    # 任何 OpenAI 兼容的 /v1/audio/speech 端点。不占显存、不用预热，代价是联网 + 按量计费。
    # URL 填到 /v1 为止（引擎自己拼 /audio/speech）
    tts_api_url: str
    tts_api_key: str
    tts_api_model: str
    tts_api_voice: str

    # ---- VAD ----
    # energy = 零依赖能量法（默认）；silero = 更准，需 onnxruntime + 模型
    vad_engine: str

    # ---- ASR ----
    # none = 不启用（默认）；sensevoice = FunASR SenseVoice-Small
    # 不启用时 VAD 与打断依然工作，只是语音进不了 LLM
    asr_engine: str
    asr_device: str

    @classmethod
    def from_env(cls) -> "Settings":
        origins = _env("NEXUS_CORS_ORIGINS", "*")
        return cls(
            host=_env("NEXUS_HOST", "127.0.0.1"),
            port=_env_int("NEXUS_PORT", 8765),
            cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
            engine=_env("NEXUS_TTS_ENGINE", "tone").strip().lower(),
            default_voice=_env("NEXUS_TTS_VOICE", "default"),
            sample_rate=_env_int("NEXUS_SAMPLE_RATE", 24000),
            cosyvoice_model_dir=_env("NEXUS_COSYVOICE_DIR", ""),
            cosyvoice_load_on_start=_env("NEXUS_COSYVOICE_WARMUP", "0") == "1",
            tts_api_url=_env("NEXUS_TTS_API_URL", "").strip(),
            tts_api_key=_env("NEXUS_TTS_API_KEY", "").strip(),
            tts_api_model=_env("NEXUS_TTS_API_MODEL", "tts-1").strip(),
            tts_api_voice=_env("NEXUS_TTS_API_VOICE", "").strip(),
            vad_engine=_env("NEXUS_VAD_ENGINE", "energy").strip().lower(),
            asr_engine=_env("NEXUS_ASR_ENGINE", "none").strip().lower(),
            asr_device=_env("NEXUS_ASR_DEVICE", "cpu").strip().lower(),
        )


settings = Settings.from_env()
