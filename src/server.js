// src/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";

import db from "./db.js"; // laten staan, maar we gebruiken 'm niet actief
import { appendUniversalRows, appendHistoryRow, ensureHeaders } from "./sheetsUtil.js";
import { scrapeSmart } from "./scrape.js";

dotenv.config();
const app = express();

/* --------------------------- basics & helpers --------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isCloud = Boolean(process.env.RENDER || process.env.CI || process.env.NODE_ENV === "production");
const DEBUG = (process.env.DEBUG || "0") === "1";

// Geheimen maskeren (alleen een stukje tonen)
const mask = (v, keepStart = 8, keepEnd = 4) => {
  if (!v) return null;
  const s = String(v);
  if (s.length <= keepStart + keepEnd) return s;
  return s.slice(0, keepStart) + "…" + s.slice(-keepEnd);
};

// Playwright-browserpaden inspecteren
function getPWInfo() {
  const candidates = [];

  // 1) Aanbevolen: browsers onder node_modules (PLAYWRIGHT_BROWSERS_PATH=0)
  const nmLocal = path.join(process.cwd(), "node_modules", "playwright", ".local-browsers");
  candidates.push({ label: "node_modules .local-browsers", dir: nmLocal, exists: fs.existsSync(nmLocal) });

  // 2) Render cache (vaak de foutplek)
  const renderCache = "/opt/render/.cache/ms-playwright";
  candidates.push({ label: "render cache", dir: renderCache, exists: fs.existsSync(renderCache) });

  // 3) HOME cache fallback
  const home = process.env.HOME || "";
  if (home) {
    const homeCache = path.join(home, ".cache", "ms-playwright");
    candidates.push({ label: "home cache", dir: homeCache, exists: fs.existsSync(homeCache) });
  }

  // probeer in bestaande paden een chromium subfolder te spotten (1 niveau diep)
  const chromiumHints = [];
  for (const c of candidates) {
    if (!c.exists) continue;
    try {
      const items = fs.readdirSync(c.dir, { withFileTypes: true });
      for (const it of items) {
        if (!it.isDirectory()) continue;
        if (/chrom/i.test(it.name)) {
          chromiumHints.push(path.join(c.dir, it.name));
        }
      }
    } catch {}
  }

  return {
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    candidates,
    chromiumHints,
  };
}

/* ------------------------------- middleware ---------------------------- */

app.use(express.json({ limit: "2mb" }));

// CORS — whitelists; voeg optioneel FRONTEND_ORIGIN toe via env
const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_ORIGIN,             // bv. https://<jouw-pages>.pages.dev
  process.env.FRONTEND_ORIGIN_2            // extra indien nodig
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl
    if (allowedOrigins.length === 0) return cb(null, true); // geen whitelist ingesteld
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (DEBUG) return cb(null, true);  // in DEBUG: alles toestaan
    return cb(new Error("CORS blocked: " + origin));
  }
}));

// Static client (upload.html bereikbaar op /client/upload.html)
// LET OP: verwacht src/client/ binnen het src-pad
app.use("/client", express.static(path.join(__dirname, "client")));

/* -------------------------------- health -------------------------------- */

app.get("/health", (_req, res) => {
  try {
    const row = db.prepare?.("SELECT COUNT(*) AS total FROM ads_universal").get?.();
    res.json({ ok: true, ads_in_db: row?.total ?? 0, ts: new Date().toISOString() });
  } catch {
    res.json({ ok: true, ads_in_db: 0, ts: new Date().toISOString() });
  }
});

/* ------------------------------ debug tools ----------------------------- */
/* Zet DEBUG=1 in je environment om deze endpoints te gebruiken. */

if (DEBUG) {
  // 1) Env + Playwright overzicht (maskert secrets)
  app.get("/debug/env", (_req, res) => {
    const pw = getPWInfo();
    const out = {
      ok: true,
      debug: true,
      node: process.version,
      platform: process.platform,
      tz_env: process.env.TZ || null,
      now: new Date().toString(),
      env: {
        RENDER: !!process.env.RENDER,
        NODE_ENV: process.env.NODE_ENV || null,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
        FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || null,
        FRONTEND_ORIGIN_2: process.env.FRONTEND_ORIGIN_2 || null,
        FORCE_LOCALE: process.env.FORCE_LOCALE || null,
        ALLOWED_CTA: process.env.ALLOWED_CTA || null,
        ALLOWED_PAGE_CATEGORIES: process.env.ALLOWED_PAGE_CATEGORIES || null,
        REQUIRE_CATEGORY_STRICT: process.env.REQUIRE_CATEGORY_STRICT || null,
        EXCLUDED_PAGE_NAME_REGEX: process.env.EXCLUDED_PAGE_NAME_REGEX || null,
        CONCURRENCY: process.env.CONCURRENCY || null,
        BLOCK_STYLESHEETS: process.env.BLOCK_STYLESHEETS || null,
        MAX_PAGES: process.env.MAX_PAGES || null,
        MAX_SCANNED: process.env.MAX_SCANNED || null,
        META_ADS_TOKEN_present: !!process.env.META_ADS_TOKEN,
        META_ADS_TOKEN_snippet: mask(process.env.META_ADS_TOKEN, 12, 6),
      },
      playwright: pw
    };
    res.json(out);
  });

  // 2) Snelle netwerk-ping (default: graph.facebook.com)
  app.get("/debug/ping", async (req, res) => {
    const u = (req.query.u && String(req.query.u)) || "https://graph.facebook.com";
    try {
      const r = await fetch(u, { method: "GET" });
      const text = await r.text().catch(() => "");
      res.json({ ok: true, url: u, status: r.status, bodySnippet: text.slice(0, 300) });
    } catch (e) {
      res.status(500).json({ ok: false, url: u, error: String(e?.message || e) });
    }
  });
}

/* ------------------------------ sheets init ----------------------------- */

app.post("/sheets/init", async (_req, res) => {
  try {
    await ensureHeaders();
    res.json({ ok: true, msg: "Headers set" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ------------------------- sync scrape (kort) --------------------------- */

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

    // Sheets push
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

/* ========================== ASYNC VARIANT (in-proc) ========================== */
/*           Geen extra Render worker nodig; queue leeft in dit proces.         */

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
    setImmediate(runNextJob); // kijk of er nog een queued job ligt
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

/* --------------------------------- start -------------------------------- */

const PORT = process.env.PORT || 5179;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
