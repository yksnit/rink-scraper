import functions from '@google-cloud/functions-framework';
import { scrapeAcuitySchedule } from './src/acuity.js';

const DEFAULT_SCHEDULE_URL =
  process.env.SCHEDULE_URL ??
  'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344';

/**
 * HTTP Cloud Function.
 *
 *   GET  /?url=<acuity schedule url>&days=60&eventType=stick%20%26%20puck
 *   POST { "url": "...", "days": 60, "eventType": "..." }
 *
 * All parameters are optional; `url` defaults to the SCHEDULE_URL env var.
 * Responds with a JSON array of { eventType, eventTime, eventDate, spotsLeft }.
 */
functions.http('scrapeRink', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }

  const input = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
  const url = input.url || DEFAULT_SCHEDULE_URL;
  const days = input.days === undefined ? 60 : Number(input.days);

  if (!Number.isInteger(days) || days < 1 || days > 180) {
    return res.status(400).json({ error: '`days` must be an integer between 1 and 180' });
  }
  if (!/^https:\/\/[\w.-]*acuityscheduling\.com\//.test(url)) {
    return res.status(400).json({ error: '`url` must be an acuityscheduling.com schedule link' });
  }

  try {
    const events = await scrapeAcuitySchedule(url, { days, eventType: input.eventType });
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).json(events);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: err.message });
  }
});
