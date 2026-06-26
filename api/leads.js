// Serverless function: fetches all records from the Airtable Leads table and
// returns a slimmed-down JSON array used by the dashboard.
//
// Required environment variables on Vercel:
//   AIRTABLE_TOKEN  - Personal Access Token with data.records:read on the base
//   AIRTABLE_BASE   - Airtable base id (e.g. app7dTq3SSToVhnwl)
//   AIRTABLE_TABLE  - Airtable table id  (e.g. tbloGJE9Oz52hrMTl)

// Fields the sales dashboards compute KPIs from, plus the marketing-side
// qualification field.
const STATIC_FIELDS = [
  "Date Created",
  "Qualified Status",
  "Qualified After Call",
  "Date Setting Call",
  "Setting No-Show",
  "Date Strategy Call",
  "Strategy No-Show",
  "Assessment Filled",
  "Outcome Strategy Call",
  "Follow Up Process",
  "Close Won/Lost",
  "Amount received",
  "Date Close",
  "Setter",
  "Closer"
];

// Marketing attribution fields whose exact Airtable names may vary. They are
// resolved against the real schema by sampling records (Airtable returns the
// field names present on each record), first by candidate name, then by
// pattern. Matched fields are copied onto the canonical key in every record
// and the mapping is reported to the client for the data-quality row.
const ATTRIBUTION_RESOLVERS = {
  "Country": {
    candidates: ["Country", "Land", "Country Code"],
    pattern: /country|^land$/i
  },
  "Ad Name": {
    candidates: ["Ad Name", "Ad", "Meta Ad", "Ad name", "utm_content", "UTM Content"],
    pattern: /ad.?name|utm.?content/i
  },
  "Campaign Name": {
    candidates: ["Campaign Name", "Campaign", "Campaign name", "utm_campaign", "UTM Campaign"],
    pattern: /campaign/i
  }
};

const MAX_PAGE_ATTEMPTS = 3;

async function fetchPage(url, token) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) return res.json();

    const body = await res.text();
    // Transient: Airtable rate limit / server hiccup — back off and retry.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_PAGE_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * 500));
      continue;
    }

    const err = new Error(`Airtable ${res.status}: ${body.slice(0, 300)}`);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.type === "UNKNOWN_FIELD_NAME") {
        const m = /Unknown field name: "(.*)"/.exec(parsed.error.message || "");
        if (m) err.unknownField = m[1];
      }
    } catch { /* body wasn't JSON — keep the generic error */ }
    throw err;
  }
}

// Sample one page without a field filter to learn which field names actually
// exist (only fields with a value on at least one sampled record show up,
// which is good enough for attribution fields that are filled by the ad
// integration).
async function discoverFieldMap(baseId, tableId, token) {
  const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
  url.searchParams.set("pageSize", "100");
  const json = await fetchPage(url, token);
  const present = new Set();
  for (const r of json.records) for (const k of Object.keys(r.fields)) present.add(k);

  const map = {};
  for (const [canonical, { candidates, pattern }] of Object.entries(ATTRIBUTION_RESOLVERS)) {
    let hit = null;
    for (const c of candidates) {
      hit = [...present].find(f => f.toLowerCase() === c.toLowerCase());
      if (hit) break;
    }
    if (!hit) hit = [...present].find(f => pattern.test(f));
    map[canonical] = hit || null;
  }
  return map;
}

async function fetchAllWithFields(baseId, tableId, token, fields) {
  const all = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);
    const json = await fetchPage(url, token);
    for (const r of json.records) all.push(r.fields);
    offset = json.offset;
  } while (offset);
  return all;
}

// If the Airtable schema changed and a requested field no longer exists,
// drop that field and retry instead of failing the whole dashboard. Dropped
// fields are reported to the client so it can show a warning.
async function fetchAll(baseId, tableId, token, fields) {
  fields = [...fields];
  const missingFields = [];
  while (true) {
    try {
      const records = await fetchAllWithFields(baseId, tableId, token, fields);
      return { records, missingFields };
    } catch (err) {
      if (err.unknownField && fields.includes(err.unknownField)) {
        fields = fields.filter(f => f !== err.unknownField);
        missingFields.push(err.unknownField);
        continue;
      }
      throw err;
    }
  }
}

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE || "app7dTq3SSToVhnwl";
  const tableId = process.env.AIRTABLE_TABLE || "tbloGJE9Oz52hrMTl";

  if (!token) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "AIRTABLE_TOKEN not set" });
    return;
  }

  try {
    const fieldMap = await discoverFieldMap(baseId, tableId, token);
    const attributionFields = Object.values(fieldMap).filter(Boolean);
    const fields = [...new Set([...STATIC_FIELDS, ...attributionFields])];

    const { records, missingFields } = await fetchAll(baseId, tableId, token, fields);

    // Normalise discovered attribution fields onto their canonical keys so
    // the front end never has to care about the actual Airtable names.
    for (const [canonical, actual] of Object.entries(fieldMap)) {
      if (!actual || actual === canonical) continue;
      for (const r of records) {
        if (r[actual] !== undefined) r[canonical] = r[actual];
      }
    }

    // Only successful responses are cacheable; errors must never be cached.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      records,
      missingFields,
      fieldMap,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(err.message || err) });
  }
}
