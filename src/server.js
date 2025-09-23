// src/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import db from "./db.js"; // laten staan, maar we gebruiken 'm niet
import { appendUniversalRows, appendHistoryRow, ensureHeaders } from "./sheetsUtil.js";
import { scrapeSmart } from "./scrape.js";

dotenv.config();
const app = express();

// ---------- basics ----------
app.use(express.json({ limit: "2mb" }));
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://<JOUW-PAGES-URL>.pages.dev"
  ]
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/client", express.static(path.join(__dirname, "client")));

const isCloud = Boolean(process.env.RENDER || process.env.CI || process.env.NODE_ENV === "production");

// ---------- health ----------
app.get("/health", (_req, res) => {
  try {
    const row = db.prepare?.("SELECT COUNT(*) AS total FROM ads_universal").get?.();
    res.json({ ok: true, ads_in_db: row?.total ?? 0, ts: new Date().toISOString() });
  } catch {
    res.json({ ok: true, ads_in_db: 0, ts: new Date().toISOString() });
  }
});

// ---------- sheets init ----------
app.post("/sheets/init", async (_req, res) => {
  try {
    await ensureHeaders();
    res.json({ ok: true, msg: "Headers set" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- sync scrape (zonder DB inserts) ----------
app.post("/scrape/smart", async (req, res) => {
  try {
    const {
      link, country, keyword,
      limit = 25, active = true, headless = true, log = true,
      date_min, date_max, require_category
    } = req.body || {};

    const DRE = /^\d{4}-\d{2}-\d{2}$/;
    const dm = date_min && DRE.test(date_min) ? date_min : undefined;
    const dx = date_max && DRE.test(date_max) ? date_max : undefined;

    if (!link && (!keyword || !country)) {
      return res.status(400).json({ ok: false, error: "Provide 'link' or 'keyword' + 'country'." });
    }

    const started = new Date().toISOString();

    // In de cloud altijd headless forceren
    const items = await scrapeSmart({
      url: link, country, keyword, limit, active,
      headless: isCloud ? true : !!headless,
      log, dateMin: dm, dateMax: dx, requireCategory: require_category
    });

    // Sheets push (blijft gelijk)
    const rows = items.map(it => ([
      it.ad_snapshot_url || "",       // A
      it.page_name || "",             // B
      it.country || "",               // C
      typeof it.reach === "number" ? it.reach : "", // D
      it.product_url || "",           // E
      it.start_date || "",            // F
      it.media_type || "",            // G
      it.platforms || "",             // H
      it.keyword || "",               // I
      it.ad_id || "",                 // J
      it.cta_text || "",              // K
      it.page_likes || "",            // L
      it.page_followers || "",        // M
      it.page_category || ""          // N
    ]));

    if (rows.length) await appendUniversalRows(rows);

    await appendHistoryRow([
      `smart-${Date.now()}`,
      started,
      new Date().toISOString(),
      (keyword || ""),
      (country || ""),
      limit,
      items.length,
      Math.max(0, limit - items.length),
      "smart-graph+snapshot+cta-filter",
    ]);

    res.json({ ok: true, count: items.length, sample: items.slice(0, 3) });
  } catch (e) {
    console.error("[/scrape/smart] ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =====================================================================
//                       ASYNC VARIANT (zonder database)
// =====================================================================

// Simpele in-memory job store (reset bij herstart)
const jobs = new Map(); // id -> {status, payload, result, error, created_at, updated_at}
let workerBusy = false;

function makeJob(payload) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = { id, status: "queued", payload, result: null, error: null, created_at: now, updated_at: now };
  jobs.set(id, job);
  return job;
}

async function runNextJob() {
  if (workerBusy) return;
  const job = [...jobs.values()].find(j => j.status === "queued");
  if (!job) return;

  workerBusy = true;
  try {
    job.status = "running";
    job.updated_at = new Date().toISOString();

    const {
      link, country, keyword,
      limit = 25, active = true, headless = true, log = true,
      date_min, date_max, require_category
    } = job.payload || {};

    const DRE = /^\d{4}-\d{2}-\d{2}$/;
    const dm = date_min && DRE.test(date_min) ? date_min : undefined;
    const dx = date_max && DRE.test(date_max) ? date_max : undefined;

    const items = await scrapeSmart({
      url: link, country, keyword, limit, active,
      headless: isCloud ? true : !!headless,
      log, dateMin: dm, dateMax: dx, requireCategory: require_category
    });

    // Sheets push, net als sync
    const rows = items.map(it => ([
      it.ad_snapshot_url || "",
      it.page_name || "",
      it.country || "",
      typeof it.reach === "number" ? it.reach : "",
      it.product_url || "",
      it.start_date || "",
      it.media_type || "",
      it.platforms || "",
      it.keyword || "",
      it.ad_id || "",
      it.cta_text || "",
      it.page_likes || "",
      it.page_followers || "",
      it.page_category || ""
    ]));
    if (rows.length) await appendUniversalRows(rows);

    await appendHistoryRow([
      `smart-${Date.now()}`,
      job.created_at,
      new Date().toISOString(),
      (keyword || ""),
      (country || ""),
      limit,
      items.length,
      Math.max(0, limit - items.length),
      "smart-graph+snapshot+cta-filter (async)",
    ]);

    job.result = { ok: true, count: items.length, sample: items.slice(0, 3) };
    job.status = "done";
    job.updated_at = new Date().toISOString();
  } catch (e) {
    console.error("[worker] job error:", e);
job.error = JSON.stringify({
  message: String(e?.message || e),
  name: e?.name,
  code: e?.code,
  cause: e?.cause && {
    code: e.cause.code,
    errno: e.cause.errno,
    syscall: e.cause.syscall,
    hostname: e.cause.hostname
  },
  stack: e?.stack?.split('\n').slice(0,5).join('\n')
});
    job.status = "error";
    job.updated_at = new Date().toISOString();
  } finally {
    workerBusy = false;
    // meteen kijken of er nog eentje ligt
    setImmediate(runNextJob);
  }
}

// Start async job – antwoordt meteen
app.post("/scrape/smart-async", async (req, res) => {
  try {
    const { link, country, keyword } = req.body || {};
    if (!link && (!keyword || !country)) {
      return res.status(400).json({ ok: false, error: "Provide 'link' or 'keyword' + 'country'." });
    }
    const job = makeJob({ ...(req.body || {}) });
    setImmediate(runNextJob); // kick de worker
    res.status(202).json({ ok: true, job_id: job.id, status: job.status, check: `/jobs/${job.id}` });
  } catch (e) {
    console.error("[/scrape/smart-async] ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Job status/result
app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
      created_at: job.created_at,
      updated_at: job.updated_at
    }
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 5179;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
