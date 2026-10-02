"""Brush pen pressure test: lines across the page, each pressed a little harder.

Every line lowers the pen further (smaller pen_pos_down), so a brush tip
splays wider down the sheet. Read the log to see which height made which
line, then use the one you like as pen_pos_down in your plots.

Set PAGE to your paper (width along the rail × height, in mm) with its
corner at the plotter's home corner; the lines fill it inside MARGIN.

By default the ramp runs from the min to the max pen-down height saved in
the Pen tab. If the first line doesn't mark, lower DOWN_START; if the last
line jams the pen or skips, raise DOWN_END.
"""

from plotterhub import PEN_DOWN_MAX, PEN_DOWN_MIN, plotter

# A3 landscape = (420, 297) — the largest that fits the 430 × 297 travel
# A4 = (210, 297)  A4 landscape = (297, 210)  Letter = (216, 279)  5x7 in = (127, 178)
PAGE = (420, 297)     # paper width × height, mm
MARGIN = 15           # blank border on every side, mm

LINES = 10            # how many lines
DOWN_START = PEN_DOWN_MIN   # pen_pos_down for the first (lightest) line, 0-100
DOWN_END = PEN_DOWN_MAX     # pen_pos_down for the last (heaviest) line
PEN_UP = None         # pen_pos_up; None = the height saved in the Pen tab

SPEED = 15            # pen-down speed, 1-100 — slow lets the ink flow
SETTLE_MS = 250       # pause after lowering so the bristles settle

width, height = PAGE
x0, x1 = MARGIN, width - MARGIN
y0, y1 = MARGIN, height - MARGIN
if x1 <= x0 or y1 <= y0:
    raise SystemExit(f"MARGIN {MARGIN} mm leaves no room on a {width} × {height} mm page")
spacing = (y1 - y0) / (LINES - 1) if LINES > 1 else 0
print(f"{LINES} lines, {x1 - x0:g} mm long, {spacing:.1f} mm apart")

extra = {} if PEN_UP is None else {"pen_pos_up": PEN_UP}
with plotter(page=PAGE, speed_pendown=SPEED, pen_delay_down=SETTLE_MS, **extra) as ad:
    for i in range(LINES):
        t = i / (LINES - 1) if LINES > 1 else 0
        down = round(DOWN_START + (DOWN_END - DOWN_START) * t)
        y = y0 + i * spacing

        ad.moveto(x0, y)            # travel with the pen up at the old height
        ad.options.pen_pos_down = down
        ad.update()
        ad.lineto(x1, y)
        print(f"line {i + 1:2d}/{LINES}: pen_pos_down = {down}  (y = {y:.1f} mm)")

print("done")
