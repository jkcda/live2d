"""抠瞳孔图层 + 把眼白补回去（让立绘的瞳孔能跟着鼠标动）。

为什么需要它：立绘是**一张平图**，瞳孔和眼白粘在一起。要让它单独移动，
必须做两件事，缺一件都会露馅：

  1. **抠出瞳孔/虹膜**（连高光一起，否则瞳孔走了高光还在原地）；
  2. **把它原来的位置补成眼白** —— 不补的话，瞳孔一移开就露出一个洞，
     或者原地留一个黑点。这是这个脚本真正难的部分，也是"能不能做"的关键。

怎么做到的（都是实测量出来的结论，见 docs）：
  · 你这张的瞳孔和虹膜**是同一块有饱和度的团**（瞳孔暗核的饱和度 0.58，
    比眼白高得多），所以按"饱和度 + 暗度"能把整块干净地分出来；
  · 虹膜只占眼睛宽度约七成，四周还有 10~20px 眼白 —— 瞳孔位移几像素时，
    只在被拖走的那一侧露出**几像素宽的细条**，需要的只是眼白，
    所以补洞用「从洞边向内传播 + 局部平滑」就够，不必让 AI 重画；
  · 虹膜外面那圈「暗」是睫毛线和眉毛，不限制范围会被一起抠走
    （一移动就变成"睫毛在漂"），所以取连通块后再和**内接椭圆**相交，把它切掉。

自检（脚本会打印，不通过就别用）：
  · 把图层叠回补好的底图，和原图在眼睛区域应当**几乎无差异**（无损还原）；
  · 补完的洞里不该再剩暗像素（说明瞳孔确实被抠走了）。

用法：
    cd python
    .venv/Scripts/python.exe tools/extract_pupils.py            # 报告 + 出图
    .venv/Scripts/python.exe tools/extract_pupils.py --dry-run  # 只看报告
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

DEFAULT_PORTRAIT = Path(__file__).resolve().parents[2] / "public" / "portrait"
DEFAULT_PREVIEW = Path(__file__).resolve().parents[2] / "vendor" / "pupil-preview"


def luminance_saturation(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    val = mx / 255.0
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0.0)
    return val, sat


def eye_roi(portrait: Path, canvas: tuple[int, int]) -> tuple[int, int, int, int] | None:
    """眼睛大致范围：优先用「闭眼差分」的 alpha 包围盒（那是实测出来的眼睛位置）"""
    closed = portrait / "eyes_closed.png"
    if closed.exists():
        a = np.asarray(Image.open(closed).convert("RGBA"))[:, :, 3]
        ys, xs = np.where(a > 24)
        if len(ys) > 100:
            x0, x1 = int(xs.min()), int(xs.max()) + 1
            y0, y1 = int(ys.min()), int(ys.max()) + 1
            # 外扩一点，保证虹膜边缘也在范围内
            pad = max(6, int((x1 - x0) * 0.06))
            return (
                max(0, x0 - pad),
                max(0, y0 - pad),
                min(canvas[0], x1 + pad),
                min(canvas[1], y1 + pad),
            )
    return None


def inscribed_ellipse(shape: tuple[int, int], bbox: tuple[int, int, int, int], grow: float) -> np.ndarray:
    """bbox 的内接椭圆（grow=1.08 时略微外扩，把虹膜那圈过渡也带上）"""
    h, w = shape
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2 * grow, (y1 - y0) / 2 * grow
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx - cx) / max(rx, 1)) ** 2 + ((yy - cy) / max(ry, 1)) ** 2 <= 1


def find_irises(rgb: np.ndarray, alpha: np.ndarray, roi, sat_th: float, min_area: int) -> list[dict]:
    x0, y0, x1, y1 = roi
    sub = np.zeros(alpha.shape, dtype=bool)
    sub[y0:y1, x0:x1] = True

    val, sat = luminance_saturation(rgb)
    # 虹膜 = 有彩色的（含饱和的暗核）；纯黑无彩的睫毛反而饱和度低，正好被排除
    cand = sub & (alpha > 128) & (sat > sat_th) & (val > 0.12)

    lab, n = ndimage.label(cand, structure=np.ones((3, 3), dtype=int))
    out: list[dict] = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < min_area:
            continue
        bx = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        mask = lab == i
        mask = ndimage.binary_fill_holes(mask)
        mask = ndimage.binary_closing(mask, iterations=2)
        mask &= inscribed_ellipse(alpha.shape, bx, 1.08)
        out.append({"bbox": bx, "area": int(mask.sum()), "mask": mask, "raw": int(len(ys))})
    out.sort(key=lambda d: -d["area"])
    return out[:2]  # 最多两只眼睛


def inpaint(rgb: np.ndarray, hole: np.ndarray) -> np.ndarray:
    """
    从洞边向内传播补洞。

    为什么用传播而不是"用周围平均色填一层"：眼睛周围是有明暗过渡的
    （上眼睑有阴影、外眼角偏暗），一片纯色填上去像贴了块胶布。
    传播是逐圈把已知像素的平均值推进去，天然延续了周边的明暗方向。
    """
    out = rgb.astype(np.float32).copy()
    known = ~hole
    for _ in range(256):
        if known.all():
            break
        acc = np.zeros_like(out)
        cnt = np.zeros(hole.shape, dtype=np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            acc += np.roll(out, (dy, dx), axis=(0, 1)) * np.roll(known, (dy, dx), axis=(0, 1))[..., None]
            cnt += np.roll(known, (dy, dx), axis=(0, 1))
        fillable = (~known) & (cnt > 0)
        if not fillable.any():
            break
        out[fillable] = acc[fillable] / cnt[fillable][..., None]
        known |= fillable

    # 传播会留下同心圆状的条带，在洞内做一次轻平滑
    smooth = np.asarray(
        Image.fromarray(out.astype(np.uint8)).filter(ImageFilter.GaussianBlur(3)), dtype=np.float32
    )
    k = np.asarray(
        Image.fromarray((hole * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)),
        dtype=np.float32,
    )[..., None] / 255.0
    return out * (1 - k) + smooth * k


def main() -> None:
    ap = argparse.ArgumentParser(description="抠瞳孔图层 + 补眼白")
    ap.add_argument("--portrait", type=Path, default=DEFAULT_PORTRAIT)
    ap.add_argument("--saturation", type=float, default=0.30, help="虹膜的饱和度阈值")
    ap.add_argument("--min-area", type=int, default=200, help="小于这么多像素的色块当成噪点")
    ap.add_argument("--dilate", type=int, default=2, help="补洞范围在虹膜外再扩几像素")
    ap.add_argument("--preview", type=Path, default=DEFAULT_PREVIEW)
    ap.add_argument("--dry-run", action="store_true", help="只报告，不改动素材")
    ap.add_argument("--force", action="store_true", help="已经抠过一次时仍然重跑")
    args = ap.parse_args()

    body = args.portrait / "body.png"
    if not body.exists():
        raise SystemExit(f"找不到底图：{body}")

    # 防手滑：这个脚本会**覆盖底图**。底图已经被抠过一次（目录里已有 pupil.png）时
    # 再跑一遍，就是在"没有瞳孔的图"上找瞳孔 —— 找不到还好，找到的多半是眼睛阴影，
    # 结果是把眼睛越补越糊。所以要显式 --force。
    existing = args.portrait / "pupil.png"
    if existing.exists() and not args.force and not args.dry_run:
        print(f"⚠ 已经存在 {existing}，说明底图抠过一次了")
        print(f"  想重做请先还原底图：copy vendor\\portrait-base-with-pupil\\body.png {body}")
        print("  确认要在这张底图上再抠一次，就加 --force")
        return
    img = Image.open(body).convert("RGBA")
    arr = np.asarray(img, dtype=np.uint8)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]

    roi = eye_roi(args.portrait, img.size)
    if roi is None:
        # 没有闭眼差分时的兜底：取角色上三分之一
        ys, xs = np.where(alpha > 128)
        y0, y1 = int(ys.min()), int(ys.min() + (ys.max() - ys.min()) * 0.33)
        roi = (int(xs.min()), y0, int(xs.max()), y1)
        print("⚠ 没找到 eyes_closed.png，用「角色上三分之一」当眼睛范围，可能不准")

    print(f"底图 {body.name} {img.size[0]}×{img.size[1]}｜眼睛范围 x[{roi[0]},{roi[2]}] y[{roi[1]},{roi[3]}]")
    irises = find_irises(rgb, alpha, roi, args.saturation, args.min_area)
    if not irises:
        raise SystemExit("没找到虹膜/瞳孔 —— 试试调低 --saturation")

    val, sat = luminance_saturation(rgb)
    for i, ir in enumerate(irises):
        m = ir["mask"]
        ys, xs = np.where(m)
        print(
            f"  虹膜{i + 1}：{int(m.sum())} px  bbox x[{xs.min()},{xs.max()}] y[{ys.min()},{ys.max()}]"
            f"  平均饱和 {sat[m].mean():.2f}  最暗亮度 {val[m].min():.2f}"
        )

    layer_mask = np.zeros(alpha.shape, dtype=bool)
    for ir in irises:
        layer_mask |= ir["mask"]

    # ── 图层：把虹膜那块原样抠出来（不算透明的地方一律透明）
    feathered = np.asarray(
        Image.fromarray((layer_mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)),
        dtype=np.float32,
    ) / 255.0
    layer = np.zeros_like(arr)
    layer[:, :, :3] = rgb
    layer[:, :, 3] = np.clip(feathered * alpha, 0, 255).astype(np.uint8)

    # ── 底图：把虹膜位置补成眼白
    hole = ndimage.binary_dilation(layer_mask, iterations=args.dilate)
    before_min = float(val[hole].min())
    fixed_rgb = inpaint(rgb, hole)
    fixed = arr.copy()
    fixed[:, :, :3] = np.clip(fixed_rgb, 0, 255).astype(np.uint8)
    fval, _ = luminance_saturation(fixed[:, :, :3])

    # ── 自检 1：把图层叠回补好的底图，应当和原图几乎一致
    a = layer[:, :, 3:4].astype(np.float32) / 255.0
    comp = layer[:, :, :3].astype(np.float32) * a + fixed[:, :, :3].astype(np.float32) * (1 - a)
    diff = np.abs(comp - rgb.astype(np.float32))[roi[1] : roi[3], roi[0] : roi[2]]
    print(f"\n自检 1（无损还原）：眼睛区域平均差 {diff.mean():.2f}，最大差 {diff.max():.0f}")
    print(
        f"自检 2（洞补干净了）：洞里最暗亮度 {before_min:.2f} → {float(fval[hole].min()):.2f}"
        f"（应明显变亮，剩下的暗像素 {int((fval[hole] < 0.45).sum())} 个，应为 0 附近）"
    )

    if args.dry_run:
        print("\n--dry-run：没有改动任何文件")
        return

    # 原底图先在 vendor 留一份（换回来只要复制回去）
    backup = DEFAULT_PREVIEW.parent / "portrait-base-with-pupil"
    backup.mkdir(parents=True, exist_ok=True)
    if not (backup / "body.png").exists():
        shutil.copy2(body, backup / "body.png")
        print(f"原底图已备份 → {backup / 'body.png'}")

    Image.fromarray(layer, "RGBA").save(args.portrait / "pupil.png")
    Image.fromarray(fixed, "RGBA").save(body)
    print(f"瞳孔图层 → {args.portrait / 'pupil.png'}")
    print(f"补好的底图 → {body}")

    # 给人看的预览：眼睛那块的原图 / 补完 / 图层，横向拼一张放大的对比图
    args.preview.mkdir(parents=True, exist_ok=True)
    x0, y0, x1, y1 = roi
    scale = 4
    size = ((x1 - x0) * scale, (y1 - y0) * scale)

    def tile(src: np.ndarray) -> Image.Image:
        t = Image.new("RGBA", size, (40, 42, 48, 255))
        crop = Image.fromarray(src[y0:y1, x0:x1], "RGBA").resize(size, Image.NEAREST)
        t.alpha_composite(crop)
        return t

    strips = [tile(arr), tile(fixed), tile(layer)]
    gap = 12
    total = Image.new("RGBA", (size[0] * 3 + gap * 2, size[1]), (24, 26, 30, 255))
    x = 0
    for s in strips:
        total.alpha_composite(s, (x, 0))
        x += size[0] + gap
    out_preview = args.preview / "眼睛对比_原图_补完_图层.png"
    total.convert("RGB").save(out_preview)
    Image.fromarray(layer, "RGBA").save(args.preview / "瞳孔图层.png")
    Image.fromarray(fixed, "RGBA").save(args.preview / "去瞳孔底图.png")
    print(f"预览（左 原图 / 中 补完 / 右 图层）→ {out_preview}")


if __name__ == "__main__":
    main()
