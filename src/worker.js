// src/worker.js
import dotenv from "dotenv";
dotenv.config();

import db from "./db.js";
import { scrapeSmart } from "./scrape.js";

// Poll elke paar seconden op een queued job en voer 'm uit
const POLL_MS = 3000;

async function main() {
  console.log("[worker] started");
  // simpele eindeloze loop
  while (true) {
    const job = takeQueuedJob();
    if (job) {
      await runJob(job).catch(err => {
        console.error("[worker] runJob error:", err);
      });
    } else {
      await sleep(POLL_MS);
    }
  }
}

function takeQueuedJob() {
  const row = db.prepare(
    `SELECT id, payload FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1`
  ).get();

  if (!row) return null;

  const changed = db.prepare(
    `UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status='queued'`
  ).run(new Date().toISOString(), row.id);

  return changed.changes ? row : null;
}

async function runJob(row) {
  const now = () => new Date().toISOString();
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}

  try {
    // zelfde mapping als je /scrape/smart route
    const {
      link, country, keyword,
      limit = 25, active = true, headless = true, log = true,
      date_min, date_max, require_category
    } = payload;

    const DRE = /^\d{4}-\d{2}-\d{2}$/;
    const dm = date_min && DRE.test(date_min) ? date_min : undefined;
    const dx = date_max && DRE.test(date_max) ? date_max : undefined;

    const items = await scrapeSmart({
      url: link, country, keyword, limit, active, headless, log,
      dateMin: dm, dateMax: dx, requireCategory: require_category
    });

    db.prepare(
      `UPDATE jobs SET status='done', result=?, updated_at=? WHERE id=?`
    ).run(JSON.stringify({ count: items.length, sample: items.slice(0,3) }), now(), row.id);

    console.log(`[worker] job ${row.id} done (${items.length} items)`);
  } catch (e) {
    db.prepare(
      `UPDATE jobs SET status='error', error=?, updated_at=? WHERE id=?`
    ).run(String(e && e.stack || e), now(), row.id);
    console.error(`[worker] job ${row.id} error:`, e);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
