// Wires up the dashboard: pulls leads from /api/leads, listens to filter
// controls, recomputes KPIs and re-draws charts. All filtering happens
// client-side so the dataset is fetched once and reused.

import {
  bucketOutcome, filterRecords, setterKPIs, closerKPIs,
  groupBy, parseDate, fmt
} from "./kpis.js";

const state = {
  records: [],
  fetchedAt: null,
  charts: {}
};

const $ = id => document.getElementById(id);
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ---------- Loading ----------
async function loadRecords() {
  $("status-text").textContent = "Loading…";
  $("refresh-btn").disabled = true;
  try {
    const res = await fetch("/api/leads");
    if (!res.ok) throw new Error((await res.text()).slice(0, 200));
    const data = await res.json();
    state.records = data.records || [];
    state.fetchedAt = new Date(data.fetchedAt || Date.now());
    populatePeopleFilters();
    render();
    const ts = state.fetchedAt.toLocaleString();
    $("status-text").textContent = `${state.records.length} leads — updated ${ts}`;
    $("footer-info").textContent =
      `Data source: Airtable Leads table. Auto-refreshes every 5 minutes.`;
  } catch (err) {
    $("status-text").textContent = "Error loading: " + err.message;
  } finally {
    $("refresh-btn").disabled = false;
  }
}

// ---------- Filter wiring ----------
function populatePeopleFilters() {
  const setters = new Set();
  const closers = new Set();
  for (const r of state.records) {
    if (r["Setter"]) setters.add(r["Setter"]);
    if (r["Closer"]) closers.add(r["Closer"]);
  }
  populateSelect($("setter-filter"), [...setters].sort(), "All setters");
  populateSelect($("closer-filter"), [...closers].sort(), "All closers");
}

function populateSelect(sel, values, allLabel) {
  const current = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  sel.value = current && values.includes(current) ? current : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function readFilters() {
  const basis = $("timeframe-basis").value;
  const preset = $("date-preset").value;
  let from = null, to = null;

  if (preset === "custom") {
    if ($("date-from").value) from = new Date($("date-from").value);
    if ($("date-to").value)   to   = new Date($("date-to").value);
  } else if (preset === "all") {
    /* keep null */
  } else if (preset === "ytd") {
    const now = new Date();
    from = new Date(now.getFullYear(), 0, 1);
    to = now;
  } else {
    const days = parseInt(preset, 10);
    to = new Date();
    from = new Date();
    from.setDate(from.getDate() - days);
  }

  // Reflect computed dates in the inputs so the user can see + tweak them.
  if (preset !== "custom") {
    $("date-from").value = from ? toInputDate(from) : "";
    $("date-to").value   = to   ? toInputDate(to)   : "";
  }
  if (to) { to = new Date(to); to.setHours(23, 59, 59, 999); }

  return {
    basis,
    from,
    to,
    setter: $("setter-filter").value || null,
    closer: $("closer-filter").value || null
  };
}

function toInputDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- Render ----------
function render() {
  const filters = readFilters();
  const filtered = filterRecords(state.records, filters);

  renderSetter(filtered);
  renderCloser(filtered);
}

function renderSetter(records) {
  const k = setterKPIs(records);
  $("s-booked").textContent       = fmt.num(k.bookedCalls);
  $("s-completed").textContent    = fmt.num(k.completedCalls);
  $("s-noshow").textContent       = fmt.pct(k.noShowRate);
  $("s-qualified").textContent    = fmt.pct(k.qualifiedRate);
  $("s-closing-rate").textContent = fmt.pct(k.closingRate);
  $("s-closer-disq").textContent  = fmt.pct(k.closerDisqualRate);
  $("s-closer-noshow").textContent= fmt.pct(k.closerNoShowRate);
  $("s-revenue").textContent      = fmt.money(k.revenue);
  $("s-no-outcome").textContent   = fmt.num(k.noOutcome);

  drawFunnelChart("setter-funnel", [
    { label: "Setting Calls Booked",   value: k.bookedCalls },
    { label: "Setting Calls Completed", value: k.completedCalls },
    { label: "Closing Calls Booked",   value: k.closingBooked },
    { label: "Closing Calls Completed", value: k.closingComplete },
    { label: "Closes",                 value: k.closes }
  ]);

  renderSetterByPerson(records);
  renderSetterTable(records);
}

function renderCloser(records) {
  const k = closerKPIs(records);
  $("c-booked").textContent             = fmt.num(k.bookedCalls);
  $("c-completed").textContent          = fmt.num(k.completedCalls);
  $("c-noshow").textContent             = fmt.pct(k.noShowRate);
  $("c-assessment").textContent         =
      `${fmt.num(k.assessmentFilled)} (${fmt.pct(k.assessmentRate)})`;
  $("c-cancelled-noassess").textContent = fmt.num(k.cancelledNoAssessment);
  $("c-closes").textContent             = fmt.num(k.closes);
  $("c-noclose").textContent            = fmt.num(k.noCloses);
  $("c-disq").textContent               = fmt.num(k.disqualified);
  $("c-followup").textContent           = fmt.num(k.followUp);
  $("c-close-after-fu").textContent     = fmt.num(k.closeAfterFU);
  $("c-noclose-after-fu").textContent   = fmt.num(k.noCloseAfterFU);
  $("c-closing-rate").textContent       = fmt.pct(k.closingRate);
  $("c-close-rate-fu").textContent      = fmt.pct(k.closeRateAfterFU);
  $("c-revenue").textContent            = fmt.money(k.revenue);

  drawDonutChart("closer-outcomes", {
    "Close": k.closes,
    "No Close": k.noCloses,
    "Follow Up": k.followUp,
    "Disqualified": k.disqualified
  });

  renderCloserByPerson(records);
  renderCloserTable(records);
}

// ---------- Per-person ----------
function renderSetterByPerson(records) {
  const groups = groupBy(records, "Setter");
  const rows = [...groups.entries()].map(([name, recs]) => {
    const k = setterKPIs(recs);
    return { name, ...k };
  }).sort((a, b) => b.bookedCalls - a.bookedCalls).slice(0, 15);

  drawBarChart("setter-by-person",
    rows.map(r => r.name),
    [
      { label: "Booked",    data: rows.map(r => r.bookedCalls),   color: "#4f8cff" },
      { label: "Completed", data: rows.map(r => r.completedCalls), color: "#7c5cff" }
    ]
  );
}

function renderSetterTable(records) {
  const tbody = document.querySelector("#setter-table tbody");
  const groups = groupBy(records, "Setter");
  const rows = [...groups.entries()].map(([name, recs]) => {
    const k = setterKPIs(recs);
    return { name, ...k };
  }).sort((a, b) => b.bookedCalls - a.bookedCalls);

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${fmt.num(r.bookedCalls)}</td>
      <td class="num">${fmt.num(r.completedCalls)}</td>
      <td class="num">${fmt.pct(r.noShowRate)}</td>
      <td class="num">${fmt.pct(r.qualifiedRate)}</td>
      <td class="num">${fmt.num(r.closes)}</td>
      <td class="num">${fmt.pct(r.closingRate)}</td>
      <td class="num">${fmt.pct(r.closerDisqualRate)}</td>
      <td class="num">${fmt.pct(r.closerNoShowRate)}</td>
      <td class="num">${fmt.money(r.revenue)}</td>
    </tr>
  `).join("");
}

function renderCloserByPerson(records) {
  const groups = groupBy(records, "Closer");
  const rows = [...groups.entries()].map(([name, recs]) => {
    const k = closerKPIs(recs);
    return { name, ...k };
  }).sort((a, b) => b.closes - a.closes).slice(0, 15);

  drawComboChart("closer-by-person",
    rows.map(r => r.name),
    rows.map(r => r.closes),
    rows.map(r => r.revenue)
  );
}

function renderCloserTable(records) {
  const tbody = document.querySelector("#closer-table tbody");
  const groups = groupBy(records, "Closer");
  const rows = [...groups.entries()].map(([name, recs]) => {
    const k = closerKPIs(recs);
    return { name, ...k };
  }).sort((a, b) => b.closes - a.closes);

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${fmt.num(r.bookedCalls)}</td>
      <td class="num">${fmt.num(r.completedCalls)}</td>
      <td class="num">${fmt.pct(r.noShowRate)}</td>
      <td class="num">${fmt.num(r.assessmentFilled)}</td>
      <td class="num">${fmt.num(r.closes)}</td>
      <td class="num">${fmt.num(r.noCloses)}</td>
      <td class="num">${fmt.num(r.followUp)}</td>
      <td class="num">${fmt.pct(r.closingRate)}</td>
      <td class="num">${fmt.money(r.revenue)}</td>
    </tr>
  `).join("");
}

