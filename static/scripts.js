// Scripts tab: edit, save and run Python scripts that drive the plotter
// directly (app/script_runner.py). Loaded after app.js, so $, t, readErr and
// serverState are in scope; app.js forwards script_* WebSocket events to
// window.onScriptEvent.

// ───── Tabs ──────────────────────────────────────────────────────────────

const TAB_KEY = "plotterhub.tab";

function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
  });
  try { localStorage.setItem(TAB_KEY, name); } catch {}
  if (name === "scripts") loadScripts();
  if (name === "pen" && window.loadPen) window.loadPen();
}

document.querySelectorAll(".tabs .tab").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

// ───── Scripts ───────────────────────────────────────────────────────────

const scriptsList = $("scripts-list");
const scriptName = $("script-name");
const scriptCode = $("script-code");
const scriptSave = $("script-save");
const scriptDelete = $("script-delete");
const scriptRun = $("script-run");
const scriptStop = $("script-stop");
const scriptNew = $("script-new");
const scriptMessage = $("script-message");
const scriptOutput = $("script-output");
const scriptPreviewBtn = $("script-preview");
const previewPanel = $("script-preview-panel");
const previewSvg = $("script-preview-svg");
const previewStats = $("script-preview-stats");
const previewWarnings = $("script-preview-warnings");

let scripts = [];             // [{name, source}]
let currentScript = null;     // name of the script loaded in the editor
let scriptStatus = { running: false };

const NEW_SCRIPT = `from plotterhub import plotter

with plotter() as ad:
    ad.moveto(20, 20)
    ad.lineto(120, 20)
`;

function setScriptMessage(text, isError) {
  scriptMessage.textContent = text || "";
  scriptMessage.className = isError ? "error" : "muted";
}

function renderScriptsList() {
  const opts = scripts.map((s) => {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = s.source === "example" ? `${s.name} (${t("scripts.example")})` : s.name;
    return o;
  });
  if (currentScript === null || !scripts.some((s) => s.name === currentScript)) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = t("scripts.unsaved");
    opts.unshift(o);
  }
  scriptsList.replaceChildren(...opts);
  scriptsList.value = currentScript || "";
  const cur = scripts.find((s) => s.name === currentScript);
  scriptDelete.disabled = !cur || cur.source !== "user";
}

scriptsList.addEventListener("change", () => {
  if (scriptsList.value) openScript(scriptsList.value);
});

function renderScriptStatus() {
  const s = scriptStatus;
  const queueBusy = !!(serverState && (serverState.active_id || serverState.awaiting_next_job));
  scriptRun.hidden = !!s.running;
  scriptStop.hidden = !s.running;
  scriptRun.disabled = queueBusy;
  scriptRun.title = queueBusy ? t("a11y.sleep_busy") : "";
  if (s.running) {
    setScriptMessage(t("scripts.running", { name: s.name }));
  } else if (s.name && s.stopped) {
    setScriptMessage(t("scripts.stopped"));
  } else if (s.name && s.exit_code != null) {
    setScriptMessage(t("scripts.finished", { code: s.exit_code }), s.exit_code !== 0);
  }
}

function appendOutput(line) {
  const atBottom = scriptOutput.scrollTop + scriptOutput.clientHeight >= scriptOutput.scrollHeight - 4;
  scriptOutput.textContent += line + "\n";
  if (atBottom) scriptOutput.scrollTop = scriptOutput.scrollHeight;
}

async function loadScripts() {
  try {
    const res = await fetch("/scripts", { cache: "no-store" });
    if (!res.ok) throw new Error(await readErr(res));
    const data = await res.json();
    scripts = data.scripts;
    scriptStatus = data.status;
    scriptOutput.textContent = data.status.log.map((l) => l + "\n").join("");
    scriptOutput.scrollTop = scriptOutput.scrollHeight;
    if (currentScript === null && scripts.length) {
      await openScript(scripts[0].name);
    } else {
      renderScriptsList();
    }
    renderScriptStatus();
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
  }
}

