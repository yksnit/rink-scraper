/**
 * Scraper for Acuity Scheduling booking pages.
 *
 * Acuity's public booking page is a client-side app that loads availability
 * from two JSON endpoints (the same calls the browser makes):
 *
 *   GET /api/scheduling/v1/availability/month?owner&appointmentTypeId&calendarId&timezone&month=YYYY-MM-01
 *     -> { "2026-10-18": true, "2026-10-19": false, ... }   (which days have open slots)
 *
 *   GET /api/scheduling/v1/availability/times?owner&appointmentTypeId&calendarId&timezone&startDate=YYYY-MM-DD
 *     -> { "2026-10-18": [{ "time": "2026-10-18T07:30:00-0500", "slotsAvailable": 8 }, ...] }
 *
 * Event metadata (name, category, duration, timezone) is embedded in the
 * booking page HTML as `var BUSINESS = {...}`.
 */

const ORIGIN = 'https://app.acuityscheduling.com';
const AVAILABILITY_API = `${ORIGIN}/api/scheduling/v1/availability`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const DEFAULT_DAYS = 60;
const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 3;

/**
 * Scrape every bookable event on an Acuity schedule page for the next `days` days.
 *
 * @param {string} scheduleUrl  Any Acuity booking link for a single appointment type, e.g.
 *   https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344
 *   https://app.acuityscheduling.com/schedule.php?owner=19790920&appointmentType=14752819
 * @param {object}  [options]
 * @param {number}  [options.days=60]        Number of days to cover, starting today (rink local time).
 * @param {string}  [options.eventType]      Override the eventType label (defaults to the Acuity category).
 * @param {number}  [options.concurrency=4]  Parallel requests to Acuity.
 * @returns {Promise<Array<{eventType: string, eventTime: string, eventDate: string, spotsLeft: number}>>}
 */
export async function scrapeAcuitySchedule(scheduleUrl, options = {}) {
  const days = options.days ?? DEFAULT_DAYS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const { business, finalUrl } = await fetchBusiness(scheduleUrl);
  const { appointmentTypeId, calendarId } = parseScheduleUrl(finalUrl);

  const appointmentType = findAppointmentType(business, appointmentTypeId);
  if (!appointmentType) {
    throw new Error(`Appointment type ${appointmentTypeId} not found on ${scheduleUrl}`);
  }

  // A URL without a calendar means "any calendar" - check each one the appointment type runs on.
  const calendarIds = calendarId ? [calendarId] : appointmentType.calendarIDs ?? [];
  if (calendarIds.length === 0) {
    throw new Error(`No calendar found for appointment type ${appointmentTypeId}`);
  }

  const timezone = calendarTimezone(business, calendarIds[0]) || business.timezone || 'America/New_York';
  const eventType = options.eventType ?? defaultEventType(appointmentType);
  const durationMinutes = Number(appointmentType.duration) || 0;

  const startDate = todayIn(timezone);
  const endDate = addDays(startDate, days - 1);

  const baseParams = {
    owner: business.ownerKey,
    appointmentTypeId: String(appointmentTypeId),
    timezone,
  };

  const slots = [];
  for (const calId of calendarIds) {
    const params = { ...baseParams, calendarId: String(calId) };

    // 1. Which days in the window have availability (one request per month).
    const openDates = [];
    for (const month of monthsBetween(startDate, endDate)) {
      const monthAvailability = await getJson('month', { ...params, month });
      for (const [date, isOpen] of Object.entries(monthAvailability)) {
        if (isOpen && date >= startDate && date <= endDate) openDates.push(date);
      }
    }

    // 2. Time slots for each open day.
    const perDay = await mapWithConcurrency(openDates, concurrency, async (date) => {
      const times = await getJson('times', { ...params, startDate: date });
      return times[date] ?? [];
    });
    slots.push(...perDay.flat());
  }

  return slots
    .map((slot) => ({ slot, start: parseAcuityTime(slot.time) }))
    .sort((a, b) => a.start - b.start)
    .map(({ slot, start }) => {
      const end = new Date(start.getTime() + durationMinutes * 60_000);
      return {
        eventType,
        eventTime: `${formatTime(start, timezone)} - ${formatTime(end, timezone)}`,
        eventDate: formatDate(start, timezone),
        spotsLeft: slot.slotsAvailable,
      };
    });
}

