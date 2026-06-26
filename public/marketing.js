// Marketing Dashboard: combines Meta Ads data (/api/meta) with the Airtable
// funnel (records from /api/leads). Pure rendering + KPI math, called from
// app.js on every render.
//
// Stage counting: each stage is counted by its own event date within the
// selected range — leads/qualified by Date Created, booked/held by setting
// call date, closes & cash by close date (falling back to the closing call
// date when Date Close is empty).

import { filterRecords, bucketOutcome, parseDate, fmt, hasOccurred } from "./kpis.js";

// A close counts as "Core Offer" (high ticket) when at least this much cash
// was received. Adjust to the actual core-offer price point.
export const CORE_OFFER_MIN_CASH = 5000;

// Minimum Meta-reported leads before an ad/campaign qualifies for the
// "best efficiency" ranking, so a 1-lead fluke can't win.
const EFFICIENCY_MIN_LEADS = 5;

const $ = id => document.getElementById(id);

const fmtX = r => (r == null ? "—" : r.toFixed(2) + "×");

// ---------- Qualification ----------
// "Qualified Status" is the marketing-side field; values vary, so treat any
// positive-looking value as qualified ("Qualified", "Yes", true, …) and
// anything containing not/dis/un as not qualified.
function isMarketingQualified(r) {
  const v = r["Qualified Status"];
  if (v === true) return true;
  if (typeof v !== "string") return false;
  if (/(^|\s)(not|dis|un)/i.test(v)) return false;
  return /qualif|yes/i.test(v);
}

function isSalesQualified(r) { return r["Qualified After Call"] === "Yes"; }

// ---------- Close date (cash basis) ----------
function closeDate(r) { return r["Date Close"] || r["Date Strategy Call"]; }

function inCloseRange(r, from, to) {
  const d = parseDate(closeDate(r));
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// ---------- Country normalisation ----------
// Meta reports ISO-3166 alpha-2 codes; Airtable values are free text. Map
// common names (EN + DE) to codes so the two sources join.
const COUNTRY_CODES = {
  "germany": "DE", "deutschland": "DE",
  "united states": "US", "usa": "US", "united states of america": "US", "america": "US",
  "austria": "AT", "österreich": "AT", "oesterreich": "AT",
  "switzerland": "CH", "schweiz": "CH",
  "united kingdom": "GB", "uk": "GB", "england": "GB", "great britain": "GB",
  "canada": "CA", "kanada": "CA",
  "australia": "AU", "australien": "AU",
  "netherlands": "NL", "niederlande": "NL", "holland": "NL",
  "france": "FR", "frankreich": "FR",
  "spain": "ES", "spanien": "ES",
  "italy": "IT", "italien": "IT",
  "belgium": "BE", "belgien": "BE",
  "sweden": "SE", "schweden": "SE",
  "norway": "NO", "norwegen": "NO",
  "denmark": "DK", "dänemark": "DK",
  "poland": "PL", "polen": "PL",
  "ireland": "IE", "irland": "IE",
  "new zealand": "NZ", "neuseeland": "NZ",
  "luxembourg": "LU", "luxemburg": "LU",
  "united arab emirates": "AE", "uae": "AE", "dubai": "AE"
};

function countryCode(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_CODES[v.toLowerCase()] || v; // unmapped names stay as-is
}

let regionNames;
try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* older browser */ }
function countryLabel(code) {
  if (!code) return "Unknown";
  if (regionNames && /^[A-Z]{2}$/.test(code)) {
    try { return regionNames.of(code) || code; } catch { return code; }
  }
  return code;
}

// ---------- Aggregation ----------
function pct(num, den) { return den ? num / den : null; }
function per(spend, count) { return spend != null && count ? spend / count : null; }

function sumAmount(records) {
  let s = 0;
  for (const r of records) {
    const v = r["Amount received"];
    if (typeof v === "number") s += v;
  }
  return s;
}

