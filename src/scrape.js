// src/scrape.js
// Graph API voor listing (incl. eu_total_reach & media_type)
// Snapshot (Playwright) alleen voor product link + CTA
// Filter: alleen CTA "Shop Now" / "Shop Nu" (of via ALLOWED_CTA)
// Parallel snapshots met kleine page-pool
// Force NL UI (Accept-Language + Playwright locale + cookie + ?locale=nl_NL)
// Category pre-check vóór snapshot (skip dure navigaties voor uitgesloten pages)
// Heldere logging + juiste cap: MAX_SCANNED telt nu alleen SNAPSHOT-POGINGEN

import dotenv from "dotenv";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const STORAGE_DIR  = path.join(__dirname, "..", "storage");
const STORAGE_PATH = path.join(STORAGE_DIR, "fb-state.json");

const META_TOKEN = process.env.META_ADS_TOKEN;
const ALLOWED_CTA = (process.env.ALLOWED_CTA || "Shop Now,Shop Nu,Shoppen")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Case-sensitive whitelist. Body > env > default (exacte match)
const ALLOWED_PAGE_CATEGORIES = (process.env.ALLOWED_PAGE_CATEGORIES || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Als categorie ontbreekt → direct weigeren?
const REQUIRE_CATEGORY_STRICT = (process.env.REQUIRE_CATEGORY_STRICT ?? "1") === "1";

// Optioneel: page name uitsluiten via regex (bv. cadeau|gift|miro)
const EXCLUDED_PAGE_NAME_REGEX = process.env.EXCLUDED_PAGE_NAME_REGEX
  ? new RegExp(process.env.EXCLUDED_PAGE_NAME_REGEX, "i")
  : null;

// ===== Locale forcing (altijd NL tenzij FORCE_LOCALE anders zegt) =====
const LOCALES = { NL: "nl-NL", BE: "nl-BE", FR: "fr-FR", DE: "de-DE", ES: "es-ES", IT: "it-IT", GB: "en-GB", US: "en-US" };
function resolveLocale(country) {
  // Default NL, maar kan via env overschreven worden
  const force = (process.env.FORCE_LOCALE || "nl-NL").trim();
  if (force) return force;
  return LOCALES[(country || "NL").toUpperCase()] || "nl-NL";
}
function underscoreLocale(loc) { return (loc || "nl-NL").replace("-", "_"); }

// ===== helpers =====
function categoryMatch(cat, list) {
  if (!list || list.length === 0) return true;   // geen filter → alles doorlaten
  if (!cat) return false;
  const arr = Array.isArray(cat)
    ? cat
    : String(cat).split(/[\u00B7•|,/]+/).map(s => s.trim()).filter(Boolean);
  // hoofdletter-gevoelig: exacte gelijkheid
  return arr.some(c => list.includes(c));
}

function cleanCount(s) {
  if (!s) return null;
  return s.replace(/\s+/g, " ").trim();
}

function parseFromUrl(libraryUrl) {
  if (!libraryUrl) return {};
  const u = new URL(libraryUrl);
  const p = Object.fromEntries(u.searchParams.entries());
  return {
    country: p.country || p.ad_reached_countries || "",
    q: p.q || p.search_terms || "",
    startMin: p["ad_delivery_date_min"] || p["start_date[min]"] || "",
    startMax: p["ad_delivery_date_max"] || p["start_date[max]"] || "",
    active: (p.active_status || "active").toLowerCase() === "active",
  };
}

function classifyCTA(t) {
  const clean = (t || "").trim().toLowerCase();
  if (/shop\s*now/.test(clean)) return "Shop Now";
  if (/shop\s*nu/.test(clean))  return "Shop Nu";
  if (/shoppen/.test(clean))    return "Shoppen";
  return null;
}

// ===== Graph: 1 pagina fetchen (with cursor) =====
async function fetchAdsPage({
  country, q, active = true, limit = 50, after = null,
  graphVer = "v23.0", dateMin = "", dateMax = ""
}) {
  if (!META_TOKEN) throw new Error("META_ADS_TOKEN ontbreekt in .env");

  const params = new URLSearchParams({
    access_token: META_TOKEN,
    ad_type: "ALL",
    ad_reached_countries: country,
    ad_active_status: active ? "ACTIVE" : "ALL",
    search_terms: q || "",
    limit: String(Math.min(200, Math.max(10, limit))),
    fields: [
      "id",
      "ad_snapshot_url",
      "page_id",
      "page_name",
      "publisher_platforms",
      "ad_delivery_start_time",
      "ad_delivery_stop_time",
      "ad_active_status",
      "media_type",
      "eu_total_reach"
    ].join(","),
  });
  if (after) params.set("after", after);
  if (dateMin) params.set("ad_delivery_date_min", dateMin);
  if (dateMax) params.set("ad_delivery_date_max", dateMax);

  const url = `https://graph.facebook.com/${graphVer}/ads_archive?${params}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Meta API error: ${JSON.stringify(j)}`);

  const data = Array.isArray(j.data) ? j.data : [];
  const cursorAfter = j?.paging?.cursors?.after || null;
  return { data, cursorAfter };
}

