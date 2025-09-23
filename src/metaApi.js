// src/metaApi.js
// Helper om Meta Graph (Ad Library API) te bevragen met betere foutmeldingen,
// timeout en retries. Gebruikt automatisch een env-token als je er geen meegeeft.

import { isEUorUK } from "./eu.js";

// Kleine sleep helper voor retries
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpJSON(url, opts = {}, { timeoutMs = 25000, maxRetries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: controller.signal,
        headers: {
          'User-Agent': 'ad-research-tool/1.0 (+render)',
          'Accept': 'application/json',
          ...(opts.headers || {})
        }
      });
      const text = await res.text(); // eerst als tekst voor debugging
      if (!res.ok) {
        // Geef de echte http-code + stukje body terug
        throw new Error(`HTTP ${res.status} on ${url}\n${text.slice(0, 800)}`);
      }
      try { return JSON.parse(text); } catch {
        throw new Error(`Invalid JSON from ${url}\n${text.slice(0, 800)}`);
      }
    } catch (e) {
      lastErr = e;
      // Alleen retry op netwerk/timeout/5xx
      const msg = String(e?.message || e);
      const retriable = msg.includes("timeout") || msg.includes("network") || msg.includes("ENOTFOUND") || msg.includes("ECONNRESET") || msg.includes("5");
      if (attempt < maxRetries && retriable) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      // Laat een rijke fout naar boven bubbelen
      const cause = e?.cause;
      const detail = {
        message: msg,
        name: e?.name,
        code: e?.code,
        cause: cause && { code: cause.code, errno: cause.errno, syscall: cause.syscall, hostname: cause.hostname },
      };
      const rich = new Error(`fetch failed → ${url} :: ${JSON.stringify(detail)}`);
      rich.cause = e;
      throw rich;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function fetchMetaAds({ keyword, country, limit = 500, token, graphVer = "v23.0" }) {
  if (!keyword) throw new Error("keyword is required");
  if (!country) throw new Error("country is required");

  // Token uit param of uit env (zet op Render bij Environment: META_ADS_TOKEN = EAAG... )
  const envToken = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.GRAPH_TOKEN;
  const useToken = token || envToken;
  if (!useToken) throw new Error("META_ADS_TOKEN missing (geen token in arg óf env)");

  const eu = isEUorUK(country);
  const base = `https://graph.facebook.com/${graphVer}/ads_archive`;

  const params = new URLSearchParams({
    // Graph verwacht search_terms als string; geen hard returns of rare quotes
    search_terms: `'${String(keyword)}'`,
    ad_reached_countries: JSON.stringify([country.toUpperCase()]),
    ad_type: "ALL",
    ad_active_status: "ACTIVE",
    limit: String(limit),
    access_token: useToken
  });

  params.set("fields", eu
    ? [
        "page_name","ad_snapshot_url","ad_creation_time",
        "publisher_platforms","link_url","media_type",
        "eu_total_reach","total_reach_by_location",
        "age_country_gender_reach_breakdown"
      ].join(",")
    : [
        "page_name","ad_snapshot_url","ad_creation_time",
        "publisher_platforms","link_url","media_type"
      ].join(",")
  );

  const url = `${base}?${params.toString()}`;
  const json = await httpJSON(url, {}, { timeoutMs: 25000, maxRetries: 2 });

  return (json.data || []).map(ad => ({
    page_name: ad.page_name ?? null,
    ad_snapshot_url: ad.ad_snapshot_url ?? null,
    product_url: ad.link_url ?? null,
    start_date: ad.ad_creation_time ? ad.ad_creation_time.slice(0,10) : null,
    media_type: ad.media_type ?? "UNKNOWN",
    platforms: (ad.publisher_platforms || []).join(","),
    eu_total_reach: eu ? (ad.eu_total_reach ?? null) : null,
    reach_by_location: eu && ad.total_reach_by_location ? JSON.stringify(ad.total_reach_by_location) : null,
    age_gender_breakdown: eu && ad.age_country_gender_reach_breakdown ? JSON.stringify(ad.age_country_gender_reach_breakdown) : null
  }));
}