export function marketingKPIs(allRecords, filters) {
  const { from, to } = filters;
  const leadsR  = filterRecords(allRecords, { ...filters, basis: "Date Created" });
  const bookedR = filterRecords(allRecords, { ...filters, basis: "Date Setting Call" })
    .filter(r => r["Date Setting Call"]);
  const dueR    = bookedR.filter(r => hasOccurred(r["Date Setting Call"]));
  const heldR   = dueR.filter(r => r["Setting No-Show"] !== true);

  const closeR  = allRecords.filter(r => {
    if (filters.setter && r["Setter"] !== filters.setter) return false;
    if (filters.closer && r["Closer"] !== filters.closer) return false;
    return inCloseRange(r, from, to);
  });
  const closes      = closeR.filter(r => bucketOutcome(r) === "close");
  const coreCloses  = closes.filter(r => (r["Amount received"] || 0) >= CORE_OFFER_MIN_CASH);
  const cash        = sumAmount(closeR);

  // Closing-call stage — Meta only knows the booked setting call, so the
  // closing call (the second call) is supplemented entirely from Airtable.
  const closingBookedR  = filterRecords(allRecords, { ...filters, basis: "Date Strategy Call" })
    .filter(r => r["Date Strategy Call"]);
  const closingDueR     = closingBookedR.filter(r => hasOccurred(r["Date Strategy Call"]));
  const closingHeldR    = closingDueR.filter(r => r["Strategy No-Show"] !== true);
  // Outcome completeness: held closing calls that have an outcome set.
  const withOutcome     = closingHeldR.filter(r => bucketOutcome(r) !== null);

  return {
    leads: leadsR.length,
    qualified: leadsR.filter(isMarketingQualified).length,
    booked: bookedR.length,
    held: heldR.length,
    closingBooked: closingBookedR.length,
    closingHeld: closingHeldR.length,
    salesQualified: heldR.filter(isSalesQualified).length,
    closes: closes.length,
    coreCloses: coreCloses.length,
    cash,
    showRate: pct(heldR.length, dueR.length),
    closingShowRate: pct(closingHeldR.length, closingDueR.length),
    outcomeCompleteness: pct(withOutcome.length, closingHeldR.length),
    // per-group source sets, reused by the country table
    _leadsR: leadsR,
    _closeRClosed: closes,
    _closeR: closeR
  };
}

// ---------- Render ----------
export function renderMarketing(allRecords, meta, filters, syncInfo) {
  const k = marketingKPIs(allRecords, filters);
  const configured = !!(meta && meta.configured);
  const spend = configured ? meta.spend : null;

  $("meta-banner").hidden = configured;
  if (meta && meta.error) {
    $("meta-banner").hidden = false;
    $("meta-banner").textContent = "Meta Ads error: " + meta.error;
  }

  // Row 1 — North Star
  $("m-spend").textContent    = spend == null ? "—" : fmt.money(spend);
  $("m-cash").textContent     = fmt.money(k.cash);
  $("m-roas").textContent     = fmtX(spend ? k.cash / spend : null);
  $("m-cac").textContent      = fmt.money(per(spend, k.closes));
  $("m-core-cac").textContent = fmt.money(per(spend, k.coreCloses));

  // Row 2 — Funnel
  renderFunnel(k);
  $("m-show-rate").textContent  = fmt.pct(k.showRate);
  $("m-sales-qualified").textContent =
    `${fmt.num(k.salesQualified)} (${fmt.pct(pct(k.salesQualified, k.held))})`;

  // Row 3 — Cost per stage
  $("m-cpl").textContent  = fmt.money(per(spend, k.leads));
  $("m-cpql").textContent = fmt.money(per(spend, k.qualified));
  $("m-cpbc").textContent = fmt.money(per(spend, k.booked));
  $("m-cphc").textContent = fmt.money(per(spend, k.held));
  $("m-cac2").textContent = fmt.money(per(spend, k.closes));

  // Rows 4 + 5
  renderCountryTable(k, meta);
  renderTopPerformers(allRecords, meta, filters);

  // Row 6 — Data quality
  $("m-sync-meta").textContent = configured
    ? new Date(meta.fetchedAt).toLocaleString()
    : (meta && meta.error ? "error" : "not connected");
  $("m-sync-airtable").textContent =
    syncInfo.airtableFetchedAt ? syncInfo.airtableFetchedAt.toLocaleString() : "—";
  $("m-outcome-complete").textContent = fmt.pct(k.outcomeCompleteness);
  const map = syncInfo.fieldMap || {};
  $("m-attribution").textContent = Object.keys(map).length
    ? Object.entries(map).map(([c, a]) => `${c}: ${a || "not found"}`).join(" · ")
    : "—";
  $("m-fx").textContent = fxLabel(meta, configured);
  $("m-fx").classList.toggle("warn-text", !!(meta?.fx?.fallback || meta?.fx?.unsupported));
}

