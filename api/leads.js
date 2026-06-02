// Serverless function: fetches all records from the Airtable Leads table and
// returns a slimmed-down JSON array used by the dashboard.
//
// Required environment variables on Vercel:
//   AIRTABLE_TOKEN  - Personal Access Token with data.records:read on the base
//   AIRTABLE_BASE   - Airtable base id (e.g. app7dTq3SSToVhnwl)
//   AIRTABLE_TABLE  - Airtable table id  (e.g. tbloGJE9Oz52hrMTl)

const FIELDS = [
  "Full Name",
  "Date Created",
  "Stages",
  "Current Stage",
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
  "Close Amount",
  "Amount received",
  "Date Close",
  "Setter",
  "Closer",
  "Setting Event",
  "Strategy Event"
];

async function fetchAll(baseId, tableId, token) {
  const all = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    for (const f of FIELDS) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const r of json.records) all.push(r.fields);
    offset = json.offset;
  } while (offset);
  return all;
}

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE || "app7dTq3SSToVhnwl";
  const tableId = process.env.AIRTABLE_TABLE || "tbloGJE9Oz52hrMTl";

  if (!token) {
    res.status(500).json({ error: "AIRTABLE_TOKEN not set" });
    return;
  }

  try {
    const records = await fetchAll(baseId, tableId, token);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ records, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
