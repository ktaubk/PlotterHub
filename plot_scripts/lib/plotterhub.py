"""Helpers for scripts run from PlotterHub's Scripts tab.

    from plotterhub import plotter

    with plotter() as ad:          # connected, pen up, units = mm
        ad.moveto(20, 20)
        ad.lineto(120, 20)

Pass ``page=(width, height)`` in mm to record the paper size — the Preview
draws it as an outline (the paper is assumed to sit at the home corner).

``ad`` is a NextDraw in interactive mode (moveto / lineto / penup / pendown /
draw_path / delay ...). To change an option mid-script — pen heights, speeds —
set it on ``ad.options`` and call ``ad.update()``. On the way out (finished,
error or Stop) the pen is raised and the carriage returns to home.

Pen heights are 0-100 with higher = higher: ``pen_pos_down`` lower presses
the pen harder into the paper. The heights saved in the Pen tab are
PEN_UP, PEN_DOWN_MIN (lightest touch that marks — the default pen-down) and
PEN_DOWN_MAX (hardest useful press, a lower number):

    from plotterhub import plotter, PEN_DOWN_MIN, PEN_DOWN_MAX
"""

import os
from contextlib import contextmanager

from nextdraw import NextDraw

_UNITS = {"in": 0, "cm": 1, "mm": 2}

PEN_UP = int(os.environ.get("PLOTTER_PEN_UP", "60"))
PEN_DOWN_MIN = int(os.environ.get("PLOTTER_PEN_DOWN", "40"))
PEN_DOWN_MAX = int(os.environ.get("PLOTTER_PEN_DOWN_MAX", "25"))


@contextmanager
def plotter(units: str = "mm", page: tuple[float, float] | None = None, **options):
    """Connect with the hub's machine settings; extra kwargs set ad.options."""
    ad = NextDraw()
    ad.page_mm = page  # only the preview reads it
    ad.interactive()
    ad.options.model = int(os.environ.get("PLOTTER_MODEL", "9"))
    ad.options.penlift = int(os.environ.get("PLOTTER_PENLIFT", "1"))
    ad.options.handling = int(os.environ.get("PLOTTER_HANDLING", "1"))
    # Pen heights saved from the Pen tab; pass pen_pos_up=... to override.
    ad.options.pen_pos_up = PEN_UP
    ad.options.pen_pos_down = PEN_DOWN_MIN
    ad.options.units = _UNITS[units]
    for k, v in options.items():
        setattr(ad.options, k, v)
    if not ad.connect():
        raise SystemExit("Could not connect to the plotter. Is it on and plugged in?")
    try:
        yield ad
    finally:
        try:
            ad.penup()
            ad.moveto(0, 0)
            ad.block()
        finally:
            ad.disconnect()
