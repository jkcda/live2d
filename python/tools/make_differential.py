"""从「AI 改过的一张图」自动做出差分图（mouth_1 / eyes_closed 这类）。

为什么需要这个脚本 —— 网页版差分工具（public/dev/diff-tool.html）要手拖框，
而手拖有两个必然的坑，用户已经踩过：

  1. **框拖大了** → 框外那些「AI 顺手重画的像素」也被贴上去，
     脸上一块矩形和周围对不上（「完全和嘴对不上」就是这么来的）；
  2. **框拖偏了** → 嘴唇没框全，切口型时嘴缺一块。

这个脚本换个思路：**不框，直接算差异**。
   底图 vs AI 结果逐像素比，把真正改动的连通区域找出来，
   只把那些像素做成差分（边缘羽化），其余一律丢弃。
框外漂移自动消失，因为压根没被复制过来。

用法：
    cd python
    # 自动找改动区域
    .venv/Scripts/python.exe tools/make_differential.py \
        --base ../public/portrait/body.png \
        --variant ../vendor/portrait-ai-output/半张.png \
        --out ../public/portrait/mouth_1.png

    # 只想看看改了哪儿（不写文件）
    ... --report-only

    # 只在某个范围内找（比如已知嘴在脸上半部分，避免抓到衣服上的漂移）
    ... --box 600,250,1100,800

    # 阈值/羽化微调
    ... --threshold 18 --feather 2.0 --dilate 3

判定「改动够不够真」：脚本会把**被丢弃的漂移**也量化出来。
如果改动区域和漂移一样大，说明这张 AI 结果其实整张重画了，不该用。
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

MASK_MIN_ALPHA = 40  # 底图 alpha 低于它算背景，不参与比较
MIN_AREA_ABS = 40  # 小于这么多像素的改动块直接丢（噪点）
MIN_AREA_REL = 0.04  # 或者小于最大块的 4% 也丢（AI 的零散漂移）
# 注意：阈值别调太低，也别把 MIN_AREA_REL 调太高。
# 经验值（1600×2848 立绘）：AI「只改嘴」的一次编辑，框内通常只有 1~3 个改动块、
# 几百到两千像素；如果上百个块散在全身（头发/袖口/裙摆），那就是它整张重画了 ——
# 这种情况不要放宽过滤，要用 --box 把搜索范围收窄到脸。


def load_pair(base_path: Path, variant_path: Path) -> tuple[np.ndarray, np.ndarray, list[str]]:
    notes: list[str] = []
    base_img = Image.open(base_path)
    base = np.asarray(base_img.convert("RGBA"), dtype=np.uint8)
    variant_img = Image.open(variant_path)
    if variant_img.size != base_img.size:
        notes.append(
            f"⚠ AI 结果尺寸是 {variant_img.size[0]}×{variant_img.size[1]}，"
            f"底图是 {base_img.size[0]}×{base_img.size[1]} —— 已强行缩到底图尺寸，可能错位"
        )
        variant_img = variant_img.resize(base_img.size, Image.LANCZOS)
    variant = np.asarray(variant_img.convert("RGBA"), dtype=np.uint8)
    return base, variant, notes


def diff_mask(base: np.ndarray, variant: np.ndarray, threshold: float) -> np.ndarray:
    """逐像素差异 → 布尔掩码。只比底图**实心**的地方。"""
    d = np.abs(base[:, :, :3].astype(np.int16) - variant[:, :, :3].astype(np.int16)).max(axis=2)
    mask = (d > threshold) & (base[:, :, 3] >= MASK_MIN_ALPHA)
    return mask


def keep_changed_blobs(mask: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """连通域过滤：去掉零散噪点，返回保留的块信息。"""
    lab, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=int))
    if n == 0:
        return np.zeros_like(mask), []
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    biggest = float(sizes.max())
    floor = max(MIN_AREA_ABS, biggest * MIN_AREA_REL)
    keep_ids = [i + 1 for i, s in enumerate(sizes) if s >= floor]
    kept = np.isin(lab, keep_ids)
    blobs = []
    for i in keep_ids:
        ys, xs = np.where(lab == i)
        blobs.append(
            {
                "面积": int(sizes[i - 1]),
                "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            }
        )
    blobs.sort(key=lambda b: -b["面积"])
    return kept, blobs


def build_alpha(kept: np.ndarray, dilate: int, feather: float, base_alpha: np.ndarray) -> np.ndarray:
    """
    掩码 → alpha。

    先膨胀几像素再高斯羽化：膨胀保证改动区的**边缘过渡像素**也一起带上
    （否则嘴唇外沿会残留一圈旧像素），羽化保证贴上去看不到硬边。
    边缘处两个图本来就基本一致，所以羽化不会糊掉嘴型。
    """
    m = kept
    if dilate > 0:
        m = ndimage.binary_dilation(m, iterations=dilate)
    m = ndimage.binary_fill_holes(m)
    m = np.clip(m.astype(np.float32) * 255.0, 0, 255).astype(np.uint8)
    if feather > 0:
        img = Image.fromarray(m, mode="L").filter(ImageFilter.GaussianBlur(feather))
        m = np.asarray(img, dtype=np.uint8)
    # 底图是背景的地方不画（避免差分图在轮廓外留下东西）
    m = np.where(base_alpha >= MASK_MIN_ALPHA, m, 0).astype(np.uint8)
    return m


def main() -> None:
    parser = argparse.ArgumentParser(description="AI 编辑结果 → 自动差分图")
    parser.add_argument("--base", type=Path, required=True, help="底图（透明 PNG，必须是应用正在用的那张）")
    parser.add_argument("--variant", type=Path, required=True, help="AI 改过的图（整张立绘）")
    parser.add_argument("--out", type=Path, help="输出差分图；不填则只报告")
    parser.add_argument("--box", help="只在 x0,y0,x1,y1 范围内找改动")
    parser.add_argument("--threshold", type=float, default=18, help="差异阈值（0~255，默认 18）")
    parser.add_argument("--dilate", type=int, default=3, help="掩码膨胀像素（默认 3）")
    parser.add_argument("--feather", type=float, default=2.0, help="羽化半径（默认 2.0）")
    parser.add_argument("--report-only", action="store_true", help="只报告，不写文件")
    args = parser.parse_args()

    base, variant, notes = load_pair(args.base, args.variant)
    for n in notes:
        print(n)

    search = np.ones(base.shape[:2], dtype=bool)
    if args.box:
        x0, y0, x1, y1 = (int(v) for v in args.box.split(","))
        search[:] = False
        search[y0:y1, x0:x1] = True

    d = np.abs(base[:, :, :3].astype(np.int16) - variant[:, :, :3].astype(np.int16)).max(axis=2)
    mask = diff_mask(base, variant, args.threshold) & search
    kept, blobs = keep_changed_blobs(mask)

    solid = base[:, :, 3] >= MASK_MIN_ALPHA
    if solid.sum() == 0:
        raise SystemExit("底图没有任何实心像素 —— 是不是忘了抠背景？")

    changed_all = int((mask).sum())
    changed_kept = int(kept.sum())
    drift = float(d[solid & ~kept].mean()) if (solid & ~kept).sum() else 0.0

    print(f"底图：{args.base}  {base.shape[1]}×{base.shape[0]}")
    print(f"改动像素：{changed_all}（角色面积的 {changed_all / solid.sum() * 100:.3f}%）")
    print(f"保留下来的块：{len(blobs)} 个")
    for b in blobs[:6]:
        print(f"  面积 {b['面积']:6d}  bbox x[{b['bbox'][0]},{b['bbox'][2]}] y[{b['bbox'][1]},{b['bbox'][3]}]")
    print(f"丢弃的「框外漂移」：平均 {drift:.2f}（0~765，越小越好；比阈值大说明这张整张都重画了）")

    if not blobs:
        print("没找到任何改动 —— 要么 AI 没改（图一样），要么阈值太高")
        return

    ys, xs = np.where(kept)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    w, h = base.shape[1], base.shape[0]
    print(
        "改动总范围：x[%d,%d] y[%d,%d]（比例 x %.4f y %.4f w %.4f h %.4f）"
        % (x0, x1, y0, y1, x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h)
    )

    if drift > args.threshold * 1.2:
        print("⚠ 漂移偏大：AI 大概整张重画了。这次的差分仍只含改动块，但两张图的画风可能已经不一致")

    if args.report_only or not args.out:
        print("（--report-only / 未指定 --out，没有写文件）")
        return

    alpha = build_alpha(kept, args.dilate, args.feather, base[:, :, 3])
    out = np.zeros_like(base)
    out[:, :, :3] = variant[:, :, :3]
    out[:, :, 3] = alpha
    Image.fromarray(out, mode="RGBA").save(args.out)
    cov = float((alpha > 40).mean())
    print(f"已写出 {args.out}（{w}×{h}，不透明像素占比 {cov * 100:.3f}%）")


if __name__ == "__main__":
    main()
