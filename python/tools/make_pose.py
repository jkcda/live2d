"""把「AI 改过的整身图」做成姿态差分（`pose_<id>.png`）。

为什么要单独一个脚本、而且和表情那条路完全不同：

  表情（`expr_*.png`）是**叠在脸上一层差分** —— 只取改动区域，其余透明，
  所以"原来的五官"自动被盖住。

  姿态不行。"把手放下来"这件事没法靠叠一层表达：差分图层只能往上**加**像素，
  加不出"擦掉"的效果，原来垂着的那条胳膊会留在原地（看起来她有两只手）。
  所以姿态必须是**整身替换图**，切换时和底图交叉淡入淡出。

但整身替换会带出一个新问题：AI 改图时**顺手把整张脸也重画了一遍**
（实测：瞳孔、发丝边缘、脸颊阴影一共约 1.8 万像素和底图不一致）。
直接换上去的话，她一招手脸就轻微变样 —— 很出戏。

所以这个脚本做两件事：
  1. 抠底（isnet-anime，和 cutout.py 同一个模型）；
  2. 把**头部区域**恢复成底图那张（默认 x≥640、y<520 这块矩形里，
     凡是底图有像素的地方一律用底图的）。

这样挥手期间脸和头发是**逐像素相同**的，动的只有身体和手臂。
恢复区域是个矩形是有意为之：它是"框住整个头、但不压到抬起来的手臂"的那个框，
脚本会自检并把结果报出来（头部区域改了 0 个像素才算过）。

用法（先备份素材，脚本不覆盖底图）：

    cd python
    .venv/Scripts/python tools/make_pose.py ../vendor/portrait-ai-output/招手.png \
        --base ../public/portrait/body.png --out ../public/portrait/pose_wave.png

自检不通过（头部区域有改动）时退出码为 1，别直接把图放进素材目录。

环境：需要 onnxruntime（抠图）+ pillow + numpy，可用 scipy 更稳（去碎块）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 抠图和底图准备共用同一份实现，避免两边的掩码参数漂移
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cutout import DEFAULT_MODEL, cutout  # noqa: E402

#: 默认的"头部区域"：这个矩形里凡是底图有像素的地方都用底图。
#:
#: 为什么是 640,0 ~ 1600,520（当前素材 1600×2848 实测）：
#:   · 左边 640 是头部轮廓的左缘外侧（再往左就是抬起来的手臂所在的空档）；
#:   · 下边 520 卡在脖子/肩膀之上（肩膀的抬起属于"姿态"的一部分，要留着）；
#:   · 上边和右边取满，把头发一起框住。
#: 换素材（换个头身比、或者手臂抬得更高）要重调，脚本的报错会告诉你调哪边。
DEFAULT_HEAD_BOX = (640, 0, 1600, 520)


def parse_box(text: str) -> tuple[int, int, int, int]:
    parts = [int(v) for v in text.replace(" ", "").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("格式应为 x0,y0,x1,y1，例如 640,0,1600,520")
    return parts[0], parts[1], parts[2], parts[3]


def main() -> None:
    parser = argparse.ArgumentParser(description="把整身图做成姿态差分（抠底 + 脸部还原）")
    parser.add_argument("src", type=Path, help="AI 改过的整身图（PNG/JPG）")
    parser.add_argument("--base", type=Path, required=True, help="底图 body.png（脸部以它为准）")
    parser.add_argument("--out", type=Path, required=True, help="输出 pose_<id>.png")
    parser.add_argument(
        "--head-box",
        type=parse_box,
        default=DEFAULT_HEAD_BOX,
        help=f"头部区域 x0,y0,x1,y1（默认 {','.join(map(str, DEFAULT_HEAD_BOX))}）",
    )
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="isnetis.onnx 路径")
    parser.add_argument(
        "--no-restore-face",
        action="store_true",
        help="不做脸部还原（只想看看「直接整身换」是什么样时用）",
    )
    args = parser.parse_args()

    base_img = Image.open(args.base).convert("RGBA")
    base = np.asarray(base_img).astype(np.int16)

    # 1) 抠底（临时文件放输出旁边，转成数组后删掉）
    tmp = args.out.with_suffix(".cut.tmp.png")
    info = cutout(args.src, tmp, args.model)
    # 注意 copy：PIL 转出来的数组是只读的（后面要往上写）
    pose = np.array(Image.open(tmp).convert("RGBA"))
    tmp.unlink(missing_ok=True)

    if pose.shape != base.shape:
        raise SystemExit(
            f"尺寸不一致：底图 {base.shape[1]}×{base.shape[0]}，"
            f"姿态图 {pose.shape[1]}×{pose.shape[0]} —— 整身替换图必须和底图同尺寸"
        )

    base_alpha = base[..., 3] > 24
    pose_alpha = pose[..., 3] > 24

    # 2) 脸部还原：头部框里，底图有像素的地方一律用底图
    x0, y0, x1, y1 = args.head_box
    box = np.zeros(base_alpha.shape, dtype=bool)
    box[y0:y1, x0:x1] = True
    restore = base_alpha & box
    changed_before = 0
    if not args.no_restore_face:
        diff = np.abs(pose[..., :3].astype(np.int16) - base[..., :3]).max(axis=2)
        changed_before = int(((diff > 0) & restore).sum())
        pose[restore] = base[restore].astype(np.uint8)

    # 3) 自检
    diff = np.abs(pose[..., :3].astype(np.int16) - base[..., :3]).max(axis=2)
    head_changed = int(((diff > 0) & restore).sum())
    both = base_alpha & pose_alpha
    body_changed = int(((diff > 30) & both & ~box).sum())
    new_px = int((pose_alpha & box & ~base_alpha).sum())
    gone_px = int((base_alpha & ~pose_alpha).sum())

    Image.fromarray(pose).save(args.out)

    print(f"抠底：不透明占比 {info['不透明占比']}，清掉背景碎块 {info['清掉的背景碎块']}")
    print(f"尺寸：{pose.shape[1]}×{pose.shape[0]}")
    if not args.no_restore_face:
        print(f"脸部还原：头部框 {x0},{y0} ~ {x1},{y1} 内改了 {changed_before} 个像素（用底图覆盖回去）")
    print("自检：")
    print(f"  · 头部框内仍然和底图不同的像素：{head_changed}  ← 必须是 0，否则脸在挥手时会变样")
    print(f"  · 身体部分明显变化（>30）：{body_changed} px  ← 这就是姿态本身；太小说明图没改对")
    print(f"  · 头部框内新出现的像素：{new_px}（AI 把发丝画宽了一点，可忽略）")
    print(f"  · 消失的像素：{gone_px}（原来垂着的手臂，正是要它消失的）")
    print(f"\n输出：{args.out}")

    if head_changed:
        print(
            "\n❌ 头部区域还有改动 —— 把 --head-box 往大调（覆盖住整个头和头发），"
            "或者确认这张姿态图里手臂没有伸进头部区域。",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    sys.exit(main())
