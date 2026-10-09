// Pen tab: guided calibration for a regular pen (app/pen_tuner.py draws the
// test lines). Steps: set up → pen down → pen up → save. Each step draws one
// test line, asks what it looks like, and picks the next height from the
// answer. Click a step in the step bar to redo just that one; the other
// results are kept. Heights are 0-100, higher = higher. Brush pressure
// (pen_pos_down_max) isn't calibrated here and is left as it was.
// Loaded after scripts.js; app.js forwards pen_status events to window.onPenEvent.

const penClose = $("pen-close");
const penConn = $("pen-conn");
const penQuestion = $("pen-question");
const penAnswers = $("pen-answers");
const penMessage = $("pen-message");
const penSaved = $("pen-saved");
const penLog = $("pen-log");

const COARSE = 5;   // search step; the first solid line is then refined by 1
const MARGIN = 3;   // pen down sits this far below the first solid line

let pen = { active: false, tests: 0, saved_up: 60, saved_down: 40, saved_down_max: 25 };
let cal = null;     // calibration state, reset by resetCal()
let penBusy = false;

function resetCal() {
  // edge: first height that drew a solid line; down = edge - MARGIN.
  cal = { step: "setup", edge: null, down: null, up: null, h: null,
          lastNo: null, coarseMark: null, fine: false, saved: false };
  penLog.replaceChildren();
}

function setPenMessage(text, isError) {
  penMessage.textContent = text || "";
  penMessage.className = isError ? "error" : "muted";
}

function addLog(text, result, kind) {
  const li = document.createElement("li");
  li.textContent = text + " ";
  if (result) {
    const r = document.createElement("span");
    r.className = "r" + (kind ? " " + kind : "");
    r.textContent = "— " + result;
    li.appendChild(r);
  }
  penLog.appendChild(li);
  penLog.scrollTop = penLog.scrollHeight;
  return li;
}

// Mark the latest log line with the answer given for it.
function answerLog(result, kind) {
  const li = penLog.lastElementChild;
  if (!li) return;
  const r = document.createElement("span");
  r.className = "r" + (kind ? " " + kind : "");
  r.textContent = "— " + result;
  li.appendChild(r);
}

async function penRequest(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await readErr(res));
  pen = await res.json();
  return pen;
}

// Draw one test line, log it, then ask the step's question.
async function drawLine(down, opts = {}) {
  penBusy = true;
  renderPen();
  const n = pen.tests + 1;
  penQuestion.textContent = t("pen.drawing", { n });
  penAnswers.replaceChildren();
  setPenMessage("");
  try {
    await penRequest("/pen/line", { pen_pos_down: down, pen_pos_up: opts.up ?? null, dashed: !!opts.dashed });
    addLog(opts.dashed ? t("pen.log_dashed", { n, h: opts.up }) : t("pen.log_line", { n, h: down }),
           opts.note, opts.note ? "" : null);
    return n;
  } catch (e) {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
    return null;
  } finally {
    penBusy = false;
  }
}

function ask(question, answers) {
  penQuestion.textContent = question;
  penAnswers.replaceChildren(...answers.map(([label, cls, fn]) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", () => { if (!penBusy) fn(); });
    return b;
  }));
  renderPen();
}

// ───── Steps ─────────────────────────────────────────────────────────────

function stepSetup() {
  cal.step = "setup";
  ask(t("pen.setup_text"), [[t("pen.start"), "primary", startCalibration]]);
}

async function ensureConnected() {
  if (pen.active) return true;
  penBusy = true;
  setPenMessage("");
  penQuestion.textContent = t("pen.homing");
  penAnswers.replaceChildren();
  try {
    await penRequest("/pen/connect");
    return true;
  } catch (e) {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
    return false;
  } finally {
    penBusy = false;
  }
}

async function startCalibration() {
  if (await ensureConnected()) startStep("down");
}

// Begin (or redo) one search step from its starting height.
function startStep(step) {
  cal.step = step;
  setPenMessage("");
  if (step === "down") {
    cal.fine = false;
    cal.lastNo = cal.coarseMark = null;
    // Start clear of the paper.
    cal.h = Math.min(100, (cal.edge ?? pen.saved_down + MARGIN) + 15);
    return downTrial();
  }
  cal.h = Math.min(100, cal.down + 2 * COARSE);
  upTrial();
}

// After a step: run the first one still missing, else go to Save.
function nextStep() {
  cal.saved = false;
  const missing = ["down", "up"].find((k) => cal[k] == null);
  if (missing) startStep(missing);
  else stepReview();
}

// Pen down: step down by COARSE until a line comes out solid, then go back
// to the last skipping height and step down by 1 to find the exact edge.
async function downTrial() {
  const n = await drawLine(cal.h);
  if (n == null) return ask(penQuestion.textContent, [[t("pen.retry"), "primary", downTrial]]);
  ask(t("pen.down_q", { n, h: cal.h }), [
    [t("pen.skips"), "neutral", () => { answerLog(t("pen.r_skips"), "no"); downSkips(); }],
    [t("pen.solid"), "primary", () => { answerLog(t("pen.r_solid"), "yes"); downSolid(); }],
  ]);
}

function downSkips() {
  cal.lastNo = cal.h;
  const next = cal.h - (cal.fine ? 1 : COARSE);
  // Never redraw a height already known to mark: that's the answer range.
  if (cal.coarseMark != null && next <= cal.coarseMark) return narrowDown(cal.coarseMark);
  if (next < 0) { setPenMessage(t("pen.limit", { h: 0 })); return foundDown(0); }
  cal.h = next;
  downTrial();
}