async function openScript(name) {
  try {
    const res = await fetch(`/scripts/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(await readErr(res));
    const data = await res.json();
    currentScript = data.name;
    scriptName.value = data.name;
    scriptCode.value = data.code;
    renderScriptsList();
    if (!previewPanel.hidden) previewScript();
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
  }
}

function editorName() {
  let n = scriptName.value.trim();
  if (n && !n.endsWith(".py")) n += ".py";
  return n;
}

async function saveScript() {
  const name = editorName();
  if (!name) { scriptName.focus(); return false; }
  try {
    const res = await fetch(`/scripts/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: scriptCode.value }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    currentScript = name;
    scriptName.value = name;
    const res2 = await fetch("/scripts", { cache: "no-store" });
    if (res2.ok) scripts = (await res2.json()).scripts;
    renderScriptsList();
    setScriptMessage(t("scripts.saved"));
    return true;
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
    return false;
  }
}

scriptSave.addEventListener("click", saveScript);

scriptCode.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    saveScript();
  } else if (e.key === "Tab") {
    // Indent with four spaces instead of leaving the textarea.
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = scriptCode;
    scriptCode.value = value.slice(0, a) + "    " + value.slice(b);
    scriptCode.selectionStart = scriptCode.selectionEnd = a + 4;
  }
});

// ───── Preview ───────────────────────────────────────────────────────────
// Dry-runs the editor's code against a recording stand-in for the plotter
// (plot_scripts/preview_shim) and draws what it would plot. Once shown, the
// preview follows edits.

const SHEET_MM = [420, 297];  // A3 landscape
let previewSeq = 0;
let previewTimer = null;

