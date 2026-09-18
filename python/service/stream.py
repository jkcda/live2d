"""`WS /stream` 实时输入通道。

职责：麦克风音频 → VAD → ASR → 事件推给前端。

**为什么 TTS 不在这条通道上**：TTS 是「一句一个离散请求」，用 HTTP POST 更简单，
而且前端已经接好了。这条通道只承载**必须流式**的东西 —— 麦克风音频。

## 协议

上行
    <binary>                      原始 PCM，int16 小端，16kHz 单声道
    {"type":"interrupt"}          用户插话：重置 VAD、丢弃正在累积的语音
    {"type":"reset"}              同上（语义别名，前端用哪个都行）
    {"type":"flush"}              **我说完了** —— 把累积的音频送去识别
    {"type":"stop"}               同上（语义别名）

下行
    {"type":"ready", ...}         连接建立，报告引擎与帧格式
    {"type":"vad", "state":"speech"|"silence", "probability":0.8}
    {"type":"asr_start"}          语音结束，开始识别（UI 可以显示「识别中…」）
    {"type":"asr", "text":"...", "final":true}
    {"type":"error", "message":"..."}

## 什么时候收尾：手动，不是自动

**VAD 报静音不再触发识别。** 只有客户端发 `flush` 才收尾。

原因：VAD 的静音判定太敏感 —— 停半秒喘口气就被切成一句，
用户听到的是半截话，下一句还会被当成新的一轮。
**「我说完了」只有用户自己知道。**

VAD 仍然在跑，它现在只干两件事：
  · 给前端做 **barge-in**（`vad: speech` → 掐断 TTS）
  · 记录语音边界（预滚缓冲靠它保住第一个音节）

`MAX_UTTERANCE_MS` 那条兜底必须留着 —— 手动模式下一个忘了按停的人会把内存吃满。

## 并发模型

收包循环只做「拆帧 + 喂 VAD」，**不做 ASR** ——
ASR 要几百毫秒，如果放在收包循环里，用户在这期间开口会被丢掉。
ASR 丢到独立 task，结果通过 outbox 队列回传。

发送统一走 `_outbox` + 单独的 sender task：
Starlette 的 WebSocket.send 不是并发安全的，多个 task 直接 send 会串帧。
"""

from __future__ import annotations

import asyncio
import json
import logging

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect

from .asr import ASREngine
from .vad import FRAME_SAMPLES, SAMPLE_RATE, VADEngine

log = logging.getLogger(__name__)

#: 语音开始前保留的预滚缓冲。不留的话第一个音节会被削掉 ——
#: VAD 需要 3 帧才能确认「开始说话」，那 96ms 的音频不能丢。
PREROLL_MS = 300

#: 单次语音的最长时长。超过就强制切断去识别，防止有人对着麦克风唱歌把内存吃满
MAX_UTTERANCE_MS = 30_000

#: 累积多长的静音就认为这句话结束了（由 VAD 决定，这里只是兜底）
SILENCE_FLUSH_MS = 800


