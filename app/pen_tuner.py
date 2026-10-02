"""Live pen-height tuning: hold an interactive NextDraw session so the web UI
can nudge three heights and see the pen move on each click — pen up, min pen
down (lightest touch that marks) and max pen down (hardest useful press).
Heights are 0-100, higher = higher, so max pen down is the *lower* number.

The session owns the USB port (plot_worker.acquire_port) from connect until
close, so the queue, Sleep and scripts are refused meanwhile. It closes
itself after _IDLE_TIMEOUT_S without a request so a forgotten tab can't
hold the plotter forever. Heights found here are saved as the hub's
pen_pos_up / pen_pos_down / pen_pos_down_max settings: plots use up + min
down; scripts also get max down (e.g. as a pressure range for a brush).
"""

import logging
import threading
import time

from nextdraw import NextDraw

from . import config, plot_worker, state

log = logging.getLogger(__name__)

_IDLE_TIMEOUT_S = 300
# All pen-down tests happen in a test area at least 50 mm from the home
# corner: the pen only lowers at the next test line's start, never at home.
_TEST_X_MM, _TEST_Y_MM = 50.0, 50.0   # first test line's start
_TEST_LEN_MM = 30.0
_TEST_STEP_MM = 4.0                   # gap between successive test lines
_TEST_ROWS = 40                       # wrap back to the top after this many (y ≤ 206 mm)

_lock = threading.RLock()
_ad: NextDraw | None = None
_up = 60
_down = 40          # min pen down (light)
_down_max = 25      # max pen down (heavy)
_position = "up"    # where the pen is: "up" | "down" | "down_max"
POSITIONS = ("up", "down", "down_max")
_tests = 0
_last_used = 0.0
_watchdog: threading.Thread | None = None


def is_active() -> bool:
    return _ad is not None


def status() -> dict:
    return {"active": _ad is not None, "pen_pos_up": _up, "pen_pos_down": _down,
            "pen_pos_down_max": _down_max, "position": _position, "tests": _tests,
            "saved_up": config.PEN_POS_UP, "saved_down": config.PEN_POS_DOWN,
            "saved_down_max": config.PEN_POS_DOWN_MAX}


def _emit() -> None:
    state.emit({"type": "pen_status", **status()})


def _touch() -> None:
    global _last_used
    _last_used = time.monotonic()


def connect() -> dict:
    global _ad, _up, _down, _down_max, _position, _tests, _watchdog
    with _lock:
        if _ad is not None:
            _touch()
            return status()
        plot_worker.acquire_port()  # raises "Plotter is busy"
        try:
            ad = NextDraw()
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
        _up, _down = config.PEN_POS_UP, config.PEN_POS_DOWN
        _down_max = config.PEN_POS_DOWN_MAX
        _position = "up"
        _touch()
        _watchdog = threading.Thread(target=_watch_idle, daemon=True)
        _watchdog.start()
    _emit()
    return status()


def _require() -> NextDraw:
    if _ad is None:
        raise RuntimeError("Pen tuning isn't connected")
    _touch()
    return _ad


def _clamp(v: int) -> int:
    return max(0, min(100, int(v)))


def _test_spot() -> tuple[float, float]:
    """Start of the next test line."""
    return _TEST_X_MM, _TEST_Y_MM + (_tests % _TEST_ROWS) * _TEST_STEP_MM


def _go_to_test_spot(ad: NextDraw) -> None:
    """Pen-up move to the next test line's start (no-op if already there)."""
    x, y = _test_spot()
    cx, cy = ad.turtle_pos()
    if abs(cx - x) > 0.01 or abs(cy - y) > 0.01:
        ad.moveto(x, y)


def set_heights(up: int, down: int, down_max: int, position: str) -> dict:
    """Apply heights, then move the pen to ``position`` (one of POSITIONS)."""
    global _up, _down, _down_max, _position
    with _lock:
        ad = _require()
        _up, _down, _down_max = _clamp(up), _clamp(down), _clamp(down_max)
        ad.options.pen_pos_up = _up
        ad.options.pen_pos_down = _down_max if position == "down_max" else _down
        ad.update()          # re-inits the servo; leaves the pen up
        if position in ("down", "down_max"):
            _go_to_test_spot(ad)
            ad.pendown()
        else:
            ad.penup()
        _position = position
    _emit()
    return status()


def test_line() -> dict:
    """Draw a short line at the pen-down height being tuned (max if that row
    was the last lowered, else min), each line below the last."""
    global _tests, _position
    with _lock:
        ad = _require()
        heavy = _position == "down_max"
        ad.options.pen_pos_down = _down_max if heavy else _down
        ad.update()
        x, y = _test_spot()
        ad.moveto(x, y)
        ad.lineto(x + _TEST_LEN_MM, y)
        ad.penup()
        _tests += 1
        _go_to_test_spot(ad)  # park over the next line's start
        ad.block()
        _position = "up"
    _emit()
    return status()


def save() -> dict:
    with _lock:
        config.update(pen_pos_up=_up, pen_pos_down=_down, pen_pos_down_max=_down_max)
    _emit()
    return status()


def close() -> None:
    global _ad, _position
    with _lock:
        ad = _ad
        if ad is None:
            return
        _ad = None
        _position = "up"
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
    while _ad is not None:
        time.sleep(5)
        if _ad is not None and time.monotonic() - _last_used > _IDLE_TIMEOUT_S:
            log.info("pen tuner: idle for %ss, closing", _IDLE_TIMEOUT_S)
            close()
            return
