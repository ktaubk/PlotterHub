// Pen tab: live pen-height tuning (app/pen_tuner.py). Each +/- click sends
// the new heights and moves the pen there, so you can watch the tip find the
// paper. Loaded after scripts.js; app.js forwards pen_status events to
// window.onPenEvent.

const penConnect = $("pen-connect");
const penClose = $("pen-close");
const penConn = $("pen-conn");
const penUpValue = $("pen-up-value");
const penDownValue = $("pen-down-value");
const penDownMaxValue = $("pen-down-max-value");
const penTest = $("pen-test");
const penSave = $("pen-save");
const penSaved = $("pen-saved");
const penMessage = $("pen-message");
const penGauge = $("pen-gauge");

// Heights are 0-100, higher = higher: max pen down is the lowest number.
let pen = { active: false, pen_pos_up: 60, pen_pos_down: 40, pen_pos_down_max: 25,
            position: "up", saved_up: 60, saved_down: 40, saved_down_max: 25 };
const FIELD = { up: "pen_pos_up", down: "pen_pos_down", down_max: "pen_pos_down_max" };
let penStep = 5;
let penChain = Promise.resolve();   // serialize requests so clicks land in order

function setPenMessage(text, isError) {
  penMessage.textContent = text || "";
  penMessage.className = isError ? "error" : "muted";
}

function renderPen() {
  const on = !!pen.active;
  penConnect.hidden = on;
  penClose.hidden = !on;
  penConn.textContent = on ? t("pen.connected") : t("pen.disconnected");
  document.querySelectorAll("#tab-pen .pen-controls button").forEach((b) => {
    if (!b.classList.contains("pen-step-btn")) b.disabled = !on;
  });
  penUpValue.textContent = pen.pen_pos_up;
  penDownValue.textContent = pen.pen_pos_down;
  penDownMaxValue.textContent = pen.pen_pos_down_max;
  document.querySelectorAll("#tab-pen .pen-row").forEach((r) =>
    r.classList.toggle("current", on && pen.position === r.dataset.which));
  penSaved.textContent = t("pen.saved", { up: pen.saved_up, down: pen.saved_down, max: pen.saved_down_max });
  const ordered = pen.pen_pos_up > pen.pen_pos_down && pen.pen_pos_down >= pen.pen_pos_down_max;
  if (!ordered) setPenMessage(t("pen.warn_order"), true);
  else if (penMessage.className === "error" && penMessage.textContent === t("pen.warn_order")) setPenMessage("");
  renderGauge();
}

// A 0-100 rail with the up and down heights marked; the dot is the pen.
function renderGauge() {
  const top = 10, bottom = 210;
  const y = (v) => bottom - (bottom - top) * v / 100;
  const yu = y(pen.pen_pos_up), yd = y(pen.pen_pos_down), ym = y(pen.pen_pos_down_max);
  const tip = pen.active ? { up: yu, down: yd, down_max: ym }[pen.position] : null;
  penGauge.innerHTML = `
    <line class="rail" x1="20" y1="${top}" x2="20" y2="${bottom}"/>
    <text class="tick" x="8" y="${top + 4}">100</text>
    <text class="tick" x="14" y="${bottom + 4}">0</text>
    <line class="mark up" x1="12" y1="${yu}" x2="28" y2="${yu}"/>
    <text class="label up" x="32" y="${yu + 4}">${pen.pen_pos_up}</text>
    <line class="mark down" x1="12" y1="${yd}" x2="28" y2="${yd}"/>
    <text class="label down" x="32" y="${yd + 4}">${pen.pen_pos_down}</text>
    <line class="mark down-max" x1="12" y1="${ym}" x2="28" y2="${ym}"/>
    <text class="label down-max" x="32" y="${ym + 4}">${pen.pen_pos_down_max}</text>
    ${tip != null ? `<circle class="tip" cx="20" cy="${tip}" r="5"/>` : ""}`;
}

function penPost(path, body) {
  const run = async () => {
    const res = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(await readErr(res));
    pen = await res.json();
    renderPen();
  };
  penChain = penChain.then(run).catch((e) => {
    setPenMessage(t("error.request_failed", { message: e.message }), true);
  });
  return penChain;
}

function sendHeights(position) {
  // Show the new value at once; the server's reply confirms it.
  pen.position = position;
  renderPen();
  return penPost("/pen/heights", {
    pen_pos_up: pen.pen_pos_up, pen_pos_down: pen.pen_pos_down,
    pen_pos_down_max: pen.pen_pos_down_max, position,
  });
}

const clamp100 = (v) => Math.max(0, Math.min(100, v));

document.querySelectorAll("#tab-pen .pen-row").forEach((row) => {
  const which = row.dataset.which;
  const nudge = (dir) => {
    pen[FIELD[which]] = clamp100(pen[FIELD[which]] + dir * penStep);
    sendHeights(which);
  };
  row.querySelector(".pen-dec").addEventListener("click", () => nudge(-1));
  row.querySelector(".pen-inc").addEventListener("click", () => nudge(1));
  row.querySelector(".pen-go").addEventListener("click", () => sendHeights(which));
});

document.querySelectorAll("#tab-pen .pen-step-btn").forEach((b) =>
  b.addEventListener("click", () => {
    penStep = Number(b.dataset.step);
    document.querySelectorAll("#tab-pen .pen-step-btn").forEach((o) => o.classList.toggle("active", o === b));
  }));

penConnect.addEventListener("click", () => { setPenMessage(""); penPost("/pen/connect"); });
penClose.addEventListener("click", () => penPost("/pen/close"));
penTest.addEventListener("click", () => penPost("/pen/test-line"));
penSave.addEventListener("click", () =>
  penPost("/pen/save").then(() => {
    if (pen.saved_up === pen.pen_pos_up) {
      setPenMessage(t("pen.saved_now", { up: pen.saved_up, down: pen.saved_down, max: pen.saved_down_max }));
    }
  }));

window.loadPen = async () => {
  try {
    const res = await fetch("/pen", { cache: "no-store" });
    if (res.ok) { pen = await res.json(); renderPen(); }
  } catch {}
};

window.onPenEvent = (msg) => {
  pen = msg;
  renderPen();
};

renderPen();
let penInitialTab = null;
try { penInitialTab = localStorage.getItem("plotterhub.tab"); } catch {}
if (penInitialTab === "pen") window.showTab("pen");