// ---------------------------------------------------------------------------
// Page + URL parsing
// ---------------------------------------------------------------------------

async function fetchBusiness(scheduleUrl) {
  const res = await fetchWithRetry(scheduleUrl, { headers: { 'User-Agent': USER_AGENT } });
  const html = await res.text();
  const business = extractJsObject(html, 'BUSINESS');
  if (!business?.ownerKey) {
    throw new Error(`Could not find Acuity business data on ${scheduleUrl}`);
  }
  // Legacy schedule.php links redirect to /schedule/{ownerKey}/..., so parse the final URL.
  return { business, finalUrl: res.url || scheduleUrl };
}

/** Supports /schedule/{key}/appointment/{id}/calendar/{id} and ?appointmentType(Ids[])=&calendarID(s)= forms. */
export function parseScheduleUrl(url) {
  const u = new URL(url);
  const pathMatch = u.pathname.match(/\/appointment\/(\d+)(?:\/calendar\/(\d+))?/);
  const q = u.searchParams;

  const appointmentTypeId = Number(
    pathMatch?.[1] ?? q.get('appointmentType') ?? q.get('appointmentTypeIds[]') ?? q.get('appointmentTypeIds'),
  );
  const calendarId = Number(
    pathMatch?.[2] ?? q.get('calendarID') ?? q.get('calendarIds[]') ?? q.get('calendarIds'),
  ) || null;

  if (!appointmentTypeId) {
    throw new Error(`URL does not identify a single appointment type: ${url}`);
  }
  return { appointmentTypeId, calendarId };
}

/** Pulls `var NAME = {...};` out of an inline <script> and JSON-parses it. */
function extractJsObject(html, name) {
  const marker = `var ${name} = `;
  const start = html.indexOf(marker);
  if (start === -1) return null;

  let i = html.indexOf('{', start + marker.length);
  const from = i;
  let depth = 0;
  let inString = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return JSON.parse(html.slice(from, i + 1));
    }
  }
  return null;
}

function findAppointmentType(business, id) {
  // appointmentTypes is grouped by category: { "Stick and Puck": [...], "Public Skating": [...] }
  const groups = business.appointmentTypes ?? {};
  const all = Array.isArray(groups) ? groups : Object.values(groups).flat();
  return all.find((t) => Number(t.id) === id);
}

function calendarTimezone(business, calendarId) {
  const all = Object.values(business.calendars ?? {}).flat();
  return all.find((c) => Number(c.id) === Number(calendarId))?.timezone;
}

/** "Stick and Puck" -> "stick & puck" */
function defaultEventType(appointmentType) {
  const label = appointmentType.category || appointmentType.name || 'event';
  return label.toLowerCase().replace(/\band\b/g, '&').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJson(endpoint, params) {
  const url = `${AVAILABILITY_API}/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  return res.json();
}

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => '');
      throw new Error(`Acuity request failed (${res.status}) ${url}: ${body.slice(0, 300)}`);
    }
    await sleep(500 * 2 ** attempt);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Dates (all YYYY-MM-DD strings are calendar dates in the rink's timezone)
// ---------------------------------------------------------------------------

function todayIn(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First-of-month strings covering [start, end], e.g. ["2026-10-01", "2026-11-01", "2026-12-01"]. */
function monthsBetween(start, end) {
  const months = [];
  const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 7) <= end.slice(0, 7)) {
    months.push(d.toISOString().slice(0, 10));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return months;
}

/** "2026-10-18T07:30:00-0500" -> Date (adds the colon to the offset for strict ISO parsing). */
function parseAcuityTime(time) {
  return new Date(time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(/[  ]/g, ' '); // ICU uses a narrow no-break space before AM/PM
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}
