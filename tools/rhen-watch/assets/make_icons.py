#!/usr/bin/env python3
"""Generate the three tray/window/shortcut icons (recording green, paused grey, degraded amber).

Usage (from this folder): python make_icons.py
Writes rhen-watch.ico, rhen-watch-paused.ico and rhen-watch-degraded.ico, each with 16, 32 and 48 px images as
32-bit DIBs (BGRA plus the all-zero AND mask old loaders expect). Standard library only; output is deterministic,
so the checked-in files can be compared with a fresh run.
"""
import os
import struct

SIZES = (16, 32, 48)
SS = 4  # supersampling factor for smooth edges
ICONS = {
    "rhen-watch.ico": ((46, 158, 91), "dot"),  # recording: green
    "rhen-watch-paused.ico": ((125, 131, 141), "bars"),  # paused: grey
    "rhen-watch-degraded.ico": ((224, 161, 0), "bang"),  # degraded: amber
}
WHITE = (255, 255, 255)


def inside(kind, x, y):
    """Is the unit-square point (x, y) part of the white mark?"""
    cx, cy = x - 0.5, y - 0.5
    if kind == "dot":
        return cx * cx + cy * cy <= 0.17**2
    if kind == "bars":
        return 0.09 <= abs(cx) <= 0.2 and abs(cy) <= 0.24
    # exclamation mark: a bar and a dot
    bar = abs(cx) <= 0.07 and -0.28 <= cy <= 0.08
    dot = cx * cx + (cy - 0.2) ** 2 <= 0.075**2
    return bar or dot


def pixel(kind, color, px, py, size):
    """RGBA of one output pixel, averaged over SS*SS samples."""
    r = g = b = a = 0.0
    for sy in range(SS):
        for sx in range(SS):
            x = (px + (sx + 0.5) / SS) / size
            y = (py + (sy + 0.5) / SS) / size
            d = ((x - 0.5) ** 2 + (y - 0.5) ** 2) ** 0.5
            if d > 0.47:
                continue  # outside the disc: transparent
            c = WHITE if inside(kind, x, y) else color
            if d > 0.40:  # a slightly darker rim keeps the disc readable on light taskbars
                c = tuple(int(v * 0.8) for v in c)
            r += c[0]
            g += c[1]
            b += c[2]
            a += 1
    n = SS * SS
    if a == 0:
        return (0, 0, 0, 0)
    return (round(r / a), round(g / a), round(b / a), round(255 * a / n))


def dib(kind, color, size):
    rows = []
    for py in range(size - 1, -1, -1):  # bottom-up
        row = bytearray()
        for px in range(size):
            r, g, b, a = pixel(kind, color, px, py, size)
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    pixels = b"".join(rows)
    mask_row = ((size + 31) // 32) * 4
    mask = bytes(mask_row * size)  # all zero: the alpha channel decides
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return header + pixels + mask


def ico(kind, color):
    images = [dib(kind, color, s) for s in SIZES]
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for s, img in zip(SIZES, images):
        out += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    for img in images:
        out += img
    return bytes(out)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for name, (color, kind) in ICONS.items():
        with open(os.path.join(here, name), "wb") as f:
            f.write(ico(kind, color))
        print("wrote", name)


if __name__ == "__main__":
    main()