// ===== CONSENT =====

// Consent cache per host (klik maar 1x per host)
const CONSENTED = new Set();

async function superConsent(page, { timeoutMs = 2500 } = {}) {
  // Taal-agnostisch: zoek naar “accept/allow/agree/consent/continue/ok” e.d. + cookie hints
  const deadline = Date.now() + timeoutMs;

  const genericButtonSelectors = [
    'button[aria-label*="cookie" i]',
    'button:has-text("cookie")',
    '[role="dialog"] button',
    '[data-testid*="consent" i] button',
    'button[type="submit"]',
    'button', // laatste redmiddel binnen dialog
  ];

  const acceptRegexes = [
    /(accept|allow|agree|consent|continue|ok|proceed|enable)/i,
    /(alles|alle|toestaan|accepteren|aanvaarden)/i, // NL fallback
  ];

  async function tryFrame(f) {
    // a) role=button by text
    for (const re of acceptRegexes) {
      try { if (await f.getByRole('button', { name: re }).first().click({ timeout: 150 })) return true; } catch {}
    }
    // b) generic selectors + tekstfilter
    for (const sel of genericButtonSelectors) {
      const btns = f.locator(sel);
      const count = await btns.count().catch(() => 0);
      const max = Math.min(count, 8);
      for (let i = 0; i < max; i++) {
        const b = btns.nth(i);
        try {
          const txt = (await b.innerText({ timeout: 40 }).catch(() => "")) || (await b.getAttribute('aria-label').catch(() => "")) || "";
          if (acceptRegexes.some(re => re.test(txt))) {
            await b.click({ timeout: 180 });
            return true;
          }
        } catch {}
      }
    }
    // c) fallback: klik de eerste knop in een dialog
    try {
      const dlg = f.locator('[role="dialog"]');
      if (await dlg.count() > 0) {
        const primary = dlg.locator('button').first();
        await primary.click({ timeout: 150 });
        return true;
      }
    } catch {}
    return false;
  }

  while (Date.now() < deadline) {
    if (await tryFrame(page)) return true;
    for (const f of page.frames()) { try { if (await tryFrame(f)) return true; } catch {} }
    await page.waitForTimeout(80);
  }
  return false;
}

async function ensureConsent(page, timeoutMs = 2500) {
  try {
    const host = new URL(page.url()).hostname.replace(/^www\./, "");
    if (CONSENTED.has(host)) return true;
    const ok = await superConsent(page, { timeoutMs });
    if (ok) CONSENTED.add(host);
    return ok;
  } catch { return false; }
}

