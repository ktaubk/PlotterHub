"""Stand-in ``nextdraw`` module for previewing a script without the plotter.

The Scripts tab's Preview puts this directory first on PYTHONPATH, so a
script's ``from nextdraw import NextDraw`` (directly or via plotterhub.py)
gets this recorder instead. It mirrors the interactive API's motion and pen
semantics, records pen-down strokes with the options in force when each was
drawn, and at exit writes everything as JSON to $PLOTTERHUB_PREVIEW_OUT.
Positions are recorded in mm from home.
"""

import atexit
import json
import os
import types

try:
    from nextdrawcore import nextdraw_conf as _conf
    _DEFAULTS = {k: getattr(_conf, k) for k in dir(_conf)
                 if not k.startswith("_") and isinstance(getattr(_conf, k), (int, float, bool, str))}
except Exception:
    _DEFAULTS = {"pen_pos_up": 60, "pen_pos_down": 40, "speed_pendown": 25,
                 "speed_penup": 75, "accel": 75}

try:
    from nextdrawcore.nextdraw_options.models import plotters as _plotters
except Exception:
    _plotters = None

_UNIT_TO_MM = {0: 25.4, 1: 10.0, 2: 1.0}
_instances: list["NextDraw"] = []


class NextDraw:
    def __init__(self):
        self.options = types.SimpleNamespace(**_DEFAULTS)
        self.options.model = int(os.environ.get("PLOTTER_MODEL", "9"))
        self.options.units = 0
        self.options.mode = "plot"
        self.params = types.SimpleNamespace(travel_x=16.93, travel_y=11.69)
        self.connected = False
        self.plot_status = types.SimpleNamespace(stopped=0)
        self._x = self._y = 0.0           # mm
        self._down = False
        self._stroke = None               # current pen-down stroke dict
        self.strokes: list[dict] = []
        self.travel: list[list[list[float]]] = []
        self.lifts = 0
        self.delay_ms = 0
        self.warnings: list[str] = []
        self.out_of_bounds = 0
        self.page_mm = None   # set by plotterhub.plotter(page=...)
        _instances.append(self)

    # Setup ----------------------------------------------------------------

    def interactive(self):
        self.options.mode = "interactive"
        self.options.units = 0

    def plot_setup(self, svg_input=None, argstrings=None):
        self._warn("plot_setup()/plot_run() (SVG plotting) isn't previewed — only interactive moves are.")

    def plot_run(self, output=False):
        return "" if output else None

    def load_config(self, config_ref):
        pass

    def _apply_model(self):
        if _plotters is not None:
            try:
                p = _plotters[int(self.options.model)]
                self.params.travel_x, self.params.travel_y = p.travel_x, p.travel_y
            except Exception:
                pass

    def connect(self):
        self._apply_model()
        self.connected = True
        self._down = False
        return True

    def disconnect(self):
        self._end_stroke()
        self.connected = False

    def update(self):
        self._apply_model()
        self._end_stroke()   # next stroke picks up the new options

    def block(self):
        pass

    def delay(self, time_ms):
        self.delay_ms += int(time_ms or 0)

    def usb_command(self, command):
        pass

    def usb_query(self, query):
        return None

    # Position and pen -----------------------------------------------------

    def _mm(self, v):
        return v * _UNIT_TO_MM.get(self.options.units, 25.4)

    def _from_mm(self, v):
        return v / _UNIT_TO_MM.get(self.options.units, 25.4)

    def turtle_pos(self):
        return self._from_mm(self._x), self._from_mm(self._y)

    current_pos = turtle_pos

    def turtle_pen(self):
        return not self._down

    current_pen = turtle_pen

    def penup(self):
        if self._down:
            self.lifts += 1
        self._down = False
        self._end_stroke()

    def pendown(self):
        self._down = True

    # Motion ---------------------------------------------------------------

    def _segment(self, x_mm, y_mm):
        w, h = self.params.travel_x * 25.4, self.params.travel_y * 25.4
        if not (-0.01 <= x_mm <= w + 0.01 and -0.01 <= y_mm <= h + 0.01):
            self.out_of_bounds += 1
        if self._down:
            if self._stroke is None:
                self._stroke = {
                    "pts": [[round(self._x, 3), round(self._y, 3)]],
                    "pen_pos_down": self.options.pen_pos_down,
                    "speed_pendown": self.options.speed_pendown,
                }
                self.strokes.append(self._stroke)
            self._stroke["pts"].append([round(x_mm, 3), round(y_mm, 3)])
        else:
            self.travel.append([[round(self._x, 3), round(self._y, 3)],
                                [round(x_mm, 3), round(y_mm, 3)]])
        self._x, self._y = x_mm, y_mm

    def _end_stroke(self):
        self._stroke = None

    def goto(self, x, y):
        self._segment(self._mm(x), self._mm(y))

    def go(self, dx, dy):
        self._segment(self._x + self._mm(dx), self._y + self._mm(dy))

    def moveto(self, x, y):
        self.penup()
        self.goto(x, y)

    def move(self, dx, dy):
        self.penup()
        self.go(dx, dy)

    def lineto(self, x, y):
        self._down = True
        self.goto(x, y)

    def line(self, dx, dy):
        self._down = True
        self.go(dx, dy)

    def draw_path(self, vertex_list):
        pts = list(vertex_list)
        if len(pts) < 2:
            return
        self.moveto(*pts[0])
        for p in pts[1:]:
            self.lineto(*p)
        self.penup()

    def _warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)


@atexit.register
def _dump():
    out = os.environ.get("PLOTTERHUB_PREVIEW_OUT")
    if not out:
        return
    travel_x = travel_y = None
    strokes, travel, warnings, lifts, delay_ms, page = [], [], [], 0, 0, None
    for nd in _instances:
        travel_x, travel_y = nd.params.travel_x * 25.4, nd.params.travel_y * 25.4
        strokes += [s for s in nd.strokes if len(s["pts"]) > 1]
        travel += nd.travel
        warnings += [w for w in nd.warnings if w not in warnings]
        if nd.out_of_bounds:
            warnings.append(f"{nd.out_of_bounds} move(s) go outside the {travel_x:.0f} × "
                            f"{travel_y:.0f} mm travel; the plotter clips them at the edge.")
        lifts += nd.lifts
        page = page or nd.page_mm
        delay_ms += nd.delay_ms
    with open(out, "w") as f:
        json.dump({"travel_mm": [travel_x or 430.0, travel_y or 297.0],
                   "strokes": strokes, "travel": travel[:20000], "pen_lifts": lifts,
                   "delay_ms": delay_ms, "page_mm": list(page) if page else None, "warnings": warnings[:20]}, f)
