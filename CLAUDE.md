# PlotterHub (NextDraw fork)

Fork of [Synendo/PlotterHub](https://github.com/Synendo/PlotterHub) at
[ktaubk/PlotterHub](https://github.com/ktaubk/PlotterHub), ported from the
AxiDraw Python API (`pyaxidraw`) to the Bantam Tools NextDraw Python API.
`origin` = the fork, `upstream` = Synendo. Work lands on `main` (the Pi's
self-update fetches `main`); `nextdraw` mirrors it.

Keep replies short: lead with the action, one line per finding.

## Hardware and deployment

- **Plotter:** NextDraw 1117 = model **9** (430 × 297 mm travel). USB id
  `04d8:fd92`, nickname `NextDraw1117`, `/dev/ttyACM0`.
- **Pi:** Raspberry Pi 5, Raspberry Pi OS Lite 64-bit (Debian 13 trixie),
  Python 3.13, hostname `plotterhub`, user `ktaub`, SSH key auth only.
  Repo at `~/PlotterHub`, service `plotterhub` on port 80. LAN IP was
  `192.168.7.125` (DHCP, may change).
- **Room setup:** the carriage rests at mid-rail between sessions — that's
  what the header **Sleep** button (rail-and-carriage icon) does.

**Deploy a change:** commit, push to `origin main`, then trigger the Pi's own
update helper (NOPASSWD, no password needed):

```bash
ssh ktaub@plotterhub.local 'sudo -n /usr/local/sbin/plotterhub-update >/dev/null 2>&1 &'
```

It resets to `origin/main`, re-runs `install.sh`, restarts the service, and
logs to `~/PlotterHub/update.log`. Bump `VERSION` so the change is visible.
`sudo` otherwise needs the Pi password — never handle it; have the user run
anything that needs it.

**Local dev:** there's no test suite. Run the app with a venv that has
`requirements.txt` installed (`python -m uvicorn app.main:app --port 8099`);
the NextDraw API works without hardware in preview mode, and connects fail
cleanly (`plot_status.stopped == 101`). Keep `config.json`, `state.json` and
`uploads/` out of commits (gitignored).

## NextDraw API — things that bite

- `from nextdraw import NextDraw`; `NextDraw()` replaces `axidraw.AxiDraw()`.
  `plot_setup`, `plot_run(output=True)`, `plot_status.stopped`,
  `transmit_pause_request` and `res_plot` behave as in pyaxidraw.
- **`res_home` is gone.** Homing after a cancel is utility `raise_pen` then
  `walk_home` (`_walk_home()` in `plot_worker.py`). Raise first: `walk_home`
  moves with the pen wherever it is.
- **Never move the carriage with `walk_x`/`walk_mmx`.** They call
  `adjust_origin_offset`, shifting the *plot origin* with the carriage, and
  the offset persists in the EBB — every later plot starts displaced. For
  absolute moves use the interactive API: `interactive()` → `connect()`
  (raises pen, `find_home()`) → `moveto()` → `block()` → `disconnect()`.
  Interactive units default to inches, as does `params.travel_x`.
- `mode="find_home"` clears the homed flag first, so it forces a real
  re-home; `find_home()` alone returns early if already homed.
- Pause button: EBB3 `QG` status byte, bit 5 (`32`), via
  `plotink.ebb3_serial.EBB3` — not the legacy `QB`/`ebb_motion` query.
- Speeds clamp to 1–100 (AxiDraw allowed 110). `handling` 1–4 replaces
  `const_speed`. Models 1–7 are AxiDraws; **8 changed meaning** (was V3 Wide,
  now NextDraw 8511).
- `signal.signal` in `set_up_pause_transmitter` only runs when
  `keyboard_pause` is set, so the API is safe off the main thread.
- AxiDraw hardware needs EBB firmware ≥ 3.0.1 to work at all.

## SVG pipeline — things that bite

- **Layers** are only top-level `<g inkscape:groupmode="layer">` children of
  `<svg>`, plotted in document order; a label starting with a digit is
  "addressable". A file with none gets one implicit "Whole document" layer.
- **The browser re-parses layers itself** in `fetchSvgMeta()` (`app.js`).
  It must agree with `svg_utils.parse_layers()` — change both together.
  Same for `PX_PER_MM` / `SHAPE_SELECTOR`, mirrored in both files.
- **No `viewBox`** means user units are CSS px, not mm (Processing/py5
  exports). `transform_to_paper` and the preview both handle it; forgetting
  scales art 3.78× and crops it.
- **Unstroked shapes get plotted anyway** — vpype re-emits them as lines.
  `strip_unstroked()` removes explicit `stroke:none` shapes at upload. It
  deliberately keeps shapes with *no* stroke declared (could be CSS-class
  styled). Files uploaded before this existed still contain them.
- vpype output always carries a `viewBox`; with optimization on (default),
  bugs that only affect raw files stay hidden. Test with it off too.
- `svg_optimize.optimize_svg` needs `vpype` installed; without it planning
  fails silently (card stuck on "waiting to plan…", `plan_status: failed`).

## Making layered SVGs (user's sketches are py5 in Thonny)

py5/Processing export through Batik: no layers, no `viewBox`, white
background and occlusion-mask shapes. Draw each pen pass in its own stroke
colour, then:

```bash
vpype read --attr stroke in.svg write out.svg
```

→ numbered Inkscape layers plus a `viewBox`. `--layer-label` errors in
vpype 1.15 — keep the default labels. Don't draw a background rect.
Alternatives that emit layers natively: vsketch (`vsk.stroke(n)`), p5.js +
p5.plotSvg (`setSvgGroupByStrokeColor()`).

**Known limitation:** white occlusion masks don't hide anything on a
plotter — the lines underneath still plot. NextDraw has a `hiding`
(hidden-line) option that uses fills, but PlotterHub doesn't expose it and it
can't work with optimization on or after `strip_unstroked`.

## Conventions

- UI strings live in `static/i18n/*.json` — 10 locales, identical key sets.
  Edit the files textually (they have blank-line section breaks a JSON
  re-dump destroys). Check with:
  ```bash
  python3 -c "import json,glob;s={f:set(json.load(open(f))) for f in glob.glob('static/i18n/*.json')};b=s['static/i18n/en.json'];print([f for f,k in s.items() if k!=b] or 'ok')"
  ```
- Web-UI errors use coded details (`_coded` / `_WORKER_ERROR_CODES` in
  `main.py` → `apierror.*` strings); `/api/v1/*` keeps plain strings.
- Commits end with the `Co-Authored-By` trailer.

## The user's Mac

- ProtonVPN free has no LAN access, and its kill switch blocks the Pi.
  Windscribe is installed with LAN traffic allowed.
- A process without macOS **Local Network** permission gets "No route to
  host" to the Pi even with correct routing; SSH by IP if `.local` fails.
- `~/Desktop` is privacy-protected from Claude — have the user copy files
  elsewhere.

## Unresolved

- The physical pause button works in code but hasn't been confirmed by a
  real press on the hardware. (Sleep and plotting are confirmed.)
- Once saw a job's paper flip to A3 during testing; couldn't reproduce via
  upload, reload or PATCH.
