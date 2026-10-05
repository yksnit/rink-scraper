// Run the scraper from the command line without the Functions runtime:
//   node scripts/run-local.js [scheduleUrl] [days]
import { scrapeAcuitySchedule } from '../src/acuity.js';

const url =
  process.argv[2] ?? 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344';
const days = Number(process.argv[3] ?? 60);

const events = await scrapeAcuitySchedule(url, { days });
console.log(JSON.stringify(events, null, 2));
console.error(`\n${events.length} events`);