async function previewScript() {
  const seq = ++previewSeq;
  previewPanel.hidden = false;
  previewPanel.classList.add("stale");
  scriptPreviewBtn.disabled = true;
  try {
    const res = await fetch("/scripts/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: scriptCode.value }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    const data = await res.json();
    if (seq !== previewSeq) return;  // a newer preview is on its way
    renderPreview(data);
  } catch (e) {
    if (seq === previewSeq) previewWarnings.textContent = t("error.request_failed", { message: e.message });
  } finally {
    if (seq === previewSeq) {
      previewPanel.classList.remove("stale");
      scriptPreviewBtn.disabled = false;
    }
  }
}

function renderPreview(data) {
  const [W, H] = data.travel_mm || [430, 297];
  // Frame the travel area, widened to include anything drawn outside it.
  const pad = 6;
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  // The sheet is A3 landscape at the home corner; a script's
  // plotter(page=...) area is outlined on top of it when it differs.
  const page = data.page_mm;
  const showPage = page && !(page[0] === SHEET_MM[0] && page[1] === SHEET_MM[1]);
  if (page) { x1 = Math.max(x1, page[0]); y1 = Math.max(y1, page[1]); }
  for (const st of data.strokes) for (const [x, y] of st.pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  previewSvg.setAttribute("viewBox", `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);

  const downs = data.strokes.map((s) => s.pen_pos_down);
  const lo = Math.min(...downs), hi = Math.max(...downs);
  const varies = downs.length > 1 && hi > lo;
  // Lower pen_pos_down = more pressure = wider mark (a brush splays).
  const width = (d) => (varies ? 0.8 + 2.7 * (hi - d) / (hi - lo) : 0.8);

  const parts = [`<rect class="travel-area" x="0" y="0" width="${W}" height="${H}"/>`];
  for (let x = 50; x < W; x += 50) parts.push(`<line class="grid" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  for (let y = 50; y < H; y += 50) parts.push(`<line class="grid" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  parts.push(`<rect class="sheet" x="0" y="0" width="${SHEET_MM[0]}" height="${SHEET_MM[1]}"><title>A3 · ${fmtLength(SHEET_MM[0])} × ${fmtLength(SHEET_MM[1])}</title></rect>`);
  if (showPage) {
    parts.push(`<rect class="page" x="0" y="0" width="${page[0]}" height="${page[1]}"><title>${t("scripts.preview_page", { w: fmtLength(page[0]), h: fmtLength(page[1]) })}</title></rect>`);
  }
  if (data.travel.length) {
    parts.push(`<path class="travel" d="${data.travel.map(([a, b]) => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`).join("")}"/>`);
  }
  let downMm = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of data.strokes) {
    for (let i = 0; i < s.pts.length; i++) {
      const [x, y] = s.pts[i];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (i) downMm += Math.hypot(x - s.pts[i - 1][0], y - s.pts[i - 1][1]);
    }
    const tip = t("scripts.preview_stroke", { down: s.pen_pos_down, speed: s.speed_pendown });
    parts.push(`<polyline class="stroke" stroke-width="${width(s.pen_pos_down).toFixed(2)}" points="${s.pts.map((p) => p.join(",")).join(" ")}"><title>${tip}</title></polyline>`);
  }
  parts.push(`<circle class="home" cx="0" cy="0" r="3"><title>${t("scripts.preview_home")}</title></circle>`);
  previewSvg.innerHTML = parts.join("");

  const stats = [t("scripts.preview_stats", {
    strokes: data.strokes.length,
    distance: (downMm / 1000).toFixed(2),
    lifts: data.pen_lifts,
  })];
  if (data.strokes.length) stats.push(t("scripts.preview_extent", { w: fmtLength(maxX - minX), h: fmtLength(maxY - minY) }));
  if (varies) stats.push(t("scripts.preview_pressure", { lo, hi }));
  previewStats.textContent = stats.join(" · ");

  const warnings = [...data.warnings];
  if (data.exit_code !== 0) {
    const last = data.log.filter((l) => l.trim()).slice(-1)[0] || "";
    warnings.push(data.exit_code == null ? last : t("scripts.preview_error", { message: last }));
  }
  previewWarnings.textContent = warnings.join("\n");
}

scriptPreviewBtn.addEventListener("click", previewScript);

scriptCode.addEventListener("input", () => {
  if (previewPanel.hidden) return;
  previewPanel.classList.add("stale");
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewScript, 800);
});

scriptNew.addEventListener("click", () => {
  currentScript = null;
  scriptName.value = "";
  scriptCode.value = NEW_SCRIPT;
  renderScriptsList();
  if (!previewPanel.hidden) previewScript();
  scriptName.focus();
});

scriptDelete.addEventListener("click", async () => {
  if (!currentScript || !confirm(t("scripts.confirm_delete", { name: currentScript }))) return;
  try {
    const res = await fetch(`/scripts/${encodeURIComponent(currentScript)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readErr(res));
    currentScript = null;
    await loadScripts();
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
  }
});

scriptRun.addEventListener("click", async () => {
  scriptRun.disabled = true;
  try {
    const res = await fetch("/scripts/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editorName() || "untitled.py", code: scriptCode.value }),
    });
    if (!res.ok) throw new Error(await readErr(res));
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
  } finally {
    renderScriptStatus();
  }
});

scriptStop.addEventListener("click", async () => {
  try {
    const res = await fetch("/scripts/stop", { method: "POST" });
    if (!res.ok) throw new Error(await readErr(res));
  } catch (e) {
    setScriptMessage(t("error.request_failed", { message: e.message }), true);
  }
});

window.onScriptEvent = (msg) => {
  if (msg.type === "script_output") {
    appendOutput(msg.line);
  } else if (msg.type === "script_status") {
    if (msg.running && !scriptStatus.running) scriptOutput.textContent = "";
    scriptStatus = msg;
    renderScriptStatus();
  }
};

let initialTab = "queue";
try { initialTab = localStorage.getItem(TAB_KEY) || "queue"; } catch {}
window.showTab = showTab;
// pen.js (loaded next) opens its own tab if it was the last one used.
if (initialTab === "scripts") showTab("scripts");
