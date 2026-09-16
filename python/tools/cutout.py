"""给动漫立绘抠背景（输出带 alpha 的 PNG）。

为什么单独一个脚本、而不是放进推理服务：抠图只在「准备素材」时用一次，
不属于运行路径。模型也不入库。

用法：
    cd python
    .venv/Scripts/python tools/cutout.py ../public/portrait/body.png ../public/portrait/body_cut.png

要改的原图先备份 —— 这个脚本会写到你指定的输出路径，不会覆盖输入。

模型：isnet-anime（动漫立绘专用，168MB），放 python/pretrained_models/isnetis.onnx
下载（二选一，国内用镜像更快）：
    curl -L -o pretrained_models/isnetis.onnx https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx
    curl -L -o pretrained_models/isnetis.onnx https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx

装依赖：
    pip install onnxruntime pillow
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

#: 模型输入边长（isnet-anime 用 1024）
INPUT_SIZE = 1024

#: 掩码下限：低于它的当作背景。
#: 立绘背景通常比角色亮，不压掉低值会在边缘留一圈浅色描边（halo）。
MASK_FLOOR = 0.12
MASK_CEIL = 0.85

DEFAULT_MODEL = Path(__file__).resolve().parents[1] / "pretrained_models" / "isnetis.onnx"


def build_input(img: Image.Image) -> tuple[np.ndarray, tuple[int, int, int, int], tuple[int, int]]:
    """把图等比缩放进 1024×1024 的正方形（居中补零），返回张量与还原所需的信息。

    返回：(NCHW float32 张量, (左, 上, 宽, 高) 的有效区域, 原始尺寸)
    """
    w0, h0 = img.size
    scale = INPUT_SIZE / max(w0, h0)
    w, h = max(1, round(w0 * scale)), max(1, round(h0 * scale))
    resized = img.resize((w, h), Image.LANCZOS)

    canvas = np.zeros((INPUT_SIZE, INPUT_SIZE, 3), dtype=np.float32)
    left, top = (INPUT_SIZE - w) // 2, (INPUT_SIZE - h) // 2
    canvas[top : top + h, left : left + w] = np.asarray(resized, dtype=np.float32) / 255.0

    tensor = np.transpose(canvas, (2, 0, 1))[np.newaxis, ...]
    return tensor, (left, top, w, h), (w0, h0)


def clean_specks(mask: np.ndarray, keep_ratio: float = 0.02) -> tuple[np.ndarray, int]:
    """去掉孤立的背景残留碎块。

    模型偶尔会把背景里的一小块（花纹、光斑）判成主体 —— 那些碎块和角色不相连，
    看起来就是「没抠干净」。做法：连通域标记，只保留主体和**面积大于主体 2%** 的部件
    （角色的手、飘带可能与身体不相连，所以不能只留最大的一块）。

    返回 (清理后的掩码, 去掉的碎块数)。
    """
    try:
        from scipy import ndimage
    except ImportError:
        return mask, 0

    binary = mask > 0.5
    labels, count = ndimage.label(binary)
    if count <= 1:
        return mask, 0

    sizes = ndimage.sum(binary, labels, range(1, count + 1))
    largest = float(sizes.max())
    keep_labels = [i + 1 for i, size in enumerate(sizes) if size >= largest * keep_ratio]

    kept = np.isin(labels, keep_labels)
    removed = count - len(keep_labels)

    # 被去掉的部分连同它的软边一起压掉
    cleaned = mask.copy()
    cleaned[~kept] = 0.0
    return cleaned, removed


def extract_mask(output: np.ndarray, box: tuple[int, int, int, int], size: tuple[int, int]) -> np.ndarray:
    left, top, w, h = box
    w0, h0 = size
    # 模型输出形如 (1, 1, 1024, 1024)，取第一个通道
    m = np.asarray(output).reshape(-1, INPUT_SIZE, INPUT_SIZE)[0]
    m = m[top : top + h, left : left + w]
    m = np.clip(m, 0.0, 1.0)

    # 压掉低值：减少背景残留的浅色边
    m = np.clip((m - MASK_FLOOR) / max(1e-6, MASK_CEIL - MASK_FLOOR), 0.0, 1.0)

    # 先在小图上清碎块（快），再放大回原尺寸
    m, removed = clean_specks(m)

    mask = Image.fromarray((m * 255).astype(np.uint8), mode="L").resize((w0, h0), Image.LANCZOS)
    return np.asarray(mask, dtype=np.float32) / 255.0, removed


def cutout(src: Path, dst: Path, model_path: Path) -> dict:
    if not model_path.exists():
        raise SystemExit(
            f"找不到模型 {model_path}\n"
            "下载：curl -L -o pretrained_models/isnetis.onnx "
            "https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx"
        )

    img = Image.open(src).convert("RGB")
    tensor, box, size = build_input(img)

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output = session.run(None, {input_name: tensor})[0]

    alpha, removed_specks = extract_mask(output, box, size)

    out = img.convert("RGBA")
    out.putalpha(Image.fromarray((alpha * 255).astype(np.uint8), mode="L"))
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)

    # 顺便报告内容包围盒 —— 立绘模式的取景就是按它算的
    ys, xs = np.nonzero(alpha > 0.5)
    h, w = alpha.shape
    return {
        "输出": str(dst),
        "尺寸": [w, h],
        "不透明占比": round(float((alpha > 0.5).mean()), 3),
        "清掉的背景碎块": removed_specks,
        "内容包围盒_比例": [
            round(float(xs.min() / w), 3),
            round(float(ys.min() / h), 3),
            round(float((xs.max() - xs.min() + 1) / w), 3),
            round(float((ys.max() - ys.min() + 1) / h), 3),
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="给动漫立绘抠背景")
    parser.add_argument("src", type=Path, help="输入图（PNG/JPG）")
    parser.add_argument("dst", type=Path, help="输出 PNG（带 alpha）")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="isnetis.onnx 路径")
    args = parser.parse_args()

    if args.src.resolve() == args.dst.resolve():
        raise SystemExit("输入输出不能是同一个文件 —— 先备份原图")

    info = cutout(args.src, args.dst, args.model)
    for k, v in info.items():
        print(f"{k}: {v}")
    print("\n完成。检查一下四角是否透明，再放进 public/portrait/body.png")


if __name__ == "__main__":
    sys.exit(main())
