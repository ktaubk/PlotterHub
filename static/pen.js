// Pen tab: guided pen calibration (app/pen_tuner.py draws the test lines).
// Steps: set up → lightest mark (min pen down) → heaviest press (max pen
// down) → pen up → save. Each step draws one test line, asks what it looks
// like, and picks the next height from the answer. Heights are 0-100,
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

async function startCalibration() {
  penBusy = true;
  setPenMessage("");
  try {
    await penRequest("/pen/connect");
  } catch (e) {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
    return;
  } finally {
    penBusy = false;
  }
  cal.step = "min";
  cal.h = Math.min(100, pen.saved_down + 15);   // start clear of the paper
  minTrial();
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
  if (cal.fine && next <= cal.coarseMark) return foundMin(cal.coarseMark);
  if (next < 0) { setPenMessage(t("pen.limit", { h: 0 })); return foundMin(0); }
  cal.h = next;
  minTrial();
}

function minMarks() {
  if (cal.fine) return foundMin(cal.h);
  if (cal.lastNo == null) {
    // The very first line marked, so the search started too low: go higher.
    if (cal.h >= 100) return foundMin(100);
    cal.h = Math.min(100, cal.h + 2 * COARSE);
    return minTrial();
  }
  if (cal.lastNo - cal.h <= 1) return foundMin(cal.h);
  cal.fine = true;
  cal.coarseMark = cal.h;
  cal.h = cal.lastNo - 1;
  minTrial();
}

function foundMin(h) {
  cal.min = h;
  cal.step = "max";
  if (h === 0) return foundMax(0);
  cal.prev = h;
  cal.h = Math.max(0, h - COARSE);
  maxTrial();
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
  cal.step = "up";
  cal.h = Math.min(100, cal.min + 2 * COARSE);
  upTrial();
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
  stepReview();
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

const STEP_ORDER = ["setup", "min", "max", "up", "review"];

function renderPen() {
  const on = !!pen.active;
  penClose.hidden = !on;
  penConn.textContent = on ? t("pen.connected") : t("pen.disconnected");
  const cur = STEP_ORDER.indexOf(cal.step);
  document.querySelectorAll("#pen-steps li").forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle("current", i === cur);
    li.classList.toggle("done", i < cur || (cal.saved && i === cur));
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
