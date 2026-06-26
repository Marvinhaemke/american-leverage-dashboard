// Serverless function: pulls ad spend / lead numbers from the Meta Marketing
// API for the Marketing Dashboard.
//
// Required environment variables on Vercel:
//   META_ACCESS_TOKEN   - Meta (Facebook) Marketing API access token with
//                         ads_read on the ad account
//   META_AD_ACCOUNT_ID  - Ad account id, with or without the "act_" prefix
//
// If they are not set the endpoint returns { configured: false } and the
// dashboard shows a "Meta not connected" notice instead of failing.

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_ATTEMPTS = 3;

// Meta reports leads under different action types depending on the campaign
// setup; take the first one present.
const LEAD_ACTION_TYPES = [
  "lead",
  "onsite_conversion.lead_grouped",
  "leadgen_grouped",
  "offsite_conversion.fb_pixel_lead"
];

function leadCount(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const t of LEAD_ACTION_TYPES) {
    const a = actions.find(x => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * 500));
      continue;
    }
    // Strip the token from anything that could end up in an error message.
    throw new Error(`Meta ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Live USD-per-CAD rate from the Bank of Canada Valet API. The FXUSDCAD
// series is CAD per 1 USD, so USD per CAD is its reciprocal. Returns the rate
// and the observation date. Throws on any failure so the caller can fall back.
const BOC_FX_URL =
  "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1";

async function fetchUsdPerCad() {
  const res = await fetch(BOC_FX_URL);
  if (!res.ok) throw new Error(`Bank of Canada ${res.status}`);
  const json = await res.json();
  const obs = json.observations?.[json.observations.length - 1];
  const cadPerUsd = Number(obs?.FXUSDCAD?.v);
  if (!cadPerUsd) throw new Error("Bank of Canada: no rate in response");
  return { usdPerCad: 1 / cadPerUsd, date: obs.d };
}

// Resolve the conversion to USD for the ad account's reporting currency.
// USD passes through untouched; CAD uses the live Bank of Canada rate (with an
// env override / approximate fallback if that request fails); any other
// currency is left unconverted and flagged.
async function resolveFx(currency) {
  if (currency === "USD") {
    return { fx: { reporting: "USD", original: "USD", converted: false, rate: 1 }, convert: v => v };
  }
  if (currency === "CAD") {
    try {
      const { usdPerCad, date } = await fetchUsdPerCad();
      return {
        fx: { reporting: "USD", original: "CAD", converted: true, rate: usdPerCad, date, source: "Bank of Canada" },
        convert: v => v * usdPerCad
      };
    } catch (err) {
      const envRate = Number(process.env.META_FX_USD_PER_CAD);
      const usdPerCad = envRate || 0.73; // rough long-run CAD value
      return {
        fx: {
          reporting: "USD", original: "CAD", converted: true, rate: usdPerCad,
          source: envRate ? "env override" : "approximate fallback",
          fallback: true, error: String(err.message || err)
        },
        convert: v => v * usdPerCad
      };
    }
  }
  // Unknown currency — don't guess a rate.
  return {
    fx: { reporting: "USD", original: currency || "unknown", converted: false, rate: 1, unsupported: true },
    convert: v => v
  };
}

// Follows paging.next links (ad-level insights can span many pages).
async function graphGetAll(path, params, token) {
  const rows = [];
  let json = await graphGet(path, params, token);
  for (;;) {
    rows.push(...(json.data || []));
    const next = json.paging?.next;
    if (!next) return rows;
    const res = await fetch(next);
    if (!res.ok) throw new Error(`Meta ${res.status} while paging insights`);
    json = await res.json();
  }
}

export default async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;
  let account = process.env.META_AD_ACCOUNT_ID || "";
  if (!token || !account) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ configured: false });
    return;
  }
  if (!account.startsWith("act_")) account = "act_" + account;

  const { from, to } = req.query;
  const range = from && to
    ? { time_range: JSON.stringify({ since: from, until: to }) }
    : { date_preset: "maximum" };

  try {
    const [totals, byCountry, byAd] = await Promise.all([
      graphGet(`${account}/insights`, { ...range, fields: "spend,actions,account_currency" }, token),
      graphGetAll(`${account}/insights`, { ...range, fields: "spend,actions", breakdowns: "country", limit: "200" }, token),
      graphGetAll(`${account}/insights`, { ...range, level: "ad", fields: "ad_name,campaign_name,spend,actions", limit: "500" }, token)
    ]);

    const t = totals.data?.[0] || {};
    const currency = (t.account_currency || "USD").toUpperCase();
    // All spend figures are reported in USD; the rest of the app assumes USD
    // so cash (Airtable, USD) and spend share one currency for ROAS / CAC.
    const { fx, convert } = await resolveFx(currency);

    const payload = {
      configured: true,
      spend: convert(Number(t.spend) || 0),
      leads: leadCount(t.actions),
      countries: byCountry.map(r => ({
        country: r.country,
        spend: convert(Number(r.spend) || 0),
        leads: leadCount(r.actions)
      })),
      ads: byAd.map(r => ({
        ad: r.ad_name || "(unnamed ad)",
        campaign: r.campaign_name || "(unnamed campaign)",
        spend: convert(Number(r.spend) || 0),
        leads: leadCount(r.actions)
      })),
      fx,
      fetchedAt: new Date().toISOString()
    };

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(payload);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(err.message || err) });
  }
}
