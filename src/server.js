// src/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import db from "./db.js";
import { appendUniversalRows, appendHistoryRow, ensureHeaders } from "./sheetsUtil.js";
import { scrapeSmart } from "./scrape.js";

dotenv.config();
const app = express();

// JSON body parsing
app.use(express.json({ limit: "2mb" }));

// CORS openzetten (pas origin aan naar je eigen Pages/Render domein)
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://<JOUW-PAGES-URL>.pages.dev"
  ]
}));

// Static client map (upload.html bereikbaar op /client/upload.html)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/client", express.static(path.join(__dirname, "client")));

/* ---------- health ---------- */
app.get("/health", (_req, res) => {
  try {
    const row = db.prepare("SELECT COUNT(*) AS total FROM ads_universal").get();
    res.json({ ok: true, ads_in_db: row?.total ?? 0, ts: new Date().toISOString() });
  } catch {
    res.json({ ok: true, ads_in_db: 0, ts: new Date().toISOString() });
  }
});

/* ---------- sheets init (headers) ---------- */
app.post("/sheets/init", async (_req, res) => {
  try {
    await ensureHeaders();
    res.json({ ok: true, msg: "Headers set" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- smart scrape (Graph + snapshot + CTA-filter) ---------- */
app.post("/scrape/smart", async (req, res) => {
  try {
    const { link, country, keyword, limit = 25, active = true, headless = true, log = true,
            date_min, date_max, require_category } = req.body || {};
    
    // simpele validatie (optioneel)
    const DRE = /^\d{4}-\d{2}-\d{2}$/;
    const dm = date_min && DRE.test(date_min) ? date_min : undefined;
    const dx = date_max && DRE.test(date_max) ? date_max : undefined;

    if (!link && (!keyword || !country)) {
      return res.status(400).json({ ok: false, error: "Provide 'link' or 'keyword' + 'country'." });
    }

    const started = new Date().toISOString();
    const items = await scrapeSmart({
      url: link, country, keyword, limit, active, headless, log,
      dateMin: dm, dateMax: dx, requireCategory: require_category
    });

    // --- DB insert (optioneel/best-effort) ---
    const now = new Date().toISOString();
    const batchId = `smart-${Date.now()}`;

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO ads_universal
      (batch_id, pulled_at, keyword, country,
       ad_snapshot_url, page_name, reach, reach_min, reach_max,
       product_url, start_date, media_type, platforms)
      VALUES (@batch_id, @pulled_at, @keyword, @country,
              @ad_snapshot_url, @page_name, @reach, NULL, NULL,
              @product_url, @start_date, @media_type, @platforms)
    `);

    let inserted = 0;
    for (const it of items) {
      try {
        const info = stmt.run({
          batch_id: batchId,
          pulled_at: now,
          keyword: it.keyword || "",
          country: it.country || "",
          ad_snapshot_url: it.ad_snapshot_url || "",
          page_name: it.page_name || "",
          reach: typeof it.reach === "number" ? it.reach : null,
          product_url: it.product_url || "",
          start_date: it.start_date || "",
          media_type: it.media_type || "UNKNOWN",
          platforms: it.platforms || "",
        });
        inserted += info.changes;
      } catch (e) {
        console.log("[DB] insert skipped/best-effort:", e.message);
      }
    }

    // --- Sheets push: exact kolom-schema ---
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

    if (rows.length) {
      await appendUniversalRows(rows);
    }

    await appendHistoryRow([
      batchId,
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
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 5179;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
