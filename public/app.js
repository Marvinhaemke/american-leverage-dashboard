// Wires up the dashboard: pulls leads from /api/leads, listens to filter
// controls, recomputes KPIs and re-draws charts. All filtering happens
// client-side so the dataset is fetched once and reused.

import {
  filterRecords, setterKPIs, closerKPIs, groupBy, fmt
} from "./kpis.js";
import { renderMarketing } from "./marketing.js";

const state = {
  records: [],
  fetchedAt: null,
  missingFields: [],
  fieldMap: {},
  meta: null,     // /api/meta payload (or { error })
  metaKey: null,  // date-range key the current meta payload belongs to
  charts: {}
};

const $ = id => document.getElementById(id);
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// Each dashboard applies the date range to its own date field.
const SETTER_BASIS = "Date Setting Call";
const CLOSER_BASIS = "Date Strategy Call"; // = closing call

const COLORS = {
  text: "#e9edf4",
  muted: "#8d97ab",
  grid: "#28303f",
  accent: "#4f8cff",
  accent2: "#9d7bff",
  good: "#34c77b",
  bad: "#ff5d6c",
  warn: "#ffb84d"
};

// ---------- Loading ----------
async function loadRecords() {
  $("status-text").textContent = "Loading…";
  $("refresh-btn").disabled = true;
  try {
    const res = await fetch("/api/leads");
    if (!res.ok) throw new Error((await res.text()).slice(0, 200));
    const data = await res.json();
    state.records = data.records || [];
    state.missingFields = data.missingFields || [];
    state.fieldMap = data.fieldMap || {};
    state.fetchedAt = new Date(data.fetchedAt || Date.now());
    state.metaKey = null; // refresh Meta data alongside Airtable
    populatePeopleFilters();
    render();
    const ts = state.fetchedAt.toLocaleString();
    let status = `${state.records.length} leads — updated ${ts}`;
    if (state.missingFields.length) {
      status += ` — ⚠ not found in Airtable: ${state.missingFields.join(", ")}`;
    }
    $("status-text").textContent = status;
    $("status-text").classList.toggle("warn-text", state.missingFields.length > 0);
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

  // Normalise to whole days so boundary records aren't dropped by the
  // time-of-day the page happened to load at.
  if (from) { from = new Date(from); from.setHours(0, 0, 0, 0); }
  if (to)   { to   = new Date(to);   to.setHours(23, 59, 59, 999); }

  // Reflect computed dates in the inputs so the user can see + tweak them.
  if (preset !== "custom") {
    $("date-from").value = from ? toInputDate(from) : "";
    $("date-to").value   = to   ? toInputDate(to)   : "";
  }

  return {
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

// ---------- Meta Ads data ----------
// Spend data is aggregated server-side for the selected date range, so it is
// refetched when the range changes (people filters don't affect Meta).
async function maybeLoadMeta(filters) {
  const key = `${filters.from ? toInputDate(filters.from) : ""}|${filters.to ? toInputDate(filters.to) : ""}`;
  if (state.metaKey === key) return;
  state.metaKey = key;
  try {
    const params = new URLSearchParams();
    if (filters.from && filters.to) {
      params.set("from", toInputDate(filters.from));
      params.set("to", toInputDate(filters.to));
    }
    const res = await fetch("/api/meta" + (params.size ? "?" + params : ""));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.meta = data;
  } catch (err) {
    state.meta = { configured: false, error: err.message };
  }
  if (state.metaKey === key) render(); // still the current range
}

// ---------- Render ----------
function render() {
  const filters = readFilters();

  renderOverview(filters);
  renderSetter(filterRecords(state.records, { ...filters, basis: SETTER_BASIS }));
  // Closer call-based KPIs use the closing-call date; revenue (Amount
  // received) is attributed by Close Date instead.
  renderCloser(
    filterRecords(state.records, { ...filters, basis: CLOSER_BASIS }),
    filterRecords(state.records, { ...filters, basis: "Date Close" })
  );
  renderMarketing(state.records, state.meta, filters, {
    airtableFetchedAt: state.fetchedAt,
    fieldMap: state.fieldMap
  });
  maybeLoadMeta(filters);
}

// Each overview metric uses its natural date basis (see kpi-sub labels).
function renderOverview(filters) {
  const byCreated = filterRecords(state.records, { ...filters, basis: "Date Created" });
  const bySetting = filterRecords(state.records, { ...filters, basis: SETTER_BASIS });
  const byClosing = filterRecords(state.records, { ...filters, basis: CLOSER_BASIS });
  const byClose   = filterRecords(state.records, { ...filters, basis: "Date Close" });

  const c = closerKPIs(byClosing);
  $("o-leads").textContent          = fmt.num(byCreated.length);
  $("o-setting-booked").textContent = fmt.num(setterKPIs(bySetting).bookedCalls);
  $("o-closing-booked").textContent = fmt.num(c.bookedCalls);
  $("o-closes").textContent         = fmt.num(c.closes);
  $("o-closing-rate").textContent   = fmt.pct(c.closingRate);
  $("o-revenue").textContent        = fmt.money(closerKPIs(byClose).revenue);
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
  renderSetterPeople(records);
}

function renderCloser(records, revenueRecords) {
  const k = closerKPIs(records);
  // Revenue is summed over records whose Close Date falls in the range,
  // independent of when the closing call happened.
  const revByCloser = revenueByPerson(revenueRecords, "Closer");
  const totalRevenue = [...revByCloser.values()].reduce((a, b) => a + b, 0);

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
  $("c-revenue").textContent            = fmt.money(totalRevenue);

  drawDonutChart("closer-outcomes", {
    "Close": k.closes,
    "No Close": k.noCloses,
    "In Follow Up": k.followUp,
    "Disqualified": k.disqualified
  });

  renderCloserByPerson(records, revByCloser);
  renderCloserPeople(records, revByCloser);
}

// Sum of "Amount received" per person over the given records.
function revenueByPerson(records, field) {
  const m = new Map();
  for (const r of records) {
    const who = r[field];
    const v = r["Amount received"];
    if (who && typeof v === "number") m.set(who, (m.get(who) || 0) + v);
  }
  return m;
}

// ---------- Per-person ----------
function personRows(records, field, kpiFn, sortKey) {
  const groups = groupBy(records, field);
  return [...groups.entries()]
    .map(([name, recs]) => ({ name, ...kpiFn(recs) }))
    .sort((a, b) => b[sortKey] - a[sortKey]);
}

function renderSetterByPerson(records) {
  const rows = personRows(records, "Setter", setterKPIs, "bookedCalls").slice(0, 15);
  drawBarChart("setter-by-person",
    rows.map(r => r.name),
    [
      { label: "Booked",    data: rows.map(r => r.bookedCalls),    color: COLORS.accent },
      { label: "Completed", data: rows.map(r => r.completedCalls), color: COLORS.accent2 }
    ]
  );
}

// One card per setter, rendered side by side in a grid of columns.
function renderSetterPeople(records) {
  const rows = personRows(records, "Setter", setterKPIs, "bookedCalls");
  $("setter-people").innerHTML = rows.length ? rows.map(r => personCard(r.name, fmt.money(r.revenue), "revenue", [
    ["Booked",           fmt.num(r.bookedCalls)],
    ["Completed",        fmt.num(r.completedCalls)],
    ["No Show",          fmt.pct(r.noShowRate)],
    ["Qualified",        fmt.pct(r.qualifiedRate)],
    ["Closes",           fmt.num(r.closes)],
    ["Closing Rate",     fmt.pct(r.closingRate)],
    ["Closer Disq.",     fmt.pct(r.closerDisqualRate)],
    ["Closer No-Show",   fmt.pct(r.closerNoShowRate)]
  ])).join("") : peopleEmpty("setters");
}

function renderCloserByPerson(records, revByCloser) {
  const rows = personRows(records, "Closer", closerKPIs, "closes").slice(0, 15);
  drawComboChart("closer-by-person",
    rows.map(r => r.name),
    rows.map(r => r.closes),
    rows.map(r => revByCloser.get(r.name) || 0)
  );
}

// One card per closer, rendered side by side in a grid of columns.
function renderCloserPeople(records, revByCloser) {
  const rows = personRows(records, "Closer", closerKPIs, "closes");
  $("closer-people").innerHTML = rows.length ? rows.map(r => personCard(r.name, fmt.money(revByCloser.get(r.name) || 0), "revenue", [
    ["Booked",       fmt.num(r.bookedCalls)],
    ["Completed",    fmt.num(r.completedCalls)],
    ["No Show",      fmt.pct(r.noShowRate)],
    ["Assessments",  fmt.num(r.assessmentFilled)],
    ["Closes",       fmt.num(r.closes)],
    ["No Close",     fmt.num(r.noCloses)],
    ["In Follow Up", fmt.num(r.followUp)],
    ["Closing Rate", fmt.pct(r.closingRate)]
  ])).join("") : peopleEmpty("closers");
}

function personCard(name, highlightValue, highlightLabel, metrics) {
  return `
    <div class="person-card">
      <div class="person-head">
        <span class="person-avatar">${escapeHtml(name.trim().charAt(0).toUpperCase() || "?")}</span>
        <span class="person-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      </div>
      <div class="person-highlight">
        <span class="kpi-value">${highlightValue}</span>
        <span class="kpi-sub">${highlightLabel}</span>
      </div>
      <ul class="person-metrics">
        ${metrics.map(([label, value]) => `<li><span>${label}</span><b>${value}</b></li>`).join("")}
      </ul>
    </div>`;
}

function peopleEmpty(what) {
  return `<div class="people-empty">No ${what} with data in the selected range</div>`;
}

// ---------- Charts ----------
// If the Chart.js CDN failed to load, skip chart drawing instead of throwing —
// KPIs and tables should still render.
function chartsAvailable() {
  return typeof Chart !== "undefined";
}

function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

// Charts live inside fixed-height .chart-body wrappers, so let them fill it.
const BASE_OPTIONS = { responsive: true, maintainAspectRatio: false };

function drawFunnelChart(canvasId, stages) {
  if (!chartsAvailable()) return;
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: stages.map(s => s.label),
      datasets: [{
        data: stages.map(s => s.value),
        backgroundColor: ["#4f8cff", "#5d8cff", "#6c7fff", "#9d7bff", "#34c77b"],
        borderRadius: 6
      }]
    },
    options: {
      ...BASE_OPTIONS,
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: COLORS.muted, precision: 0 }, grid: { color: COLORS.grid } },
        y: { ticks: { color: COLORS.text }, grid: { display: false } }
      }
    }
  });
}