function downSolid() {
  if (cal.fine) return foundDown(cal.h);
  if (cal.lastNo == null) {
    // The very first line was solid, so the search started too low: go higher.
    if (cal.h >= 100) return foundDown(100);
    cal.coarseMark = cal.h;
    cal.h = Math.min(100, cal.h + 2 * COARSE);
    return downTrial();
  }
  narrowDown(cal.h);
}

// ``solid`` is solid and cal.lastNo skips: refine between them by 1.
function narrowDown(solid) {
  if (cal.fine || cal.lastNo - solid <= 1) return foundDown(solid);
  cal.fine = true;
  cal.coarseMark = solid;
  cal.h = cal.lastNo - 1;
  downTrial();
}

// Sit a little below the edge so slightly uneven paper still marks.
function foundDown(edge) {
  cal.edge = edge;
  cal.down = Math.max(0, edge - MARGIN);
  nextStep();
}

// Pen up: dashes at pen down with pen-up hops at the test height; raise the
// lift until the gaps stay clean.
async function upTrial() {
  const n = await drawLine(cal.down, { up: cal.h, dashed: true });
  if (n == null) return ask(penQuestion.textContent, [[t("pen.retry"), "primary", upTrial]]);
  ask(t("pen.up_q", { n, h: cal.h }), [
    [t("pen.gaps_marked"), "neutral", () => {
      answerLog(t("pen.r_dragged"), "no");
      if (cal.h >= 100) { setPenMessage(t("pen.limit", { h: 100 })); return foundUp(100); }
      cal.h = Math.min(100, cal.h + COARSE);
      upTrial();
    }],
    [t("pen.gaps_clean"), "primary", () => { answerLog(t("pen.r_clean"), "yes"); foundUp(cal.h); }],
  ]);
}

function foundUp(h) {
  cal.up = h;
  nextStep();
}

function stepReview() {
  cal.step = "review";
  const vals = { up: cal.up, down: cal.down, margin: cal.edge - cal.down };
  const buttons = [
    [t("pen.sample"), "secondary", drawSample],
    [t("pen.save"), "primary", saveCalibration],
    [t("pen.restart"), "neutral", () => { resetCal(); startCalibration(); }],
  ];
  ask(cal.saved ? t("pen.saved_now", vals) : t("pen.review_text", vals), buttons);
  if (!(cal.up > cal.down)) setPenMessage(t("pen.order_warn"), true);
}

async function drawSample() {
  const note = t("pen.r_sample");
  for (const [down, opts] of [[cal.down, {}], [cal.down, { up: cal.up, dashed: true }]]) {
    if (await drawLine(down, { ...opts, note }) == null) break;
  }
  stepReview();
}

async function saveCalibration() {
  try {
    await penRequest("/pen/save", { pen_pos_up: cal.up, pen_pos_down: cal.down });
    cal.saved = true;
  } catch (e) {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
  }
  stepReview();
}

// ───── Render ────────────────────────────────────────────────────────────

function stepDone(step) {
  if (step === "setup") return !!pen.active;
  if (step === "review") return cal.saved;
  return cal[step] != null;
}

// Pen down can always be (re)done; pen up needs it first, and Save needs both.
function stepAvailable(step) {
  if (step === "setup" || step === "down") return true;
  if (step === "review") return cal.down != null && cal.up != null;
  return cal.down != null;
}

async function goToStep(step) {
  if (penBusy || !stepAvailable(step) || step === cal.step) return;
  if (step === "setup") return stepSetup();
  if (step === "review") return stepReview();
  if (await ensureConnected()) startStep(step);
}

document.querySelectorAll("#pen-steps li").forEach((li) => {
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.addEventListener("click", () => goToStep(li.dataset.step));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goToStep(li.dataset.step); }
  });
});

function renderPen() {
  const on = !!pen.active;
  penClose.hidden = !on;
  penConn.textContent = on ? t("pen.connected") : t("pen.disconnected");
  document.querySelectorAll("#pen-steps li").forEach((li) => {
    const step = li.dataset.step;
    li.classList.toggle("current", step === cal.step);
    li.classList.toggle("done", stepDone(step));
    const ok = stepAvailable(step) && !penBusy;
    li.classList.toggle("available", ok);
    li.setAttribute("aria-disabled", ok ? "false" : "true");
  });
  for (const key of ["down", "up"]) {
    const el = document.querySelector(`.pen-result[data-key="${key}"]`);
    el.querySelector("b").textContent = cal[key] ?? "—";
    el.classList.toggle("found", cal[key] != null);
  }
  penSaved.textContent = t("pen.saved", { up: pen.saved_up, down: pen.saved_down });
}

penClose.addEventListener("click", async () => {
  try { await penRequest("/pen/close"); } catch {}
  resetCal();
  stepSetup();
  setPenMessage(t("pen.closed"));
});

window.loadPen = async () => {
  try {
    const res = await fetch("/pen", { cache: "no-store" });
    if (res.ok) { pen = await res.json(); renderPen(); }
  } catch {}
};

window.onPenEvent = (msg) => {
  const wasActive = pen.active;
  pen = msg;
  // Closed elsewhere (idle timeout, another tab): start again from set-up.
  if (wasActive && !pen.active && cal.step !== "setup") {
    resetCal();
    stepSetup();
    setPenMessage(t("pen.closed"));
  }
  renderPen();
};

resetCal();
stepSetup();
let penInitialTab = null;
try { penInitialTab = localStorage.getItem("plotterhub.tab"); } catch {}
if (penInitialTab === "pen") window.showTab("pen");
