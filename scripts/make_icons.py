#!/usr/bin/env python3
"""Draws the app icons (a chalkboard play: an O running a route to an X) using only the standard library.

Usage: python3 scripts/make_icons.py   (writes public/icons/*.png)
"""
import math
import os
import struct
import zlib

SS = 3  # supersampling per axis


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, maskable):
    # Content lives in a 0..1 box; maskable icons keep it inside the central 70%.
    scale = 0.64 if maskable else 0.84
    off = (1 - scale) / 2
    def T(x, y):
        return off + x * scale, off + y * scale

    ring_c = T(0.27, 0.70)
    ring_r = 0.155 * scale
    ring_w = 0.075 * scale
    xc = T(0.73, 0.28)
    xs = 0.15 * scale
    xw = 0.085 * scale
    # Route: from the O curving up and across to the X, drawn as segments with an arrowhead.
    pts = [T(0.27, 0.50), T(0.27, 0.36), T(0.40, 0.25), T(0.56, 0.255)]
    rw = 0.045 * scale
    tip = T(0.58, 0.255)
    head = [T(0.515, 0.20), T(0.515, 0.31)]

    rows = []
    bg_top = (22, 66, 36)
    bg_bot = (13, 40, 22)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    # Background gradient with faint yard lines.
                    t = v
                    cr = bg_top[0] + (bg_bot[0] - bg_top[0]) * t
                    cg = bg_top[1] + (bg_bot[1] - bg_top[1]) * t
                    cb = bg_top[2] + (bg_bot[2] - bg_top[2]) * t
                    if abs(((v * 8) % 1) - 0.5) > 0.47:
                        cr, cg, cb = cr + 10, cg + 22, cb + 12
                    ink = 0.0
                    x_hit = False
                    # O
                    d = abs(math.hypot(u - ring_c[0], v - ring_c[1]) - ring_r)
                    if d < ring_w / 2:
                        ink = 1.0
                    # X
                    for (ax, ay, bx, by) in ((-1, -1, 1, 1), (-1, 1, 1, -1)):
                        if seg_dist(u, v, xc[0] + ax * xs, xc[1] + ay * xs, xc[0] + bx * xs, xc[1] + by * xs) < xw / 2:
                            ink = 1.0
                            x_hit = True
                    # Route and arrowhead
                    for i in range(len(pts) - 1):
                        if seg_dist(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) < rw / 2:
                            ink = 1.0
                    for h in head:
                        if seg_dist(u, v, tip[0], tip[1], h[0], h[1]) < rw / 2:
                            ink = 1.0
                    if ink:
                        cr, cg, cb = (250, 204, 21) if x_hit else (255, 255, 255)  # the X is gold
                    r += cr
                    g += cg
                    b += cb
            n = SS * SS
            row += bytes((int(r / n), int(g / n), int(b / n)))
        rows.append(bytes([0]) + bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
    os.makedirs(out, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False), ("icon-maskable-512.png", 512, True), ("apple-touch-icon.png", 180, False)):
        with open(os.path.join(out, name), "wb") as f:
            f.write(render(size, maskable))
        print("wrote", name)


if __name__ == "__main__":
    main()