function drawDonutChart(canvasId, dataObj) {
  if (!chartsAvailable()) return;
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: Object.keys(dataObj),
      datasets: [{
        data: Object.values(dataObj),
        backgroundColor: [COLORS.good, COLORS.bad, COLORS.warn, COLORS.muted],
        borderWidth: 0
      }]
    },
    options: {
      ...BASE_OPTIONS,
      cutout: "62%",
      plugins: {
        legend: { labels: { color: COLORS.text }, position: "bottom" }
      }
    }
  });
}

function drawBarChart(canvasId, labels, datasets) {
  if (!chartsAvailable()) return;
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
      ...BASE_OPTIONS,
      plugins: { legend: { labels: { color: COLORS.text } } },
      scales: {
        x: { ticks: { color: COLORS.muted }, grid: { display: false } },
        y: { ticks: { color: COLORS.muted, precision: 0 }, grid: { color: COLORS.grid } }
      }
    }
  });
}

function drawComboChart(canvasId, labels, closes, revenue) {
  if (!chartsAvailable()) return;
  destroyChart(canvasId);
  const ctx = $(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "bar",  label: "Closes",  data: closes,  backgroundColor: COLORS.accent, borderRadius: 4, yAxisID: "y" },
        { type: "line", label: "Revenue", data: revenue, borderColor: COLORS.good,       backgroundColor: COLORS.good, yAxisID: "y1", tension: 0.3 }
      ]
    },
    options: {
      ...BASE_OPTIONS,
      plugins: { legend: { labels: { color: COLORS.text } } },
      scales: {
        x:  { ticks: { color: COLORS.muted }, grid: { display: false } },
        y:  { ticks: { color: COLORS.muted, precision: 0 }, grid: { color: COLORS.grid }, position: "left" },
        y1: { ticks: { color: COLORS.muted, callback: v => "$" + v.toLocaleString() }, grid: { display: false }, position: "right" }
      }
    }
  });
}

// ---------- Events ----------
function bindEvents() {
  $("refresh-btn").addEventListener("click", loadRecords);

  for (const id of ["date-preset", "setter-filter", "closer-filter"]) {
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
      document.querySelectorAll(".tab").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      $("tab-" + btn.dataset.tab).classList.add("active");
      // Re-render so charts are drawn into the now-visible (non-zero-size) panel.
      render();
    });
  });
}

bindEvents();
loadRecords();
setInterval(loadRecords, REFRESH_MS);
