// KPI computation. Pure functions, no DOM. Imported by app.js.
//
// Funnel terminology mapping (per user):
//   Setting Call            -> Date Setting Call, Setting No-Show
//   Closing Call            -> Date Strategy Call, Strategy No-Show Status (the
//                              Airtable schema calls it "Strategy" but it IS the
//                              closing call)
//   Outcome (new values)    -> "Close" / "No Close" / "Follow Up" in
//                              "Outcome Strategy Call". Legacy values still
//                              present in the table are mapped below.
//
// "Close after Follow Up": Outcome = Close AND Follow Up Process checkbox.
// The user noted the outcome can be overwritten to Close after a follow-up,
// and Follow Up Process is a separate flag that stays true.

// ---------- Outcome bucketing ----------
// Legacy outcome strings get mapped into the new three buckets. Anything
// unrecognised goes to null (treated as "no outcome").
const OUTCOME_MAP = {
  "Close": "close",
  "No Close": "no_close",
  "Follow Up": "follow_up",
  // legacy
  "Bought Assessment on Call": "close",
  "Buying Assessment After Call": "follow_up",
  "No U.S. Data - Follow Up Consultation": "follow_up",
  "Not Qualified / Bad Fit": "no_close",
  "Cancelled Call": "cancelled",
  "No-Show": "no_show"
};

export function bucketOutcome(record) {
  // Close Won/Lost is a separate authoritative signal — honour it first.
  const won = record["Close Won/Lost"];
  if (won === "Won") return "close";
  if (won === "Lost") return "no_close";
  const raw = record["Outcome Strategy Call"];
  if (!raw) return null;
  return OUTCOME_MAP[raw] ?? null;
}

