"""Perlin noise square: a block of parallel lines whose pressure follows noise.

Each line is drawn in short steps; at every step the pen-down height is set
from 2D Perlin noise at that spot, inside the range saved in the Pen tab —
lightest mark where the noise is low, heaviest press where it's high. With a
brush pen the noise shows up as swelling and thinning strokes.

The noise is normalised over the whole square, so the full pressure range is
always used. Change SEED for a different pattern, SCALE for bigger or smaller
blobs.

Note: each step is its own move, so the carriage eases in and out every
STEP mm. Shorter steps follow the noise more closely but plot slower.
"""

import math
import random

from plotterhub import PEN_DOWN_MAX, PEN_DOWN_MIN, plotter, set_pressure

PAGE = (420, 297)     # paper width × height, mm (A3 landscape)
SIZE = 150            # square side, mm — centred on the page
LINES = 50            # lines across the square
STEP = 4              # mm between pressure changes along a line

SCALE = 60            # noise feature size, mm (bigger = smoother blobs)
OCTAVES = 2           # layers of detail
SEED = 7

LIGHT = PEN_DOWN_MIN  # pen_pos_down where the noise is lowest
HEAVY = PEN_DOWN_MAX  # pen_pos_down where the noise is highest
SPEED = 20            # pen-down speed, 1-100


# 2D Perlin noise -------------------------------------------------------------

rng = random.Random(SEED)
_perm = list(range(256))
rng.shuffle(_perm)
_perm += _perm
_GRAD = [(math.cos(a), math.sin(a)) for a in (i * math.tau / 16 for i in range(16))]


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def _dot(ix, iy, x, y):
    gx, gy = _GRAD[_perm[_perm[ix & 255] + (iy & 255)] & 15]
    return gx * (x - ix) + gy * (y - iy)


def perlin(x, y):
    ix, iy = math.floor(x), math.floor(y)
    u, v = _fade(x - ix), _fade(y - iy)
    n00, n10 = _dot(ix, iy, x, y), _dot(ix + 1, iy, x, y)
    n01, n11 = _dot(ix, iy + 1, x, y), _dot(ix + 1, iy + 1, x, y)
    top = n00 + u * (n10 - n00)
    bottom = n01 + u * (n11 - n01)
    return top + v * (bottom - top)


def noise(x, y):
    total, amp, freq = 0.0, 1.0, 1.0 / SCALE
    for _ in range(OCTAVES):
        total += amp * perlin(x * freq, y * freq)
        amp, freq = amp / 2, freq * 2
    return total


# Plan the square ----------------------------------------------------------

x0 = (PAGE[0] - SIZE) / 2
y0 = (PAGE[1] - SIZE) / 2
steps = max(1, round(SIZE / STEP))
gap = SIZE / (LINES - 1) if LINES > 1 else 0

rows = []
for i in range(LINES):
    y = y0 + i * gap
    rows.append([(x0 + j * SIZE / steps, y) for j in range(steps + 1)])

values = [[noise(x, y) for x, y in row] for row in rows]
lo = min(min(r) for r in values)
hi = max(max(r) for r in values)
span = (hi - lo) or 1.0


def height(v):
    t = (v - lo) / span                     # 0 = light … 1 = heavy
    return round(LIGHT + (HEAVY - LIGHT) * t)


print(f"{LINES} lines × {steps} steps, {SIZE} mm square at ({x0:.0f}, {y0:.0f}) mm")
print(f"pressure range: pen_pos_down {LIGHT} (light) → {HEAVY} (heavy)")

# Plot --------------------------------------------------------------------

with plotter(page=PAGE, speed_pendown=SPEED) as ad:
    for i, (row, vals) in enumerate(zip(rows, values)):
        if i % 2:                           # serpentine: less pen-up travel
            row, vals = row[::-1], vals[::-1]
        h = height(vals[0])
        ad.moveto(*row[0])
        ad.options.pen_pos_down = h
        ad.update()                         # pen is up here, so update() is fine
        ad.pendown()
        current = h
        for (x, y), v in zip(row[1:], vals[1:]):
            h = height(v)
            if h != current:
                set_pressure(ad, h)
                current = h
            ad.lineto(x, y)
        ad.penup()
        if (i + 1) % 10 == 0:
            print(f"line {i + 1}/{LINES}")

print("done")
