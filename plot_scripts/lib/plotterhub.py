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
the pen harder into the paper. The hub's saved heights are
PEN_UP, PEN_DOWN_MIN (lightest touch that marks — the default pen-down) and
PEN_DOWN_MAX (hardest useful press, a lower number):

    from plotterhub import plotter, PEN_DOWN_MIN, PEN_DOWN_MAX

To vary pressure *along* a stroke, call set_pressure(ad, height) between
lineto()s: it moves the pen-down height while the pen stays on the paper.
(ad.update() can't do this — it lifts the pen whenever a height changes.)
"""

import os
from contextlib import contextmanager

from nextdraw import NextDraw

_UNITS = {"in": 0, "cm": 1, "mm": 2}

PEN_UP = int(os.environ.get("PLOTTER_PEN_UP", "60"))
PEN_DOWN_MIN = int(os.environ.get("PLOTTER_PEN_DOWN", "40"))
PEN_DOWN_MAX = int(os.environ.get("PLOTTER_PEN_DOWN_MAX", "25"))


def set_pressure(ad, pen_pos_down: float) -> None:
    """Change the pen-down height mid-stroke without lifting the pen.

    Sets the EBB's pen-down servo position (SC,5) and, if the pen is down,
    re-issues pen-down (SP,0) with no delay, so the servo eases to the new
    height while the carriage keeps moving. Lower = more pressure.
    """
    pos = max(0.0, min(100.0, float(pen_pos_down)))
    ad.options.pen_pos_down = pos
    params = ad.params
    smin, smax = getattr(params, "servo_min", None), getattr(params, "servo_max", None)
    if smin is None or smax is None:
        return  # preview stand-in: recording the option is enough
    ad.usb_command(f"SC,5,{int(round(smin + (smax - smin) * pos / 100))}")
    if not ad.current_pen():  # current_pen() is True when the pen is up
        ad.usb_command(f"SP,0,0,{params.servo_pin}")


@contextmanager
def plotter(units: str = "mm", page: tuple[float, float] | None = None, **options):
    """Connect with the hub's machine settings; extra kwargs set ad.options."""
    ad = NextDraw()
    ad.page_mm = page  # only the preview reads it
    ad.interactive()
    ad.options.model = int(os.environ.get("PLOTTER_MODEL", "9"))
    ad.options.penlift = int(os.environ.get("PLOTTER_PENLIFT", "1"))
    ad.options.handling = int(os.environ.get("PLOTTER_HANDLING", "1"))
    # The hub's saved pen heights; pass pen_pos_up=... to override.
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
