"""Subprocess entry point for running a NextDraw preview.

Invoked by plot_worker so the preview can be SIGTERM'd if the user cancels
during the planning phase. Prints a single JSON line on success; exits
non-zero on error (stderr carries the exception message).
"""
import json
import sys

from nextdraw import NextDraw


def main() -> int:
    svg_path = sys.argv[1]
    model = int(sys.argv[2])
    speed_pendown = int(sys.argv[3])
    speed_penup = int(sys.argv[4])
    acceleration = int(sys.argv[5])
    handling = int(sys.argv[6])
    penlift = int(sys.argv[7])

    ad = NextDraw()
    ad.plot_setup(svg_path)
    ad.options.mode = "plot"
    ad.options.preview = True
    # Nothing is rendered from the preview — we only read the time/distance
    # stats — so skip building the preview path graphics.
    ad.options.rendering = False
    ad.options.model = model
    ad.options.handling = handling
    ad.options.penlift = penlift
    ad.options.speed_pendown = speed_pendown
    ad.options.speed_penup = speed_penup
    ad.options.accel = acceleration
    ad.plot_run()

    pen_lifts = 0
    if hasattr(ad, "pen") and hasattr(ad.pen, "status") and hasattr(ad.pen.status, "lifts"):
        pen_lifts = int(ad.pen.status.lifts)

    result = {
        "estimated_total_seconds": float(getattr(ad, "time_estimate", 0.0)),
        "distance_pendown_m": float(getattr(ad, "distance_pendown", 0.0)),
        "distance_total_m": float(getattr(ad, "distance_total", 0.0)),
        "pen_lifts": pen_lifts,
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