// ===== Snapshot: product link + CTA =====
async function scrapeSnapshotBits(page, snapshotUrl) {
  // voeg locale=nl_NL toe als verzekeringspolis
  const u = new URL(snapshotUrl);
  if (!u.searchParams.get("locale")) u.searchParams.set("locale", "nl_NL");

  await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
  await ensureConsent(page, 2000);

  // Snelle presence-check; we hebben enkel tekst/aria nodig
  await page.waitForSelector('a[role="link"],button,div[role="button"],a[aria-label]', { timeout: 600 }).catch(()=>{});

  // Product link – pak eerste externe link (strip l.facebook.com)
  const product_url = await page.evaluate(() => {
    function unwrap(href) {
      try {
        const u = new URL(href);
        if (u.hostname === "l.facebook.com" && u.pathname === "/l.php" && u.searchParams.get("u")) {
          return decodeURIComponent(u.searchParams.get("u"));
        }
      } catch {}
      return href;
    }
    const aTags = [...document.querySelectorAll('a[href^="http"]')];
    for (const a of aTags) {
      const raw = a.getAttribute("href");
      if (!raw) continue;
      const href = unwrap(raw);
      try {
        const u = new URL(href);
        const host = u.hostname.toLowerCase();
        if (host.endsWith("facebook.com") || host.endsWith("fb.com") || host.endsWith("meta.com")) continue;
        return href;
      } catch {}
    }
    return "";
  });

  // CTA – detecteer Shop Now / Shop Nu / Shoppen
  const cta_text = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(
      'a[role="link"],button,div[role="button"],a[aria-label]'
    )];
    const texts = nodes
      .map(n => (n.innerText || n.getAttribute("aria-label") || "").trim())
      .filter(t => t && t.length <= 20);

    const match = texts.find(t => /(shop\s*now|shop\s*nu|shoppen)/i.test(t));
    if (!match) return null;

    const clean = match.trim().toLowerCase();
    if (/shop\s*now/.test(clean)) return "Shop Now";
    if (/shop\s*nu/.test(clean))  return "Shop Nu";
    if (/shoppen/.test(clean))    return "Shoppen";
    return null;
  });

  return { product_url: product_url || null, cta_text: cta_text || null };
}