class StreamSession:
    """一条 WebSocket 连接对应一个会话。"""

    def __init__(self, ws: WebSocket, vad: VADEngine, asr: ASREngine | None) -> None:
        self._ws = ws
        self._vad = vad
        self._asr = asr

        self._outbox: asyncio.Queue[dict | bytes | None] = asyncio.Queue()
        self._sender: asyncio.Task | None = None
        self._asr_task: asyncio.Task | None = None

        # 收包缓冲：TCP/WS 不保证帧边界，收到的可能是半个帧或三个帧
        self._raw = bytearray()
        # 预滚缓冲（说话前的那一小段）
        self._preroll: list[np.ndarray] = []
        self._preroll_samples = 0
        # 当前这句话累积的波形
        self._utterance: list[np.ndarray] = []
        self._utterance_samples = 0
        self._speaking = False

    # ------------------------------------------------------------ 生命周期

    async def run(self) -> None:
        await self._ws.accept()
        self._sender = asyncio.create_task(self._send_loop())

        ok, reason = self._vad.availability()
        asr_ok, asr_reason = (False, "未启用") if self._asr is None else self._asr.availability()

        await self._emit(
            {
                "type": "ready",
                "sample_rate": SAMPLE_RATE,
                "frame_samples": FRAME_SAMPLES,
                "vad": self._vad.name,
                "vad_ready": ok,
                "vad_detail": reason,
                "asr": self._asr.name if self._asr else None,
                "asr_ready": asr_ok,
                "asr_detail": asr_reason,
            }
        )

        try:
            while True:
                message = await self._ws.receive()
                if message["type"] == "websocket.disconnect":
                    break

                if (data := message.get("bytes")) is not None:
                    await self._on_audio(data)
                elif (text := message.get("text")) is not None:
                    await self._on_control(text)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - 连接异常不该污染日志
            log.exception("WS 会话异常")
        finally:
            await self._shutdown()

    async def _shutdown(self) -> None:
        for task in (self._asr_task, self._sender):
            if task and not task.done():
                task.cancel()
        if self._sender:
            await asyncio.gather(self._sender, return_exceptions=True)
        if self._asr_task:
            await asyncio.gather(self._asr_task, return_exceptions=True)
        self._asr_task = None

    # ------------------------------------------------------------ 收包

    async def _on_control(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            log.warning("收到非 JSON 控制帧：%r", text[:80])
            return

        kind = msg.get("type")

        if kind in ("interrupt", "reset"):
            # 用户插话：丢掉正在累积的语音，重置 VAD
            self._vad.reset()
            self._preroll.clear()
            self._preroll_samples = 0
            self._utterance.clear()
            self._utterance_samples = 0
            self._speaking = False
            await self._emit({"type": "vad", "state": "silence", "probability": 0.0})
            return

        if kind in ("flush", "stop"):
            # ★ 手动结束这一轮说话：把累积的音频送去识别。
            #
            # 以前是 **VAD 一报静音就自动收尾** —— 但那个判定太敏感：
            # 停半秒喘口气就被切成一句，用户听到的是半截话，
            # 而且下一句还会被当成新的一轮。
            #
            # **「我说完了」这件事只有用户自己知道**，所以改成客户端显式通知。
            #
            # VAD 仍然在跑，它现在只干两件事：
            #   · 给前端做 barge-in（`vad: speech` → 掐断 TTS）
            #   · 记录语音边界（预滚缓冲靠它保住第一个音节）
            self._flush_utterance()
            return

    async def _on_audio(self, data: bytes) -> None:
        self._raw.extend(data)

        frame_bytes = FRAME_SAMPLES * 2  # int16
        while len(self._raw) >= frame_bytes:
            chunk = bytes(self._raw[:frame_bytes])
            del self._raw[:frame_bytes]
            await self._on_frame(chunk)

    async def _on_frame(self, chunk: bytes) -> None:
        samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0

        # 预滚：不管说没说话都留着最近 300ms
        if not self._speaking:
            self._preroll.append(samples)
            self._preroll_samples += samples.size
            while self._preroll_samples > SAMPLE_RATE * PREROLL_MS // 1000 and self._preroll:
                self._preroll_samples -= self._preroll.pop(0).size

        event = self._vad.process(samples)

        if event is not None:
            await self._emit(
                {
                    "type": "vad",
                    "state": event.state,
                    "probability": round(event.probability, 3),
                }
            )
            if event.state == "speech":
                self._begin_utterance()
            # ★ 静音**不再自动收尾** —— 见下面 flush 的注释

        if self._speaking:
            self._utterance.append(samples)
            self._utterance_samples += samples.size

            if self._utterance_samples > SAMPLE_RATE * MAX_UTTERANCE_MS // 1000:
                # 说太久了，强制切断去识别（这条兜底必须留着 ——
                # 手动模式下一个忘了按停的人会把内存吃满）
                self._flush_utterance()

    # ------------------------------------------------------------ 语音片段

    def _begin_utterance(self) -> None:
        self._speaking = True
        # 把预滚缓冲接上，保住第一个音节
        self._utterance = list(self._preroll)
        self._utterance_samples = self._preroll_samples
        self._preroll.clear()
        self._preroll_samples = 0

    def _flush_utterance(self) -> None:
        if not self._speaking:
            return

        self._speaking = False
        chunks = self._utterance
        total = self._utterance_samples
        self._utterance = []
        self._utterance_samples = 0

        if total < SAMPLE_RATE * 0.2:  # 不到 200ms，当噪音丢掉
            return
        if self._asr is None:
            return
        if self._asr_task and not self._asr_task.done():
            # 上一次识别还没回来，这次跳过 —— 总比排队堆积好
            return

        pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        self._asr_task = asyncio.create_task(self._recognize(pcm))

    async def _recognize(self, pcm: np.ndarray) -> None:
        await self._emit({"type": "asr_start"})
        try:
            text = await self._asr.transcribe(pcm, SAMPLE_RATE)  # type: ignore[union-attr]
        except Exception as err:  # noqa: BLE001
            log.exception("ASR 失败")
            await self._emit({"type": "error", "message": f"识别失败：{err}"})
            return

        await self._emit({"type": "asr", "text": text, "final": True})

    # ------------------------------------------------------------ 发送

    async def _emit(self, payload: dict) -> None:
        await self._outbox.put(payload)

    async def _send_loop(self) -> None:
        while True:
            item = await self._outbox.get()
            if item is None:
                break
            try:
                await self._ws.send_text(json.dumps(item, ensure_ascii=False))
            except Exception:  # noqa: BLE001 - 连接已断，退出即可
                break
