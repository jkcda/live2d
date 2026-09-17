"""生成托盘图标（一轮弯月）。

为什么不用现成的图片：托盘图标在 16x16 下显示，随便缩放一张大图会糊成一团。
这里直接按最终尺寸逐像素画 + 超采样抗锯齿，边缘干净。

用法：
    python tools/gen-tray-icon.py
输出：
    public/tray.png      32x32（Windows 托盘会缩到 16，@2x 下用 32 刚好）
    public/tray@2x.png   64x64
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 弯月：外圆挖掉一个偏移的内圆
OUTER = (17.0, 16.0, 11.0)   # cx, cy, r
INNER = (23.5, 13.5, 10.0)

# 采样倍数，用来抗锯齿（3 表示每个像素采 3x3 = 9 个点）
SS = 3


def coverage(x: float, y: float) -> float:
    """返回该像素被弯月覆盖的比例 0~1。"""
    hits = 0
    for sy in range(SS):
        for sx in range(SS):
            px = x + (sx + 0.5) / SS
            py = y + (sy + 0.5) / SS
            d_out = (px - OUTER[0]) ** 2 + (py - OUTER[1]) ** 2
            d_in = (px - INNER[0]) ** 2 + (py - INNER[1]) ** 2
            if d_out <= OUTER[2] ** 2 and d_in >= INNER[2] ** 2:
                hits += 1
    return hits / (SS * SS)


def render(size: int) -> bytes:
    """渲染成 RGBA 像素数据。"""
    scale = size / 32.0
    rows = bytearray()

    for y in range(size):
        rows.append(0)  # PNG 每行开头的 filter 字节
        for x in range(size):
            # 先按 32x32 的坐标系算覆盖，再缩放到目标尺寸
            a = coverage(x / scale, y / scale)
            alpha = int(round(a * 255))
            # 浅色，Windows 托盘是深色底
            rows += bytes((232, 236, 245, alpha))

    return bytes(rows)


def write_png(path: Path, size: int) -> None:
    raw = render(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"  {path.relative_to(ROOT)}  ({size}x{size}, {len(png)} bytes)")


def main() -> None:
    print("生成托盘图标：")
    write_png(ROOT / "public" / "tray.png", 32)
    write_png(ROOT / "public" / "tray@2x.png", 64)


if __name__ == "__main__":
    main()
