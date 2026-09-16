"""一条命令把一张立绘准备好：备份原图 → 抠背景 → 输出取景参数。

为什么要有这个脚本：手工做要三步，而且每步都有坑 ——
  1. 文件名必须是 body.png（叫 ComfyUI_00003_.png 应用认不出来）
  2. 背景必须抠掉，否则桌宠会顶着一个方块，且「只有她身上才响应」失效
  3. 抠完还要知道角色在画面里的位置（取景就是按它算的）

用法：
    cd python
    .venv/Scripts/python.exe tools/prepare_portrait.py "C:/path/to/你的立绘.png"

    # 素材目录不是默认位置时：
    .venv/Scripts/python.exe tools/prepare_portrait.py 图.png --out ../public/portrait

依赖：pip install onnxruntime pillow，模型见 tools/cutout.py 顶部说明。

注意：**换了底图，之前做好的嘴/眼差分就作废了**（差分必须和底图同尺寸同构图，
否则会错位）。所以先把底图定死，再做差分。
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from cutout import DEFAULT_MODEL, cutout

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "public" / "portrait"


def main() -> None:
    parser = argparse.ArgumentParser(description="准备立绘：备份 + 抠背景 + 报告取景参数")
    parser.add_argument("src", type=Path, help="输入立绘（PNG/JPG，随便什么文件名）")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="素材目录")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--keep-names", action="store_true", help="不重命名，只用原文件名（不推荐）")
    args = parser.parse_args()

    if not args.src.exists():
        raise SystemExit(f"找不到输入文件：{args.src}")

    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    raw_dst = out_dir / "body_original.png"
    body_dst = out_dir / "body.png"

    if args.src.resolve() != raw_dst:
        shutil.copy2(args.src, raw_dst)
        print(f"原图已备份 → {raw_dst}")

    info = cutout(raw_dst, body_dst, args.model)
    for k, v in info.items():
        print(f"{k}: {v}")

    # 取景参数就是内容包围盒，顺便把可选的 portrait.json 片段打出来
    x, y, w, h = info["内容包围盒_比例"]
    print()
    print("=== 下一步 ===")
    print(f"1. 立绘已就位：{body_dst}")
    print("2. 刷新应用（设置 → 角色 → 立绘差分），确认取景和命中区")
    print("3. 做嘴/眼差分：打开 http://localhost:5176/dev/diff-tool.html")
    print()
    print("如果自动推导的取景/命中区不满意，在 public/portrait/portrait.json 里覆盖：")
    print(
        "{\n"
        f'  "canvas": {{ "width": {info["尺寸"][0]}, "height": {info["尺寸"][1]} }},\n'
        f'  "content": {{ "x": {x}, "y": {y}, "width": {w}, "height": {h} }},\n'
        '  "regions": {\n'
        f'    "Head": {{ "x": {x}, "y": {y}, "width": {w}, "height": {round(h * 0.17, 3)} }},\n'
        f'    "Body": {{ "x": {x}, "y": {round(y + h * 0.17, 3)}, "width": {w}, "height": {round(h * 0.83, 3)} }}\n'
        "  }\n"
        "}"
    )


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