// Human-readable description of how spend was converted to USD.
function fxLabel(meta, configured) {
  if (!configured) return "—";
  const fx = meta.fx;
  if (!fx || !fx.converted) {
    if (fx?.unsupported) return `${fx.original}: no USD rate — spend shown as-is`;
    return `${fx?.original || "USD"} — no conversion needed`;
  }
  const rate = fx.rate ? fx.rate.toFixed(4) : "?";
  const date = fx.date ? ` · ${fx.date}` : "";
  const src = fx.fallback ? `${fx.source} ⚠` : (fx.source || "");
  return `${fx.original}→USD @ ${rate} (${src}${date})`;
}

function renderFunnel(k) {
  // Meta's view stops at the booked call; the setting/closing call split and
  // everything past it is supplemented from Airtable.
  const stages = [
    { label: "Leads", value: k.leads, src: "meta" },
    { label: "Qualified Leads", value: k.qualified, src: "airtable" },
    { label: "Setting Booked", value: k.booked, src: "airtable" },
    { label: "Setting Held", value: k.held, src: "airtable" },
    { label: "Closing Booked", value: k.closingBooked, src: "airtable" },
    { label: "Closing Held", value: k.closingHeld, src: "airtable" },
    { label: "Closes", value: k.closes, src: "airtable" }
  ];
  const html = stages.map((s, i) => {
    const stage = `
      <div class="funnel-stage funnel-stage--${s.src}">
        <span class="kpi-value">${fmt.num(s.value)}</span>
        <span class="kpi-label">${s.label}</span>
      </div>`;
    if (i === stages.length - 1) return stage;
    const rate = pct(stages[i + 1].value, s.value);
    return stage + `<div class="funnel-rate"><span>→</span><b>${fmt.pct(rate)}</b></div>`;
  }).join("");
  $("mkt-funnel").innerHTML = html;
}

