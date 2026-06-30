# American Leverage — Sales Dashboard

KPI dashboard for the Setter → Closer funnel, fed live from Airtable and
deployable to Vercel.

## Layout

Header and filters ("general information") sit on top, followed by an overall
overview strip (leads, calls booked, closes, closing rate, revenue — each
metric filtered by its natural date field). Below that, three tabs:

- **Setter Dashboard** / **Closer Dashboard** — individual setters / closers
  shown as cards in columns next to each other, followed by team totals and
  charts. The date range applies to setting call dates on the Setter tab and
  closing call dates on the Closer tab.
- **Marketing Dashboard** — combines Meta Ads spend with the Airtable funnel:
  1. North star: Spend, Cash Collected, ROAS (cash basis), Blended CAC,
     Core-Offer CAC (high-ticket closes only)
  2. Funnel with transition rates. Meta only sees as far as the booked call,
     so the funnel is supplemented from Airtable to show both calls:
     Leads → Qualified → Setting Booked → Closing Booked → Closes (each stage
     colour-coded by source). Show Rate prominent, plus sales-side
     Qualified-after-Call
  3. Cost per stage: CPL, cost per qualified lead (marketing-side), cost per
     qualified lead after call (sales-side), cost per booked call, cost per
     held call, cost per closing call (past closing calls excl. no-shows),
     CAC
  4. Country table sorted by cash collected (spend, CPQL, closes, cash, CAC)
  5. Top performers: best ad and best campaign, each by volume (most leads)
     and by efficiency (lowest CAC, falling back to CPL)
  6. Data quality: last sync per source, outcome completeness, attribution
     field mapping

  Each marketing stage is counted by its own event date within the range.
  The Core-Offer threshold is `CORE_OFFER_MIN_CASH` in
  [public/marketing.js](public/marketing.js).

## What's tracked

### Setter Dashboard
- Booked Calls (setting calls scheduled)
- Completed Calls (setting calls that showed)
- No-Show Rate
- Qualified Rate (of completed setting calls)
- Closing Rate (closes / completed closing calls)
- Closer Disqualification Rate
- Closer No-Show Rate
- Revenue (Amount received)
- No Outcome (completed closing calls with no outcome filled in)
- Funnel chart + per-setter table

### Closer Dashboard
- Booked Calls (closing calls scheduled — Date Strategy Call)
- Completed Calls
- No-Show Rate
- **Assessment Filled** (count + rate on booked closing calls)
- **Cancelled — no assessment** (cancelled calls with no assessment ever filled)
- Closes / No Close / Follow Up
- Close after Follow Up / No Close after Follow Up
- Closing Rate
- Close Rate after Follow Up
- Disqualified from Closer
- Revenue (Amount received, attributed by **Close Date** — not the closing
  call date used for the call-based KPIs)
- Outcome donut + per-closer table

## Filters
- Date range: last 7 / 30 / 90 days, YTD, all-time, or custom
- Setter and Closer dropdowns

The timeframe basis is fixed per tab (Setting Call date on the Setter tab,
Closing Call date on the Closer tab). Filtering happens client-side on a
single fetched dataset, so changing filters is instant.

## Schema robustness

The API only requests the fields the dashboard actually uses (see `FIELDS` in
[api/leads.js](api/leads.js)). If a field is renamed or deleted in Airtable,
the function drops it and retries instead of failing — the dashboard still
loads and shows a warning in the status bar listing the missing fields, so
KPIs that depend on them can be spotted immediately. Rate-limited (429) and
5xx responses are retried with backoff.

## Funnel mapping notes

Per the doc, the funnel is:

```
Setting Call ──(qualified)──► Closing Call ──► Close / No Close / Follow Up
                              (assessment must be filled, else cancelled)
```

The Airtable schema uses "Strategy Call" for what the funnel calls the
**Closing Call**. The dashboard treats them as identical (`Date Strategy Call`,
`Strategy No-Show Status`, `Outcome Strategy Call`).

**Outcomes**: the user has confirmed new records will use the literal values
`Close`, `No Close`, `Follow Up` in `Outcome Strategy Call`. Legacy values
present in the existing data are mapped to these buckets in
[public/kpis.js](public/kpis.js). `Close Won/Lost` is honoured first when set.

`Follow Up Process` is a separate checkbox that stays true even after the
outcome is overwritten to `Close` — that's how **Close after Follow Up** and
**No Close after Follow Up** are identified.

## Local development

```
npm install -g vercel
vercel link            # link to your Vercel project
vercel env add AIRTABLE_TOKEN
vercel dev
```

Open http://localhost:3000.

## Deploying

```
vercel --prod
```

### Required environment variables

| Variable | Value |
| --- | --- |
| `AIRTABLE_TOKEN` | Airtable Personal Access Token with `data.records:read` on the base |
| `AIRTABLE_BASE`  | `app7dTq3SSToVhnwl` (optional — already defaulted) |
| `AIRTABLE_TABLE` | `tbloGJE9Oz52hrMTl` (optional — already defaulted) |
| `META_ACCESS_TOKEN` | Meta Marketing API token with `ads_read` on the ad account (Marketing tab) |
| `META_AD_ACCOUNT_ID` | Meta ad account id, with or without the `act_` prefix (Marketing tab) |

Without the Meta variables the Marketing tab still loads (funnel, cash, data
quality) and shows a "Meta not connected" notice for the spend-based KPIs.

### Currency

All spend is reported in **USD**. Meta returns spend in the ad account's
currency (`account_currency`); when that is **CAD** it is converted using the
live **Bank of Canada** USD/CAD rate (Valet API, `FXUSDCAD`). The rate and its
date are shown in the Marketing tab's data-quality row. If the Bank of Canada
request fails the function falls back to `META_FX_USD_PER_CAD` (if set) or an
approximate rate, and flags it. USD accounts pass through unconverted; other
currencies are shown as-is with a warning. Airtable cash (`Amount received`)
is assumed to be USD already.

| Variable | Value |
| --- | --- |
| `META_FX_USD_PER_CAD` | Optional fallback USD-per-CAD rate if the Bank of Canada API is unreachable |

The marketing attribution fields (country / ad / campaign) are
**auto-discovered** from the Airtable schema by sampling records and matching
common names (`Country`/`Land`, `Ad Name`/`utm_content`, `Campaign`/
`utm_campaign`, …). The resolved mapping is shown in the Marketing tab's
data-quality row.

The token lives **only on the server** (Vercel function); the browser never
sees it.

The function caches Airtable responses for 60 seconds at Vercel's edge and the
front end refreshes every 5 minutes.
