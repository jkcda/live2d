"""上传参考音频，克隆一个音色到硅基流动。

## 为什么需要它

线上 TTS 默认只能用供应商的预设音色（`模型名:alex` 这种）。
想要**你自己的声音**，就得先把参考音频传上去，换回一个 voice uri。

这个脚本就是干这个的：把 `python/voices/` 下的一对素材
（`<名字>.wav` + 同名的 `.txt`）传上去，拿回 uri。

## 用法

    # 用 tools/tts-api.env 里的 key 和模型，克隆「少女」
    python tools/clone-voice.py 少女

    # 换个自定义名（uri 里会用到，建议用 ASCII）
    python tools/clone-voice.py 少女 --name shaonv

跑完会打印一行 `NEXUS_TTS_API_VOICE=speech:...`，
**把它填进 tools/tts-api.env** 就生效了。

## 参考音频的要求

- **5~10 秒**最好。太短音色不稳，太长上传慢且没额外收益
- 干净、单人、没有背景音乐
- 同名 `.txt` 必须是**音频里原样说的那句话** —— 这个文本是模型对齐用的，
  写错了克隆出来的音色会跑偏（但不会报错，只会"不太像"）
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
VOICES_DIR = ROOT / "python" / "voices"
ENV_FILE = ROOT / "tools" / "tts-api.env"


def read_env(path: Path) -> dict[str, str]:
    """读 tools/tts-api.env。解析规则和 start-api.ps1 保持一致（只认 KEY=VALUE 和 # 注释）。"""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        i = line.find("=")
        if i <= 0:
            continue
        out[line[:i].strip()] = line[i + 1 :].strip().strip('"').strip("'")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="上传参考音频克隆音色")
    ap.add_argument("voice", help="python/voices/ 下的名字（不带扩展名），例如 少女")
    ap.add_argument("--name", default="", help="自定义音色名，默认用 voice 参数")
    args = ap.parse_args()

    cfg = read_env(ENV_FILE)
    key = cfg.get("NEXUS_TTS_API_KEY", "")
    model = cfg.get("NEXUS_TTS_API_MODEL", "FunAudioLLM/CosyVoice2-0.5B")
    base = cfg.get("NEXUS_TTS_API_URL", "https://api.siliconflow.cn/v1")

    if not key:
        print(f"❌ {ENV_FILE} 里没有 NEXUS_TTS_API_KEY", file=sys.stderr)
        return 1

    wav = VOICES_DIR / f"{args.voice}.wav"
    txt = VOICES_DIR / f"{args.voice}.txt"
    if not wav.exists():
        print(f"❌ 找不到参考音频：{wav}", file=sys.stderr)
        return 1
    if not txt.exists():
        print(
            f"❌ 找不到参考文本：{txt}\n"
            f"   这个文件里要写**音频里原样说的那句话** —— 模型靠它对齐，写错了音色会跑偏",
            file=sys.stderr,
        )
        return 1

    text = txt.read_text(encoding="utf-8").strip()
    name = args.name or args.voice

    print(f"参考音频：{wav.name}（{wav.stat().st_size / 1024:.0f} KB）")
    print(f"参考文本：{text}")
    print(f"模型    ：{model}")
    print(f"音色名  ：{name}")
    print()

    with wav.open("rb") as f:
        resp = requests.post(
            f"{base.rstrip('/')}/uploads/audio/voice",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (wav.name, f, "audio/wav")},
            data={"model": model, "customName": name, "text": text},
            timeout=180,
            proxies={"http": None, "https": None},
        )

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}：{resp.text[:300]}", file=sys.stderr)
        return 1

    uri = resp.json().get("uri", "")
    if not uri:
        print(f"❌ 返回里没有 uri：{resp.text[:300]}", file=sys.stderr)
        return 1

    print("✅ 克隆成功。把下面这行填进 tools/tts-api.env：")
    print()
    print(f"NEXUS_TTS_API_VOICE={uri}")
    print()
    print("（也可以直接跑： .\\tools\\start-api.cmd 重启服务生效）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