async function scrapePageInfo(page, pageId, cookieLocale) {
  async function extract() {
    return await page.evaluate(() => {
      const text = document.body.innerText || "";
      const likeRx = /([\d.,\s]+(?:[KkMmBb]|d\.)?)\s*(?:likes|vind-ik-leuks|mentions j.?aime|me gusta|curtidas|mi piace|Gefällt\s*mir)/i;
      const follRx = /([\d.,\s]+(?:[KkMmBb]|d\.)?)\s*(?:followers|volgers|abonnés|seguidores|abonnenten|seguaci)/i;
      const catRxList = [
        /Pagina\s*·\s*([^\n•|]{2,60})/i,
        /Page\s*·\s*([^\n•|]{2,60})/i,
        /Página\s*·\s*([^\n•|]{2,60})/i,
        /Seite\s*·\s*([^\n•|]{2,60})/i
      ];
      const likes = (text.match(likeRx)?.[1] || "").trim() || null;
      const followers = (text.match(follRx)?.[1] || "").trim() || null;

      let category = null;
      for (const rx of catRxList) { const m = text.match(rx); if (m) { category = m[1].trim(); break; } }

      const split = (category || "")
        .split(/[\u00B7•|,/]+/)
        .map(s => s.trim())
        .filter(Boolean);
      return {
        page_url: location.href,
        page_likes: likes,
        page_followers: followers,
        page_category: split[0] || category || null,
        page_categories: split.length ? split : null
      };
    });
  }

  // Desktop met expliciete NL locale
  const urlDesktop = `https://www.facebook.com/profile.php?id=${pageId}&locale=${cookieLocale}`;
  await page.goto(urlDesktop, { waitUntil: "domcontentloaded", timeout: 15000 });
  await ensureConsent(page, 2000);
  await page.waitForSelector("body", { timeout: 1500 }).catch(()=>{});
  await page.locator('[aria-label="Sluiten"], [aria-label="Close"]').first().click({ timeout: 500 }).catch(()=>{});
  await page.keyboard.press("Escape").catch(()=>{});
  let info = await extract();

  // Fallback: mbasic (minder gating)
  if (!info.page_likes && !info.page_followers && !info.page_category) {
    const urlMbasic = `https://mbasic.facebook.com/profile.php?id=${pageId}&refid=17&locale=${cookieLocale}`;
    await page.goto(urlMbasic, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector("body", { timeout: 1500 }).catch(()=>{});
    await ensureConsent(page, 2000);
    info = await extract();
    info.page_url = urlMbasic;
  }

  return info;
}

// ===== Hoofdfunctie =====
export async function scrapeSmart({
  url, country, keyword, active = true, limit = 25, headless = true,
  perAdDelayMs = 0, log = true, dateMin, dateMax, requireCategory,
}) {
  // safety caps (env-overrides mogelijk)
  // LET OP: MAX_SCANNED telt nu ALLEEN SNAPSHOT-POGINGEN
  const MAX_SNAPSHOT_ATTEMPTS = Number(process.env.MAX_SCANNED || (limit * 200));
  const MAX_PAGES = Number(process.env.MAX_PAGES || 40);
  const MAX_NOPROGRESS_PAGES = Number(process.env.MAX_NOPROGRESS_PAGES || 5);

  const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
  const BLOCK_STYLESHEETS = (process.env.BLOCK_STYLESHEETS ?? "1") === "1";

  const fromUrl = parseFromUrl(url);
  const _country = (country || fromUrl.country || "NL").toUpperCase();
  const _q       = (keyword || fromUrl.q || "").trim();
  const _active  = active ?? fromUrl.active;
  const _dateMin = dateMin ?? fromUrl.startMin ?? "";
  const _dateMax = dateMax ?? fromUrl.startMax ?? "";
  const requiredCats = (requireCategory
    ? requireCategory.split(",").map(s => s.trim()).filter(Boolean)
    : ALLOWED_PAGE_CATEGORIES);

  if (!_country || !_q) throw new Error("scrapeSmart: country en keyword (of link met q) zijn vereist.");

  const resolvedLocale = resolveLocale(_country);          // bv. nl-NL (forced)
  const cookieLocale   = underscoreLocale(resolvedLocale); // nl_NL

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 80,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ]
  });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const HAS_STATE = fs.existsSync(STORAGE_PATH);

  // Context met harde NL voorkeur
  const ctx = await browser.newContext({
    storageState: HAS_STATE ? STORAGE_PATH : undefined,
    locale: resolvedLocale, // bv. nl-NL
    timezoneId: "Europe/Brussels",
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'accept-language': `${resolvedLocale},nl;q=0.9,en;q=0.8` }
  });

  // Verzeker 'locale' cookie vóór navigatie
  await ctx.addCookies([{
    name: "locale",
    value: cookieLocale,   // nl_NL
    domain: ".facebook.com",
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  }]);

  // Bespaar bandbreedte: blokkeer zware assets (cta/tekst blijft werken)
  await ctx.route("**/*", route => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font" || (BLOCK_STYLESHEETS && t === "stylesheet")) {
      return route.abort();
    }
    return route.continue();
  });

  await ctx.setDefaultTimeout(12000);

  // Page pool voor snapshots (parallel tabs)
  const snapshotPages = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const p = await ctx.newPage();
    p.setDefaultNavigationTimeout(15000);
    p.setDefaultTimeout(8000);
    snapshotPages.push(p);
  }

  // Eén tab voor page info (bottleneck = ok)
  const pageInfoTab = await ctx.newPage();
  pageInfoTab.setDefaultNavigationTimeout(15000);
  pageInfoTab.setDefaultTimeout(8000);

  // Caches
  const pageInfoCache   = new Map();   // page_id -> info
  const pageAllowCache  = new Map();   // page_id -> true/false (toegestaan o.b.v. category en optionele name-regex)
  const pageCategoryMap = new Map();   // page_id -> (string|null), voor logging
  const pagesSeen       = new Set();   // unieke pages gezien (voor duidelijke metrics)

  // Counters
  const out = [];
  const stats = {
    seenAds: 0,              // alle ads uit Graph
    attemptedSnapshots: 0,   // ALLEEN ads waarvoor we snapshot probeerden
    preRejectedAds: 0,       // ads geskipt vóór snapshot
    noCta: 0,                // snapshot zonder CTA
    rejectedByPolicy: {},    // snapshot met niet-toegestane CTA
    // Unieke page metrics:
    uniquePages: 0,
    uniqueCatMissing: 0,
    uniqueCatRejected: 0,
    uniqueNameRejected: 0
  };
  const bump = (obj, key) => (obj[key] = (obj[key] || 0) + 1);

  let after = null;
  let pageCount = 0;
  let prevOutLen = 0;
  let noProgressPages = 0;
  let lastCursor = null;

  // Page-allow beslissen (en unieke stats bijwerken)
  async function decidePageAllow(page_id, page_name) {
    if (pageAllowCache.has(page_id)) return pageAllowCache.get(page_id);

    // optionele naam-exclude
    if (EXCLUDED_PAGE_NAME_REGEX && page_name && EXCLUDED_PAGE_NAME_REGEX.test(page_name)) {
      pageAllowCache.set(page_id, false);
      if (!pagesSeen.has(page_id)) { pagesSeen.add(page_id); stats.uniquePages++; stats.uniqueNameRejected++; }
      return false;
    }

    // haal info
    let pinfo = pageInfoCache.get(page_id);
    if (!pinfo) {
      try {
        pinfo = await scrapePageInfo(pageInfoTab, page_id, cookieLocale);
      } catch {
        pinfo = { page_url: `https://www.facebook.com/profile.php?id=${page_id}&locale=${cookieLocale}`, page_likes: null, page_followers: null, page_category: null };
      }
      pageInfoCache.set(page_id, pinfo);
    }

    const cat = pinfo?.page_category || null;
    pageCategoryMap.set(page_id, cat);

    // unieke page-registratie
    if (!pagesSeen.has(page_id)) { pagesSeen.add(page_id); stats.uniquePages++; }

    // beslis
    if (!cat) {
      if (REQUIRE_CATEGORY_STRICT) {
        pageAllowCache.set(page_id, false);
        stats.uniqueCatMissing++;
        return false;
      } else {
        pageAllowCache.set(page_id, true);
        return true;
      }
    }
    if (!categoryMatch(cat, ALLOWED_PAGE_CATEGORIES)) {
      pageAllowCache.set(page_id, false);
      stats.uniqueCatRejected++;
      return false;
    }
    pageAllowCache.set(page_id, true);
    return true;
  }

  // Ad-processor: gebruikt een toegewezen snapshotPage
  async function processAd(ad, page) {
    // 0) beslis op page-niveau vóór snapshot
    const allowed = await decidePageAllow(ad.page_id, ad.page_name);
    if (!allowed) { stats.preRejectedAds++; return null; }

    // CAP op het aantal snapshot-pogingen
    if (stats.attemptedSnapshots >= MAX_SNAPSHOT_ATTEMPTS) return null;

    // 1) snapshot + CTA
    stats.attemptedSnapshots++;
    const bits = await scrapeSnapshotBits(page, ad.ad_snapshot_url);

    // 2) CTA filter
    const seen = classifyCTA(bits.cta_text);
    if (!seen) { stats.noCta++; return null; }
    if (!ALLOWED_CTA.includes(seen.toLowerCase())) { bump(stats.rejectedByPolicy, seen); return null; }

    // 3) Page info voor output (we hebben al beslist, maar vul velden)
    let pinfo = pageInfoCache.get(ad.page_id);
    if (!pinfo) {
      try {
        pinfo = await scrapePageInfo(pageInfoTab, ad.page_id, cookieLocale);
      } catch {
        pinfo = { page_url: `https://www.facebook.com/profile.php?id=${ad.page_id}&locale=${cookieLocale}`, page_likes: null, page_followers: null, page_category: pageCategoryMap.get(ad.page_id) || null };
      }
      pageInfoCache.set(ad.page_id, pinfo);
    }

    // 4) Output
    const reach = typeof ad.eu_total_reach === "number" ? ad.eu_total_reach : null;
    return {
      ad_snapshot_url: ad.ad_snapshot_url,
      page_name: ad.page_name || "",
      country: _country,
      reach,
      product_url: bits.product_url || "",
      start_date: ad.ad_delivery_start_time ? ad.ad_delivery_start_time.slice(0, 10) : "",
      media_type: ad.media_type || "UNKNOWN",
      platforms: Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms.join(",") : "",
      keyword: _q,
      ad_id: ad.id || "",
      cta_text: seen,
      ad_active_status: ad.ad_active_status || "",
      page_likes: cleanCount(pinfo?.page_likes),
      page_followers: cleanCount(pinfo?.page_followers),
      page_category: (pinfo?.page_categories?.join(" · ")) || pinfo?.page_category || pageCategoryMap.get(ad.page_id) || null,
      page_url: pinfo?.page_url || `https://www.facebook.com/profile.php?id=${ad.page_id}&locale=${cookieLocale}`
    };
  }

  try {
    while (out.length < limit) {
      if (pageCount >= MAX_PAGES) { if (log) console.log(`[SMART] stop: reached MAX_PAGES=${MAX_PAGES}`); break; }
      // BELANGRIJK: stop niet op seenAds maar op attemptedSnapshots
      if (stats.attemptedSnapshots >= MAX_SNAPSHOT_ATTEMPTS) { if (log) console.log(`[SMART] stop: reached MAX_SCANNED=${MAX_SNAPSHOT_ATTEMPTS} (snapshot attempts)`); break; }

      pageCount += 1;
      const { data, cursorAfter } = await fetchAdsPage({
        country: _country,
        q: _q,
        active: _active,
        limit: Math.min(200, Math.max(10, limit)),
        after,
        dateMin: _dateMin,
        dateMax: _dateMax
      });

      if (log) console.log(`[SMART] page ${pageCount} got ${data.length} ads (after=${after || "-"})`);
      if (!data.length) { if (log) console.log("[SMART] No more ads available from Graph."); break; }
      if (cursorAfter && cursorAfter === lastCursor) { if (log) console.log("[SMART] stop: cursor didn't advance"); break; }

      // Parallel verwerken met page-pool
      const tasks = [];
      let poolIdx = 0;

      for (const ad of data) {
        if (out.length >= limit) break;
        if (stats.attemptedSnapshots >= MAX_SNAPSHOT_ATTEMPTS) break;

        stats.seenAds++;

        const page = (poolIdx < snapshotPages.length)
          ? snapshotPages[poolIdx++]
          : snapshotPages[poolIdx++ % snapshotPages.length];

        tasks.push(
          (async () => {
            try {
              const res = await processAd(ad, page);
              if (res) out.push(res);
              if (perAdDelayMs) await new Promise(r => setTimeout(r, perAdDelayMs));
            } catch {
              // stil overslaan
            }
          })()
        );

        // throttle: wacht zodra we >= CONCURRENCY taken gestart hebben
        if (tasks.length >= CONCURRENCY) {
          await Promise.race(tasks.map(p => p.catch(() => {})));
          // verwijder afgewerkte tasks (niet perfect, maar oké)
          for (let i = tasks.length - 1; i >= 0; i--) {
            const t = tasks[i];
            if (t.status === 'fulfilled' || t.status === 'rejected') tasks.splice(i, 1);
          }
        }
      }

      // wacht de batch af
      await Promise.allSettled(tasks);

      // progress check per pagina
      if (out.length === prevOutLen) {
        noProgressPages += 1;
        if (noProgressPages >= MAX_NOPROGRESS_PAGES) {
          if (log) console.log(`[SMART] stop: ${noProgressPages} pages without progress`);
          break;
        }
      } else {
        noProgressPages = 0;
        prevOutLen = out.length;
      }

      if (!cursorAfter) { if (log) console.log("[SMART] No next cursor from Graph."); break; }
      lastCursor = cursorAfter;
      after = cursorAfter;
    }
  } finally {
    try {
      await ctx.storageState({ path: STORAGE_PATH }); // maakt storage/fb-state.json automatisch aan
    } catch {}
    await browser.close();
  }

  if (log) {
    const fmt = o => Object.entries(o).map(([k,v]) => `${k}=${v}`).join(" ");
    console.log(`[SMART] done ${out.length}/${limit}`);
    console.log(`[SMART] ads: seen=${stats.seenAds} attemptedSnapshots=${stats.attemptedSnapshots} preRejectedAds=${stats.preRejectedAds} noCta=${stats.noCta} rejectedByPolicy{ ${fmt(stats.rejectedByPolicy)} }`);
    console.log(`[SMART] pages: unique=${pagesSeen.size} uniqueCatMissing=${[...pageAllowCache].filter(([id, allow]) => allow===false && (pageCategoryMap.get(id)==null)).length} uniqueCatRejected=${[...pageAllowCache].filter(([id, allow]) => allow===false && (pageCategoryMap.get(id)!=null)).length}`);
  }

  return out.slice(0, limit);
}
