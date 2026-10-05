# Rink Scraper

Google Cloud Function (Node.js 22) that scrapes an Acuity Scheduling booking page
and returns every bookable session for the next 60 days:

```json
[
  { "eventType": "stick & puck", "eventTime": "7:30 AM - 8:30 AM", "eventDate": "October 18, 2026", "spotsLeft": 8 }
]
```

## How it works

Acuity's booking page loads its data from two public JSON endpoints, and the scraper calls them directly
(no headless browser needed):

1. `availability/month` lists the days in each month that have open slots.
2. `availability/times` lists each open day's start times and remaining spots.

The event name, category, duration (used for the end time) and timezone come from the
`BUSINESS` object embedded in the booking page.

## Run locally

```bash
npm install
npm run scrape                                    # default rink, 60 days
node scripts/run-local.js "<acuity url>" 30       # any rink, any range
npm start                                         # local function at http://localhost:8080
```

## Deploy

```bash
gcloud functions deploy scrapeRink \
  --gen2 --runtime=nodejs22 --region=us-south1 \
  --source=. --entry-point=scrapeRink --trigger-http --allow-unauthenticated \
  --memory=256Mi --timeout=120s --max-instances=5 \
  --set-env-vars SCHEDULE_URL="https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344"
```

Live: https://us-south1-rink-scraper.cloudfunctions.net/scrapeRink

> **Region matters.** Acuity returns `403 Forbidden` to some Google Cloud outgoing IP addresses.
> In `us-central1` the function landed on a blocked address, but `us-south1` works. If the function
> starts returning 502 errors that mention a 403, redeploy to another region, or route outgoing
> traffic through a reserved static IP (Cloud NAT).

## Request parameters (all optional)

| Param       | Default                 | Notes                                                  |
|-------------|-------------------------|--------------------------------------------------------|
| `url`       | `SCHEDULE_URL` env var  | Any Acuity link for one appointment type (new `/schedule/...` or legacy `schedule.php?...`) |
| `days`      | `60`                    | 1–180                                                  |
| `eventType` | Acuity category, lower-cased, "and" → "&" | Override the label, e.g. `public skate`  |

Pass them as a query string (`GET ?url=...&days=30`) or a JSON body (`POST`).

## Adding other rinks

Any Acuity-hosted rink works: pass its booking URL as `url`. For rinks on other platforms
(DaySmart, Rec Desk, ActiveNet, etc.), add a sibling module in `src/` that returns the same
shape and route to it in `index.js` based on the URL's hostname.

## Notes

- Fully booked sessions are omitted, because Acuity only returns open slots.
- Dates with no published schedule yet (e.g. next month before the rink posts it) are simply empty.
- These are Acuity's internal endpoints rather than its documented API (which needs the business
  owner's API key), so they could change without notice.