// ---------- Date helpers ----------
export function parseDate(s) {
  if (!s) return null;
  // Airtable date fields come back as ISO yyyy-mm-dd; Date() parses to UTC midnight.
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function inRange(date, from, to) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

// ---------- Booleans ----------
// A call has "occurred" once its scheduled date is on or before today. Calls
// dated in the future are still on the calendar but haven't happened yet, so
// they count as Booked but NOT as Completed (and aren't no-shows yet either).
function hasOccurred(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return d <= today;
}

function isNoShowSetting(r)    { return r["Setting No-Show"] === true; }
function isNoShowClosing(r)    { return r["Strategy No-Show"] === true; }
function isAssessmentFilled(r) { return r["Assessment Filled"] === true; }
function isFollowUpFlag(r)     { return r["Follow Up Process"] === true; }

function isQualifiedSetting(r) {
  // Qualified after Call is the authoritative setter-side qualification signal
  // (per user — Qualified Status is a marketing field, not relevant here).
  return r["Qualified After Call"] === "Yes";
}
function isDisqualifiedByCloser(r) {
  // Only signal available in the current schema: "Qualified After Call" = No
  // on a lead whose closing call completed. (Qualified Status is marketing-only
  // per user.) If a dedicated closer-disqualification field is added later,
  // wire it in here.
  return r["Qualified After Call"] === "No";
}

// ---------- Filtering ----------
// `basis` = which date field to apply the range to.
export function filterRecords(records, { basis, from, to, setter, closer }) {
  return records.filter(r => {
    if (setter && r["Setter"] !== setter) return false;
    if (closer && r["Closer"] !== closer) return false;
    if (!from && !to) return true;
    const d = parseDate(r[basis]);
    // If the record has no value for the chosen date field, drop it from
    // any time-bounded view — otherwise blanks would inflate "all time".
    if (!d) return false;
    return inRange(d, from, to);
  });
}

// ---------- Aggregation helpers ----------
function pct(num, den) {
  if (!den) return null;
  return num / den;
}
function sum(records, field) {
  let s = 0;
  for (const r of records) {
    const v = r[field];
    if (typeof v === "number") s += v;
  }
  return s;
}

// ---------- Setter KPIs ----------
export function setterKPIs(records) {
  const settingBooked   = records.filter(r => r["Date Setting Call"]);
  // "Due" = call date has passed; future-dated bookings are excluded from
  // completed / no-show so pending calls don't distort either metric.
  const settingDue      = settingBooked.filter(r => hasOccurred(r["Date Setting Call"]));
  const settingComplete = settingDue.filter(r => !isNoShowSetting(r));
  const settingNoShow   = settingDue.filter(isNoShowSetting);
  const qualified       = settingComplete.filter(isQualifiedSetting);

  // Downstream closing-call view limited to records this setter sent forward.
  const closingBooked   = records.filter(r => r["Date Strategy Call"]);
  const closingDue      = closingBooked.filter(r => hasOccurred(r["Date Strategy Call"]));
  const closingComplete = closingDue.filter(r => !isNoShowClosing(r));
  const closingNoShow   = closingDue.filter(isNoShowClosing);
  const closerDisq      = closingComplete.filter(isDisqualifiedByCloser);
  const closes          = closingComplete.filter(r => bucketOutcome(r) === "close");

  const noOutcome = closingComplete.filter(r => bucketOutcome(r) === null);

  return {
    bookedCalls: settingBooked.length,
    completedCalls: settingComplete.length,
    noShowRate: pct(settingNoShow.length, settingDue.length),
    qualifiedRate: pct(qualified.length, settingComplete.length),
    closingRate: pct(closes.length, closingComplete.length),
    closerDisqualRate: pct(closerDisq.length, closingComplete.length),
    closerNoShowRate: pct(closingNoShow.length, closingDue.length),
    revenue: sum(records, "Amount received"),
    noOutcome: noOutcome.length,
    closes: closes.length,
    closingBooked: closingBooked.length,
    closingComplete: closingComplete.length
  };
}

// ---------- Closer KPIs ----------
export function closerKPIs(records) {
  const booked   = records.filter(r => r["Date Strategy Call"]);
  // "Due" = closing call date has passed; future bookings are excluded from
  // completed / no-show.
  const due      = booked.filter(r => hasOccurred(r["Date Strategy Call"]));
  const complete = due.filter(r => !isNoShowClosing(r));
  const noShow   = due.filter(isNoShowClosing);

  const closes   = complete.filter(r => bucketOutcome(r) === "close");
  const noCloses = complete.filter(r => bucketOutcome(r) === "no_close");
  const followUp = complete.filter(r => bucketOutcome(r) === "follow_up" || isFollowUpFlag(r));

  // After follow-up resolution: Follow Up Process flag stays true even when
  // the outcome has since been overwritten to Close / No Close.
  const closeAfterFU   = complete.filter(r => bucketOutcome(r) === "close"    && isFollowUpFlag(r));
  const noCloseAfterFU = complete.filter(r => bucketOutcome(r) === "no_close" && isFollowUpFlag(r));

  const disq        = complete.filter(isDisqualifiedByCloser);
  const assessment  = booked.filter(isAssessmentFilled);
  // Cancelled (per legacy outcome value) without an assessment ever submitted.
  const cancelledNoAssess = booked.filter(r => {
    const o = r["Outcome Strategy Call"];
    return (o === "Cancelled Call" || bucketOutcome(r) === "cancelled") && !isAssessmentFilled(r);
  });

  return {
    bookedCalls: booked.length,
    completedCalls: complete.length,
    noShowRate: pct(noShow.length, due.length),
    assessmentFilled: assessment.length,
    assessmentRate: pct(assessment.length, booked.length),
    cancelledNoAssessment: cancelledNoAssess.length,
    closes: closes.length,
    noCloses: noCloses.length,
    followUp: followUp.length,
    closeAfterFU: closeAfterFU.length,
    noCloseAfterFU: noCloseAfterFU.length,
    disqualified: disq.length,
    closingRate: pct(closes.length, complete.length),
    closeRateAfterFU: pct(closeAfterFU.length, closeAfterFU.length + noCloseAfterFU.length),
    revenue: sum(records, "Amount received")
  };
}

// ---------- Per-person breakdowns ----------
export function groupBy(records, field) {
  const groups = new Map();
  for (const r of records) {
    const key = r[field];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// ---------- Formatters ----------
export const fmt = {
  num: n => (n == null ? "—" : Number(n).toLocaleString()),
  pct: r => (r == null ? "—" : (r * 100).toFixed(1) + "%"),
  money: n => (n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }))
};
