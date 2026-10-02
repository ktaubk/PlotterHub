"""Run a user's Python script against the plotter, outside the job queue.

A script is a plain Python file that drives the NextDraw interactive API —
usually through ``plot_scripts/lib/plotterhub.py``'s ``plotter()`` context
manager, which connects with the hub's machine settings. It runs as a
subprocess of the service's own interpreter (so ``nextdraw`` is importable)
while this module holds the plot worker's USB port lock, so neither the
queue nor the Sleep move can grab the plotter mid-script.

Built-in examples live in ``plot_scripts/examples`` (tracked); scripts saved
from the web UI go to ``plot_scripts/user`` (gitignored) and shadow an
example of the same name.
"""

import json as _json
import logging
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

from . import config, plot_worker, state

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = BASE_DIR / "plot_scripts"
EXAMPLES_DIR = SCRIPTS_DIR / "examples"
USER_DIR = SCRIPTS_DIR / "user"
LIB_DIR = SCRIPTS_DIR / "lib"
PREVIEW_SHIM_DIR = SCRIPTS_DIR / "preview_shim"

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}\.py$")
_STOP_GRACE_S = 5.0     # SIGINT first so the script's finally can lift the pen
_PREVIEW_TIMEOUT_S = 20.0

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_stop_requested = threading.Event()
_log: deque[str] = deque(maxlen=500)
_status: dict = {"running": False, "name": None, "exit_code": None,
                 "stopped": False, "started_at": None}


# Script files -------------------------------------------------------------

def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name))


def list_scripts() -> list[dict]:
    found: dict[str, str] = {}
    for src, d in (("example", EXAMPLES_DIR), ("user", USER_DIR)):
        if d.is_dir():
            for p in d.glob("*.py"):
                if valid_name(p.name):
                    found[p.name] = src  # user overrides example
    return [{"name": n, "source": found[n]} for n in sorted(found)]


def _path_for(name: str) -> tuple[Path, str] | None:
    for src, d in (("user", USER_DIR), ("example", EXAMPLES_DIR)):
        p = d / name
        if p.is_file():
            return p, src
    return None


def read_script(name: str) -> dict | None:
    found = _path_for(name)
    if found is None:
        return None
    p, src = found
    return {"name": name, "source": src, "code": p.read_text()}


def save_script(name: str, code: str) -> dict:
    USER_DIR.mkdir(parents=True, exist_ok=True)
    (USER_DIR / name).write_text(code)
    return {"name": name, "source": "user"}


def delete_script(name: str) -> bool:
    """Delete a user script. Examples can't be deleted (returns False)."""
    p = USER_DIR / name
    if not p.is_file():
        return False
    p.unlink()
    return True


# Running ------------------------------------------------------------------

def status() -> dict:
    with _lock:
        return {**_status, "log": list(_log)}


def is_running() -> bool:
    return _status["running"]


def _emit_status() -> None:
    state.emit({"type": "script_status", **_status})


def _append(line: str) -> None:
    _log.append(line)
    state.emit({"type": "script_output", "line": line})


def _script_env(path_dirs: list[Path]) -> dict:
    extra = [os.environ["PYTHONPATH"]] if os.environ.get("PYTHONPATH") else []
    return {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(d) for d in path_dirs] + extra),
        "PYTHONUNBUFFERED": "1",
        "PLOTTER_MODEL": str(config.PLOTTER_MODEL),
        "PLOTTER_PENLIFT": str(config.PENLIFT),
        "PLOTTER_HANDLING": str(config.HANDLING),
        "PLOTTER_PEN_UP": str(config.PEN_POS_UP),
        "PLOTTER_PEN_DOWN": str(config.PEN_POS_DOWN),
        "PLOTTER_PEN_DOWN_MAX": str(config.PEN_POS_DOWN_MAX),
    }


def preview(code: str) -> dict:
    """Dry-run ``code`` against the recording shim (no hardware, no port lock).

    Returns the recorded strokes plus the script's output and exit code.
    """
    with tempfile.TemporaryDirectory(prefix="plotterhub-preview-") as d:
        src, out = Path(d) / "script.py", Path(d) / "preview.json"
        src.write_text(code)
        env = _script_env([PREVIEW_SHIM_DIR, LIB_DIR])
        env["PLOTTERHUB_PREVIEW_OUT"] = str(out)
        try:
            proc = subprocess.run(
                [sys.executable, str(src)], cwd=str(SCRIPTS_DIR), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                timeout=_PREVIEW_TIMEOUT_S,
            )
            rc, output = proc.returncode, proc.stdout
        except subprocess.TimeoutExpired as e:
            rc = None
            output = e.stdout or ""
            if isinstance(output, bytes):  # TimeoutExpired ignores text=True
                output = output.decode(errors="replace")
            output += f"\npreview timed out after {_PREVIEW_TIMEOUT_S:.0f} s"
        result = _json.loads(out.read_text()) if out.exists() else {
            "travel_mm": None, "strokes": [], "travel": [], "pen_lifts": 0,
            "delay_ms": 0, "warnings": []}
    lines = output.splitlines()
    return {**result, "exit_code": rc, "log": lines[-200:]}


def run(name: str, code: str) -> None:
    """Start ``code`` (displayed as ``name``). Raises RuntimeError if busy."""
    global _proc
    with _lock:
        if _status["running"]:
            raise RuntimeError("Plotter is busy")
        plot_worker.acquire_port()  # raises "Plotter is busy"
        try:
            fd, tmp = tempfile.mkstemp(prefix="plotterhub-", suffix=".py")
            with os.fdopen(fd, "w") as f:
                f.write(code)
            env = _script_env([LIB_DIR])
            proc = subprocess.Popen(
                [sys.executable, "-u", tmp], cwd=str(SCRIPTS_DIR), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
        except Exception:
            plot_worker.release_port()
            raise
        _proc = proc
        _stop_requested.clear()
        _log.clear()
        _status.update(running=True, name=name, exit_code=None,
                       stopped=False, started_at=time.time())
    _emit_status()
    threading.Thread(target=_watch, args=(proc, Path(tmp)), daemon=True).start()


def _watch(proc: subprocess.Popen, tmp: Path) -> None:
    global _proc
    rc = None
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            _append(line.rstrip("\n"))
        rc = proc.wait()
        if _stop_requested.is_set():
            # The script may have been killed with the pen down; lift it and
            # send the carriage home before anything else gets the port.
            _append("— stopped; raising pen and returning home —")
            try:
                plot_worker.walk_home()
            except Exception as e:
                _append(f"could not home the carriage: {e}")
    except Exception:
        log.exception("script watcher crashed")
    finally:
        tmp.unlink(missing_ok=True)
        with _lock:
            _proc = None
            _status.update(running=False, exit_code=rc,
                           stopped=_stop_requested.is_set())
        plot_worker.release_port()
        _emit_status()


def stop() -> None:
    proc = _proc
    if proc is None:
        raise RuntimeError("No script running")
    _stop_requested.set()
    try:
        proc.send_signal(signal.SIGINT)
    except ProcessLookupError:
        return

    def _kill_later():
        try:
            proc.wait(timeout=_STOP_GRACE_S)
        except subprocess.TimeoutExpired:
            proc.kill()

    threading.Thread(target=_kill_later, daemon=True).start()


def shutdown(timeout_s: float = 10.0) -> None:
    proc = _proc
    if proc is None:
        return
    try:
        stop()
        proc.wait(timeout=timeout_s)
    except Exception:
        log.exception("script shutdown")
