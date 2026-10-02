// Pen tab: guided pen calibration (app/pen_tuner.py draws the test lines).
// Steps: set up → lightest mark (min pen down) → heaviest press (max pen
// down) → pen up → save. Each step draws one test line, asks what it looks
// like, and picks the next height from the answer. Click a step in the step
// bar to redo just that one; the other results are kept. Heights are 0-100,
// higher = higher, so pressing harder means a lower number.
// Loaded after scripts.js; app.js forwards pen_status events to window.onPenEvent.

const penClose = $("pen-close");
const penConn = $("pen-conn");
const penQuestion = $("pen-question");
const penAnswers = $("pen-answers");
const penMessage = $("pen-message");
const penSaved = $("pen-saved");
const penLog = $("pen-log");

const COARSE = 5;   // search step; the lightest mark is then refined by 1

let pen = { active: false, tests: 0, saved_up: 60, saved_down: 40, saved_down_max: 25 };
let cal = null;     // calibration state, reset by resetCal()
let penBusy = false;

function resetCal() {
  cal = { step: "setup", min: null, max: null, up: null, h: null, prev: null,
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
  ask(t("pen.setup_text") + " " + t("pen.setup_place_hint"), [
    [t("pen.place"), "neutral", startPlace],
    [t("pen.start"), "primary", startCalibration],
  ]);
}

// Place a new pen: the holder waits over the test area, lowered to the saved
// lightest mark, so the pen is clamped with its tip just resting on the paper
// and its heights start out where the calibration expects them.
async function startPlace() {
  if (!(await ensureConnected())) return;
  // A new pen makes earlier results meaningless; start it at the saved
  // lightest mark so the saved heights carry over as closely as possible.
  cal.placeH = cal.min ?? pen.saved_down;
  cal.min = cal.max = cal.up = null;
  cal.saved = false;
  placeHold(true);
}

async function placeHold(lowered) {
  penBusy = true;
  renderPen();
  setPenMessage("");
  try {
    await penRequest("/pen/hold", { pen_pos_down: cal.placeH, lowered });
  } catch (e) {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
  } finally {
    penBusy = false;
  }
  placeAsk(lowered);
}

function placeAsk(lowered) {
  const h = cal.placeH;
  const up = Math.min(100, Math.max(pen.saved_up, h + 10));
  const nudge = (d) => () => { cal.placeH = Math.max(0, Math.min(100, h + d)); placeHold(true); };
  const lowText = t("pen.place_lowered", { h }) +
    (h === pen.saved_down ? " " + t("pen.place_is_saved") : "");
  ask(lowered ? lowText : t("pen.place_raised", { h, up }), [
    lowered ? [t("pen.place_raise"), "primary", () => placeHold(false)]
            : [t("pen.place_lower"), "neutral", () => placeHold(true)],
    [t("pen.place_test", { h }), "secondary", async () => {
      if (await drawLine(h) != null) placeAsk(false);
    }],
    ["−5", "neutral", nudge(-5)],
    ["+5", "neutral", nudge(5)],
    [t("pen.start"), lowered ? "neutral" : "primary", () => startStep("min")],
  ]);
}

async function ensureConnected() {
  if (pen.active) return true;
  penBusy = true;
  setPenMessage("");
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
  if (await ensureConnected()) startStep("min");
}

// Begin (or redo) one search step from its starting height.
function startStep(step) {
  cal.step = step;
  setPenMessage("");
  if (step === "min") {
    cal.fine = false;
    cal.lastNo = cal.coarseMark = null;
    // Start clear of the paper: above the last result, the height a new pen
    // was seated at, or the saved lightest mark.
    cal.h = Math.min(100, (cal.min ?? cal.placeH ?? pen.saved_down) + 15);
    return minTrial();
  }
  if (step === "max") {
    if (cal.min === 0) return foundMax(0);
    cal.prev = cal.min;
    cal.h = Math.max(0, cal.min - COARSE);
    return maxTrial();
  }
  cal.h = Math.min(100, cal.min + 2 * COARSE);
  upTrial();
}

// After a step: run the first one still missing, else go to Save.
function nextStep() {
  cal.saved = false;
  const missing = ["min", "max", "up"].find((k) => cal[k] == null);
  if (missing) startStep(missing);
  else stepReview();
}

// Lightest mark: step down by COARSE until a line marks, then go back to
// the last blank height and step down by 1 to find the exact one.
async function minTrial() {
  const n = await drawLine(cal.h);
  if (n == null) return ask(penQuestion.textContent, [[t("pen.retry"), "primary", minTrial]]);
  ask(t("pen.min_q", { n, h: cal.h }), [
    [t("pen.no_mark"), "neutral", () => { answerLog(t("pen.r_no_mark"), "no"); minNoMark(); }],
    [t("pen.marks"), "primary", () => { answerLog(t("pen.r_mark"), "yes"); minMarks(); }],
  ]);
}

function minNoMark() {
  cal.lastNo = cal.h;
  const next = cal.h - (cal.fine ? 1 : COARSE);
  // Never redraw a height already known to mark: that's the answer range.
  if (cal.coarseMark != null && next <= cal.coarseMark) return narrowMin(cal.coarseMark);
  if (next < 0) { setPenMessage(t("pen.limit", { h: 0 })); return foundMin(0); }
  cal.h = next;
  minTrial();
}

function minMarks() {
  if (cal.fine) return foundMin(cal.h);
  if (cal.lastNo == null) {
    // The very first line marked, so the search started too low: go higher.
    if (cal.h >= 100) return foundMin(100);
    cal.coarseMark = cal.h;
    cal.h = Math.min(100, cal.h + 2 * COARSE);
    return minTrial();
  }
  narrowMin(cal.h);
}

// ``mark`` marks and cal.lastNo doesn't: refine between them by 1.
function narrowMin(mark) {
  if (cal.fine || cal.lastNo - mark <= 1) return foundMin(mark);
  cal.fine = true;
  cal.coarseMark = mark;
  cal.h = cal.lastNo - 1;
  minTrial();
}

function foundMin(h) {
  cal.min = h;
  if (h === 0) cal.max = 0;   // can't press harder than 0
  nextStep();
}

// Heaviest press: keep pressing harder by COARSE while lines improve.
async function maxTrial() {
  const n = await drawLine(cal.h);
  if (n == null) return ask(penQuestion.textContent, [[t("pen.retry"), "primary", maxTrial]]);
  ask(t("pen.max_q", { n, h: cal.h, prev: cal.prev }), [
    [t("pen.harder"), "neutral", () => {
      answerLog(t("pen.r_better"), "yes");
      if (cal.h === 0) { setPenMessage(t("pen.limit", { h: 0 })); return foundMax(0); }
      cal.prev = cal.h;
      cal.h = Math.max(0, cal.h - COARSE);
      maxTrial();
    }],
    [t("pen.use_this"), "primary", () => { answerLog(t("pen.r_chosen"), "yes"); foundMax(cal.h); }],
    [t("pen.too_far", { prev: cal.prev }), "neutral", () => { answerLog(t("pen.r_too_far"), "no"); foundMax(cal.prev); }],
  ]);
}

function foundMax(h) {
  cal.max = h;
  nextStep();
}

// Pen up: dashes at the lightest mark with pen-up hops at the test height;
// raise the lift until the gaps stay clean.
async function upTrial() {
  const n = await drawLine(cal.min, { up: cal.h, dashed: true });
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
  const vals = { up: cal.up, down: cal.min, max: cal.max };
  const buttons = [
    [t("pen.sample"), "secondary", drawSample],
    [t("pen.save"), "primary", saveCalibration],
    [t("pen.restart"), "neutral", () => { resetCal(); startCalibration(); }],
  ];
  ask(cal.saved ? t("pen.saved_now", vals) : t("pen.review_text", vals), buttons);
  if (!(cal.up > cal.min && cal.min >= cal.max)) setPenMessage(t("pen.order_warn"), true);
}

async function drawSample() {
  const note = t("pen.r_sample");
  for (const [down, opts] of [[cal.min, {}], [cal.max, {}], [cal.min, { up: cal.up, dashed: true }]]) {
    if (await drawLine(down, { ...opts, note }) == null) break;
  }
  stepReview();
}

async function saveCalibration() {
  try {
    await penRequest("/pen/save", { pen_pos_up: cal.up, pen_pos_down: cal.min, pen_pos_down_max: cal.max });
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

// Lightest mark can always be (re)done; the others need it first, and Save
// needs all three.
function stepAvailable(step) {
  if (step === "setup" || step === "min") return true;
  if (step === "review") return cal.min != null && cal.max != null && cal.up != null;
  return cal.min != null;
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
  for (const key of ["min", "max", "up"]) {
    const el = document.querySelector(`.pen-result[data-key="${key}"]`);
    el.querySelector("b").textContent = cal[key] ?? "—";
    el.classList.toggle("found", cal[key] != null);
  }
  penSaved.textContent = t("pen.saved", { up: pen.saved_up, down: pen.saved_down, max: pen.saved_down_max });
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