function renderCountryTable(k, meta) {
  const tbody = document.querySelector("#country-table tbody");

  // Airtable side per country
  const at = new Map(); // code -> { qualified, closes, cash }
  const bump = (code, key, n) => {
    if (!at.has(code)) at.set(code, { qualified: 0, closes: 0, cash: 0 });
    at.get(code)[key] += n;
  };
  for (const r of k._leadsR) {
    if (isMarketingQualified(r)) bump(countryCode(r["Country"]) || "??", "qualified", 1);
  }
  for (const r of k._closeRClosed) bump(countryCode(r["Country"]) || "??", "closes", 1);
  for (const r of k._closeR) {
    const v = r["Amount received"];
    if (typeof v === "number") bump(countryCode(r["Country"]) || "??", "cash", v);
  }

  // Meta side per country
  const mt = new Map();
  if (meta?.configured) {
    for (const c of meta.countries || []) mt.set(c.country, c);
  }

  const codes = [...new Set([...at.keys(), ...mt.keys()])].filter(c => c !== "??" || at.get("??")?.cash || at.get("??")?.closes);
  const rows = codes.map(code => {
    const a = at.get(code) || { qualified: 0, closes: 0, cash: 0 };
    const m = mt.get(code);
    const spend = m ? m.spend : null;
    return {
      code,
      label: code === "??" ? "No country set" : countryLabel(code),
      spend,
      cpql: per(spend, a.qualified),
      closes: a.closes,
      cash: a.cash,
      cac: per(spend, a.closes)
    };
  }).sort((x, y) => y.cash - x.cash || (y.spend || 0) - (x.spend || 0));

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="num">${r.spend == null ? "—" : fmt.money(r.spend)}</td>
      <td class="num">${fmt.money(r.cpql)}</td>
      <td class="num">${fmt.num(r.closes)}</td>
      <td class="num">${fmt.money(r.cash)}</td>
      <td class="num">${fmt.money(r.cac)}</td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="6">No data in the selected range</td></tr>`;
}

function renderTopPerformers(allRecords, meta, filters) {
  const ids = ["top-ad-volume", "top-ad-eff", "top-camp-volume", "top-camp-eff"];
  if (!meta?.configured || !(meta.ads || []).length) {
    for (const id of ids) {
      $(id).innerHTML = `<span class="kpi-sub">${meta?.configured ? "No ad data in range" : "Meta not connected"}</span>`;
    }
    return;
  }

  // Airtable closes/cash per ad and campaign name (when attribution exists),
  // matched on the exact name reported by Meta.
  const closesBy = field => {
    const m = new Map();
    for (const r of allRecords) {
      if (filters.setter && r["Setter"] !== filters.setter) continue;
      if (filters.closer && r["Closer"] !== filters.closer) continue;
      if (!inCloseRange(r, filters.from, filters.to)) continue;
      if (bucketOutcome(r) !== "close") continue;
      const key = r[field];
      if (!key) continue;
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  };
  const adCloses = closesBy("Ad Name");
  const campCloses = closesBy("Campaign Name");

  const campaigns = new Map();
  for (const a of meta.ads) {
    if (!campaigns.has(a.campaign)) campaigns.set(a.campaign, { name: a.campaign, spend: 0, leads: 0 });
    const c = campaigns.get(a.campaign);
    c.spend += a.spend;
    c.leads += a.leads;
  }
  const adRows = meta.ads.map(a => ({ name: a.ad, spend: a.spend, leads: a.leads, closes: adCloses.get(a.ad) || 0 }));
  const campRows = [...campaigns.values()].map(c => ({ ...c, closes: campCloses.get(c.name) || 0 }));

  renderPerformer("top-ad-volume", best(adRows, r => r.leads, true));
  renderPerformer("top-ad-eff", bestEfficiency(adRows));
  renderPerformer("top-camp-volume", best(campRows, r => r.leads, true));
  renderPerformer("top-camp-eff", bestEfficiency(campRows));
}

function best(rows, score, desc) {
  let top = null;
  for (const r of rows) {
    const s = score(r);
    if (s == null) continue;
    if (!top || (desc ? s > score(top) : s < score(top))) top = r;
  }
  return top;
}

// Efficiency: lowest CAC when closes are attributable, otherwise lowest CPL
// among ads/campaigns with enough lead volume to be meaningful.
function bestEfficiency(rows) {
  const withCloses = rows.filter(r => r.closes > 0);
  if (withCloses.length) return best(withCloses, r => r.spend / r.closes, false);
  return best(rows.filter(r => r.leads >= EFFICIENCY_MIN_LEADS), r => r.spend / r.leads, false);
}

function renderPerformer(id, row) {
  if (!row) {
    $(id).innerHTML = `<span class="kpi-sub">Not enough data</span>`;
    return;
  }
  const cpl = per(row.spend, row.leads);
  const cac = row.closes ? row.spend / row.closes : null;
  $(id).innerHTML = `
    <span class="performer-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
    <ul class="person-metrics">
      <li><span>Leads</span><b>${fmt.num(row.leads)}</b></li>
      <li><span>Spend</span><b>${fmt.money(row.spend)}</b></li>
      <li><span>CPL</span><b>${fmt.money(cpl)}</b></li>
      <li><span>CAC</span><b>${cac == null ? "—" : fmt.money(cac)}</b></li>
    </ul>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
