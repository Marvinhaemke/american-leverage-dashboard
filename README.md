# American Leverage — Sales Dashboard

KPI dashboard for the Setter → Closer funnel, fed live from Airtable and
deployable to Vercel.

## Layout

Header and filters ("general information") sit on top, followed by an overall
overview strip (leads, calls booked, closes, closing rate, revenue). Below
that, the **Setter** and **Closer** dashboards sit in two columns next to each
other; they stack vertically on narrow screens.

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
- Revenue (Amount received)
- Outcome donut + per-closer table

## Filters
- Timeframe basis: **Date Created**, **Setting Call**, **Closing Call**, or **Close Date**
- Date range: last 7 / 30 / 90 days, YTD, all-time, or custom
- Setter and Closer dropdowns

Filtering happens client-side on a single fetched dataset, so changing filters
is instant.

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

The token lives **only on the server** (Vercel function); the browser never
sees it.

The function caches Airtable responses for 60 seconds at Vercel's edge and the
front end refreshes every 5 minutes.