// ---------- Charts ----------
function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

function drawFunnelChart(canvasId, stages) {
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: stages.map(s => s.label),
      datasets: [{
        data: stages.map(s => s.value),
        backgroundColor: ["#4f8cff", "#5d8cff", "#6c7fff", "#7c5cff", "#34c77b"],
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b94a7" }, grid: { color: "#262d3a" } },
        y: { ticks: { color: "#e7ebf2" }, grid: { display: false } }
      }
    }
  });
}

function drawDonutChart(canvasId, dataObj) {
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: Object.keys(dataObj),
      datasets: [{
        data: Object.values(dataObj),
        backgroundColor: ["#34c77b", "#ff5d6c", "#ffb84d", "#8b94a7"],
        borderWidth: 0
      }]
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e7ebf2" }, position: "bottom" }
      }
    }
  });
}

function drawBarChart(canvasId, labels, datasets) {
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: datasets.map(d => ({
        label: d.label,
        data: d.data,
        backgroundColor: d.color,
        borderRadius: 4
      }))
    },
    options: {
      plugins: { legend: { labels: { color: "#e7ebf2" } } },
      scales: {
        x: { ticks: { color: "#8b94a7" }, grid: { display: false } },
        y: { ticks: { color: "#8b94a7" }, grid: { color: "#262d3a" } }
      }
    }
  });
}

function drawComboChart(canvasId, labels, closes, revenue) {
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "bar",  label: "Closes",  data: closes,  backgroundColor: "#4f8cff", borderRadius: 4, yAxisID: "y" },
        { type: "line", label: "Revenue", data: revenue, borderColor: "#34c77b",     backgroundColor: "#34c77b", yAxisID: "y1", tension: 0.3 }
      ]
    },
    options: {
      plugins: { legend: { labels: { color: "#e7ebf2" } } },
      scales: {
        x:  { ticks: { color: "#8b94a7" }, grid: { display: false } },
        y:  { ticks: { color: "#8b94a7" }, grid: { color: "#262d3a" }, position: "left" },
        y1: { ticks: { color: "#8b94a7", callback: v => "$" + v.toLocaleString() }, grid: { display: false }, position: "right" }
      }
    }
  });
}

// ---------- Events ----------
function bindEvents() {
  $("refresh-btn").addEventListener("click", loadRecords);

  for (const id of ["timeframe-basis", "date-preset", "setter-filter", "closer-filter"]) {
    $(id).addEventListener("change", render);
  }
  for (const id of ["date-from", "date-to"]) {
    $(id).addEventListener("change", () => {
      $("date-preset").value = "custom";
      render();
    });
  }

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

bindEvents();
loadRecords();
setInterval(loadRecords, REFRESH_MS);
