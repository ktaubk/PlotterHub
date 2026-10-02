"""Pen calibration: hold an interactive NextDraw session so the web UI's
guided calibration (static/pen.js) can draw test lines at chosen heights.

The UI walks through three questions — the lightest height that marks (min
pen down), the hardest useful press (max pen down) and the lowest lift whose
pen-up hops stay clean (pen up) — asking for one test line per step. Heights
are 0-100, higher = higher, so max pen down is the *lower* number.

Test lines are drawn only in a test area at least 50 mm from the home
corner: 30 mm lines, each 6 mm below the last, in columns of 30. The pen is
never lowered anywhere else.

The session owns the USB port (plot_worker.acquire_port) from connect until
close, so the queue, Sleep and scripts are refused meanwhile. It closes
itself after _IDLE_TIMEOUT_S without a request so a forgotten tab can't
hold the plotter forever. Results are saved as the hub's pen_pos_up /
pen_pos_down / pen_pos_down_max settings: plots use up + min down; scripts
also get max down (e.g. as a pressure range for a brush).
"""

import logging
import threading
import time

from nextdraw import NextDraw

from . import config, plot_worker, state

log = logging.getLogger(__name__)

_IDLE_TIMEOUT_S = 300
_TEST_X_MM, _TEST_Y_MM = 50.0, 50.0   # first test line's start
_TEST_LEN_MM = 30.0
_ROW_MM = 6.0                         # brush strokes get wide
_ROWS = 30                            # lines per column (y ≤ 224 mm)
_COL_MM = 45.0
_COLS = 5                             # then start over at the first column
_DASHES = 5                           # dashed line: 4 mm dashes, 2 mm hops
_DASH_MM, _HOP_MM = 4.0, 2.0

_lock = threading.RLock()
_ad: NextDraw | None = None
_tests = 0
_last_used = 0.0


def is_active() -> bool:
    return _ad is not None


def status() -> dict:
    return {"active": _ad is not None, "tests": _tests,
            "saved_up": config.PEN_POS_UP, "saved_down": config.PEN_POS_DOWN,
            "saved_down_max": config.PEN_POS_DOWN_MAX}


def _emit() -> None:
    state.emit({"type": "pen_status", **status()})


def _touch() -> None:
    global _last_used
    _last_used = time.monotonic()


def _test_spot() -> tuple[float, float]:
    """Start of the next test line."""
    n = _tests % (_ROWS * _COLS)
    return _TEST_X_MM + (n // _ROWS) * _COL_MM, _TEST_Y_MM + (n % _ROWS) * _ROW_MM


def _go_to_test_spot(ad: NextDraw) -> None:
    """Pen-up move to the next test line's start (no-op if already there)."""
    x, y = _test_spot()
    cx, cy = ad.turtle_pos()
    if abs(cx - x) > 0.01 or abs(cy - y) > 0.01:
        ad.moveto(x, y)


def connect() -> dict:
    global _ad, _tests
    with _lock:
        if _ad is not None:
            _touch()
            return status()
        plot_worker.acquire_port()  # raises "Plotter is busy"
        ad = NextDraw()
        try:
            ad.interactive()
            plot_worker.apply_machine_options(ad)
            ad.options.units = 2  # mm
            if not ad.connect():
                raise RuntimeError("Could not connect to the plotter")
            _tests = 0
            _go_to_test_spot(ad)  # wait over the test area, pen up
            ad.block()
        except Exception:
            try:
                ad.disconnect()
            except Exception:
                pass
            plot_worker.release_port()
            raise
        _ad = ad
        _touch()
        threading.Thread(target=_watch_idle, daemon=True).start()
    _emit()
    return status()


def _require() -> NextDraw:
    if _ad is None:
        raise RuntimeError("Pen tuning isn't connected")
    _touch()
    return _ad


def _clamp(v: int) -> int:
    return max(0, min(100, int(v)))


def draw(down: int, up: int | None = None, dashed: bool = False) -> dict:
    """Draw the next test line at pen-down height ``down``.

    ``dashed`` lifts the pen to ``up`` between dashes, to check that height
    clears the paper. For a solid line the lift only has to stay above
    ``down``, so it defaults to the saved pen-up height (or 10 above).
    """
    global _tests
    with _lock:
        ad = _require()
        down = _clamp(down)
        up = _clamp(up) if up is not None else _clamp(max(config.PEN_POS_UP, down + 10))
        ad.options.pen_pos_up = up
        ad.options.pen_pos_down = down
        ad.update()          # re-inits the servo; leaves the pen up
        x, y = _test_spot()
        if dashed:
            for i in range(_DASHES):
                x0 = x + i * (_DASH_MM + _HOP_MM)
                ad.moveto(x0, y)
                ad.lineto(x0 + _DASH_MM, y)
        else:
            ad.moveto(x, y)
            ad.lineto(x + _TEST_LEN_MM, y)
        ad.penup()
        _tests += 1
        _go_to_test_spot(ad)  # park over the next line's start
        ad.block()
    _emit()
    return status()


def save(up: int, down: int, down_max: int) -> dict:
    with _lock:
        config.update(pen_pos_up=_clamp(up), pen_pos_down=_clamp(down),
                      pen_pos_down_max=_clamp(down_max))
    _emit()
    return status()


def close() -> None:
    global _ad
    with _lock:
        ad = _ad
        if ad is None:
            return
        _ad = None
        try:
            ad.penup()
            ad.moveto(0, 0)
            ad.block()
        except Exception:
            log.exception("pen tuner: homing on close failed")
        finally:
            try:
                ad.disconnect()
            except Exception:
                pass
            plot_worker.release_port()
    _emit()


def _watch_idle() -> None:
    me = _ad
    while _ad is me and me is not None:
        time.sleep(5)
        if _ad is me and time.monotonic() - _last_used > _IDLE_TIMEOUT_S:
            log.info("pen tuner: idle for %ss, closing", _IDLE_TIMEOUT_S)
            close()
            return
