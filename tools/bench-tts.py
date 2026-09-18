"""CosyVoice 合成的 A/B 基准：量 RTF 和首块延迟。

**为什么不走 HTTP 服务**：一个进程里「加载 → 注册音色 → 预热 → 跑固定文本 → 退出」，
条件干净。走服务的话，加载和预热会被算进去，而且服务本身的生命周期会干扰。

**为什么要 A/B/A 跑三遍**：这台机器上 RTF 的波动极大 ——
空闲时 0.74~0.94，GPU 上同时跑着 Edge 视频 + Live2D 时 1.2~1.6，**差近一倍**。
所以「优化前后各跑一次」很容易把「这次机器更闲」误判成「优化生效了」。
跑 A/B/A，两次 A 对得上才说明条件没漂。

用法：
    python tools/bench-tts.py            # 基线
    python tools/bench-tts.py --jit      # 开 JIT
    python tools/bench-tts.py --label "改了 X 之后"

用 /d/cosyvoice 的 venv 跑（需要 numpy/torch）：
    D:\\cosyvoice\\.venv\\Scripts\\python.exe tools/bench-tts.py

## 2026-09-18 的实测结论（就是这个脚本跑出来的）

    JIT 关（第一次）  RTF 中位 0.82｜首块中位 3.17s
    JIT 开            RTF 中位 1.56｜首块中位 6.70s
    JIT 关（第二次）  RTF 中位 0.83｜首块中位 3.12s   ← 对照，条件没漂

JIT 把**前 3 句拖慢 3~4 倍**（5 字：2.03s → 10.94s），后 3 句和基线一样。
原因是 JIT 惰性编译 —— 按 shape 首次使用时才编译，预热那句覆盖不到。
**稳态没有任何收益，冷启动代价巨大。结论：JIT 对本项目不适用。**
"""

import argparse
import statistics
import sys
import time
from pathlib import Path

import torch

COSY_ROOT = Path(r"D:\cosyvoice")
sys.path.insert(0, str(COSY_ROOT))
sys.path.insert(0, str(COSY_ROOT / "third_party" / "Matcha-TTS"))

from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

MODEL_DIR = COSY_ROOT / "pretrained_models" / "CosyVoice2-0.5B"
VOICES_DIR = Path(r"D:\nexus\live2d\python\voices")
VOICE = "少女"

# 固定文本：短中长都有，和真实对话的分布接近
TEXTS = [
    "嗯，我在。",
    "好，我看看。",
    "这个我也说不好，你得自己拿主意。",
    "你从下午两点就开始写这个了，中间只起来倒过一次水。",
    "今天天气还不错，你要是想出去走走的话，记得带件外套，晚上会凉。",
    "欸，你刚才说的那个我想了想，好像有点道理，但也不全是那么回事。",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jit", action="store_true", help="开启 JIT")
    ap.add_argument("--label", default="", help="这一轮的名字，方便对比（默认按 --jit 推断）")
    args = ap.parse_args()

    label = args.label or ("JIT 开" if args.jit else "JIT 关")

    t0 = time.time()
    model = CosyVoice2(str(MODEL_DIR), load_jit=args.jit, load_trt=False, fp16=True)
    load_s = time.time() - t0

    wav = VOICES_DIR / f"{VOICE}.wav"
    prompt_text = (VOICES_DIR / f"{VOICE}.txt").read_text(encoding="utf-8").strip()
    model.add_zero_shot_spk(prompt_text, str(wav), VOICE)

    # 预热：JIT 的内核编译发生在这里，别让它污染测量
    t0 = time.time()
    for _ in model.inference_zero_shot("预热一下。", "", "", VOICE, stream=True, speed=1.0):
        pass
    torch.cuda.synchronize()
    warm_s = time.time() - t0

    print(f"\n{'=' * 62}")
    print(f"  {label}   （加载 {load_s:.1f}s｜预热 {warm_s:.1f}s）")
    print(f"{'=' * 62}")
    print(f"  {'字数':>4} {'首块':>7} {'总计':>7} {'音频':>7} {'RTF':>6} {'块':>3}")
    print(f"  {'-' * 44}")

    rtfs: list[float] = []
    firsts: list[float] = []

    for text in TEXTS:
        torch.cuda.synchronize()
        t0 = time.time()
        first = 0.0
        audio = 0.0
        n = 0
        for out in model.inference_zero_shot(text, "", "", VOICE, stream=True, speed=1.0):
            if not first:
                first = time.time() - t0
            audio += out["tts_speech"].shape[1] / model.sample_rate
            n += 1
        total = time.time() - t0
        rtf = total / audio if audio else 0.0
        rtfs.append(rtf)
        firsts.append(first)
        print(f"  {len(text):>4} {first:>6.2f}s {total:>6.2f}s {audio:>6.2f}s {rtf:>6.2f} {n:>3}")

    print(f"  {'-' * 44}")
    print(f"  中位 RTF     {statistics.median(rtfs):.2f}")
    print(f"  中位首块     {statistics.median(firsts):.2f}s")
    print(f"  总计（6 句） {sum(rtfs) / len(rtfs) * 0:.0f}——见上表")
    print()
    print(f"  汇总行（方便复制对比）：{label}｜RTF 中位 {statistics.median(rtfs):.2f}"
          f"｜首块中位 {statistics.median(firsts):.2f}s"
          f"｜RTF 范围 {min(rtfs):.2f}~{max(rtfs):.2f}")


if __name__ == "__main__":
    main()
